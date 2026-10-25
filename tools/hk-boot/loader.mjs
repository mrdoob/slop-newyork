// tools/hk-boot/loader.mjs
// 用 module.register() 掛上的 loader hook，模擬 index.html 的 importmap：
//   three         → node_modules/three/build/three.webgpu.js（與瀏覽器一樣：同一個模組實例）
//   three/webgpu  → 同一個檔案，但 WebGPURenderer 換成假的（無 GPU 環境）
//   three/addons/ → node_modules/three/examples/jsm/
//   three/tsl     → 香港開機路徑上「唔准」出現：那是 ?post=1 才會動態載入的東西，
//                   佢喺 dev 分支 CDN 上最易變，唔應該成為預設開機的必需品。
// three 套件根目錄（與 shim-three-webgpu.mjs 用同一個相對路徑）
const threeRoot = new URL('../../node_modules/three/', import.meta.url);
const webgpu = new URL('build/three.webgpu.js', threeRoot).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three/webgpu') {
    return { url: new URL('./shim-three-webgpu.mjs', import.meta.url).href, shortCircuit: true, format: 'module' };
  }
  if (specifier === 'three') {
    return { url: webgpu, shortCircuit: true, format: 'module' };
  }
  if (specifier.startsWith('three/addons/')) {
    return { url: new URL(`examples/jsm/${specifier.slice('three/addons/'.length)}`, threeRoot).href, shortCircuit: true };
  }
  if (specifier === 'three/tsl' && /\/js\/hk\//.test(context.parentURL || '')) {
    throw new Error(`香港開機路徑唔應該靜態 import three/tsl（來自 ${context.parentURL}）`);
  }
  return nextResolve(specifier, context);
}
