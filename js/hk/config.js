import { GEO } from '../hk-geodata.js';

// js/hk/config.js
// 香港世界觀（Hong Kong world config）— 由 js/hk-geodata.js 推導出來的執行期世界。
//
// 與 city-config.js（紐約）的分別：
//   · 沒有 numbered streets / avenue x：香港用「走廊 corridor」＝ 一條有名有姓、有自己方位角的道路折線；
//   · 真北朝上（x = 東, z = 南, north = −z），不需要曼哈頓的 29.02° 網格旋轉；
//   · 靠左行駛（left-hand traffic）：車道是中心線「向左」的偏移，全部由 laneLateral() 一處定義；
//   · 街道查詢以最近走廊 + 沿線距離（chainage）回答，取代 streetZ(n)/avenueX(id)。

const pairs = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};
const closedRing = (flat) => {
  const pts = pairs(flat);
  if (pts.length && (pts[0].x !== pts[pts.length - 1].x || pts[0].z !== pts[pts.length - 1].z)) pts.push(pts[0]);
  return pts;
};

export const FRAME = GEO.frame;
export const WATER_LEVEL = GEO.frame.waterLevel;
export const ORIGIN = { lat: GEO.frame.originLat, lon: GEO.frame.originLon };
export const M_PER_DEG_LAT = GEO.frame.mPerDegLat;
export const M_PER_DEG_LON = GEO.frame.mPerDegLon;

/** 香港法例：靠左行駛。行車方向的左法線。 */
export const laneLateral = (dx, dz) => ({ x: dz + 0, z: 0 - dx });
/** 第 i 條行車線（由中心線數起）中心向左的距離（m）。 */
export const laneCentreOffset = (i, laneWidth) => (i + 0.5) * laneWidth;

export const LANE_WIDTH = 3.4;
export const SIDEWALK = 3.5;
export const KERB_HEIGHT = 0.15;

// --- 走廊（corridors）----------------------------------------------------------------------------------
function lengthOf(pts) {
  let len = 0;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    cum.push(len);
  }
  return { len, cum };
}

export const ROADS = GEO.roads.map((r) => {
  const pts = pairs(r.pts);
  const { len, cum } = lengthOf(pts);
  return { ...r, pts, len, cum, lanesPerWay: Math.max(1, Math.min(4, Math.round(r.lanes))) };
});

/** 沿走廊的位置：[x, z] at chainage s (m), plus the unit direction there. */
export function alongRoad(road, s) {
  const t = Math.max(0, Math.min(road.len, s));
  let i = 1;
  while (i < road.cum.length - 1 && road.cum[i] < t) i++;
  const a = road.pts[i - 1];
  const b = road.pts[i];
  const segLen = Math.max(1e-6, road.cum[i] - road.cum[i - 1]);
  const f = (t - road.cum[i - 1]) / segLen;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, dx: (b.x - a.x) / segLen, dz: (b.z - a.z) / segLen };
}

/** 走廊折線平移 offset（正值 = 行車方向的左側），附上每個頂點的行車方向。 */
export function offsetPolyline(pts, offset) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const left = laneLateral(dx, dz);
    out.push({ x: pts[i].x + left.x * offset, z: pts[i].z + left.z * offset, dx, dz });
  }
  return out;
}

/** 走廊 → 車道：雙向走廊兩組（各自靠左），單程路一組。第 0 條最貼中心線。 */
export function buildLanes(roads = ROADS) {
  const lanes = [];
  for (const road of roads) {
    const dirs = road.oneway ? [1] : [1, -1];
    for (const dir of dirs) {
      const base = dir === 1 ? road.pts : [...road.pts].reverse().map((p) => ({ x: p.x, z: p.z }));
      for (let i = 0; i < road.lanesPerWay; i++) {
        const pts = offsetPolyline(base, laneCentreOffset(i, LANE_WIDTH));
        const cum = [0];
        for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
        lanes.push({ road, dir, lane: i, isKerbLane: i === road.lanesPerWay - 1, pts, cum, len: cum[cum.length - 1] });
      }
    }
  }
  return lanes;
}

/** 車道上的位置與朝向（s = 沿線距離，米） */
export function poseAt(lane, s) {
  const t = Math.max(0, Math.min(lane.len, s));
  let i = 1;
  while (i < lane.cum.length - 1 && lane.cum[i] < t) i++;
  const a = lane.pts[i - 1];
  const b = lane.pts[i];
  const segLen = Math.max(1e-6, lane.cum[i] - lane.cum[i - 1]);
  const f = (t - lane.cum[i - 1]) / segLen;
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    dx: b.dx,
    dz: b.dz,
    heading: Math.atan2(b.dx, b.dz)
  };
}

// --- 最近道路索引（100 m 網格）-------------------------------------------------------------------------
const CELL = 100;
const roadGrid = new Map();
const key = (ix, iz) => ix * 100003 + iz;
for (const road of ROADS) {
  for (let i = 0; i + 1 < road.pts.length; i++) {
    const a = road.pts[i];
    const b = road.pts[i + 1];
    for (let ix = Math.floor(Math.min(a.x, b.x) / CELL); ix <= Math.floor(Math.max(a.x, b.x) / CELL); ix++) {
      for (let iz = Math.floor(Math.min(a.z, b.z) / CELL); iz <= Math.floor(Math.max(a.z, b.z) / CELL); iz++) {
        const k = key(ix, iz);
        if (!roadGrid.has(k)) roadGrid.set(k, []);
        roadGrid.get(k).push({ road, ax: a.x, az: a.z, bx: b.x, bz: b.z });
      }
    }
  }
}

/** 最近的走廊段：{ road, dist, x, z, dx, dz } 或 null。 */
export function nearestRoad(x, z, radius = 400) {
  const reach = Math.ceil(radius / CELL);
  const ci = Math.floor(x / CELL);
  const cz = Math.floor(z / CELL);
  let best = null;
  for (let ix = ci - reach; ix <= ci + reach; ix++) {
    for (let iz = cz - reach; iz <= cz + reach; iz++) {
      const list = roadGrid.get(key(ix, iz));
      if (!list) continue;
      for (const s of list) {
        const dx = s.bx - s.ax;
        const dz = s.bz - s.az;
        const l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
        const px = s.ax + t * dx;
        const pz = s.az + t * dz;
        const d = Math.hypot(px - x, pz - z);
        if (d > radius) continue;
        if (!best || d < best.dist) {
          const len = Math.sqrt(l2);
          best = { road: s.road, dist: d, x: px, z: pz, dx: dx / len, dz: dz / len };
        }
      }
    }
  }
  return best;
}

// --- 地區（districts）----------------------------------------------------------------------------------
export const DISTRICTS = GEO.districts.map((d) => ({ ...d, cx: (d.x0 + d.x1) / 2, cz: (d.z0 + d.z1) / 2 }));

export function districtAt(x, z) {
  for (const d of DISTRICTS) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return d;
  // outside the seed districts: nearest by centre, but say so honestly
  let best = DISTRICTS[0];
  let bd = Infinity;
  for (const d of DISTRICTS) {
    const dist = Math.hypot(x - d.cx, z - d.cz);
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}

/** 香港式雙語位置說明：「中環 Central · 干諾道中 Connaught Road Central」 */
export function locationLabel(x, z) {
  const d = districtAt(x, z);
  const near = nearestRoad(x, z);
  if (!near) return `${d.zh} ${d.en}`;
  const head = near.dist > 260 ? `${d.zh} ${d.en}` : `${d.zh} ${d.en}`;
  return `${head} · ${near.road.zh} ${near.road.en}`;
}

// --- 地標、建築、土地 -----------------------------------------------------------------------------------
/**
 * 把地標「泊」到真正空得落的位置。
 *
 * 為什麼要做：地標座標直接來自 seed（真實經緯度），但我們的走廊是**加寬的近似線**，
 * 兩者一撞，就會出現「IFC / 交易廣場 / 大會堂 企正喺干諾道中馬路中間」這種情況
 * （實測 8 個地標壓住行車道，最近的中心距只有 4.8 m）。
 *
 * 做法：先算 support function（axis-aligned box 沿方向 n 的半寬 = |nx|·w/2 + |nz|·d/2），
 * 得到「距離最近車道邊界仲差幾多」。有重疊就做**螺旋搜尋**：由 4 m 起、每次 +4 m，
 * 16 個方向，揀第一個「完全離開所有行車道（含 margin）而且仍然在陸地上」的位置。
 * 咁樣一定收斂、位移最小，而且唔會好似逐段推開咁喺兩條路之間彈來彈去（曾經把大會堂推到 435 m 外）。
 */
function landmarkClearance(item, x, z, roads) {
  let worst = Infinity;
  for (const road of roads) {
    const roadHalf = road.w / 2;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen2 = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / segLen2));
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      let nx = x - px;
      let nz = z - pz;
      const dist = Math.hypot(nx, nz);
      if (dist > 1e-4) { nx /= dist; nz /= dist; } else { nx = 1; nz = 0; }
      const extent = Math.abs(nx) * (item.w / 2) + Math.abs(nz) * (item.d / 2);
      worst = Math.min(worst, dist - roadHalf - extent);
    }
  }
  return worst;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, zi = ring[i].z;
    const xj = ring[j].x, zj = ring[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const LAND_RINGS = GEO.land.map((l) => pairs(l.ring));
function onLand(x, z) {
  return LAND_RINGS.some((ring) => pointInRing(x, z, ring));
}

function placeLandmarksOffRoad(list, roads, margin = 2.5) {
  const out = [];
  for (const item of list) {
    if (landmarkClearance(item, item.x, item.z, roads) >= margin && onLand(item.x, item.z)) {
      out.push({ ...item });
      continue;
    }
    let best = null;
    for (let radius = 4; radius <= 200 && !best; radius += 4) {
      for (let k = 0; k < 16; k++) {
        const angle = (k / 16) * Math.PI * 2;
        const x = item.x + Math.cos(angle) * radius;
        const z = item.z + Math.sin(angle) * radius;
        if (!onLand(x, z)) continue;
        if (landmarkClearance(item, x, z, roads) < margin) continue;
        best = { x, z, moved: radius };
        break;
      }
    }
    if (!best) {
      // 真係搵唔到位（例如被兩條主幹道夾死）：退而求其次，揀偏移最小、淨空最大的點
      let fallback = { x: item.x, z: item.z, clear: landmarkClearance(item, item.x, item.z, roads) };
      for (let radius = 4; radius <= 200; radius += 4) {
        for (let k = 0; k < 16; k++) {
          const angle = (k / 16) * Math.PI * 2;
          const x = item.x + Math.cos(angle) * radius;
          const z = item.z + Math.sin(angle) * radius;
          if (!onLand(x, z)) continue;
          const clear = landmarkClearance(item, x, z, roads);
          if (clear > fallback.clear + 0.5) fallback = { x, z, clear };
        }
        if (fallback.clear >= margin) break;
      }
      best = { x: fallback.x, z: fallback.z, moved: Math.hypot(fallback.x - item.x, fallback.z - item.z) };
    }
    out.push({ ...item, x: best.x, z: best.z, shiftedByRoad: Math.round(best.moved * 10) / 10 });
  }
  return out;
}

export const LANDMARKS = placeLandmarksOffRoad(GEO.landmarks, ROADS);
export const BUILDINGS = GEO.buildings;
export const LAND = GEO.land.map((l) => ({ ...l, pts: closedRing(l.ring) }));
export const TRAM = pairs(GEO.tram);
export const FERRY = { from: { x: GEO.ferry.from[0], z: GEO.ferry.from[1] }, to: { x: GEO.ferry.to[0], z: GEO.ferry.to[1] }, minutes: GEO.ferry.minutes };
export const TUNNELS = GEO.tunnels.map((t) => ({ ...t, pts: pairs(t.pts) }));

export const landmarkById = (id) => LANDMARKS.find((l) => l.id === id);

// --- 傳送點與出生點 -------------------------------------------------------------------------------------
/** 在指定走廊上取一個車道位置（t = 0..1 沿線比例）；傳送點永遠落在真實車道上。 */
function roadSpot(roadEn, t, lane = 1) {
  const road = ROADS.find((r) => r.en === roadEn) || ROADS[0];
  const p = alongRoad(road, road.len * Math.max(0, Math.min(1, t)));
  const left = laneLateral(p.dx, p.dz);
  const off = laneCentreOffset(lane, LANE_WIDTH);
  return { x: p.x + left.x * off, z: p.z + left.z * off, heading: Math.atan2(p.dx, p.dz), road: road.en };
}

export const TELEPORTS = [
  { id: 'central', zh: '中環', en: 'Central', ...roadSpot('Connaught Road Central', 0.45), note: '皇后像廣場一帶 Statue Square' },
  { id: 'ifc', zh: '國金二期', en: 'Two IFC', ...roadSpot('Connaught Road Central', 0.63) },
  { id: 'admiralty', zh: '金鐘', en: 'Admiralty', ...roadSpot('Queensway', 0.5) },
  { id: 'wanchai', zh: '灣仔', en: 'Wan Chai', ...roadSpot('Hennessy Road', 0.25) },
  { id: 'causeway', zh: '銅鑼灣', en: 'Causeway Bay', ...roadSpot('Yee Wo Street', 0.5) },
  { id: 'tst', zh: '尖沙咀', en: 'Tsim Sha Tsui', ...roadSpot('Salisbury Road', 0.45) },
  { id: 'jordan', zh: '佐敦', en: 'Jordan', ...roadSpot('Jordan Road', 0.45) },
  { id: 'mongkok', zh: '旺角', en: 'Mong Kok', ...roadSpot('Nathan Road', 0.72) },
  { id: 'icc', zh: '環球貿易廣場', en: 'ICC', ...roadSpot('Austin Road', 0.12) }
];

// 出生：干諾道中・中環，向東（往金鐘）
export const SPAWN = (() => {
  const road = ROADS[0];
  const p = alongRoad(road, road.len * 0.45);
  const left = laneLateral(p.dx, p.dz);
  const off = laneCentreOffset(1, LANE_WIDTH);
  return { x: p.x + left.x * off, z: p.z + left.z * off, heading: Math.atan2(p.dx, p.dz), road: road.en };
})();

// --- 跟車模型（簡化 IDM；抽出來是為了可以單元測試）------------------------------------------------
/**
 * 目標速度：以「淨車距」決定，淨距 = 前車距離 − 車長 − 靜止安全距。
 * @param {number} gap 與前車沿線距離（m），無前車傳 Infinity
 * @param {number} length 本車長（m）
 * @param {number} vmax 最高速（m/s）
 * @param {number} headway 每米淨距對應的速度（s/m），越大越保守
 */
export function followSpeed(gap, length, vmax, headway = 1.1) {
  if (!Number.isFinite(gap)) return vmax;
  const safe = Math.max(0, gap - length - 3);
  return Math.min(vmax, Math.max(0, safe / headway));
}

// --- 交通號誌（香港週期；黃燈後全紅緩衝，行人綠燈閃爍）--------------------------------------------------
export const SIGNAL = {
  cycle: 72,
  green: 30,
  amber: 3,
  allRed: 2,
  pedGreen: 24,
  pedFlash: 12
};

/** 幹道在 t 秒時的相位：'green' | 'amber' | 'red' */
export function signalPhase(t, isTrunk) {
  const offset = isTrunk ? 0 : SIGNAL.green + SIGNAL.amber + SIGNAL.allRed;
  const local = (((t + offset) % SIGNAL.cycle) + SIGNAL.cycle) % SIGNAL.cycle;
  if (local < SIGNAL.green) return 'green';
  if (local < SIGNAL.green + SIGNAL.amber) return 'amber';
  if (local < SIGNAL.green + SIGNAL.amber + SIGNAL.allRed) return 'red';
  return 'red';
}

/** 行人可否起步（綠燈人像；之後閃爍＝不准起步） */
export function walkPhase(t, isTrunk) {
  const offset = isTrunk ? 0 : SIGNAL.green + SIGNAL.amber + SIGNAL.allRed;
  const local = (((t + offset) % SIGNAL.cycle) + SIGNAL.cycle) % SIGNAL.cycle;
  return local < SIGNAL.pedGreen;
}

// --- 世界基本資料 ---------------------------------------------------------------------------------------
export const WORLD = {
  id: 'hong-kong',
  zh: '香港',
  en: 'Hong Kong',
  tagline: '香港 · 維多利亞港兩岸',
  speedUnit: 'km/h',
  driveSide: 'left',
  districts: DISTRICTS.length,
  buildings: BUILDINGS.length,
  roads: ROADS.length
};

/** 由 (x, z) 反推經緯度（地圖與外部工具用） */
export const toLatLon = (x, z) => [ORIGIN.lon + x / M_PER_DEG_LON, ORIGIN.lat - z / M_PER_DEG_LAT];
