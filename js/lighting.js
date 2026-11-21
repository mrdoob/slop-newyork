import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uniform,
  mix,
  dot,
  inverseSqrt,
  output,
  pmremTexture,
  positionWorld,
  cameraPosition,
  length,
  normalize,
  max,
  exp,
  abs,
  select,
  renderGroup
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { cityUniforms } from './tsl-materials.js';

// Atmospheric sky, environment lighting, sunlight and time-of-day presets.

// The sun and moon sit where they really are over New York (40.7° N) on one day in late May / mid-July, when the
// low evening sun lines up with the cross streets ("Manhattanhenge"). Positions are an elevation above the horizon
// and a compass bearing in degrees from true north; the street grid, and with it the world's -z axis, points 29°
// east of true north.
const GRID_BEARING = 29.02;
function skyDirection(elevation, bearing) {
  const el = elevation * Math.PI / 180;
  const az = (bearing - GRID_BEARING) * Math.PI / 180;
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}

// Earth's atmosphere (SkyMesh's Earth preset); only the aerosol haze changes over the day
const RAYLEIGH = 3;
const MIE_DIRECTIONAL_G = 0.7;

// SkyMesh's sky fades to black about 2° below the horizon, well before twilight ends. A sun lower than this draws
// the sky as it looks just after sunset: the last glow in the west, brightened by the preset's skyExposure, over the
// twilight blue of the glow layer.
const SKY_SUN_MIN_Y = Math.sin(-1.5 * Math.PI / 180);

// The cascades reach upstream far enough for a 550 m tower's shadow down to this sun elevation (golden hour is 6°)
const SHADOW_MIN_SUN_Y = Math.sin(5 * Math.PI / 180);

const TIME_PRESETS = {
  golden: {
    id: 'golden',
    sunDir: skyDirection(6, 299), // 19:50, straight down the cross streets
    lightColor: 0xffbb78, // the sun through 9 air masses
    lightIntensity: 5.0,
    hemiSky: 0x9abbe6,
    hemiGround: 0xc88a62, // Warm terracotta / limestone upward canyon bounce
    hemiIntensity: 1.48,
    skyTop: 0x2c568c,
    skyHorizon: 0xebd1b5,
    fogColor: 0xdcc5ae,
    fogDensity: 0.00024,
    interiorGlow: 0.48,
    roadWetness: 0.28,
    envIntensity: 0.54,
    canyonBounce: 0.52,
    mieCoefficient: 0.03, // the evening haze
    cloudCoverage: 0.36,
    cloudDensity: 0.38,
    skyExposure: 0.25,
    nightFactor: 0.0,
    glowZenith: 0x46588c, // the low sun's multiply scattered blue, without which the sky away from it turns teal
    glowHorizon: 0x7c7489
  },
  midday: {
    id: 'midday',
    sunDir: skyDirection(71, 180), // solar noon, 12:57
    lightColor: 0xfff5e8,
    lightIntensity: 6.6,
    hemiSky: 0xaad2ff,
    hemiGround: 0xb89678, // Warm sunlit masonry & pavement bounce
    hemiIntensity: 1.58,
    skyTop: 0x225ea8,
    skyHorizon: 0xc8dff5,
    fogColor: 0xc6dcf2,
    fogDensity: 0.00018,
    interiorGlow: 0.24,
    roadWetness: 0.08,
    envIntensity: 0.58,
    canyonBounce: 0.58,
    mieCoefficient: 0.02, // the clearest air of the day
    cloudCoverage: 0.32,
    cloudDensity: 0.35,
    skyExposure: 0.07,
    nightFactor: 0.0,
    glowZenith: 0x000000,
    glowHorizon: 0x000000
  },
  twilight: {
    id: 'twilight',
    sunDir: skyDirection(-5, 305), // 20:55, civil twilight: no direct sunlight, only the sky
    moonDir: skyDirection(8, 125), // the full moon rising
    lightColor: 0x8cb0e8,
    lightIntensity: 0.0, // moonlight is lost in the twilight
    hemiSky: 0x4c6ca8,
    hemiGround: 0x6e5048,
    hemiIntensity: 1.3,
    skyTop: 0x102248,
    skyHorizon: 0xb86b6c,
    fogColor: 0x353c58,
    fogDensity: 0.00032,
    interiorGlow: 1.25,
    roadWetness: 0.55,
    envIntensity: 0.5,
    canyonBounce: 0.32,
    mieCoefficient: 0.02, // a narrower glow over the set sun
    cloudCoverage: 0.40,
    cloudDensity: 0.42,
    skyExposure: 6.0,
    nightFactor: 0.0,
    glowZenith: 0x22386e, // the twilight blue
    glowHorizon: 0x2e3a5e
  },
  midnight: {
    id: 'midnight',
    sunDir: skyDirection(-20, 335), // 23:00
    moonDir: skyDirection(22, 165), // a full moon, low in the south
    lightColor: 0x8cb0e8,
    lightIntensity: 0.5, // faint next to the street lights
    hemiSky: 0x3b3a44, // the light-polluted sky
    hemiGround: 0x382e36,
    hemiIntensity: 0.72,
    skyTop: 0x10131a,
    skyHorizon: 0x3a3029,
    fogColor: 0x1a1816,
    fogDensity: 0.0002, // the city's lights carry for kilometres
    interiorGlow: 1.55,
    roadWetness: 0.62,
    envIntensity: 0.30,
    canyonBounce: 0.18,
    mieCoefficient: 0.025,
    cloudCoverage: 0.22,
    cloudDensity: 0.25,
    skyExposure: 0.022,
    nightFactor: 1.0, // no sunlit sky at all, only the city's glow
    glowZenith: 0x15171d,
    glowHorizon: 0x524840
  }
};

// A preset in a form that blends into another: its colours (linear), directions and amounts
const COLOR_KEYS = ['lightColor', 'hemiSky', 'hemiGround', 'skyTop', 'skyHorizon', 'fogColor', 'glowZenith', 'glowHorizon'];
const AMOUNT_KEYS = ['hemiIntensity', 'fogDensity', 'interiorGlow', 'roadWetness', 'envIntensity', 'canyonBounce',
  'mieCoefficient', 'cloudCoverage', 'cloudDensity', 'nightFactor'];

function lightingState() {
  const s = { lightDir: new THREE.Vector3(), sunDir: new THREE.Vector3(), moon: false, lightIntensity: 0, skyExposure: 1 };
  for (const k of COLOR_KEYS) s[k] = new THREE.Color();
  for (const k of AMOUNT_KEYS) s[k] = 0;
  return s;
}

function presetState(p, s) {
  s.lightDir.copy(p.moonDir || p.sunDir);
  s.sunDir.copy(p.sunDir);
  s.moon = !!p.moonDir;
  s.lightIntensity = p.lightIntensity;
  s.skyExposure = p.skyExposure;
  for (const k of COLOR_KEYS) s[k].setHex(p[k]);
  for (const k of AMOUNT_KEYS) s[k] = p[k];
  return s;
}

// From unit vector a towards b, along the sky
function slerpDirection(a, b, t, out) {
  const angle = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
  const s = Math.sin(angle);
  if (s < 1e-4) return out.copy(t < 0.5 ? a : b);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * angle) / s).addScaledVector(b, Math.sin(t * angle) / s);
}

// t of the way from a to b. The sky's exposure (0.02 at night to 6 in the twilight) blends on a log scale. The direct
// light is the sun by day and the moon at night: between the two it fades out and back in, rather than swinging round
// the sky with every shadow.
function blendStates(a, b, t, out) {
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of AMOUNT_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  out.skyExposure = a.skyExposure * Math.pow(b.skyExposure / a.skyExposure, t);
  slerpDirection(a.sunDir, b.sunDir, t, out.sunDir);
  if (a.moon === b.moon) {
    slerpDirection(a.lightDir, b.lightDir, t, out.lightDir);
    out.lightIntensity = a.lightIntensity + (b.lightIntensity - a.lightIntensity) * t;
    out.moon = b.moon;
  } else {
    const from = t < 0.5 ? a : b;
    out.lightDir.copy(from.lightDir);
    out.lightIntensity = from.lightIntensity * Math.abs(1 - 2 * t);
    out.moon = from.moon;
  }
  return out;
}

class LightingSystem {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.activePresetId = 'golden';
    // What is shown, and a change of time of day under way (blending `from` into `to`)
    this.state = lightingState();
    this.from = lightingState();
    this.to = lightingState();
    this.transition = null;

    SunLight.registerNode(SunLightNode);

    this.scene.fog = new THREE.FogExp2(0xdcc5ae, 0.00024);
    // Leave scene.background = null because SkyMesh renders the 360° sky dome, and setting
    // a THREE.Color on scene.background sets forceClear=true in WebGPURenderer's Background.update,
    // which would otherwise clear Cascade 0 when rendering Cascade 1 in SunShadowNode!
    this.scene.background = null;

    // Physical Preetham SkyMesh + Beer-Powder Clouds (from three/addons/objects/SkyMesh.js). Its unit box must contain
    // the camera wherever it flies over the 1:1 harbour (Manhattan alone is 13.6 km long; it renders at the far plane
    // whatever its size)
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(200000);
    this.sky.rayleigh.value = RAYLEIGH;
    this.sky.mieCoefficient.value = TIME_PRESETS.golden.mieCoefficient;
    this.sky.mieDirectionalG.value = MIE_DIRECTIONAL_G;
    this.sky.cloudScale.value = 0.00018;
    this.sky.cloudSpeed.value = 0.000015;
    this.sky.cloudCoverage.value = 0.36;
    this.sky.cloudDensity.value = 0.38;
    this.sky.cloudElevation.value = 0.52;

    // Calibrate SkyMesh raw radiance (EE=1000 * 0.04) into standard exposure=1.0 HDR range
    this.uSkyExposure = uniform(0.148);
    this.uNightFactor = uniform(0.0);
    // The direct light the aerial haze scatters (see createAerialFogNode). The fog's uniforms are in every material: shared
    // (renderGroup) they are uploaded once a render, not into every object's own uniforms whenever they change
    this.uHazeSunDir = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup);
    this.uHazeSunColor = uniform(new THREE.Color(0x000000)).setGroup(renderGroup);
    // The sky light SkyMesh leaves out, added under it: its single scattering misses the light scattered more than once,
    // the blue that fills the sky away from a low sun and the twilight sky, and Manhattan's night sky is light-polluted
    // (a dull warm glow along the horizon, darker overhead)
    this.uGlowZenith = uniform(new THREE.Color(0x000000));
    this.uGlowHorizon = uniform(new THREE.Color(0x000000));
    const rawSkyNode = this.sky.material.colorNode;
    this.sky.material.colorNode = Fn(() => {
      const raw = rawSkyNode;
      const dayCol = raw.rgb.mul(this.uSkyExposure);
      const down = float(1.0).sub(max(normalize(positionWorld.sub(cameraPosition)).y, 0.0));
      const glow = mix(this.uGlowZenith, this.uGlowHorizon, down.mul(down).mul(down).mul(down));
      const finalSky = dayCol.mul(float(1.0).sub(this.uNightFactor)).add(glow);
      return vec4(finalSky, float(1.0));
    })();

    this.scene.add(this.sky);

    // Reuse the environment scene and PMREM generator when the lighting preset changes.
    this.pmremGenerator = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.envScene = new THREE.Scene();
    this.envRenderTarget = null;

    // Two-cascade sunlight (the moon at night) points from its position toward the origin; no target object is needed.
    this.sunLight = new SunLight(TIME_PRESETS.golden.lightColor, TIME_PRESETS.golden.lightIntensity);
    this.sunLight.position.copy(TIME_PRESETS.golden.sunDir);
    this.sunLight.castShadow = true;
    // Two cascades share a 4096x2048 atlas (2048px tiles), cutting shadow-map texel fill by 56% vs 3072px tiles.
    const tile = 2048;
    this.sunLight.shadow.mapSize.set(tile, tile);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 220;
    // Suppress shadow acne along the surface normal in world units
    // so short casters like cars, curbs, tree trunks, and pedestrians keep crisp contact shadows
    this.sunLight.shadow.normalBias = 0.05;
    // SunLightShadow raises its caster ceiling by camera.far (220 m), which slices tall skyscrapers (up to One WTC
    // at 541 m) when their shadows reach several blocks downstream. Shift each cascade camera upstream along its
    // local +Z (sun) axis so every Manhattan tower stays in front of the cascade near plane, for suns down to 5°
    // (a 550 m tower's shadow then reaches 6.3 km).
    const origUpdateMatrices = this.sunLight.shadow.updateMatrices;
    this.sunLight.shadow.updateMatrices = function (light, viewCamera) {
      if (viewCamera === undefined) return;
      origUpdateMatrices.call(this, light, viewCamera);
      const extra = Math.ceil(550 / Math.max(SHADOW_MIN_SUN_Y, this.getCamera(0).matrixWorld.elements[9]));
      for (let i = 0; i < this.getViewportCount(); i++) {
        const cam = this.getCamera(i);
        cam.translateZ(extra);
        cam.far += extra;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld();
        this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
      }
    };
    this.scene.add(this.sunLight);

    // Subtle Hemisphere Sky + Warm Terracotta/Limestone Ground Bounce Fill
    // (Kept intentionally lower than sunLight so urban canyon shadows remain deep and crisp)
    this.hemiLight = new THREE.HemisphereLight(0x9abbe6, 0xc88a62, 1.05);
    this.hemiLight.position.set(0, 300, 0);
    this.scene.add(this.hemiLight);

    this.applyPreset('golden');

    // Sky-matched aerial perspective (replaces the flat FogExp2 colour): distant surfaces fade into the baked sky
    // radiance just above the horizon in their view direction (sun glow included), through an exponential haze layer
    // so helicopter / observatory views stay clearer than the horizon.
    this.uFogDensity = uniform(TIME_PRESETS.golden.fogDensity).setGroup(renderGroup);
    this.uFogHeight = uniform(900.0).setGroup(renderGroup);
    if (this.envRenderTarget) this.scene.fogNode = this.createAerialFogNode();
  }

  createAerialFogNode() {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = length(toFrag);
    const dir = toFrag.div(max(dist, 0.001));
    const horizonDir = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
    const skyColor = pmremTexture(this.envRenderTarget.texture, horizonDir, float(0.0)).rgb;
    // Mean haze density exp(-y / H) along the ray between the fragment and the camera
    const H = this.uFogHeight;
    const ya = max(positionWorld.y, 0.0);
    const yb = max(cameraPosition.y, 0.0);
    const dy = yb.sub(ya);
    const ea = exp(ya.div(H).negate());
    const eb = exp(yb.div(H).negate());
    const meanDensity = select(abs(dy).greaterThan(1.0), ea.sub(eb).mul(H).div(dy), ea);
    const tau = this.uFogDensity.mul(dist).mul(meanDensity);
    const factor = float(1.0).sub(exp(tau.mul(tau).negate()));
    // Sunlight the haze along the view ray scatters toward the eye, with the sky's own forward-peaked Mie phase
    // (Henyey-Greenstein): the air glows down a street that faces a low sun, from a few hundred metres on
    const g = MIE_DIRECTIONAL_G;
    const k = float(1 + g * g).sub(dot(dir, this.uHazeSunDir).mul(2 * g));
    const phase = inverseSqrt(k.mul(k).mul(k)).mul((1 - g * g) / (4 * Math.PI));
    // Further out the sky-coloured fog takes over, which carries the sun's glow already
    const inscatter = this.uHazeSunColor.mul(phase).mul(float(1.0).sub(exp(tau.negate()))).mul(float(1.0).sub(factor));
    return Fn(() => vec4(mix(output.rgb, skyColor, factor).add(inscatter), output.a))();
  }

  bakeEnvironmentMap() {
    if (!this.pmremGenerator) return;
    // Bake physical SkyMesh (without solar disc) into scene.environment for realistic canyon IBL.
    // Reuses a single RenderTarget so texture identity never changes.
    this.sky.showSunDisc.value = 0;
    this.envScene.add(this.sky);
    this.envRenderTarget = this.pmremGenerator.fromScene(this.envScene, 0, 0.1, 100, {
      renderTarget: this.envRenderTarget
    });
    this.scene.environment = this.envRenderTarget.texture;
    this.sky.showSunDisc.value = 1;
    this.scene.add(this.sky);
  }

  // Switch to a time of day at once
  applyPreset(presetId, force = false) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    if (!force && this.activePresetId === p.id && !this.transition && this.envRenderTarget !== null) {
      return;
    }
    this.activePresetId = p.id;
    this.transition = null;
    this.applyState(presetState(p, this.state));
  }

  // Change to a time of day over `seconds`, from whatever is shown (even partway through another change)
  transitionTo(presetId, seconds = 2) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    if (this.activePresetId === p.id) return;
    if (!(seconds > 0) || !this.envRenderTarget) {
      this.applyPreset(p.id);
      return;
    }
    this.activePresetId = p.id;
    blendStates(this.state, this.state, 0, this.from); // (a copy of what is shown)
    presetState(p, this.to);
    this.transition = { start: performance.now(), seconds, baked: -Infinity };
  }

  applyState(s, bake = true) {
    // The directional light is the sun by day and the moon once the sun has set
    this.sunLight.color.copy(s.lightColor);
    this.sunLight.intensity = s.lightIntensity;
    this.sunLight.position.copy(s.lightDir);
    this.sunLight.updateMatrixWorld();
    this.uHazeSunDir.value.copy(s.lightDir);
    // halved: the term can't tell sunlit air from the air in the towers' shadow, which is much of a low view ray
    this.uHazeSunColor.value.copy(s.lightColor).multiplyScalar(s.lightIntensity * 0.5);

    this.hemiLight.color.copy(s.hemiSky);
    this.hemiLight.groundColor.copy(s.hemiGround);
    this.hemiLight.intensity = s.hemiIntensity;

    this.scene.fog.color.copy(s.fogColor);
    this.scene.fog.density = s.fogDensity;
    if (this.uFogDensity) this.uFogDensity.value = s.fogDensity;

    // Update physical Preetham SkyMesh uniforms
    this.sky.mieCoefficient.value = s.mieCoefficient;
    this.sky.cloudCoverage.value = s.cloudCoverage;
    this.sky.cloudDensity.value = s.cloudDensity;
    const skySun = this.sky.sunPosition.value.copy(s.sunDir);
    if (skySun.y < SKY_SUN_MIN_Y) {
      const k = Math.sqrt(1 - SKY_SUN_MIN_Y * SKY_SUN_MIN_Y) / Math.hypot(skySun.x, skySun.z);
      skySun.set(skySun.x * k, SKY_SUN_MIN_Y, skySun.z * k);
    }
    this.uSkyExposure.value = s.skyExposure;
    this.uNightFactor.value = s.nightFactor;
    this.uGlowZenith.value.copy(s.glowZenith);
    this.uGlowHorizon.value.copy(s.glowHorizon);

    // The faked reflections glint with the direct light, dimmed with it (none in the twilight)
    cityUniforms.uSunColor.value.copy(s.lightColor).multiplyScalar(Math.min(1, s.lightIntensity));
    cityUniforms.uSkyTopColor.value.copy(s.skyTop);
    cityUniforms.uSkyHorizonColor.value.copy(s.skyHorizon);
    cityUniforms.uSkySunDir.value.copy(s.lightDir);
    cityUniforms.uInteriorGlow.value = s.interiorGlow;
    cityUniforms.uRoadWetness.value = s.roadWetness;
    cityUniforms.uCanyonBounce.value = s.canyonBounce;

    this.scene.environmentIntensity = s.envIntensity;
    if (bake) this.bakeEnvironmentMap();
  }

  update(focusPos) {
    if (this.transition) {
      // eased in and out. Baking the sky's environment map (the fog's colour too) takes a few ms of GPU time: during a
      // change it is baked 15 times a second, and on arrival
      const now = performance.now();
      const t = Math.min(1, (now - this.transition.start) / (this.transition.seconds * 1000));
      const bake = t >= 1 || now - this.transition.baked >= 1000 / 15;
      this.applyState(blendStates(this.from, this.to, t * t * (3 - 2 * t), this.state), bake);
      if (bake) this.transition.baked = now;
      if (t >= 1) this.transition = null;
    }

    // SunLightShadow automatically fits & texel-snaps its 2 cascades to the view camera frustum
    // every frame inside SunShadowNode.renderShadow(), splitting [near, far] halfway between a uniform and a
    // logarithmic split (the near cascade ends at ~far / 4). Keep far at 300 m at street level so the near cascade
    // stays sharp, and expand it with altitude (helicopter / observatory) so shadows reach all the way down to street level.
    const altitude = focusPos && Number.isFinite(focusPos.y) ? Math.max(0, focusPos.y) : 0;
    this.sunLight.shadow.camera.far = Math.max(220, Math.min(600, 200 + altitude * 1.5));
  }
}

export { LightingSystem };
