// tools/validate-heights.mjs — LOCAL-ONLY check of estimateHeight() against measured building heights
// usage: node tools/validate-heights.mjs
//
// Fetches the 智慧城市3D臺北 building tiles (https://3d.taipei, 3D Tiles 1.1, per-building EXT_structural_metadata with
// the measured height BUILD_H) covering the Taipei test box, matches each modelled building to the OSM footprint it
// stands in, and reports how far the generic estimate (tools/geo-height.mjs) is from the measured height, by building
// type and footprint size, with suggested ESTIMATE_TIERS.
//
// The 3D service has no open licence (its schema follows the NLSC national 3D building model, served for
// "non-value-added" use), so NOTHING it returns may be committed or written into js/*-geodata.js: downloads and the
// report stay in tools/data-local/ (git-ignored). Only the tuned estimate parameters, which remain estimates, go into
// geo-height.mjs by hand.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toWorld, BOX, load, log } from './geo-taipei-base.mjs';
import { buildingHeight, estimateHeight, ESTIMATE_TIERS, LEVEL_M } from './geo-height.mjs';

const ROOT = 'https://3d.taipei/data/3dTiles/115_A/';
const CACHE = fileURLToPath(new URL('data-local/3dtaipei/', import.meta.url));
const REPORT = fileURLToPath(new URL('data-local/height-validation.json', import.meta.url));
fs.mkdirSync(CACHE, { recursive: true });

async function fetchCached(url, binary = false) {
  const file = path.join(CACHE, url.slice(ROOT.length).replace(/[^\w.-]+/g, '_'));
  if (!fs.existsSync(file)) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': 'slop-taipei height validation (local, non-redistributed)', Referer: 'https://3d.taipei/' } });
      if (res.ok) { fs.writeFileSync(file, Buffer.from(await res.arrayBuffer())); break; }
      if (attempt >= 3) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  const buf = fs.readFileSync(file);
  return binary ? buf : JSON.parse(buf.toString('utf8'));
}

// --- Geometry: ECEF <-> geodetic (WGS84 / GRS80 are the same here), 4x4 column-major matrices --------------------------
const A = 6378137, E2 = 6.69437999014e-3;
function ecefToGeo([x, y, z]) {
  const lon = Math.atan2(y, x), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 6; i++) {
    const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + E2 * N * Math.sin(lat), p);
  }
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

// TWD97 TM2 (zone 121°E) easting/northing -> latitude/longitude (GRS80 transverse Mercator inverse)
function tm2ToGeo(E, N) {
  const k0 = 0.9999, lon0 = (121 * Math.PI) / 180, e2 = 0.00669438002290, ep2 = e2 / (1 - e2);
  const x = E - 250000, M = N / k0;
  const mu = M / (A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(phi1) ** 2, T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2), R1 = (A * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - ((N1 * Math.tan(phi1)) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
    ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(phi1);
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

// --- glTF EXT_structural_metadata property tables -> rows ----------------------------------------------------------------
function metadataRows(buf) {
  if (buf.toString('ascii', 0, 4) !== 'glTF') return [];
  const jl = buf.readUInt32LE(12);
  const j = JSON.parse(buf.toString('utf8', 20, 20 + jl));
  const meta = j.extensions && j.extensions.EXT_structural_metadata;
  if (!meta || !meta.propertyTables) return [];
  const bin = buf.subarray(20 + jl + 8);
  const view = (i) => { const bv = j.bufferViews[i]; return bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength); };
  const rows = [];
  for (const t of meta.propertyTables) {
    const props = meta.schema.classes[t.class].properties;
    const cols = {};
    for (const [n, pt] of Object.entries(t.properties)) {
      const p = props[n];
      const v = view(pt.values);
      if (p.type === 'STRING') {
        const off = view(pt.stringOffsets);
        const rd = (i) => ((pt.stringOffsetType || 'UINT32') === 'UINT16' ? off.readUInt16LE(i * 2) : off.readUInt32LE(i * 4));
        cols[n] = (i) => v.toString('utf8', rd(i), rd(i + 1));
      } else {
        const r = { FLOAT32: (i) => v.readFloatLE(i * 4), FLOAT64: (i) => v.readDoubleLE(i * 8), UINT8: (i) => v.readUInt8(i), UINT16: (i) => v.readUInt16LE(i * 2), UINT32: (i) => v.readUInt32LE(i * 4) }[p.componentType];
        cols[n] = r || (() => null);
      }
    }
    for (let i = 0; i < t.count; i++) rows.push(Object.fromEntries(Object.entries(cols).map(([n, f]) => [n, f(i)])));
  }
  return rows;
}

// --- 1. Measured buildings in the box -----------------------------------------------------------------------------------
const [S, W, N, E] = BOX;
const inBox = ([lat, lon], margin = 0) => lat > S - margin && lat < N + margin && lon > W - margin && lon < E + margin;
const root = await fetchCached(`${ROOT}tileset.json`);
const sheets = root.root.children.filter((c) => {
  const [lat, lon] = ecefToGeo(c.boundingVolume.sphere);
  const r = c.boundingVolume.sphere[3] / 100000; // degrees, roughly
  return inBox([lat, lon], r + 0.002);
});
log(`${sheets.length} of ${root.root.children.length} map sheets touch the box`);
const leaves = [];
for (const s of sheets) {
  const base = ROOT + s.content.uri.replace(/tileset\.json$/, '');
  const ts = await fetchCached(base + 'tileset.json');
  (function walk(node, m) {
    const world = node.transform ? mul(m, node.transform) : m;
    if (node.content && /^lod1\//.test(node.content.uri)) {
      const sph = node.boundingVolume.sphere;
      if (sph && inBox(ecefToGeo(apply(world, sph)), sph[3] / 100000 + 0.0005)) leaves.push(base + node.content.uri);
    }
    for (const c of node.children || []) walk(c, world);
  })(ts.root, IDENTITY);
}
log(`${leaves.length} detailed tiles to read`);
const measured = new Map();
for (let i = 0; i < leaves.length; i += 6) {
  const bufs = await Promise.all(leaves.slice(i, i + 6).map((u) => fetchCached(u, true)));
  for (const b of bufs) {
    for (const r of metadataRows(b)) {
      if (!r.BUILD_ID || !(r.BUILD_H > 0 && r.BUILD_H < 600)) continue; // drop the service's outliers
      const geo = r.CENT_E_97 ? tm2ToGeo(r.CENT_E_97, r.CENT_N_97) : [(r.Latitude * 180) / Math.PI, (r.Longitude * 180) / Math.PI];
      if (!inBox(geo)) continue;
      const prev = measured.get(r.BUILD_ID);
      if (!prev || r.BUILD_H > prev.h) measured.set(r.BUILD_ID, { h: r.BUILD_H, floors: r.BUILD_NO, at: toWorld(geo[1], geo[0]) });
    }
  }
}
log(`${measured.size} measured buildings in the box`);

// --- 2. Match to OSM footprints -------------------------------------------------------------------------------------------
function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };
const osm = load('osm_buildings.json');
const outlines = osm.elements.filter((e) => e.type === 'way' && e.tags && e.tags.building && e.tags.building !== 'no' && e.geometry && e.tags.location !== 'underground')
  .map((e) => {
    const ring = e.geometry.map((g) => toWorld(g.lon, g.lat));
    const area = ringArea(ring);
    return { id: e.id, tags: e.tags, ring, area, type: e.tags.building, h: buildingHeight(e.tags, area) };
  });
const matches = [];
for (const o of outlines) {
  // the tallest measured building standing in this footprint (OSM outlines can hold several surveyed blocks)
  let best = null;
  for (const m of measured.values()) if (pointInRing(m.at[0], m.at[1], o.ring) && (!best || m.h > best.h)) best = m;
  if (best) matches.push({ ...o, measured: best.h, floors: best.floors });
}
log(`${matches.length} of ${outlines.length} OSM outlines matched to a measured building`);

// --- 3. Report ----------------------------------------------------------------------------------------------------------------
const stat = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, median: +s[s.length >> 1].toFixed(2), mean: +(s.reduce((t, v) => t + v, 0) / s.length).toFixed(2) };
};
const bySource = {};
for (const src of ['height', 'levels', 'estimate']) {
  const ms = matches.filter((m) => m.h.source === src);
  bySource[src] = { absErrorM: stat(ms.map((m) => Math.abs(m.h.top - m.measured))), ratio: stat(ms.map((m) => m.h.top / m.measured)) };
}
console.log('\nOSM height vs measured, by height source (ratio > 1: OSM taller):');
console.table(Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { n: v.ratio?.n ?? 0, medianAbsErrM: v.absErrorM?.median, medianRatio: v.ratio?.median }])));

// What the estimate would say for every matched building (tagged or not), against measured height, per type & size
const bins = [0, 100, 300, 1000, 3000, Infinity];
const rows = {};
for (const m of matches) {
  const type = ESTIMATE_TIERS[m.type] ? m.type : 'yes';
  const b = bins.findIndex((v, i) => m.area >= v && m.area < bins[i + 1]);
  const key = `${type} ${bins[b]}-${bins[b + 1] === Infinity ? '∞' : bins[b + 1]}`;
  (rows[key] ||= []).push({ est: estimateHeight(type, m.area), measured: m.measured });
}
console.log('\nestimateHeight() vs measured, every matched building, by type & footprint (m²):');
console.table(Object.fromEntries(Object.entries(rows).sort().map(([k, v]) => [k, {
  n: v.length, estMedian: stat(v.map((x) => x.est)).median, measuredMedian: stat(v.map((x) => x.measured)).median,
  medianAbsErr: stat(v.map((x) => Math.abs(x.est - x.measured))).median
}])));

// Suggested tiers: storeys at the a0 / a1 ends from a least-squares fit of measured storeys on log(area), per type
const suggested = {};
for (const [type, [l0, l1, a0, a1]] of Object.entries(ESTIMATE_TIERS)) {
  const pts = matches.filter((m) => (ESTIMATE_TIERS[m.type] ? m.type : 'yes') === type)
    .map((m) => [Math.min(1, Math.max(0, Math.log(Math.max(m.area, 1) / a0) / Math.log(a1 / a0))), m.measured / LEVEL_M]);
  if (pts.length < 8) continue;
  const n = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const slope = n * sxx - sx * sx > 1e-9 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
  const icpt = (sy - slope * sx) / n;
  suggested[type] = { n, current: [l0, l1, a0, a1], fitted: [Math.max(1, Math.round(icpt)), Math.max(1, Math.round(icpt + slope)), a0, a1] };
}
console.log('\nSuggested ESTIMATE_TIERS (storeys at a0 / a1 m², fitted to measured heights):');
console.table(Object.fromEntries(Object.entries(suggested).map(([k, v]) => [k, { n: v.n, current: v.current.join(' / '), fitted: v.fitted.join(' / ') }])));

fs.writeFileSync(REPORT, JSON.stringify({ note: 'LOCAL ONLY: derived from https://3d.taipei (no open licence). Do not commit.', bySource, suggested }, null, 1));
log(`report written to ${REPORT} (git-ignored)`);
