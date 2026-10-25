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
    assert.ok(context.calls.length > 400, `畫得太多／太少：${context.calls.length} 個繪畫指令`);
    const kinds = new Set(context.calls.map((c) => c.name));
    for (const need of ['fillRect', 'lineTo', 'arc', 'fillText', 'rotate']) {
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

test('地圖用真實海岸線：維港是水、中環／尖沙咀／旺角是陸地', { skip }, async () => {
  const HK = await import('../js/hk/config.js');
  const { onCoastLand } = HK;
  const ifc = HK.landmarkById('ifc');
  const clock = HK.landmarkById('clock-tower');
  const icc = HK.landmarkById('icc');
  const cplaza = HK.landmarkById('central-plaza');
  const harbour = { x: (HK.FERRY.from.x + HK.FERRY.to.x) / 2, z: (HK.FERRY.from.z + HK.FERRY.to.z) / 2 };
  const cases = [
    ['中環 國際金融中心', ifc.x, ifc.z, true],
    ['尖沙咀 鐘樓', clock.x, clock.z, true],
    ['西九 環球貿易廣場', icc.x, icc.z, true],
    ['銅鑼灣 中央廣場', cplaza.x, cplaza.z, true],
    ['旺角 彌敦道', 1030, -4100, true],
    ['維多利亞港（天星小輪航線中點）', harbour.x, harbour.z, false],
    ['香港島以南的海（東澳／蒲台一帶）', -824, 9080, false]
  ];
  for (const [name, x, z, expected] of cases) {
    assert.equal(onCoastLand(x, z), expected, `${name} (${x}, ${z}) 應該${expected ? '在陸地' : '在海'}`);
  }
  // 海岸線要有足夠細節（唔可以又變回兩個雲）
  assert.ok(HK.COAST.land.length >= 2, '要有香港島 + 九龍');
  const detail = HK.COAST.land.reduce((sum, ring) => sum + ring.length, 0);
  assert.ok(detail > 4000, `海岸線點數太少（${detail}），畫出來只會係一團雲`);
  assert.ok(HK.COAST.territory.length >= 20, '要有新界／離島輪廓做背景');
});

test('地圖：範圍包住所有樓宇同走廊，而且唔會過度放大', { skip }, async () => {
  const HK = await import('../js/hk/config.js');
  const { mapBounds } = await import('../js/hk/map.js');
  const bounds = mapBounds();
  for (const b of HK.BUILDINGS) {
    assert.ok(b.x > bounds.minX && b.x < bounds.maxX, '有樓宇在地圖範圍外');
    assert.ok(b.z > bounds.minZ && b.z < bounds.maxZ, '有樓宇在地圖範圍外');
  }
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  assert.ok(span < 14000, `地圖範圍太大（${span.toFixed(0)} m），市中心會縮到睇唔到`);
});

test('天星小輪航線全程在水上（唔會橫過九龍半島）', { skip }, async () => {
  const HK = await import('../js/hk/config.js');
  const { from, to } = HK.FERRY;
  let overLand = 0;
  for (let t = 0.1; t <= 0.9; t += 0.04) {
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    if (HK.onCoastLand(x, z)) overLand += 1;
  }
  assert.equal(overLand, 0, `航線有 ${overLand} 個取樣點在陸地上`);
  // 航線要有意義的長度（唔係同一個碼頭）
  assert.ok(Math.hypot(to.x - from.x, to.z - from.z) > 700, '兩個碼頭太近');
});

test('冇樓宇起在海中心（真實海岸線 vs 手繪種子陸地的差異已剔除）', { skip }, async () => {
  const HK = await import('../js/hk/config.js');
  const inWater = HK.BUILDINGS.filter((b) => !HK.onCoastLand(b.x, b.z));
  assert.equal(inWater.length, 0, `有 ${inWater.length} 棟樓在海中心`);
  assert.ok(HK.BUILDINGS.length > 1200, `樓宇太少：${HK.BUILDINGS.length}`);
});
