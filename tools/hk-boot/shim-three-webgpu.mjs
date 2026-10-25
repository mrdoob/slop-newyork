// tools/hk-boot/shim-three-webgpu.mjs
// 給「無 GPU 環境」用的 three/webgpu：其餘全部用真正的 three.js，
// 只有 WebGPURenderer 換成一個記錄呼叫的假物件。
// `export *` 唔會再匯出本地已宣告嘅同名符號，所以 WebGPURenderer 會被覆蓋。
export * from '../../node_modules/three/build/three.webgpu.js';

export class WebGPURenderer {
  constructor(params = {}) {
    this.params = params;
    this.domElement = globalThis.document.createElement('canvas');
    this.domElement.width = 1280;
    this.domElement.height = 720;
    this.shadowMap = { enabled: false };
    this.toneMapping = null;
    this.toneMappingExposure = 1;
    this.info = { render: { drawCalls: 0, triangles: 0, frame: 0 }, memory: {} };
    this.backend = { isWebGPUBackend: false };
    this.renders = [];
    this.compiled = 0;
    this.loop = null;
    this.initCalls = 0;
  }
  async init() { this.initCalls++; return this; }
  setPixelRatio() {}
  setSize(w, h) { this.domElement.width = w; this.domElement.height = h; }
  render(scene, camera) {
    this.renders.push({ scene, camera, at: Date.now() });
    this.info.render.frame++;
    this.info.render.drawCalls = scene.children.length;
    this.info.render.triangles = scene.children.length * 12;
  }
  async compileAsync() { this.compiled++; }
  setRenderTarget(target) { this.renderTarget = target; }
  async readRenderTargetPixelsAsync() { return new Uint8Array(4); }
  setAnimationLoop(fn) {
    this.loop = fn;
    if (!fn) return;
    // 模擬 8 幀（每幀 16 ms），令 setAnimationLoop 內部的程式碼真的被執行
    let t = globalThis.performance.now();
    let pending = 0;
    for (let i = 0; i < 8; i++) {
      pending++;
      const at = t + 16;
      t = at;
      globalThis.setTimeout(() => { if (this.loop === fn) { try { fn(at); } catch (e) { globalThis.__hkLoopError = e; } } }, 0);
    }
    this.pendingFrames = pending;
  }
  dispose() {}
}
