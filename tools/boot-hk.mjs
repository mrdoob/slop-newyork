#!/usr/bin/env node
// tools/boot-hk.mjs
// 真正行一次香港的開機流程（index.html 的 DOM + 真 three.js 幾何 + 假 WebGPURenderer）。
//
//   node --import ./tools/hk-boot/register.mjs tools/boot-hk.mjs
//
// 為什麼要有這個工具：sandbox 冇 GPU、冇瀏覽器，而瀏覽器一旦在 import 階段拋錯，
// 畫面只會靜靜停在 loading。這個 harness 用 jsdom 載入真正的 index.html，
// 然後照 index.html 的順序（applyBranding → import hk/main.js → startHongKong）行一次，
// 把「會唔會成功入到香港世界」變成一個 exit code。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);

// --- 1. 用真的 index.html 建 DOM（不執行任何 script） -------------------------------
const html = readFileSync(new URL('index.html', root), 'utf8');
// 可以傳入 search 字串，例如：node … tools/boot-hk.mjs '?world=hk&test=1'
const search = process.argv[2] || '?world=hk&debug=1';
const dom = new JSDOM(html, {
  url: `http://127.0.0.1:8082/${search}`,
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

// jsdom 冇 canvas 2D context。這裡給一個「乜都收、乜都唔做」的 2D context：
// 香港的車牌、路牌、招牌都用 canvas 畫紋理，但無 GPU 的環境只需要唔拋錯。
function make2dContext(canvas) {
  const gradient = { addColorStop() {} };
  const base = {
    canvas,
    measureText: (text) => ({ width: String(text).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => gradient,
    getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    drawImage() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      const value = target[prop];
      if (value !== undefined) return value;
      // 任何未實作的方法都當成 no-op；任何屬性是可寫的
      return target[prop] = () => undefined;
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
}
window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (!this.__ctx) this.__ctx = make2dContext(this);
  return this.__ctx;
};
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ width: 1280, height: 720, left: 0, top: 0 });

const bootFailures = [];
window.__slopBootFail = (title, detail) => {
  bootFailures.push({ title, detail: detail && (detail.stack || detail.message || String(detail)) });
};

for (const key of ['window', 'document', 'location', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Event', 'CustomEvent', 'URLSearchParams', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser']) {
  const value = key === 'window' ? window : window[key];
  if (value === undefined) continue;
  try { globalThis[key] = value; } catch { /* 唯讀的 global（例如 navigator）：用 defineProperty */ Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
}
globalThis.self = window;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(globalThis.performance.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
globalThis.dispatchEvent = window.dispatchEvent.bind(window);
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
window.innerWidth = 1280;
window.innerHeight = 720;

// --- 2. 照 index.html 的順序行 ------------------------------------------------------
const { getWorldId, getWorld, applyBranding } = await import(new URL('js/world.js', root).href);
const worldId = getWorldId();
assert.equal(worldId, 'hk', '?world=hk 應該解析成 hk');
applyBranding(getWorld(worldId));
assert.equal(window.document.title, 'Slop Hong Kong', '品牌要立即換成香港');
assert.equal(window.document.querySelector('.loader-title').textContent, 'Slop Hong Kong');

const { startHongKong } = await import(new URL('js/hk/main.js', root).href);
await startHongKong();

// --- 3. 驗收：模擬層 + DOM + 繪製呼叫 ------------------------------------------------
const doc = window.document;
const report = { worldId, bootFailures, checks: [] };
const check = (name, fn) => {
  fn();
  report.checks.push(name);
};

check('冇觸發開機錯誤卡', () => assert.equal(bootFailures.length, 0, JSON.stringify(bootFailures, null, 2)));
check('loading overlay 已隱藏', () => assert.ok(doc.getElementById('loading-overlay').classList.contains('hidden')));
check('香港 HUD 已建立', () => assert.ok(doc.getElementById('hk-hud'), '#hk-hud 不存在'));
check('HUD 顯示香港品牌', () => assert.match(doc.querySelector('#hk-hud h1').textContent, /Slop Hong Kong/));
check('body 標記為 hk（紐約 HUD 靠這個隱藏）', () => assert.equal(doc.body.dataset.world, 'hk'));
check('位置標籤係香港地名', () => {
  const text = doc.getElementById('hk-location').textContent;
  assert.ok(/中環|金鐘|灣仔|銅鑼灣|尖沙咀|旺角|上環|西環|北角|油麻地|佐敦|深水埗|美孚|紅磡|天后/.test(text), `位置標籤：${text}`);
});
const hk = globalThis.__slopHK;
check('__slopHK 除錯物件已掛上', () => assert.ok(hk && hk.renderer && hk.city && hk.traffic));
check('城市有樓宇／地標', () => {
  assert.ok(hk.city.counts.buildings > 500, `buildings=${hk.city.counts.buildings}`);
  assert.ok(hk.city.counts.landmarks > 3, `landmarks=${hk.city.counts.landmarks}`);
});
check('靠左行駛（left-hand traffic）', () => {
  assert.equal(hk.HK.WORLD.driveSide, 'left');
  assert.ok(hk.traffic.counts.cars > 50, `cars=${hk.traffic.counts.cars}`);
  assert.ok(hk.traffic.counts.lanes > 50, `lanes=${hk.traffic.counts.lanes}`);
});
check('renderer.render 真係被呼叫', () => assert.ok(hk.renderer.renders.length >= 1, '一次 render 都冇'));
check('renderer.init 只行一次', () => assert.equal(hk.renderer.initCalls, 1));
check('場景有燈同天空色', () => {
  const lights = hk.scene.children.filter((o) => o.isLight);
  assert.ok(lights.length >= 2, `lights=${lights.length}`);
  assert.ok(hk.scene.background, 'scene.background 必須存在，唔係就成個畫面黑');
});
// 讓假 renderer 的 8 幀（setTimeout 排程）真的跑完；
// ?test=1 的離屏讀回是 1.5 秒後才執行，所以要多等一會，確保它真的跑過而唔會拋錯
await new Promise((resolve) => setTimeout(resolve, search.includes('test=1') ? 1900 : 150));
assert.equal(globalThis.__hkLoopError, undefined, `動畫迴圈拋錯：${globalThis.__hkLoopError && globalThis.__hkLoopError.stack}`);
assert.ok(hk.renderer.renders.length >= 2, `動畫迴圈只 render 了 ${hk.renderer.renders.length} 次`);
assert.ok(Number(doc.getElementById('hk-speed').textContent) >= 0, '速度表要係數字');
check('診斷面板：canvas 尺寸、最上層元素、GPU 錯誤都有報告', () => {
  const text = doc.querySelector('.hk-diagnostics').textContent;
  for (const needle of ['canvas', 'in DOM', '最上層', 'draw calls', 'background #']) {
    assert.ok(text.includes(needle), `診斷面板缺少「${needle}」：\n${text}`);
  }
});
check('GPU 環境有被報告（真瀏覽器會顯示 adapter，Node 會顯示冇 WebGPU）', () => {
  const text = doc.querySelector('.hk-diagnostics').textContent;
  assert.match(text, /adapter|navigator\.gpu/);
});
check('?test=1 的離屏讀回真係執行過（唔會拋錯）', () => {
  const text = doc.querySelector('.hk-diagnostics').textContent;
  if (search.includes('test=1')) {
    assert.doesNotMatch(text, /未執行/, `離屏讀回冇執行：\n${text}`);
    assert.doesNotMatch(text, /readback 失敗|失敗（/, `離屏讀回拋錯：\n${text}`);
  }
});
check('?test=1 會加一個唔受燈光影響的紅色探針方塊', () => {
  const probe = hk.scene.getObjectByName('hkTestProbe');
  if (search.includes('test=1')) {
    assert.ok(probe, 'test=1 但冇探針');
    assert.equal(probe.material.type, 'MeshBasicMaterial');
    assert.equal(probe.material.depthTest, false);
    assert.equal(hk.testPattern, true);
  } else {
    assert.equal(probe, undefined, '冇 test=1 就唔應該有探針');
  }
});
check('診斷面板有內容（?debug=1）', () => {
  const diag = doc.querySelector('.hk-diagnostics');
  assert.ok(diag, '.hk-diagnostics 唔存在');
  assert.ok(diag.textContent.includes('draw calls'), `診斷面板內容：${diag.textContent}`);
  assert.ok(diag.textContent.includes('direct render'), '預設應該係直接繪製，唔係後處理');
});

console.log('__BOOT_REPORT__ ' + JSON.stringify({
  world: worldId,
  title: doc.title,
  hud: doc.querySelector('#hk-hud h1').textContent.trim(),
  location: doc.getElementById('hk-location').textContent,
  speed: doc.getElementById('hk-speed').textContent,
  frames: hk.renderer.renders.length,
  compiled: hk.renderer.compiled,
  search,
  testPattern: hk.testPattern,
  gpuErrors: hk.gpuErrors.length,
  buildings: hk.city.counts.buildings,
  landmarks: hk.city.counts.landmarks,
  cars: hk.traffic.counts.cars,
  checks: report.checks
}));
console.log('✓ 香港世界可以開機（DOM + 幾何 + 車流 + 繪製呼叫）');
