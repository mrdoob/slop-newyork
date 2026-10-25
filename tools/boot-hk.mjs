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
import { BUILD } from '../js/hk/build.js';

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
  // 每次呼叫任何 2D 指令都 +1：測試可以用來證明「地圖真係畫過嘢」。
  canvas.__ctx2dCalls = 0;
  const proxy = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      let value = target[prop];
      if (value === undefined) value = target[prop] = () => undefined; // 未實作的方法當 no-op
      if (typeof value !== 'function') return value;
      return (...args) => {
        canvas.__ctx2dCalls += 1;
        return value.apply(target, args);
      };
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
  return proxy;
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
check('HUD 左上角見到建置版本（唔使開診斷面板）', () => {
  const badge = doc.querySelector('#hk-hud .hk-build');
  assert.ok(badge, '#hk-hud .hk-build 唔存在：用戶就係見唔到版本');
  assert.match(badge.textContent, /^v\d{4}-\d{2}-\d{2}\.\d+$/, `版本字串：${badge.textContent}`);
  assert.equal(badge.textContent, 'v' + BUILD, 'HUD 版本要同 js/hk/build.js 一致');
});
check('地圖存在，而且 M 鍵真係開關得到（用戶問：地圖在哪裡?）', () => {
  const map = globalThis.__slopHK?.map;
  assert.ok(map, '__slopHK.map 唔存在');
  const root = doc.querySelector('.hk-map');
  assert.ok(root, 'DOM 搵唔到 .hk-map');
  assert.equal(root.hidden, true, '地圖預設要收埋');
  assert.ok(doc.querySelector('#hk-hud .hk-map-toggle'), 'HUD 要有「地圖」按鈕');
  const key = (code) => new window.KeyboardEvent('keydown', { code, bubbles: true });
  window.dispatchEvent(key('KeyM'));
  assert.equal(map.isOpen, true, '按 M 應該開地圖');
  assert.equal(root.hidden, false);
  window.dispatchEvent(key('KeyM'));
  assert.equal(map.isOpen, false, '再按 M 應該收埋');
});
check('地圖畫得出（真 canvas 2D 指令），而且點擊會傳送', () => {
  const map = globalThis.__slopHK.map;
  map.setOpen(true);
  const calls = doc.querySelector('.hk-map canvas').__ctx2dCalls;
  assert.ok(calls > 150, `地圖只畫了 ${calls} 條 2D 指令`);
  const target = { x: 320, z: -1500 };
  const m = map.projection.toMap(target.x, target.z);
  const canvas = doc.querySelector('.hk-map canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height, right: canvas.width, bottom: canvas.height });
  canvas.dispatchEvent(new window.MouseEvent('click', { clientX: m.x, clientY: m.y, bubbles: true }));
  const player = globalThis.__slopHK.player.state;
  assert.ok(Math.abs(player.x - target.x) < 3, `點地圖之後玩家 x = ${player.x}`);
  assert.ok(Math.abs(player.z - target.z) < 3, `點地圖之後玩家 z = ${player.z}`);
  map.setOpen(false);
  globalThis.__slopHK.teleportTo(32, -217); // 還原，唔好影響之後的檢查
  assert.ok(Math.abs(globalThis.__slopHK.player.state.x - 32) < 1, 'teleportTo 應該把車放回中環');
});
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
check('照明有 IBL 環境光（MV 玻璃唔會變全黑）', () => {
  assert.ok(hk.lighting?.hasEnvironment, 'PMREM 環境光冇建立成功 —— 玻璃帷幕會全黑');
  assert.equal(hk.lighting.activeId, 'golden');
});
check('場景有燈同天空色', () => {
  const lights = hk.scene.children.filter((o) => o.isLight);
  assert.ok(lights.length >= 2, `lights=${lights.length}`);
  assert.ok(hk.scene.background, 'scene.background 必須存在，唔係就成個畫面黑');
});
// 讓假 renderer 的 8 幀（setTimeout 排程）真的跑完
await new Promise((resolve) => setTimeout(resolve, 150));
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
check('舊快取模組（缺 collidePlayer）唔會炸死世界', () => {
  // 真實事故：main.js 呼叫 traffic.collidePlayer()，但快取中的舊 traffic.js 冇這個方法 →
  // 第一幀 throw → 全屏錯誤卡蓋住整個世界。現在應該是「世界繼續行」。
  assert.equal(typeof hk.traffic.collidePlayer, 'function', 'traffic 應該有 collidePlayer');
  const saved = hk.traffic.collidePlayer;
  delete hk.traffic.collidePlayer;
  try {
    const loop = hk.renderer.loop;
    assert.equal(typeof loop, 'function', '動畫迴圈應該存在');
    const t = globalThis.performance.now();
    loop(t + 1000);
    loop(t + 1016);
  } finally {
    hk.traffic.collidePlayer = saved;
  }
  assert.equal(bootFailures.length, 0, '缺少一個方法就觸發了全屏開機錯誤卡');
  assert.equal(window.document.querySelector('.hk-black-warning'), null, '唔應該出現紅色提示條');
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
