import * as THREE from 'three/webgpu';
import { cityUniforms } from './city-uniforms.js';

// js/time-of-day.js
// Day, golden hour, dusk and night for footprint cities: the sun (or moon), sky & fog colour, ambient light, reflections
// and how strongly the city's own lights glow, blended over a second or two when the time changes. Values follow the
// NYC presets (js/lighting.js), rescaled to the plain DirectionalLight + HemisphereLight these viewers use.
// City-agnostic: the scene's lights come in through `parts`; anything else that lights up at night (windows, lamps,
// the player's bike) registers through `onNight(f)` with f = 0 (day) .. 1 (night).
//
// new TimeOfDay(renderer, scene, { sun, hemi, sky, target, distance }, { onNight }) ; .set(id) ; .update(dt)

const PRESETS = {
  day: {
    name: 'Day', sunDir: [-0.5, 0.79, 0.36], sunColor: 0xfff1dd, sunIntensity: 3.2, hemiSky: 0xdfeaf5, hemiGround: 0x5a5650,
    hemiIntensity: 0.9, sky: 0xb9cddc, env: 0.6, exposure: 1.0, glow: 0.24, night: 0
  },
  golden: {
    name: 'Golden hour', sunDir: [-0.82, 0.3, 0.48], sunColor: 0xffc58a, sunIntensity: 2.7, hemiSky: 0x9abbe6, hemiGround: 0xc88a62,
    hemiIntensity: 0.75, sky: 0xe3c7a8, env: 0.5, exposure: 1.0, glow: 0.48, night: 0.05
  },
  dusk: {
    name: 'Dusk', sunDir: [-0.9, 0.12, 0.42], sunColor: 0xff9466, sunIntensity: 0.9, hemiSky: 0x4c6ca8, hemiGround: 0x6e5048,
    hemiIntensity: 0.55, sky: 0x46507a, env: 0.3, exposure: 1.1, glow: 1.25, night: 0.7
  },
  night: {
    name: 'Night', sunDir: [0.42, 0.68, -0.6], sunColor: 0x8cb0e8, sunIntensity: 0.32, hemiSky: 0x263a62, hemiGround: 0x382e36,
    hemiIntensity: 0.4, sky: 0x0c1424, env: 0.12, exposure: 1.15, glow: 1.55, night: 1
  }
};
const ORDER = ['day', 'golden', 'dusk', 'night'];
const BLEND_S = 1.6;

class TimeOfDay {
  constructor(renderer, scene, parts, { onNight = [] } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.parts = parts; // { sun, hemi, sky: THREE.Color shared by background & fog, target: Vector3, distance: m }
    this.onNight = onNight;
    this.id = 'day';
    this.from = this._snapshot(PRESETS.day);
    this.to = this.from;
    this.t = 1;
    this._apply(this.from);
  }

  get presets() { return PRESETS; }

  set(id) {
    if (!PRESETS[id] || id === this.id) return;
    this.from = this._current || this._snapshot(PRESETS[this.id]);
    this.to = this._snapshot(PRESETS[id]);
    this.id = id;
    this.t = 0;
  }

  next(step = 1) {
    this.set(ORDER[(ORDER.indexOf(this.id) + step + ORDER.length) % ORDER.length]);
    return this.id;
  }

  update(dt) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / BLEND_S);
    const k = this.t * this.t * (3 - 2 * this.t);
    const a = this.from, b = this.to, mix = (x, y) => x + (y - x) * k;
    const s = {
      sunDir: a.sunDir.clone().lerp(b.sunDir, k).normalize(),
      colours: Object.fromEntries(Object.keys(a.colours).map((c) => [c, a.colours[c].clone().lerp(b.colours[c], k)])),
      ...Object.fromEntries(['sunIntensity', 'hemiIntensity', 'env', 'exposure', 'glow', 'night'].map((n) => [n, mix(a[n], b[n])]))
    };
    this._apply(s);
  }

  // Keep the sun's shadow camera over (x, z) (the camera's focus): snapped to a 16 m grid so the shadow map doesn't
  // shimmer as the focus moves
  follow(x, z) {
    const { sun, target, distance } = this.parts;
    const sx = Math.round(x / 16) * 16, sz = Math.round(z / 16) * 16;
    if (sx === target.x && sz === target.z) return;
    target.set(sx, 0, sz);
    sun.position.copy(target).addScaledVector(this._current.sunDir, distance);
    sun.target.position.copy(target);
  }

  _snapshot(p) {
    return {
      sunDir: new THREE.Vector3(...p.sunDir).normalize(),
      colours: { sun: new THREE.Color(p.sunColor), hemiSky: new THREE.Color(p.hemiSky), hemiGround: new THREE.Color(p.hemiGround), sky: new THREE.Color(p.sky) },
      sunIntensity: p.sunIntensity, hemiIntensity: p.hemiIntensity, env: p.env, exposure: p.exposure, glow: p.glow, night: p.night
    };
  }

  _apply(s) {
    this._current = s;
    const { sun, hemi, sky, target, distance } = this.parts;
    sun.position.copy(target).addScaledVector(s.sunDir, distance);
    sun.target.position.copy(target);
    sun.color.copy(s.colours.sun);
    sun.intensity = s.sunIntensity;
    hemi.color.copy(s.colours.hemiSky);
    hemi.groundColor.copy(s.colours.hemiGround);
    hemi.intensity = s.hemiIntensity;
    sky.copy(s.colours.sky);
    if (this.scene.fog) this.scene.fog.color.copy(sky); // THREE.Fog keeps its own copy
    this.scene.environmentIntensity = s.env;
    this.renderer.toneMappingExposure = s.exposure;
    cityUniforms.uInteriorGlow.value = s.glow; // car headlamps (actor-models.js) come on above ~0.6
    for (const f of this.onNight) f(s.night);
  }
}

export { TimeOfDay, PRESETS as TIME_PRESETS };
