import * as THREE from 'three/webgpu';

// js/hk/lighting.js
// 香港世界自帶的照明：半球光 + 可投影平行光 + 明確的天空底色與霧 + **程序化 IBL 環境**。
//
// 為什麼不直接用 lighting.js（紐約那套 Preetham SkyMesh + PMREM IBL + SunLight 2-cascade）？
// 那套依賴 three.js dev 分支的 SkyMesh / SunLight / ClusteredLighting 與渲染器內部節點註冊，
// 任何一環在瀏覽器裡不配合，畫面就會全黑而且沒有錯誤訊息。
//
// 為什麼還要 environment？golden hour 的「暖」有一半來自天空的環境光；
// MeshStandardNodeMaterial 沒有環境光就只能靠半球光，金屬（水面 metalness 0.72、樓冠 0.8）
// 更會直接變成黑色。這裡用一張 32×16 的程序化 equirect 天空圖 → PMREM，
// 零外部檔案、零 CDN 依賴，失敗會自動退回半球光。

const PRESETS = {
  golden: {
    sky: 0x9dc0e4, fog: 0xe2cbb0, fogNear: 260, fogFar: 7000,
    sunColor: 0xffd9b0, sunIntensity: 3.4, sunDir: [-0.42, 0.62, -0.66],
    hemiSky: 0xbcd4ee, hemiGround: 0x9a7b5e, hemiIntensity: 1.5,
    exposure: 1.15, envIntensity: 1.0
  },
  midday: {
    sky: 0xa8cdf0, fog: 0xd6e4f0, fogNear: 320, fogFar: 9000,
    sunColor: 0xfff6e8, sunIntensity: 3.6, sunDir: [-0.3, 0.82, -0.48],
    hemiSky: 0xcfe2f7, hemiGround: 0xa89a84, hemiIntensity: 1.6,
    exposure: 1.0, envIntensity: 1.15
  },
  twilight: {
    sky: 0x4a668f, fog: 0x6a7593, fogNear: 200, fogFar: 5500,
    sunColor: 0xffb27a, sunIntensity: 1.8, sunDir: [-0.62, 0.3, -0.72],
    hemiSky: 0x6a86ac, hemiGround: 0x4a4154, hemiIntensity: 1.0,
    exposure: 1.25, envIntensity: 0.9
  },
  midnight: {
    sky: 0x0b1220, fog: 0x121a26, fogNear: 150, fogFar: 4200,
    sunColor: 0x9fb6d8, sunIntensity: 0.45, sunDir: [-0.35, 0.72, -0.6],
    hemiSky: 0x2b3d59, hemiGround: 0x161a22, hemiIntensity: 0.6,
    exposure: 1.4, envIntensity: 0.5
  }
};

const hexBytes = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/**
 * 程序化天空（32×16 equirect）：上＝天空頂、中＝地平線（霧色）、下＝地面反射色。
 * 純資料，不需要任何外部圖片或 CDN。
 */
function buildSkyTexture(preset) {
  const w = 32;
  const h = 16;
  const data = new Uint8Array(w * h * 4);
  const zenith = hexBytes(preset.sky);
  const horizon = hexBytes(preset.fog);
  const ground = hexBytes(preset.hemiGround);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = 天頂，1 = 天底
    let rgb;
    if (v < 0.5) {
      const t = Math.pow(v / 0.5, 1.5);
      rgb = zenith.map((c, i) => c + (horizon[i] - c) * t);
    } else {
      const t = Math.min(1, (v - 0.5) / 0.22);
      rgb = horizon.map((c, i) => c + (ground[i] - c) * t);
    }
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(rgb[0]);
      data[i + 1] = Math.round(rgb[1]);
      data[i + 2] = Math.round(rgb[2]);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * @param {THREE.Scene} scene
 * @param {{shadows?: boolean, renderer?: object, preset?: string}} options
 *        renderer 有傳就順便建立 PMREM 環境光（失敗會靜靜退回半球光）。
 */
export function createHongKongLighting(scene, { shadows = true, renderer = null, preset = 'golden' } = {}) {
  const hemi = new THREE.HemisphereLight(0xbcd4ee, 0x9a7b5e, 1.5);
  const sun = new THREE.DirectionalLight(0xffd9b0, 3.4);
  sun.castShadow = shadows;
  if (shadows) {
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    // 平行光的投影範圍跟著玩家走（見 update），所以只要覆蓋身邊 ~300 m 就夠
    sun.shadow.camera.left = -160;
    sun.shadow.camera.right = 160;
    sun.shadow.camera.top = 160;
    sun.shadow.camera.bottom = -160;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.35;
  }
  sun.target.position.set(0, 0, 0);
  scene.add(hemi, sun, sun.target);

  // 天空底色 + 霧：即使天空著色器出問題，畫面仍然有顏色而不是全黑
  scene.background = new THREE.Color(PRESETS[preset].sky);
  scene.fog = new THREE.Fog(PRESETS[preset].fog, PRESETS[preset].fogNear, PRESETS[preset].fogFar);

  let activeId = 'golden';
  const sunOffset = new THREE.Vector3();

  // --- 程序化 IBL -------------------------------------------------------------------------------
  let pmrem = null;
  let envTexture = null;
  let envError = null;
  let skyTexture = null;
  function buildEnvironment(p) {
    if (!renderer) return;
    try {
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      if (!skyTexture) skyTexture = buildSkyTexture(p);
      const next = pmrem.fromEquirectangular(skyTexture).texture;
      envTexture?.dispose?.();
      envTexture = next;
      scene.environment = envTexture;
      scene.environmentIntensity = p.envIntensity ?? 1;
      envError = null;
    } catch (error) {
      envError = error.message || String(error);
      scene.environment = null;
      // 退而求其次：冇 IBL 就加強半球光，至少唔會成個街景黑哂
      hemi.intensity = (PRESETS[activeId] || PRESETS.golden).hemiIntensity * 1.8;
      console.warn('[hk lighting] PMREM environment unavailable, boosting the hemisphere light instead', error);
    }
  }

  function applyPreset(id) {
    const p = PRESETS[id] || PRESETS.golden;
    activeId = PRESETS[id] ? id : 'golden';
    scene.background.setHex(p.sky);
    scene.fog.color.setHex(p.fog);
    scene.fog.near = p.fogNear;
    scene.fog.far = p.fogFar;
    sun.color.setHex(p.sunColor);
    sun.intensity = p.sunIntensity;
    sunOffset.set(...p.sunDir).normalize().multiplyScalar(420);
    hemi.color.setHex(p.hemiSky);
    hemi.groundColor.setHex(p.hemiGround);
    hemi.intensity = p.hemiIntensity;
    if (renderer) renderer.toneMappingExposure = p.exposure ?? 1;
    buildEnvironment(p);
    return activeId;
  }

  /** 每幀把平行光與它的投影範圍移到玩家附近，讓 300 m 內的建築／車輛都有影子。 */
  function update(focus) {
    if (!focus) return;
    sun.position.set(focus.x + sunOffset.x, sunOffset.y, focus.z + sunOffset.z);
    sun.target.position.set(focus.x, 0, focus.z);
    sun.target.updateMatrixWorld();
  }

  applyPreset(preset);
  return {
    applyPreset,
    update,
    sun,
    hemi,
    get activeId() { return activeId; },
    get envError() { return envError; },
    get hasEnvironment() { return Boolean(envTexture); },
    get shadows() { return shadows; },
    PRESETS
  };
}
