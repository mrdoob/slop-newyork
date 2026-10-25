import * as HK from './config.js';

// js/hk/csdi.js
// 真實樓宇輪廓：香港地政總署 CSDI「Building」圖層（landsd_rcd_1637211194312_35158）。
//
// 為什麼要這一步：我們的樓宇一直是「沿街種出來的方塊」—— 位置、闊度、高度都是估的。
// 地政總署有全港約 34 萬棟樓的**真實輪廓 + 真實高度**（TopHeight / BaseHeight，米，主水平基準），
// 而 3D 視覺化地圖 https://3d.map.gov.hk/ 的建築量體正是用同一套資料做出來的。
// CSDI 的 ArcGIS REST 端點可以直接查 GeoJSON，所以我們在瀏覽器裡按地區 bbox 拉資料，
// 每個輪廓取**最小外接旋轉矩形**（OBB）→ 就是遊戲現有的盒式樓宇管線（x, z, w, d, h, rot），
// 不需要改渲染器，但位置／闊度／高度／街區方位角全部變成真實的。
//
// 誠實聲明：
//   · 3d.map.gov.hk 的 3D Tiles（.b3dm）是獨立格式，全港幾百 GB，本專案**沒有**下載；
//     我們拉的是同一來源的 2D 輪廓 + 高度，再自己擠出成量體。
//   · 若 CSDI 離線／跨域被封（CORS），會自動退回原本的種子樓宇，畫面不會爛。

export const CSDI = {
  service: 'https://portal.csdi.gov.hk/server/rest/services/common/landsd_rcd_1637211194312_35158/MapServer/0',
  outFields: 'TopHeight,BaseHeight',
  pageSize: 1000,
  maxPages: 12
};

const D2R = Math.PI / 180;

/** 經緯度 → 世界座標（與 config.js 的 toLatLon 互為反函數）。 */
export function projectLonLat(lon, lat, frame = { originLon: HK.ORIGIN.lon, originLat: HK.ORIGIN.lat, mPerDegLon: HK.M_PER_DEG_LON, mPerDegLat: HK.M_PER_DEG_LAT }) {
  return { x: (lon - frame.originLon) * frame.mPerDegLon, z: (frame.originLat - lat) * frame.mPerDegLat };
}

/** 由環（rings[0]）算出最小面積外接旋轉矩形：{ x, z, w, d, rot, area }。 */
export function minAreaRect(ring) {
  if (!ring || ring.length < 3) return null;
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uz = dz / len;
    // 以這條邊為 u 軸，另一條為 v 軸，投影所有點
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of ring) {
      const u = p.x * ux + p.z * uz;
      const v = -p.x * uz + p.z * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const d = maxV - minV;
    const area = w * d;
    if (!best || area < best.area) {
      // 矩形中心：u 軸回到世界座標
      const uc = (minU + maxU) / 2;
      const vc = (minV + maxV) / 2;
      const x = uc * ux - vc * uz;
      const z = uc * uz + vc * ux;
      // 讓 w 永遠是長邊，方便與遊戲的「沿街長邊」對齊
      const swap = d > w;
      best = {
        x,
        z,
        w: swap ? d : w,
        d: swap ? w : d,
        // 遊戲的樓宇旋轉角約定：本地 +X 軸在世界座標的方向 = (cos rot, sin rot)（見 city.js 的 ry: -b.rot
        // 與 drive.js 的 OBB 反旋轉）。所以這裡直接用 atan2(uz, ux)，唔係車頭用的 atan2(dx, dz)。
        rot: Math.atan2(uz, ux) + (swap ? Math.PI / 2 : 0),
        area
      };
    }
  }
  return best;
}

/** ArcGIS GeoJSON Feature → 遊戲用的樓宇記錄；不合格（太矮／太細／冇高度）就 return null。 */
export function featureToBuilding(feature, { project = (lon, lat) => projectLonLat(lon, lat) } = {}) {
  const geom = feature?.geometry;
  if (!geom) return null;
  const ring = geom.type === 'Polygon' ? geom.coordinates?.[0] : geom.coordinates?.[0]?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const pts = ring.map(([lon, lat]) => project(lon, lat));
  const rect = minAreaRect(pts);
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.z)) return null;

  const props = feature.properties ?? {};
  const top = Number(props.TopHeight);
  const base = Number(props.BaseHeight);
  const height = Number.isFinite(top) && Number.isFinite(base) ? top - base : Number.isFinite(top) ? top : NaN;
  if (!Number.isFinite(height) || height < 2.5 || height > 620) return null;
  if (rect.area < 12) return null; // 12 m² 以下大概係變電站／樓梯屋，畫出嚟只會變雜訊
  if (rect.w > 400 || rect.d > 400) return null;

  return {
    x: Math.round(rect.x * 100) / 100,
    z: Math.round(rect.z * 100) / 100,
    w: Math.round(Math.min(rect.w, 400) * 100) / 100,
    d: Math.round(Math.min(rect.d, 400) * 100) / 100,
    h: Math.round(height * 10) / 10,
    rot: Math.round(rect.rot * 1000) / 1000,
    tower: height >= 120 ? 1 : 0,
    real: true,
    csdi: props.BuildingCSUID ?? null
  };
}

/** GeoJSON FeatureCollection → 樓宇陣列（會去掉重複的 CSUID）。 */
export function parseFeatureCollection(fc, opts = {}) {
  const out = [];
  const seen = new Set();
  for (const f of fc?.features ?? []) {
    const b = featureToBuilding(f, opts);
    if (!b) continue;
    const id = b.csdi ?? `${b.x},${b.z},${b.w}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(b);
  }
  return out;
}

/** 玩樂範圍（走廊 + 種子樓宇的外框）→ 經緯度 bbox。 */
export function playAreaLonLat(roads = HK.ROADS, pad = 320) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const r of roads) {
    for (const p of r.pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  const lon = (x) => HK.toLatLon(x, 0)[0];
  const lat = (z) => HK.toLatLon(0, z)[1];
  return {
    west: lon(minX - pad),
    south: lat(maxZ + pad), // z 向南增加 → lat 減少
    east: lon(maxX + pad),
    north: lat(minZ - pad)
  };
}

/** 把 bbox 切成 n×n 的細格（每次查詢太少／太多都會慢，1000 筆一頁最穩）。 */
export function splitBBox(bbox, cols = 3, rows = 4) {
  const out = [];
  const dx = (bbox.east - bbox.west) / cols;
  const dy = (bbox.north - bbox.south) / rows;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      out.push({
        west: bbox.west + i * dx,
        south: bbox.south + j * dy,
        east: bbox.west + (i + 1) * dx,
        north: bbox.south + (j + 1) * dy
      });
    }
  }
  return out;
}

/** 組一條 ArcGIS REST 查詢 URL（純函數，方便測試）。 */
export function buildQueryUrl(bbox, offset = 0, service = CSDI.service) {
  const geometry = [bbox.west, bbox.south, bbox.east, bbox.north].map((v) => v.toFixed(6)).join(',');
  const params = new URLSearchParams({
    where: '1=1',
    geometry,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: CSDI.outFields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '7',
    maxAllowableOffset: '0.00002',
    resultOffset: String(offset),
    resultRecordCount: String(CSDI.pageSize),
    f: 'geojson'
  });
  return `${service}/query?${params.toString()}`;
}

/**
 * 把「壓住行車道」的樓剔走。
 *
 * 為什麼需要：政府輪廓是真實的，但我們的道路是**加寬的近似線**（走廊折線 + 3.4 m 車道），
 * 兩者一疊，就會有幾十棟樓的角位壓在車道上。玩家撞到的會是「看得見但應該唔存在」的樓。
 * 寧願少幾棟樓，都要保證「地圖上見到的路一定開得通」。
 */
export function dropBuildingsOnRoad(list, { lanes = HK.buildLanes(), clearance = 2.2 } = {}) {
  const CELL = 80;
  const key = (i, j) => i * 100003 + j;
  const grid = new Map();
  for (const lane of lanes) {
    const halfW = HK.LANE_WIDTH * 0.5;
    for (let s = 0; s <= lane.len; s += 4) {
      const p = HK.poseAt(lane, s);
      const i = Math.floor(p.x / CELL);
      const j = Math.floor(p.z / CELL);
      const k = key(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ x: p.x, z: p.z, r: halfW + clearance });
    }
  }
  const kept = [];
  const dropped = [];
  for (const b of list) {
    const radius = Math.hypot(b.w, b.d) / 2;
    const reach = Math.ceil((radius + 6) / CELL);
    const i0 = Math.floor(b.x / CELL);
    const j0 = Math.floor(b.z / CELL);
    let hit = false;
    for (let i = i0 - reach; i <= i0 + reach && !hit; i++) {
      for (let j = j0 - reach; j <= j0 + reach && !hit; j++) {
        for (const p of grid.get(key(i, j)) ?? []) {
          const d = Math.hypot(p.x - b.x, p.z - b.z);
          if (d < p.r + radius * 0.62) { hit = true; break; } // 用 0.62×對角線 ≈ 內接半徑，避免把臨街樓全砍
        }
      }
    }
    (hit ? dropped : kept).push(b);
  }
  return { kept, dropped };
}

/** fetch 的薄封裝：逾時就放棄（唔想玩家等半分鐘都未有畫面）。 */
async function fetchJson(url, timeoutMs, fetchImpl) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller?.signal, mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉真實樓宇。
 * @returns {Promise<{buildings: Array, ok: boolean, reason?: string, requests: number}>}
 */
export async function loadRealBuildings({
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  bbox = playAreaLonLat(),
  cols = 3,
  rows = 4,
  timeoutMs = 7000,
  totalTimeoutMs = 12000,
  onProgress = () => {},
  signal = null
} = {}) {
  if (!fetchImpl) return { buildings: [], ok: false, reason: '冇 fetch（這個環境唔支援網絡）', requests: 0 };
  const cells = splitBBox(bbox, cols, rows);
  const buildings = [];
  const seen = new Set();
  let requests = 0;
  const failures = [];
  const started = Date.now();
  const deadline = started + (totalTimeoutMs || 12000);
  let giveUp = false;

  for (let ci = 0; ci < cells.length; ci++) {
    if (signal?.aborted || giveUp || Date.now() > deadline) break;
    const cell = cells[ci];
    onProgress({ cell: ci + 1, cells: cells.length, found: buildings.length });
    for (let page = 0; page < CSDI.maxPages; page++) {
      try {
        const fc = await fetchJson(buildQueryUrl(cell, page * CSDI.pageSize), timeoutMs, fetchImpl);
        requests++;
        const list = parseFeatureCollection(fc);
        for (const b of list) {
          const id = b.csdi ?? `${b.x},${b.z}`;
          if (seen.has(id)) continue;
          seen.add(id);
          buildings.push(b);
        }
        const got = fc?.features?.length ?? 0;
        if (got < CSDI.pageSize) break;
      } catch (err) {
        failures.push(String(err?.message ?? err));
        // 完全拉唔到（離線／跨域被封）：唔好逐格試落去，即刻退回種子樓宇，
        // 否則玩家要等成 12 格 × 7 秒先入到遊戲。
        if (!buildings.length) giveUp = true;
        break;
      }
    }
  }

  if (!buildings.length) {
    return { buildings: [], ok: false, reason: failures[0] ?? 'CSDI 冇回應或者過濾後冇樓宇', requests };
  }
  return { buildings, ok: true, requests, cells: cells.length, failures: failures.slice(0, 3) };
}
