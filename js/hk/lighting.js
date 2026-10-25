import * as THREE from 'three/webgpu';

// js/hk/lighting.js
// 香港世界自帶的照明：半球光 + 可投影的平行光 + 明確的天空底色與霧。
//
// 為什麼不直接用 lighting.js（紐約那套 Preetham SkyMesh + PMREM IBL + SunLight 2-cascade）？
// 那套依賴 three.js dev 分支的 SkyMesh / SunLight / ClusteredLighting 與渲染器內部節點註冊，
// 任何一環在瀏覽器裡不配合，畫面就會全黑而且沒有錯誤訊息。香港世界先用「笨但一定亮」的方案，
// 確認有畫面之後，可以再用 ?sky=1 切回完整大氣天空做對比。
//
// 全部參數集中在 PRESETS，跟 post-processing.js 的 LOOKS 對應同一個 id。

const PRESETS = {
  golden: {
    sky: 0x8fb2d8, fog: 0xdcc5ae, fogNear: 260, fogFar: 7000,
    sunColor: 0xffd2a1, sunIntensity: 2.6, sunDir: [-0.42, 0.62, -0.66],
    hemiSky: 0x9fc0e8, hemiGround: 0x8a6b52, hemiIntensity: 1.15
  },
  midday: {
    sky: 0x9dc4ea, fog: 0xcfe0ef, fogNear: 320, fogFar: 9000,
    sunColor: 0xfff6e8, sunIntensity: 3.2, sunDir: [-0.3, 0.82, -0.48],
    hemiSky: 0xbcd6f2, hemiGround: 0x9a8f7c, hemiIntensity: 1.25
  },
  twilight: {
    sky: 0x2f4a6b, fog: 0x40506b, fogNear: 200, fogFar: 5500,
    sunColor: 0xffb27a, sunIntensity: 1.1, sunDir: [-0.62, 0.3, -0.72],
    hemiSky: 0x54739c, hemiGround: 0x40384a, hemiIntensity: 0.75
  },
  midnight: {
    sky: 0x060a12, fog: 0x0a1018, fogNear: 150, fogFar: 4200,
    sunColor: 0x9fb6d8, sunIntensity: 0.28, sunDir: [-0.35, 0.72, -0.6],
    hemiSky: 0x24354d, hemiGround: 0x14161c, hemiIntensity: 0.45
  }
};

export function createHongKongLighting(scene, { shadows = true } = {}) {
  const hemi = new THREE.HemisphereLight(PRESETS.golden.hemiSky, PRESETS.golden.hemiGround, PRESETS.golden.hemiIntensity);
  const sun = new THREE.DirectionalLight(PRESETS.golden.sunColor, PRESETS.golden.sunIntensity);
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
  scene.background = new THREE.Color(PRESETS.golden.sky);
  scene.fog = new THREE.Fog(PRESETS.golden.fog, PRESETS.golden.fogNear, PRESETS.golden.fogFar);

  let activeId = 'golden';
  const sunOffset = new THREE.Vector3();

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
    return activeId;
  }

  /** 每幀把平行光與它的投影範圍移到玩家附近，讓 300 m 內的建築／車輛都有影子。 */
  function update(focus) {
    if (!focus) return;
    sun.position.set(focus.x + sunOffset.x, sunOffset.y, focus.z + sunOffset.z);
    sun.target.position.set(focus.x, 0, focus.z);
    sun.target.updateMatrixWorld();
  }

  applyPreset('golden');
  return { applyPreset, update, sun, hemi, get activeId() { return activeId; }, PRESETS };
}
