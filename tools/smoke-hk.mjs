// tools/smoke-hk.mjs — 在香港世界裡真正建一次城（用真的 three.js，但不需要 GPU／瀏覽器）。
//
// usage:
//   npm install three@dev --no-save        # 只需一次，不會寫進 package.json
//   node tools/smoke-hk.mjs
//
// 這個工具存在的理由：我（agent）的沙箱沒有瀏覽器，但「建城階段有沒有 throw、有沒有無限迴圈、
// 幾何數量對不對」全部可以在 Node 裡驗證。真正的 WebGPU 繪製仍然要人開瀏覽器。
//
// 退出碼 0 = 通過；1 = 數量不符 / 幾何出現 NaN / 建城或每幀太慢 / 任何例外。

const t0 = performance.now();

// --- 建構材質時會用到的瀏覽器 API（canvas 貼圖、車牌、招牌）--------------------------------------
const ctx2d = new Proxy({}, {
  get(target, key) {
    if (key in target) return target[key];
    if (key === 'measureText') return () => ({ width: 12 });
    if (key === 'getImageData' || key === 'createImageData') {
      return (a, b, c, d) => {
        const w = key === 'getImageData' ? c : a;
        const h = key === 'getImageData' ? d : b;
        return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h };
      };
    }
    if (/^create(Linear|Radial|Conic)Gradient$/.test(key)) return () => ({ addColorStop() {} });
    if (key === 'createPattern') return () => ({});
    return () => undefined;
  },
  set(target, key, value) {
    target[key] = value;
    return true;
  }
});
const makeCanvas = () => ({ width: 256, height: 64, style: {}, getContext: () => ctx2d, toDataURL: () => 'data:,' });
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild() {}, setAttribute() {} }),
  createElementNS: () => makeCanvas(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { toggle() {}, add() {}, remove() {} }, dataset: {} },
  addEventListener() {}
};
globalThis.window = {
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 720,
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} })
};
globalThis.self = globalThis;

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

let THREE;
try {
  THREE = await import('three/webgpu');
} catch (error) {
  fail(`cannot import three/webgpu — run: npm install three@dev --no-save\n  (${error.message})`);
}

const { buildHongKongCity } = await import('../js/hk/city.js');
const { createHongKongTraffic } = await import('../js/hk/traffic.js');
const { createPlayer, ChaseCamera } = await import('../js/hk/drive.js');
const HK = await import('../js/hk/config.js');

// --- 建城 ------------------------------------------------------------------------------------------
const scene = new THREE.Scene();
const buildStart = performance.now();
const phases = [];
const city = await buildHongKongCity(scene, { onProgress: async (label) => { phases.push([label, Math.round(performance.now() - buildStart)]); } });
const cityMs = performance.now() - buildStart;

const trafficStart = performance.now();
const traffic = createHongKongTraffic(scene);
const trafficMs = performance.now() - trafficStart;

const player = createPlayer(scene, city.colliders);

// --- 統計 ------------------------------------------------------------------------------------------
let meshes = 0, instanced = 0, instances = 0, triangles = 0, lights = 0, nanGeometry = 0;
scene.traverse((o) => {
  if (o.isLight) lights++;
  if (!o.isMesh) return;
  meshes++;
  if (o.isInstancedMesh) { instanced++; instances += o.count; }
  const g = o.geometry;
  if (!g || !g.attributes?.position) return;
  const attr = g.attributes.position;
  const arr = attr.array;
  for (let i = 0; i < arr.length; i += 997) if (!Number.isFinite(arr[i])) { nanGeometry++; break; }
  const n = g.index ? g.index.count : attr.count;
  triangles += Math.floor(n / 3) * (o.isInstancedMesh ? o.count : 1);
});

// --- 跑幾幀（含車道回收）---------------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.35, 40000);
const chase = new ChaseCamera(camera, { addEventListener() {}, setPointerCapture() {} });
const frameStart = performance.now();
const FRAMES = 180;
for (let i = 0; i < FRAMES; i++) {
  player.state.speed = 12;
  player.update(1 / 60);
  chase.update(1 / 60, player.state);
  traffic.update(1 / 60, camera.position);
}
const frameMs = (performance.now() - frameStart) / FRAMES;

// --- 報告與斷言 ------------------------------------------------------------------------------------
const report = {
  phases: phases.map(([l, t]) => `${l.trim()} ${t}ms`),
  cityMs: Math.round(cityMs),
  trafficMs: Math.round(trafficMs),
  frameMs: +frameMs.toFixed(3),
  triangles,
  meshes,
  instancedMeshes: instanced,
  instances,
  lights,
  counts: city.counts,
  traffic: traffic.counts,
  playerAt: [Math.round(player.state.x), Math.round(player.state.z)],
  playerDistrict: HK.districtAt(player.state.x, player.state.z).zh
};
console.log(JSON.stringify(report, null, 1));

if (nanGeometry) fail(`${nanGeometry} geometries contain NaN positions`);
if (city.counts.buildings < 1000) fail(`only ${city.counts.buildings} buildings`);
if (traffic.counts.cars !== 96) fail(`expected 96 AI cars, got ${traffic.counts.cars}`);
if (traffic.counts.lanes < 60) fail(`only ${traffic.counts.lanes} lanes`);
if (triangles < 50000) fail(`scene is suspiciously light: ${triangles} triangles`);
if (!Number.isFinite(player.state.x) || !Number.isFinite(player.state.z)) fail('player position went non-finite');
if (cityMs > 5000) fail(`city build took ${Math.round(cityMs)} ms — too slow`);
if (frameMs > 8) fail(`simulation cost ${frameMs.toFixed(2)} ms/frame — too slow for 60 fps`);
console.log(`✓ Hong Kong builds and simulates headlessly (${Math.round(performance.now() - t0)} ms total)`);
