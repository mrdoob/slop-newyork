// tests/hk-map.test.mjs
// 地圖（js/hk/map.js）的行為測試：用 jsdom + 假 2D context 真正建立 DOM、真正畫一次、
// 真正按下 canvas。用戶問「地圖在哪裡?」，所以要有證據證明地圖真係畫得出、真係傳送到。
//
//   npm install jsdom --no-save && node --test tests/hk-map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const jsdomPath = new URL('../node_modules/jsdom/package.json', import.meta.url);
const skip = existsSync(jsdomPath) ? false : 'jsdom is not installed (npm install jsdom --no-save)';

/** 一個記錄所有繪畫指令的 2D context：可以斷言「真係畫過」。 */
function makeContext() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    calls,
    canvas: null,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => gradient,
    setLineDash() {},
    getLineDash: () => []
  };
  for (const name of [
    'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate', 'scale',
    'fillText', 'strokeText', 'clip', 'setTransform'
  ]) {
    ctx[name] = (...args) => calls.push({ name, args });
  }
  return ctx;
}

test('地圖：建立、開關、畫一次、點擊傳送', { skip }, async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:8086/?world=hk' });
  const saved = new Map();
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'getComputedStyle']) {
    saved.set(key, globalThis[key]);
    globalThis[key] = key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key];
  }
  try {
    // jsdom 冇 canvas 2D：換成會記錄指令的假 context。
    let context = null;
    dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
      if (type !== '2d') return null;
      if (!context) {
        context = makeContext();
        context.canvas = this;
      }
      return context;
    };

    const { createHongKongMap } = await import('../js/hk/map.js');
    const teleports = [];
    const map = createHongKongMap({ onTeleport: (x, z) => teleports.push({ x, z }), size: 320 });

    assert.ok(map.root.classList.contains('hk-map'), '地圖根節點要有 .hk-map');
    assert.equal(map.root.hidden, true, '地圖預設要收埋');
    assert.equal(map.isOpen, false);

    // 範圍要包住所有走廊與陸地
    for (const road of (await import('../js/hk/config.js')).ROADS) {
      for (const p of road.pts) {
        assert.ok(p.x >= map.bounds.minX - 0.001 && p.x <= map.bounds.maxX + 0.001, '走廊超出地圖東西範圍');
        assert.ok(p.z >= map.bounds.minZ - 0.001 && p.z <= map.bounds.maxZ + 0.001, '走廊超出地圖南北範圍');
      }
    }

    // 開啟 → 立即畫一次
    map.toggle();
    assert.equal(map.isOpen, true);
    assert.equal(map.root.hidden, false);
    assert.ok(context.calls.length > 200, `畫得太多／太少：${context.calls.length} 個繪畫指令`);
    const kinds = new Set(context.calls.map((c) => c.name));
    for (const need of ['clearRect', 'fillRect', 'lineTo', 'arc', 'fillText', 'rotate']) {
      assert.ok(kinds.has(need), `地圖冇用到 ${need}（應該係畫漏咗嘢）`);
    }

    // 玩家箭咀：update() 之後位置標籤要有香港地名同車速
    map.update({ x: 32, z: -217, heading: 0.4, speed: 12 }, [
      { x: 100, z: -300 },
      { x: -200, z: -600 }
    ]);
    const foot = map.root.querySelector('#hk-map-pos').textContent;
    assert.match(foot, /中環|金鐘|灣仔/, `位置標籤：${foot}`);
    assert.match(foot, /43 km\/h/, `車速標籤：${foot}`);

    // 點擊 = 傳送：取一個已知世界座標 → 它的地圖座標 → 按下去
    const target = { x: 320, z: -1500 };
    const m = map.projection.toMap(target.x, target.z);
    const canvas = map.root.querySelector('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 320, right: 320, bottom: 320 });
    canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: m.x, clientY: m.y, bubbles: true }));
    assert.equal(teleports.length, 1, '點地圖應該叫一次 onTeleport');
    assert.ok(Math.abs(teleports[0].x - target.x) < 3, `傳送 x：${teleports[0].x} vs ${target.x}`);
    assert.ok(Math.abs(teleports[0].z - target.z) < 3, `傳送 z：${teleports[0].z} vs ${target.z}`);

    // 關閉按鈕
    map.root.querySelector('.hk-map-close').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(map.isOpen, false);
    assert.equal(map.root.hidden, true);

    // 收埋之後 update() 唔應該再畫（省 CPU）
    const before = context.calls.length;
    map.update({ x: 0, z: 0, heading: 0, speed: 0 }, []);
    assert.equal(context.calls.length, before, '地圖收埋時唔應該重畫');
  } finally {
    for (const [key, value] of saved) globalThis[key] = value;
  }
});
