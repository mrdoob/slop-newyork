// tests/hk-csdi.test.mjs
// 地政總署 CSDI 真實樓宇資料的解析測試（用戶要求：用政府的真實建築物資料）。
//
// 這裡不依賴網絡：fetch 由測試注入（一個假的 fetchImpl），所以 CI/sandbox 都跑得。
// 測的是「真實輪廓 → 遊戲盒式樓宇」這條轉換是否正確，因為這是整條管線最容易出錯的地方：
// 經緯度投影、最小外接矩形、旋轉角、以及 TopHeight/BaseHeight 的高度語義。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const threePath = new URL('../node_modules/three/package.json', import.meta.url);
const skip = existsSync(threePath) ? false : 'three is not installed';

async function load() {
  const { installDomStub } = await import('../tools/dom-stub.mjs');
  installDomStub();
  const csdi = await import('../js/hk/csdi.js');
  const HK = await import('../js/hk/config.js');
  return { csdi, HK };
}

// 一個以中環為中心的 30 × 12 m 樓宇輪廓，整體旋轉 20°
function rotatedRectFeature({ lon0, lat0, w = 30, d = 12, rotDeg = 20, top = 60, base = 5, id = 'X1' }) {
  const cos = Math.cos((rotDeg * Math.PI) / 180);
  const sin = Math.sin((rotDeg * Math.PI) / 180);
  const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const ring = corners.map(([u, v]) => {
    const x = u * cos - v * sin;
    const z = u * sin + v * cos;
    return [lon0 + x * 1e-5 / 1.11, lat0 - z * 1e-5 / 1.11]; // 1e-5 度 ≈ 1.11 m（經度，香港緯度）
  });
  ring.push(ring[0]);
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { BuildingCSUID: id, TopHeight: top, BaseHeight: base }
  };
}

test('CSDI：經緯度投影同 config 的 toLatLon 互為反函數', { skip }, async () => {
  const { csdi, HK } = await load();
  for (const [x, z] of [[0, 0], [420, -880], [-1500, 2600]]) {
    const [lon, lat] = HK.toLatLon(x, z);
    const p = csdi.projectLonLat(lon, lat);
    assert.ok(Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6, `投影來回：(${x},${z}) → (${p.x.toFixed(3)},${p.z.toFixed(3)})`);
  }
});

test('CSDI：旋轉輪廓 → 最小外接矩形（闊、深、角度、中心都對）', { skip }, async () => {
  const { csdi } = await load();
  const ring = [[0, 0], [10, 0], [10, 4], [0, 4]].map(([x, z]) => ({ x, z }));
  const r = csdi.minAreaRect(ring);
  assert.ok(Math.abs(r.w - 10) < 1e-6 && Math.abs(r.d - 4) < 1e-6, `未旋轉矩形要是 10×4（實際 ${r.w.toFixed(2)}×${r.d.toFixed(2)}）`);
  assert.ok(Math.abs(r.x - 5) < 1e-6 && Math.abs(r.z - 2) < 1e-6, '中心要是 (5,2)');

  // 旋轉 30°：長邊仍要是 10，角度要是 30°
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const rot = [[-5, -2], [5, -2], [5, 2], [-5, 2]].map(([u, v]) => ({ x: u * c - v * s + 100, z: u * s + v * c + 50 }));
  const r2 = csdi.minAreaRect(rot);
  assert.ok(Math.abs(r2.w - 10) < 1e-6 && Math.abs(r2.d - 4) < 1e-6, `旋轉矩形尺寸（實際 ${r2.w.toFixed(2)}×${r2.d.toFixed(2)}）`);
  assert.ok(Math.abs(Math.abs(r2.rot) - Math.PI / 6) < 1e-6, `旋轉角要是 30°（實際 ${(r2.rot * 180 / Math.PI).toFixed(1)}°）`);
  assert.ok(Math.abs(r2.x - 100) < 1e-6 && Math.abs(r2.z - 50) < 1e-6, '旋轉後中心不變');
});

test('CSDI：真實 Feature → 遊戲樓宇（高度係 TopHeight − BaseHeight，摩天大廈會標成 tower）', { skip }, async () => {
  const { csdi, HK } = await load();
  const lon0 = HK.ORIGIN.lon + 0.01;
  const lat0 = HK.ORIGIN.lat - 0.01;
  const low = csdi.featureToBuilding(rotatedRectFeature({ lon0, lat0, top: 60, base: 5 }));
  assert.ok(low, '正常樓宇應該解析得到');
  assert.ok(Math.abs(low.h - 55) < 0.2, `高度要是 55 m（實際 ${low.h}）`);
  assert.ok(Math.abs(low.w - 30) < 2 && Math.abs(low.d - 12) < 2, `闊深要是 30×12（實際 ${low.w}×${low.d}）`);
  assert.equal(low.real, true, '要標記為真實資料');
  assert.equal(low.tower, 0, '55 m 唔係摩天大廈');

  const tower = csdi.featureToBuilding(rotatedRectFeature({ lon0, lat0, w: 40, d: 40, top: 420, base: 6, id: 'IFC' }));
  assert.ok(tower && tower.tower === 1, '400 m 以上要標成 tower（用帷幕牆材質）');
  assert.ok(Math.abs(tower.h - 414) < 0.2);

  // 冇高度、太細、冇幾何 → 一律丟棄（唔會出現 0 m 高的隱形樓）
  assert.equal(csdi.featureToBuilding(rotatedRectFeature({ lon0, lat0, top: NaN, base: NaN })), null, '冇高度要丟棄');
  assert.equal(csdi.featureToBuilding(rotatedRectFeature({ lon0, lat0, w: 2, d: 2, top: 30 })), null, '太細要丟棄');
  assert.equal(csdi.featureToBuilding({ type: 'Feature', geometry: null, properties: {} }), null, '冇幾何要丟棄');
  assert.equal(csdi.featureToBuilding(rotatedRectFeature({ lon0, lat0, top: 30, base: 29 })), null, '1 m 高要丟棄');
});

test('CSDI：查詢 URL 帶齊 bbox / 欄位 / 分頁，而且唔會 query 全港', { skip }, async () => {
  const { csdi, HK } = await load();
  const url = csdi.buildQueryUrl({ west: 114.15, south: 22.28, east: 114.17, north: 22.30 }, 1000);
  const u = new URL(url);
  assert.equal(u.searchParams.get('inSR'), '4326');
  assert.equal(u.searchParams.get('outSR'), '4326');
  assert.equal(u.searchParams.get('f'), 'geojson');
  assert.equal(u.searchParams.get('resultOffset'), '1000');
  assert.equal(u.searchParams.get('outFields'), 'TopHeight,BaseHeight');
  assert.equal(u.searchParams.get('geometry'), '114.150000,22.280000,114.170000,22.300000');

  const area = csdi.playAreaLonLat();
  assert.ok(area.east > area.west && area.north > area.south, '玩樂範圍 bbox 要有面積');
  assert.ok(area.east - area.west < 0.2, `bbox 唔應該包住全港（實際 ${(area.east - area.west).toFixed(3)}°）`);
  const cells = csdi.splitBBox(area, 3, 4);
  assert.equal(cells.length, 12, '切成 3×4 格');
  assert.ok(cells.every((c) => c.east <= area.east + 1e-9 && c.north <= area.north + 1e-9), '細格唔會超出 bbox');
  void HK;
});

test('CSDI：載入器（注入假 fetch）—— 成功會合併去重，失敗會誠實回報', { skip }, async () => {
  const { csdi, HK } = await load();
  const lon0 = HK.ORIGIN.lon + 0.008;
  const lat0 = HK.ORIGIN.lat - 0.008;
  const fc = { type: 'FeatureCollection', features: [rotatedRectFeature({ lon0, lat0, id: 'A' }), rotatedRectFeature({ lon0, lat0, id: 'A' })] };
  const calls = [];
  const okResult = await csdi.loadRealBuildings({
    bbox: { west: 114.15, south: 22.28, east: 114.17, north: 22.30 },
    cols: 1,
    rows: 1,
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => fc }; }
  });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.buildings.length, 1, '同一棟樓出現兩次只可以留一棟');
  assert.ok(calls[0].includes('/query?'), '要打去 CSDI 的 /query');

  const badResult = await csdi.loadRealBuildings({
    bbox: { west: 114.15, south: 22.28, east: 114.17, north: 22.30 },
    cols: 1,
    rows: 1,
    fetchImpl: async () => { throw new Error('CORS blocked'); }
  });
  assert.equal(badResult.ok, false);
  assert.match(badResult.reason, /CORS blocked/, '失敗原因要講清楚（畫面會退回種子樓宇）');
  assert.equal(badResult.buildings.length, 0);
});

test('CSDI：真·政府資料（tests/fixtures/csdi-central.geojson）解析得正確', { skip }, async () => {
  const { csdi, HK } = await load();
  const { readFileSync } = await import('node:fs');
  const fc = JSON.parse(readFileSync(new URL('./fixtures/csdi-central.geojson', import.meta.url), 'utf8'));
  const list = csdi.parseFeatureCollection(fc);
  assert.equal(list.length, 3, '三棟樓都要解析到');
  const byHeight = [...list].sort((a, b) => b.h - a.h);
  assert.ok(Math.abs(byHeight[0].h - 178.3) < 0.2, `最高那棟 182−3.7 = 178.3 m（實際 ${byHeight[0].h}）`);
  assert.equal(byHeight[0].tower, 1, '178 m 要標成 tower');
  for (const b of list) {
    assert.ok(b.w > 3 && b.w < 200 && b.d > 3 && b.d < 200, `真實樓宇尺寸要合理（${b.w}×${b.d}）`);
    assert.ok(Number.isFinite(b.rot), '要有旋轉角');
    // 中環的樓應該落在玩樂範圍之內（世界座標幾百米內，唔會變成幾萬米）
    const d = Math.hypot(b.x - HK.SPAWN.x, b.z - HK.SPAWN.z);
    assert.ok(d < 3000, `中環的樓離出生點應該 3 km 內（實際 ${d.toFixed(0)} m）`);
  }
});

test('CSDI：壓住車道的真實樓宇會被剔走，離開車道的會保留', { skip }, async () => {
  const { csdi, HK } = await load();
  const lanes = HK.buildLanes();
  // 揀一條車道上的點，放一棟 20×20 m 的樓 → 一定會壓路
  const lane = lanes.find((l) => l.len > 200);
  const p = HK.poseAt(lane, lane.len * 0.5);
  const onRoad = { x: p.x, z: p.z, w: 20, d: 20, h: 60, rot: 0.3, tower: 0 };
  // 離車道 60 m 遠（沿法線）→ 一定唔壓路
  const nx = p.dz;
  const nz = -p.dx;
  const away = { x: p.x + nx * 60, z: p.z + nz * 60, w: 20, d: 20, h: 60, rot: 0.3, tower: 0 };

  const { kept, dropped } = csdi.dropBuildingsOnRoad([onRoad, away], { lanes });
  assert.equal(dropped.length, 1, '壓路的樓要剔走');
  assert.equal(kept.length, 1, '離開車道的樓要保留');
  assert.equal(kept[0], away);
});
