// tools/build-tepic-geodata.mjs — writes js/world/city-geodata.js for Tepic, Nayarit, from OpenStreetMap.
// The generic fields (roadGraph, blocks, parks, roads) carry the whole city. The schema keeps a few empty fields from
// the New York game this project was forked from (streets, avenues, centralPark, boroughs, piers, bridges...), with
// `frame.grid` / `frame.waterfront` false, so the generated file keeps its shape; `manhattan` is the city's box.
//
// Frame: 1 unit = 1 m, x = east, z = south (north = -z), origin at the Plaza Principal (Plaza de Armas), axes turned
// to the centro's street grid (a few degrees from true north, measured from the streets themselves).
//
// Inputs (tools/data/tepic/, fetched by tools/data/tepic/fetch.sh through Overpass):
//   osm_tepic_roads.json      every highway=* way with geometry
//   osm_tepic_land.json       parks, pitches, schools, water, rail, land use
//   osm_tepic_pois.json       neighbourhoods, monuments, signals, lamps
//   osm_tepic_buildings.json  building footprints (sparse in Tepic; only notable ones are kept)
//   semovi_routes.json        the bus & combi routes (Secretaría de Movilidad de Nayarit, tools/data/tepic/fetch-routes.sh)
//
// usage: node --max-old-space-size=8192 tools/build-tepic-geodata.mjs [outFile]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { log, ringArea, bbox, centroid, rdp, rdpRing, extractBlocks, ringCells, clearCapsule, minAreaRect, decodePNG, createRouteMatcher } from './tepic-lib.mjs';
import { STOREFRONTS } from '../js/world/storefronts/index.js';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/tepic/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../js/world/city-geodata.js', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);

// =====================================================================================================================
// 1. FRAME: origin at the Plaza Principal, axes along the centro's grid
// =====================================================================================================================
const LAT0 = 21.51224;
const LON0 = -104.89269;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
let THETA = 0;
const enu = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
// World: x east along the grid, z south along the grid
function toWorld(lon, lat) {
  const [e, n] = enu(lon, lat);
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}

const roadsOSM = load('osm_tepic_roads.json');
const landOSM = load('osm_tepic_land.json');
// grid frame -> lon/lat (for the logs)
function toLonLat(x, z) {
  const c = Math.cos(THETA), s = Math.sin(THETA);
  const e = x * c - z * s, n = -(x * s + z * c);
  return [LON0 + e / KX, LAT0 + n / KY];
}
const DRIVE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const ways = roadsOSM.elements.filter((e) => e.type === 'way' && e.geometry && e.tags && e.tags.highway);
// Overpass' `out geom tags` carries no node ids: ways sharing a node share its exact coordinates
const nodeKey = (g) => `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
{
  // Bearing: length-weighted circular mean (mod 90°) of the street directions within 1.2 km of the plaza
  let sx = 0, sy = 0;
  for (const w of ways) {
    if (!DRIVE.has(w.tags.highway)) continue;
    const g = w.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const [e0, n0] = enu(g[i].lon, g[i].lat);
      const [e1, n1] = enu(g[i + 1].lon, g[i + 1].lat);
      if (Math.hypot(e0, n0) > 1200) continue;
      const L = Math.hypot(e1 - e0, n1 - n0);
      if (L < 5) continue;
      const a = Math.atan2(e1 - e0, n1 - n0); // bearing east of north
      sx += L * Math.cos(4 * a);
      sy += L * Math.sin(4 * a);
    }
  }
  THETA = Math.atan2(sy, sx) / 4;
  log(`grid bearing ${((THETA * 180) / Math.PI).toFixed(2)}° east of true north`);
}

// The detailed city: a box around the centro (metres in the grid frame). Everything the game builds lives in here.
// From Lo de Lamedo & Las Brisas (west) to San Cayetano & Vistas de la Cantera (east), from El Tajo (north) to the south
// of Xalisco: the whole metropolitan area of Tepic & Xalisco, and the airport (Pantanal, its terminal & access roads
// at x ~9400-10100, its runway along grid z 6000-9100)
const BOX = { x0: -5800, x1: 10400, z0: -4800, z1: 10100 };
log(`detail box corners: ${[[BOX.x0, BOX.z0], [BOX.x1, BOX.z0], [BOX.x1, BOX.z1], [BOX.x0, BOX.z1]].map(([x, z]) => toLonLat(x, z).map((v) => v.toFixed(4)).reverse().join(',')).join('  ')}`);
const inBox = (x, z) => x >= BOX.x0 && x <= BOX.x1 && z >= BOX.z0 && z <= BOX.z1;
const boxRing = [[BOX.x0, BOX.z0], [BOX.x0, BOX.z1], [BOX.x1, BOX.z1], [BOX.x1, BOX.z0]]; // negative shoelace area (x, z)

// =====================================================================================================================
// 2. STREETS: curb-to-curb widths, lanes and direction per OSM way
// =====================================================================================================================
const num = (v) => { const n = parseFloat(String(v || '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
function roadSpec(t) {
  const hw = t.highway;
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.oneway === '-1' || t.junction === 'roundabout';
  const dir = t.oneway === '-1' ? -1 : oneway ? 1 : 0;
  const widths = {
    motorway: [11, 11], trunk: [10.5, 16], primary: [10, 14], secondary: [9, 12], tertiary: [8, 10],
    unclassified: [7.4, 7.4], residential: [7.4, 7.4], living_street: [6, 6],
    motorway_link: [7, 7], trunk_link: [7, 7], primary_link: [7, 7], secondary_link: [7, 7], tertiary_link: [7, 7]
  }[hw] || [7.4, 7.4];
  let w = num(t.width);
  if (!(w >= 4 && w <= 30)) w = oneway ? widths[0] : widths[1];
  let lanes = num(t.lanes);
  if (!(lanes >= 1 && lanes <= 8)) {
    lanes = { motorway: 2, trunk: oneway ? 3 : 4, primary: oneway ? 2 : 2, secondary: oneway ? 2 : 2, tertiary: oneway ? 1 : 2 }[hw];
    if (!lanes) lanes = oneway ? 1 : 2;
  }
  const major = /^(motorway|trunk|primary)$/.test(hw);
  return { w: Math.round(w * 10) / 10, lanes: Math.round(lanes), dir, major, hw };
}
const roadName = (t) => t.name || t['name:es'] || t.ref || '';

// =====================================================================================================================
// 3. ROAD GRAPH: every drivable way split at shared nodes, clipped to the box
// =====================================================================================================================
const nodeUse = new Map();
for (const w of ways) {
  if (!DRIVE.has(w.tags.highway)) continue;
  for (const g of w.geometry) { const k = nodeKey(g); nodeUse.set(k, (nodeUse.get(k) || 0) + 1); }
}
const MERGE = 1.0;
const gnodes = [];
const gcells = new Map();
function nodeAt(x, z) {
  const ix = Math.floor(x / MERGE), iz = Math.floor(z / MERGE);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const id of gcells.get((ix + dx) * 1000003 + iz + dz) || []) {
        if (Math.hypot(gnodes[id][0] - x, gnodes[id][1] - z) <= MERGE) return id;
      }
    }
  }
  const id = gnodes.length;
  gnodes.push([x, z]);
  const k = ix * 1000003 + iz;
  if (!gcells.has(k)) gcells.set(k, []);
  gcells.get(k).push(id);
  return id;
}
const names = [];
const nameIds = new Map();
const nameId = (n) => {
  if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
  return nameIds.get(n);
};
// Clip a polyline to the box: the pieces inside, cut at the box edges
function clipChain(pts) {
  const out = [];
  let cur = [];
  const cross = (a, b) => {
    // first intersection of segment a-b with the box edges, as a point (a inside xor b inside)
    let best = null, bt = Infinity;
    const test = (t) => { if (t >= 0 && t <= 1 && t < bt) { bt = t; best = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; } };
    if (b[0] !== a[0]) { test((BOX.x0 - a[0]) / (b[0] - a[0])); test((BOX.x1 - a[0]) / (b[0] - a[0])); }
    if (b[1] !== a[1]) { test((BOX.z0 - a[1]) / (b[1] - a[1])); test((BOX.z1 - a[1]) / (b[1] - a[1])); }
    if (!best) return null;
    best[0] = Math.min(BOX.x1, Math.max(BOX.x0, best[0]));
    best[1] = Math.min(BOX.z1, Math.max(BOX.z0, best[1]));
    return best;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const inside = inBox(p[0], p[1]);
    if (inside) {
      if (!cur.length && i > 0) { const c = cross(pts[i - 1], p); if (c) cur.push(c); }
      cur.push(p);
    } else if (cur.length) {
      const c = cross(cur[cur.length - 1], p);
      if (c) cur.push(c);
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out.filter((c) => c.length > 1);
}
const links = [];
const linkDrafts = []; // { a, b, ni, spec, line, bridge, tunnel }: the links before their bridges are raised
const drivePieces = []; // for the block raster: { x0, z0, x1, z1, r, major }
const roadLines = []; // for maps & labels
const nodeWorld = new Map(); // node coordinate key -> world point (for signals)
for (const w of ways) {
  const t = w.tags;
  if (!DRIVE.has(t.highway)) continue;
  const spec = roadSpec(t);
  const name = roadName(t);
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  for (let i = 0; i < w.geometry.length; i++) nodeWorld.set(nodeKey(w.geometry[i]), pts[i]);
  // split at junctions (nodes shared with another drivable way) and at the way's ends
  let chain = [pts[0]];
  const chains = [];
  for (let i = 1; i < pts.length; i++) {
    chain.push(pts[i]);
    if (i === pts.length - 1 || nodeUse.get(nodeKey(w.geometry[i])) > 1) { chains.push(chain); chain = [pts[i]]; }
  }
  const ni = nameId(name);
  // (a bridge over something, or a road through a tunnel under it: see the bridges & ramps below)
  const bridge = !!t.bridge && t.bridge !== 'no';
  const tunnel = !!t.tunnel && t.tunnel !== 'no';
  for (const ch of chains) {
    for (const piece of clipChain(ch)) {
      const line = rdp(piece, 0.4);
      const a = nodeAt(...line[0]);
      const b = nodeAt(...line[line.length - 1]);
      if (a === b) continue;
      linkDrafts.push({ a, b, ni, spec, line, bridge, tunnel });
      for (let i = 0; i + 1 < line.length; i++) {
        drivePieces.push({ x0: line[i][0], z0: line[i][1], x1: line[i + 1][0], z1: line[i + 1][1], r: spec.w / 2 + 0.3, major: spec.major });
      }
    }
  }
  for (const piece of clipChain(pts)) {
    roadLines.push({ name, w: spec.w, dir: spec.dir === 0 ? 'TW' : spec.dir > 0 ? 'FT' : 'TF', lanes: spec.lanes, hw: spec.major, pts: rdp(piece, 0.8) });
  }
}

// =====================================================================================================================
// 3B. BRIDGES & RAMPS: the overpasses (a bridge over another road or the railway) raised over what passes under them,
//     their approaches ramping up to them; the roads through tunnels kept at grade with the roads over them raised
//     instead (the ground is one surface: no trench is cut). Each link gets the lift of every vertex over the ground
//     (piecewise linear between them), the same for the traffic, the player and the deck drawn
// =====================================================================================================================
const CLEARANCE = 6.0; // m: an overpass's deck over the road under it (~5 m of headroom under a ~1 m deck)
const RAIL_CLEARANCE = 7.0;
const RAMP = 0.07; // the steepest ramp up to a deck (7 %)
const railLines = [];
for (const e of landOSM.elements) {
  if (e.type !== 'way' || !e.geometry || !e.tags || e.tags.railway !== 'rail') continue;
  const t = e.tags;
  for (const piece of clipChain(e.geometry.map((g) => toWorld(g.lon, g.lat)))) {
    railLines.push({ line: rdp(piece, 0.3), bridge: !!t.bridge && t.bridge !== 'no', main: (t.usage || '') === 'main' || !t.service });
  }
}
// where two segments cross (strictly inside both), as [t along the first, u along the second, x, z]
const segCross = (p, q, r, s2) => {
  const d = (q[0] - p[0]) * (s2[1] - r[1]) - (q[1] - p[1]) * (s2[0] - r[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((r[0] - p[0]) * (s2[1] - r[1]) - (r[1] - p[1]) * (s2[0] - r[0])) / d;
  const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return [t, u, p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
};
// The segments of the links & rails in 50 m cells
const SEG_CELL = 50;
const segCells = new Map();
const addSeg = (owner, i, a, b) => {
  const x0 = Math.floor(Math.min(a[0], b[0]) / SEG_CELL), x1 = Math.floor(Math.max(a[0], b[0]) / SEG_CELL);
  const z0 = Math.floor(Math.min(a[1], b[1]) / SEG_CELL), z1 = Math.floor(Math.max(a[1], b[1]) / SEG_CELL);
  for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
    const k = ix * 100003 + iz;
    if (!segCells.has(k)) segCells.set(k, []);
    segCells.get(k).push([owner, i]);
  }
};
linkDrafts.forEach((d, id) => { d.id = id; for (let i = 0; i + 1 < d.line.length; i++) addSeg(d, i, d.line[i], d.line[i + 1]); });
railLines.forEach((r, id) => { r.id = -1 - id; for (let i = 0; i + 1 < r.line.length; i++) addSeg(r, i, r.line[i], r.line[i + 1]); });
const crossings = (owner) => {
  const out = [];
  const seen = new Set();
  for (let i = 0; i + 1 < owner.line.length; i++) {
    const a = owner.line[i], b = owner.line[i + 1];
    const x0 = Math.floor(Math.min(a[0], b[0]) / SEG_CELL), x1 = Math.floor(Math.max(a[0], b[0]) / SEG_CELL);
    const z0 = Math.floor(Math.min(a[1], b[1]) / SEG_CELL), z1 = Math.floor(Math.max(a[1], b[1]) / SEG_CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      for (const [other, j] of segCells.get(ix * 100003 + iz) || []) {
        const key = `${other.id}:${j}:${i}`;
        if (other === owner || seen.has(key)) continue;
        seen.add(key);
        const c = segCross(a, b, other.line[j], other.line[j + 1]);
        if (!c) continue;
        out.push({ i, t: c[0], other, j, u: c[1], x: c[2], z: c[3] });
      }
    }
  }
  return out;
};
// Vertices put into a line at the points the solve needs: { line, at: [x, z], lift?, pin? } (insertion keeps the
// line's shape, only splitting a segment)
const fixes = []; // { owner, x, z, lift } raised to `lift`; lift 0: held at grade
for (const d of linkDrafts) {
  if (!d.bridge && !d.tunnel) continue;
  for (const c of crossings(d)) {
    const o = c.other;
    const oRoad = !!o.spec;
    if (d.bridge && !(oRoad && o.bridge)) {
      // over a road (or the railway): this bridge's span up, the road (or rail) under it held at grade
      const lift = oRoad ? CLEARANCE : RAIL_CLEARANCE;
      for (const p of d.line) fixes.push({ owner: d, x: p[0], z: p[1], lift });
      fixes.push({ owner: o, x: c.x, z: c.z, lift: 0 });
    } else if (d.tunnel && oRoad && !o.tunnel && !o.bridge) {
      // a road through a tunnel: the road over it raised across it instead (its deck ~as wide as the tunnel's road)
      const half = d.spec.w / 2 + 3;
      const [ax, az] = o.line[c.j], [bx, bz] = o.line[c.j + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / L, uz = (bz - az) / L;
      for (const k of [-half, 0, half]) fixes.push({ owner: o, x: c.x + ux * k, z: c.z + uz * k, lift: CLEARANCE });
      fixes.push({ owner: d, x: c.x, z: c.z, lift: 0 });
    }
  }
}
for (const r of railLines) {
  if (!r.bridge) continue;
  for (const c of crossings(r)) {
    if (!c.other.spec || c.other.bridge) continue;
    for (const p of r.line) fixes.push({ owner: r, x: p[0], z: p[1], lift: RAIL_CLEARANCE });
    fixes.push({ owner: c.other, x: c.x, z: c.z, lift: 0 });
  }
}
// put each fix's point into its line (a vertex within 0.5 m of it serves)
for (const f of fixes) {
  const line = f.owner.line;
  let best = -1, bd = 0.5;
  line.forEach((p, i) => { const dd = Math.hypot(p[0] - f.x, p[1] - f.z); if (dd < bd) { bd = dd; best = i; } });
  if (best >= 0) { f.v = line[best]; continue; }
  let seg = -1, sd = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1];
    const L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((f.x - ax) * (bx - ax) + (f.z - az) * (bz - az)) / L2));
    const dd = Math.hypot(ax + (bx - ax) * t - f.x, az + (bz - az) * t - f.z);
    if (dd < sd) { sd = dd; seg = i; }
  }
  if (seg < 0 || sd > 2) continue;
  const v = [f.x, f.z];
  line.splice(seg + 1, 0, v);
  f.v = v;
}
// The lifts: from each raised vertex down every way out at RAMP (a graph of the links' vertices, joined at the junction
// nodes; the rails apart), held to RAMP x the distance from any vertex kept at grade
function solveLifts(lines, nodeOf) {
  const verts = new Map(); // vertex array -> id
  const adj = [];
  const idOf = (line, i) => {
    const key = nodeOf ? nodeOf(line, i) : null;
    const k = key !== null ? `n${key}` : line[i];
    if (!verts.has(k)) { verts.set(k, adj.length); adj.push([]); }
    return verts.get(k);
  };
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = idOf(line, i), b = idOf(line, i + 1);
      const L = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
      adj[a].push([b, L]);
      adj[b].push([a, L]);
    }
  }
  const spread = (seeds, value, step) => {
    // the largest of value(seed) - step x distance (a max-plus Dijkstra), cut off at 0 (in doubles: a float array
    // would round what it keeps above what the heap holds, and the vertex would never be spread from)
    const best = new Float64Array(adj.length);
    const heap = [];
    const push = (id, v) => { heap.push([v, id]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] > heap[m][0]) m = l; if (r < heap.length && heap[r][0] > heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (const [id, v] of seeds) if (v > best[id]) { best[id] = v; push(id, v); }
    while (heap.length) {
      const [v, id] = pop();
      if (v < best[id]) continue;
      for (const [n, L] of adj[id]) {
        const nv = value(v, L, step);
        if (nv > best[n]) { best[n] = nv; push(n, nv); }
      }
    }
    return best;
  };
  const raised = [], held = [];
  const mine = new Set(lines);
  for (const f of fixes) {
    if (!f.v || !mine.has(f.owner.line)) continue;
    const i = f.owner.line.indexOf(f.v);
    (f.lift > 0 ? raised : held).push([idOf(f.owner.line, i), f.lift]);
  }
  const up = spread(raised, (v, L) => v - RAMP * L);
  // how far below its cap each vertex must stay: RAMP x its distance from the nearest one held at grade, as a "height"
  // spreading down from a large value
  const BIG = 1000;
  const down = spread(held.map(([id]) => [id, BIG]), (v, L) => v - RAMP * L);
  const lift = (line, i) => {
    const id = idOf(line, i);
    const cap = down[id] > 0 ? BIG - down[id] : Infinity;
    return Math.max(0, Math.min(up[id], cap));
  };
  return lift;
}
const nodeOfDraft = new Map();
for (const d of linkDrafts) nodeOfDraft.set(d.line, d);
const roadLift = solveLifts(linkDrafts.map((d) => d.line), (line, i) => {
  const d = nodeOfDraft.get(line);
  return i === 0 ? d.a : i === line.length - 1 ? d.b : null;
});
const railLift = solveLifts(railLines.map((r) => r.line), null);
let raisedLinks = 0, raisedLen = 0;
for (const d of linkDrafts) {
  const lifts = d.line.map((_, i) => Math.round(roadLift(d.line, i) * 10));
  const inner = d.line.slice(1, -1).flatMap(([x, z]) => [q(x), q(z)]);
  const any = lifts.some((v) => v > 0);
  if (any) {
    raisedLinks++;
    for (let i = 0; i + 1 < d.line.length; i++) if (lifts[i] > 0 || lifts[i + 1] > 0) raisedLen += Math.hypot(d.line[i + 1][0] - d.line[i][0], d.line[i + 1][1] - d.line[i][1]);
  }
  // [a, b, name, width, lanes, dir, inner, lifts (dm over the ground at a, inner..., b) or 0, bridge (1: a bridge way)]
  links.push([d.a, d.b, d.ni, d.spec.w, d.spec.lanes, d.spec.dir, inner, any ? lifts : 0, d.bridge ? 1 : 0]);
}
const rails = railLines.map((r) => {
  const lifts = r.line.map((_, i) => Math.round(railLift(r.line, i) * 10));
  return [flat(r.line), lifts.some((v) => v > 0) ? lifts : 0, r.bridge ? 1 : 0, r.main ? 1 : 0];
});
log(`bridges: ${raisedLinks} links raised over ${(raisedLen / 1000).toFixed(1)} km (overpasses & their ramps); ${rails.length} rail lines, ${(railLines.reduce((t, r) => t + r.line.reduce((s2, p, i, a) => s2 + (i ? Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) : 0), 0), 0) / 1000).toFixed(1)} km`);
log(`road graph: ${gnodes.length} nodes, ${links.length} links, ${names.length} street names`);

// Traffic signals on drivable streets
const poisOSM = load('osm_tepic_pois.json');
const signals = [];
for (const e of poisOSM.elements) {
  if (e.type !== 'node' || !e.tags || e.tags.highway !== 'traffic_signals') continue;
  const p = nodeWorld.get(nodeKey(e)) || toWorld(e.lon, e.lat);
  if (inBox(p[0], p[1])) signals.push(q(p[0]), q(p[1]));
}
log(`${signals.length / 2} traffic signals`);

// =====================================================================================================================
// 4. BLOCKS: the box minus every roadway (and the things that cut blocks without carrying traffic)
// =====================================================================================================================
const SIDEWALK = 2.2; // property line in from the curb (Tepic's banquetas)
const RES = 1;
const X0 = BOX.x0, Z0 = BOX.z0;
const W = Math.ceil((BOX.x1 - BOX.x0) / RES), H = Math.ceil((BOX.z1 - BOX.z0) / RES);
const land = new Uint8Array(W * H).fill(1);
const cutters = [];
for (const w of ways) {
  const hw = w.tags.highway;
  const r = hw === 'pedestrian' ? 3 : hw === 'service' && w.tags.service !== 'parking_aisle' && w.tags.service !== 'driveway' && w.tags.name ? 2.8 : 0;
  if (!r) continue;
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  for (let i = 0; i + 1 < pts.length; i++) cutters.push({ x0: pts[i][0], z0: pts[i][1], x1: pts[i + 1][0], z1: pts[i + 1][1], r });
}
const bldOSM = load('osm_tepic_buildings.json');
// The rivers, arroyos, canals & drains (OSM waterway=*, drawn downstream), for the maps and the channels cut in the
// ground (js/world/waterways.js): [kind, half-width of the gap left between the blocks (m, 0: none), name, flags
// (1 intermittent, 2 underground: a culvert or tunnel), flat points]
const WATERWAY = /^(river|stream|canal|drain|ditch)$/;
const waterways = [];
for (const e of landOSM.elements) {
  if (e.type !== 'way' || !e.geometry || !e.tags) continue;
  const t = e.tags;
  const r = t.railway === 'rail' ? 5 : t.waterway === 'river' ? 6 : t.waterway === 'stream' ? 2.5 : 0;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  if (WATERWAY.test(t.waterway || '')) {
    const flags = (t.intermittent === 'yes' || t.seasonal === 'yes' ? 1 : 0) | (t.tunnel || t.location === 'underground' ? 2 : 0);
    for (const piece of clipChain(pts)) waterways.push([t.waterway, r, t.name || '', flags, flat(rdp(piece, 0.5))]);
  }
  if (!r) continue;
  for (let i = 0; i + 1 < pts.length; i++) cutters.push({ x0: pts[i][0], z0: pts[i][1], x1: pts[i + 1][0], z1: pts[i + 1][1], r });
}
log(`${waterways.length} waterways (${waterways.filter((w) => w[0] === 'river').length} river pieces)`);
// The airport (Aeropuerto Internacional de Tepic – Riviera Nayarit, MMEP; OSM aeroway=*): the runways & taxiways as
// centrelines with their widths (runway 02/20 is 45 m wide, its taxiways ~18 m), the aprons & helipads as rings. They
// are cut out of the blocks like roads, and js/world/airport.js lays their pavement & markings over the asphalt.
const airport = { name: '', runways: [], taxiways: [], aprons: [], helipads: [], gates: [] };
const airportRings = [];
const airfieldPieces = []; // (the runway & taxiways, which the hills are levelled under like the streets, 5D)
for (const e of landOSM.elements) {
  const a = e.type === 'way' && e.geometry && e.tags && e.tags.aeroway;
  if (!a) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  if (!pts.some(([x, z]) => inBox(x, z))) continue;
  if (a === 'aerodrome') airport.name = e.tags.name || '';
  else if (a === 'runway' || a === 'taxiway') {
    const w = num(e.tags.width) || (a === 'runway' ? 45 : 18);
    for (const piece of clipChain(pts)) (a === 'runway' ? airport.runways : airport.taxiways).push([e.tags.ref || '', w, flat(rdp(piece, 0.3))]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const piece = { x0: pts[i][0], z0: pts[i][1], x1: pts[i + 1][0], z1: pts[i + 1][1], r: w / 2 + (a === 'runway' ? 4 : 1) };
      cutters.push(piece);
      airfieldPieces.push(piece);
    }
  } else if (a === 'jet_bridge' && pts.length > 1) {
    // a gate's boarding bridge: from the terminal to the aircraft's door
    const [p0, p1] = [pts[0], pts[pts.length - 1]];
    airport.gates.push([q(p0[0]), q(p0[1]), q(p1[0]), q(p1[1])]);
  } else if ((a === 'apron' || a === 'helipad') && pts.length > 3) {
    const ring = rdpRing(pts.slice(0, -1), 0.3);
    (a === 'apron' ? airport.aprons : airport.helipads).push(flat(ring));
    if (a === 'apron') airportRings.push(ring);
  }
}
log(`airport ${airport.name || '(none)'}: ${airport.runways.length} runway, ${airport.taxiways.length} taxiways, ${airport.aprons.length} aprons, ${airport.helipads.length} helipads`);
for (const s of drivePieces) clearCapsule(land, W, H, X0, Z0, RES, s);
for (const s of cutters) clearCapsule(land, W, H, X0, Z0, RES, s);
// (the aprons too: the cells whose centres lie inside their rings)
for (const ring of airportRings) {
  const bb = bbox(ring);
  for (let j = Math.max(0, Math.floor((bb.z0 - Z0) / RES)); j <= Math.min(H - 1, Math.ceil((bb.z1 - Z0) / RES)); j++) {
    const z = Z0 + (j + 0.5) * RES;
    const xs = [];
    for (let a = 0, k = ring.length - 1; a < ring.length; k = a++) {
      const [xa, za] = ring[k], [xb, zb] = ring[a];
      if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
    }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      for (let i = Math.max(0, Math.ceil((xs[n] - X0) / RES - 0.5)); i <= Math.min(W - 1, Math.floor((xs[n + 1] - X0) / RES - 0.5)); i++) land[j * W + i] = 0;
    }
  }
}
log(`${drivePieces.length} roadway pieces and ${cutters.length} other cuts stamped on a ${W} x ${H} raster`);
// Urban or open country: the share of each island under built-up land use (OSM landuse=residential & co., schools,
// building footprints) against fields, woods & scrub. Small islands are always city blocks.
const URBAN_USE = (t) => /^(residential|commercial|retail|industrial|education|institutional|religious|construction|garages)$/.test(t.landuse || '') ||
  /^(school|university|college|hospital|marketplace|bus_station|place_of_worship|parking)$/.test(t.amenity || '');
const RURAL_USE = (t) => /^(farmland|meadow|orchard|forest|grass|greenfield|quarry|plant_nursery|vineyard|farmyard)$/.test(t.landuse || '') ||
  /^(wood|scrub|grassland|heath|wetland|bare_rock)$/.test(t.natural || '');
function classify(comps, labels) {
  const urban = new Map();
  const green = new Map();
  const r = { lab: labels, w: W, h: H, x0: X0, z0: Z0, res: RES };
  const tally = (map, ring) => ringCells(ring, r, (L) => map.set(L, (map.get(L) || 0) + 1));
  for (const e of landOSM.elements) {
    const t = e.tags || {};
    const u = URBAN_USE(t), g = !u && RURAL_USE(t);
    if (!u && !g) continue;
    for (const ring of elemRings(e)) tally(u ? urban : green, ring);
  }
  for (const e of bldOSM.elements) for (const ring of elemRings(e)) tally(urban, ring);
  const out = new Set();
  for (const c of comps) {
    const ha = (c.n * RES * RES) / 10000;
    if (ha < 1.5) continue;
    const us = (urban.get(c.id) || 0) / c.n;
    const gs = (green.get(c.id) || 0) / c.n;
    if ((ha > 4 && us < 0.25) || (ha > 60 && us < 0.6) || gs > 0.5) out.add(c.id);
  }
  return out;
}
const { blocks, lab, prop } = extractBlocks({ land, w: W, h: H, x0: X0, z0: Z0, res: RES, sidewalk: SIDEWALK, classify });
// the raster cell under world (x, z) (-1 off the raster), the block label there (0: a roadway or off the raster) and
// whether it lies inside a property line
const cellAt = (x, z) => {
  const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
  return i >= 0 && j >= 0 && i < W && j < H ? j * W + i : -1;
};
const labAt = (x, z) => { const k = cellAt(x, z); return k < 0 ? 0 : lab[k]; };
const propAt = (x, z) => { const k = cellAt(x, z); return k < 0 ? 0 : prop[k]; };

// --- Parks, pitches, schoolyards, scrub & water onto the blocks ---------------------------------------------------------
function elemRings(e) {
  if (e.type === 'way') {
    const r = (e.geometry || []).map((g) => toWorld(g.lon, g.lat));
    return r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.5 ? [r.slice(0, -1)] : [];
  }
  const parts = (e.members || []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.map((g) => toWorld(g.lon, g.lat)));
  return stitch(parts).filter((r) => r.pts.length > 3).map((r) => (r.closed ? r.pts.slice(0, -1) : r.pts));
}
// Polylines [[x, z], ...] joined end to end where they meet (within 0.5 m), either way round: [{ pts, closed }], a
// closed one ending on its first point (a relation's outer ring, a roundabout drawn as several ways)
function stitch(parts) {
  parts = parts.slice();
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  const out = [];
  while (parts.length) {
    let pts = parts.shift();
    for (let guard = 0; guard < 500 && !close(pts[0], pts[pts.length - 1]); guard++) {
      const i = parts.findIndex((p) => close(p[0], pts[pts.length - 1]) || close(p[p.length - 1], pts[pts.length - 1]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      pts = pts.concat(close(p[0], pts[pts.length - 1]) ? p.slice(1) : p.slice().reverse().slice(1));
    }
    out.push({ pts, closed: close(pts[0], pts[pts.length - 1]) });
  }
  return out;
}
// a ring's vertices `d` m inwards (each vertex along the bisector of its two edges' inward normals)
function insetRing(ring, d) {
  return ring.map((_, i) => insetVertex(ring, i, d));
}
// the vertices `idx` of a ring, `d` m inwards: a stretch of its outline as an open polyline
function insetRun(ring, idx, d) {
  return idx.map((i) => insetVertex(ring, i, d));
}
function insetVertex(ring, i, d) {
  const n = ring.length;
  const p = ring[i], a = ring[(i + n - 1) % n], b = ring[(i + 1) % n];
  const inward = (u, v) => {
    const L = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1;
    let nx = (v[1] - u[1]) / L, nz = -(v[0] - u[0]) / L;
    if (!inRing(ring, (u[0] + v[0]) / 2 + nx * 0.3, (u[1] + v[1]) / 2 + nz * 0.3)) { nx = -nx; nz = -nz; }
    return [nx, nz];
  };
  const [n1x, n1z] = inward(a, p), [n2x, n2z] = inward(p, b);
  let bx = n1x + n2x, bz = n1z + n2z;
  const bl = Math.hypot(bx, bz);
  if (bl < 1e-3) return [p[0] + n1x * d, p[1] + n1z * d];
  bx /= bl; bz /= bl;
  const k = Math.min(3, 1 / Math.max(0.33, bx * n1x + bz * n1z)); // the miter, capped at sharp corners
  return [p[0] + bx * d * k, p[1] + bz * d * k];
}
// point (x, z) inside the ring [[x, z], ...] (even-odd rule)
function inRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
const GREEN = (t) => {
  if (/^(park|garden|pitch|playground|stadium|track|sports_centre|recreation_ground|golf_course|nature_reserve|dog_park|common)$/.test(t.leisure || '')) return t.leisure;
  if (/^(grass|cemetery|recreation_ground|village_green|forest|meadow|farmland|orchard|greenfield|flowerbed)$/.test(t.landuse || '')) return t.landuse;
  if (/^(wood|scrub|grassland|heath|water|wetland)$/.test(t.natural || '')) return t.natural;
  return null;
};
const greens = [];
for (const e of landOSM.elements) {
  const t = e.tags || {};
  const cat = GREEN(t);
  if (!cat) continue;
  const rings = elemRings(e).filter((r) => Math.abs(ringArea(r)) > 150);
  if (!rings.length) continue;
  greens.push({ name: t.name || '', cat, rings });
}
const raster = { lab, w: W, h: H, x0: X0, z0: Z0, res: RES };
const byLab = new Map(blocks.map((b) => [b._lab, b]));
const parkOf = new Map();
for (const g of greens) {
  for (const ring of g.rings) {
    const counts = new Map();
    ringCells(ring, raster, (L) => counts.set(L, (counts.get(L) || 0) + 1));
    for (const [L, n] of counts) {
      const b = byLab.get(L);
      if (!b) continue;
      b.parkCells = (b.parkCells || 0) + n;
      const prev = parkOf.get(b);
      if (!prev || n > prev.cells) parkOf.set(b, { name: g.name, cells: n });
    }
  }
}
for (const b of blocks) {
  b.park = b.rural ? 1 : Math.min(1, Math.round(((b.parkCells || 0) / b.cells) * 100) / 100);
  b.parkName = parkOf.get(b)?.name || '';
}
// Roundabouts (junction=roundabout | circular, often mapped as several ways): the island inside the ring is a planted
// glorieta, never a block of houses (an island 20-80 m across is too wide for a median and has no real footprints)
{
  const chains = ways.filter((w) => /^(roundabout|circular)$/.test(w.tags.junction || '') && DRIVE.has(w.tags.highway))
    .map((w) => w.geometry.map((g) => toWorld(g.lon, g.lat)));
  const rings = stitch(chains).filter((r) => r.closed && r.pts.length > 3).map((r) => r.pts.slice(0, -1));
  let islands = 0;
  for (const b of blocks) {
    if (b.rural) continue;
    const [cx, cz] = centroid(b.poly);
    const ring = rings.find((r) => Math.abs(ringArea(b.poly)) < Math.abs(ringArea(r)) && inRing(r, cx, cz));
    if (!ring) continue;
    b.park = 1;
    b.parkName = b.parkName || 'Glorieta';
    b.roundabout = true;
    islands++;
  }
  log(`${rings.length} roundabouts, ${islands} islands planted`);
}
log(`${greens.length} green/water areas; ${blocks.filter((b) => b.park > 0.6).length} park blocks`);
const parks = greens.filter((g) => g.name || g.rings.some((r) => Math.abs(ringArea(r)) > 2500)).map((g) => ({
  name: g.name, cat: g.cat, acres: Math.round((g.rings.reduce((t, r) => t + Math.abs(ringArea(r)), 0) / 4046.86) * 10) / 10,
  rings: g.rings.map((r) => flat(rdpRing(r, 0.8)))
}));

// =====================================================================================================================
// 5. PLACES, POINTS OF INTEREST, NOTABLE FOOTPRINTS
// =====================================================================================================================
const places = [];
const pois = [];
const center = (e) => (e.type === 'node' ? toWorld(e.lon, e.lat) : e.center ? toWorld(e.center.lon, e.center.lat) : null);
for (const e of poisOSM.elements) {
  const t = e.tags || {};
  const p = center(e);
  if (!p || !t.name) continue;
  if (/^(neighbourhood|quarter|suburb)$/.test(t.place || '')) { places.push({ name: t.name, x: q(p[0]), z: q(p[1]) }); continue; }
  const kind = t.tourism || t.historic || t.amenity || (t.natural === 'peak' ? 'peak' : null) || t.leisure;
  if (!kind || /^(motel|hotel|hostel|camp_site)$/.test(kind)) continue;
  pois.push({ name: t.name, kind, x: q(p[0]), z: q(p[1]) });
}
for (const e of landOSM.elements) {
  const t = e.tags || {};
  const kind = t.leisure === 'park' || t.leisure === 'stadium' || t.amenity === 'marketplace' || t.amenity === 'bus_station' || t.amenity === 'hospital' || t.amenity === 'university' ? (t.leisure || t.amenity) : null;
  if (!kind || !t.name) continue;
  const rings = elemRings(e);
  const p = rings.length ? centroid(rings[0]) : null;
  if (!p || !inBox(p[0], p[1])) continue;
  if (pois.some((o) => o.name === t.name && Math.hypot(o.x - p[0], o.z - p[1]) < 150)) continue;
  pois.push({ name: t.name, kind, x: q(p[0]), z: q(p[1]) });
}
log(`${places.length} neighbourhoods, ${pois.length} points of interest`);

const landmarks = {};
for (const e of bldOSM.elements) {
  const t = e.tags || {};
  if (!t.name || !/^(cathedral|church|train_station|stadium|hospital|government|public|university|hotel|cathedral)$/.test(t.building || '')) continue;
  const r = elemRings(e)[0];
  if (!r || !inBox(...centroid(r))) continue;
  const b = bbox(r);
  const area = Math.abs(ringArea(r));
  if (landmarks[t.name] && landmarks[t.name].area >= area) continue;
  landmarks[t.name] = { x: q((b.x0 + b.x1) / 2), z: q((b.z0 + b.z1) / 2), w: q(b.x1 - b.x0), d: q(b.z1 - b.z0), h: num(t.height), area: Math.round(area), ring: flat(rdpRing(r, 0.4)), kind: t.building };
}
log(`${Object.keys(landmarks).length} notable footprints`);

// =====================================================================================================================
// 5B. HOUSES: every building footprint of Overture Maps (OpenStreetMap + Microsoft & Google ML footprints), as the
//     oriented box the game builds: kept inside the property line, its front towards the nearest street
// =====================================================================================================================
const HS = 8; // integers per house (see `houses` below)
// bits of a house's kind (its 7th integer, over the front side 0-3): a shop on the ground floor, a big box (a hall: a
// supermarket, department store, mall or warehouse), a strip plaza (a row of locales under one roof), a house of a
// gated community (fraccionamiento / coto, see 5B2: its number + 1 from bit COTO_SHIFT up)
const KIND = { shop: 4, big: 8, strip: 16, coto: 32 };
const COTO_SHIFT = 6;
const houses = [];
{
  const file = path.join(DATA, 'overture', 'buildings.geojsonl');
  const hashf = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  // OpenStreetMap's commercial buildings (the malls, supermarkets & department stores mapped by hand), to tell the
  // Overture footprint standing on one from the houses: the ML footprints carry no use at all (98.8% of them)
  const STORE_SHOP = /^(mall|supermarket|department_store|wholesale|doityourself|hardware|furniture|car|garden_centre|variety_store|trade)$/;
  const STORE_BUILDING = /^(retail|commercial|supermarket|warehouse|industrial)$/;
  const stores = [];
  for (const e of bldOSM.elements) {
    const t = e.tags || {};
    if (!STORE_SHOP.test(t.shop || '') && !STORE_BUILDING.test(t.building || '')) continue;
    for (const ring of elemRings(e)) stores.push({ ring, box: bbox(ring), mall: t.shop === 'mall' || /^plaza\b|centro comercial/i.test(t.name || '') });
  }
  const storeAt = (x, z) => stores.find((s) => x > s.box.x0 && x < s.box.x1 && z > s.box.z0 && z < s.box.z1 && inRing(s.ring, x, z));
  let read = 0, small = 0, outside = 0, squeezed = 0, bigBoxes = 0;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    let start = 0;
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      const line = text.slice(start, end);
      start = end + 1;
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      read++;
      const g = f.geometry;
      const outer = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
      if (!outer || outer.length < 4) continue;
      const ring = outer.map(([lon, lat]) => toWorld(lon, lat));
      const area = Math.abs(ringArea(ring));
      if (area < 25 || area > 120000) { small++; continue; }
      const r = minAreaRect(ring);
      if (!r || !inBox(r.cx, r.cz) || !labAt(r.cx, r.cz)) { outside++; continue; }
      if (byLab.get(labAt(r.cx, r.cz))?.roundabout) { outside++; continue; } // (a glorieta's monument base or kiosk)
      let { cx, cz, w, d } = r;
      const th = r.th, cs = Math.cos(th), sn = Math.sin(th);
      const toW = (u, v) => [cx + u * cs + v * sn, cz - u * sn + v * cs];
      // Pull each side back (0.4 m at a time) while it reaches past the property line: the footprint and our curbs
      // are mapped independently and the street's width is only nominal
      let ok = false;
      for (let it = 0; it < 24; it++) {
        const hw = w / 2, hd = d / 2;
        const bad = [
          [toW(-hw, -hd * 0.9), toW(-hw, 0), toW(-hw, hd * 0.9)],
          [toW(hw, -hd * 0.9), toW(hw, 0), toW(hw, hd * 0.9)],
          [toW(-hw * 0.9, -hd), toW(0, -hd), toW(hw * 0.9, -hd)],
          [toW(-hw * 0.9, hd), toW(0, hd), toW(hw * 0.9, hd)]
        ].map((pts) => pts.some(([x, z]) => !propAt(x, z)));
        if (!bad.some(Boolean)) { ok = true; break; }
        const step = 0.4;
        if (bad[0]) { w -= step; cx += step / 2 * cs; cz -= step / 2 * sn; }
        if (bad[1]) { w -= step; cx -= step / 2 * cs; cz += step / 2 * sn; }
        if (bad[2]) { d -= step; cx += step / 2 * sn; cz += step / 2 * cs; }
        if (bad[3]) { d -= step; cx -= step / 2 * sn; cz -= step / 2 * cs; }
        if (w < 3 || d < 3) break;
      }
      if (!ok || w < 3 || d < 3) { squeezed++; continue; }
      // Front: the side with the nearest roadway straight out from its middle (w, e, n, s of the house's own frame)
      const outs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      let front = 0, bestD = Infinity;
      outs.forEach(([ou, ov], k) => {
        const reach = ou ? w / 2 : d / 2;
        for (let t = 0.5; t < 30; t += 0.5) {
          const [x, z] = toW(ou * (reach + t), ov * (reach + t));
          if (!labAt(x, z)) { if (t < bestD) { bestD = t; front = k; } return; }
        }
      });
      // Storeys: the mapped ones, else by size & place (one-storey houses on the colonias, more in the centro)
      const p = f.properties || {};
      const cls = p.class || '';
      const centro = Math.hypot(cx, cz) < 650;
      const hr = hashf(cx, cz);
      let floors = p.num_floors ? Math.round(p.num_floors) : p.height ? Math.max(1, Math.round(p.height / 3)) : 0;
      if (!floors) {
        if (area < 45) floors = 1;
        else if (centro) floors = hr < 0.3 ? 1 : hr < 0.82 ? 2 : 3;
        else if (area > 600) floors = hr < 0.7 ? 1 : 2;
        else floors = hr < 0.6 ? 1 : hr < 0.94 ? 2 : 3;
      }
      floors = Math.min(12, Math.max(1, floors));
      // Big boxes (a supermarket, a department store, a mall, a warehouse): a building mapped as one in OpenStreetMap or
      // Overture, or simply too big for a house (1500 m2 and 20 m deep: Tepic's houses run 60-300 m2), built as one hall
      // with no house split, tinaco or rejas. Malls of OSM too small to be a hall are a row of locales (a strip plaza)
      const store = storeAt(...centroid(ring));
      const big = (area >= 1500 && Math.min(w, d) >= 20) || (area >= 700 && (!!store || /supermarket|warehouse|industrial|retail|commercial/.test(cls)));
      const strip = !big && !!store && store.mall;
      if (big) {
        floors = p.num_floors ? Math.min(3, Math.round(p.num_floors)) : area > 6000 ? 3 : 2; // (a hall 6-9 m high)
        bigBoxes++;
      }
      // Ground floor shops: tagged commercial buildings, most of the centro, a few on every street
      const shop = big || strip || /commercial|retail|office|supermarket|hotel/.test(cls) || (bestD < 6 && (centro ? hr > 0.25 : hashf(cz, cx) < 0.12));
      houses.push(Math.round(cx * 10), Math.round(cz * 10), Math.round(w * 10), Math.round(d * 10), Math.round(th * 1000), floors,
        front + (shop ? KIND.shop : 0) + (big ? KIND.big : 0) + (strip ? KIND.strip : 0), 0);
    }
  }
  log(`houses: ${houses.length / HS} built of ${read} Overture footprints (${small} too small or large, ${outside} off the blocks, ${squeezed} squeezed out by the streets), ${bigBoxes} big boxes`);
}

// =====================================================================================================================
// 5B2. GATED COMMUNITIES (fraccionamientos cerrados, cotos): the blocks along streets mapped access=private, each
//      network of such streets one coto. Walled round along the property line where it faces a public street (a barda
//      of ~2.6 m), a guard booth (caseta) & barrier arm where a private street meets a public one, and the same house
//      over and over inside: one colour, one height, no shops (one developer built them all)
// =====================================================================================================================
const cotos = [];
{
  // (drivable streets only: a private service road or driveway is a car park's or a house's, not a coto's)
  const PRIVATE = (t) => /^(private|residents)$/.test(t.access || '') && /^(residential|living_street|unclassified)$/.test(t.highway);
  const priv = ways.filter((w) => PRIVATE(w.tags) && w.geometry.length > 1);
  // the private streets' roadways on a raster (1: a private street)
  const privRaster = new Uint8Array(W * H).fill(1);
  const privSegs = priv.map((w) => {
    const r = roadSpec(w.tags).w / 2 + 0.3;
    const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
    for (let i = 0; i + 1 < pts.length; i++) clearCapsule(privRaster, W, H, X0, Z0, RES, { x0: pts[i][0], z0: pts[i][1], x1: pts[i + 1][0], z1: pts[i + 1][1], r });
    return { w, r, pts };
  });
  const isPriv = (x, z) => { const k = cellAt(x, z); return k >= 0 && privRaster[k] === 0; };
  // where a private street meets a public one: the gates (the public streets' nodes, and those a public street ends on)
  const pubNodes = new Set();
  const pubEnds = new Map(); // node -> [{ w, pts, e }], a public street ending there (its end index e)
  for (const w of ways) {
    if (!DRIVE.has(w.tags.highway) || PRIVATE(w.tags)) continue;
    for (const g of w.geometry) pubNodes.add(nodeKey(g));
    for (const e of [0, w.geometry.length - 1]) {
      const k = nodeKey(w.geometry[e]);
      if (!pubEnds.has(k)) pubEnds.set(k, []);
      pubEnds.get(k).push({ w, e });
    }
  }
  // the point `dist` m along a polyline from its vertex i, stepping `step` (±1) vertices at a time (at most 80% of the
  // way to its end), and the direction there
  const walk = (pts, i, step, dist) => {
    let total = 0;
    for (let k = i; k + step >= 0 && k + step < pts.length; k += step) total += Math.hypot(pts[k + step][0] - pts[k][0], pts[k + step][1] - pts[k][1]);
    let left = Math.min(dist, total * 0.8);
    let last = null;
    for (let k = i; k + step >= 0 && k + step < pts.length; k += step) {
      const a = pts[k], b = pts[k + step];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-6) continue;
      last = { x: b[0], z: b[1], ux: (b[0] - a[0]) / L, uz: (b[1] - a[1]) / L };
      if (L >= left) return { x: a[0] + last.ux * left, z: a[1] + last.uz * left, ux: last.ux, uz: last.uz };
      left -= L;
    }
    return last;
  };
  // footprints per block (how many, how many house-sized), to tell a coto from a campus or an industrial park that
  // also has private streets
  const HOUSE_SIZED = 300; // m2: Tepic's houses run 60-300 m2
  const blockHouses = new Map();
  for (let i = 0; i < houses.length; i += HS) {
    const b = byLab.get(labAt(houses[i] / 10, houses[i + 1] / 10));
    if (!b) continue;
    const st = blockHouses.get(b) || { n: 0, small: 0 };
    st.n++;
    if ((houses[i + 2] * houses[i + 3]) / 100 <= HOUSE_SIZED) st.small++;
    blockHouses.set(b, st);
  }
  // networks of private streets (sharing a node)
  const parent = priv.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byNode = new Map();
  priv.forEach((w, i) => {
    for (const g of w.geometry) {
      const k = nodeKey(g);
      if (byNode.has(k)) parent[find(i)] = find(byNode.get(k));
      else byNode.set(k, i);
    }
  });
  const nets = new Map();
  privSegs.forEach((s, i) => {
    const root = find(i);
    if (!nets.has(root)) nets.set(root, []);
    nets.get(root).push(s);
  });
  const owner = new Map(); // block -> coto number
  let walled = 0;
  for (const segs of nets.values()) {
    // the blocks lining the network: probed from both sides of each street, clear of its mouths onto public streets
    const members = new Set();
    let length = 0;
    for (const { w, r, pts } of segs) {
      const mouths = w.geometry.filter((g) => pubNodes.has(nodeKey(g))).map((g) => toWorld(g.lon, g.lat));
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        length += L;
        if (L < 0.1) continue;
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        for (let t = 1; t < L; t += 2) {
          const x = ax + ((bx - ax) * t) / L, z = az + ((bz - az) * t) / L;
          if (mouths.some(([mx, mz]) => Math.hypot(x - mx, z - mz) < 18)) continue;
          for (const side of [-1, 1]) {
            const b = byLab.get(labAt(x + nx * side * (r + SIDEWALK + 2), z + nz * side * (r + SIDEWALK + 2)));
            if (b && !b.rural && b.park <= 0.6 && b.area < 150000 && !owner.has(b)) members.add(b);
          }
        }
      }
    }
    if (!members.size || length < 60) continue; // (a private lane or two: a gated cul-de-sac, not a coto)
    // (mostly bigger buildings than houses: a campus, a hospital, an industrial park)
    let n = 0, small = 0;
    for (const b of members) { const st = blockHouses.get(b); if (st) { n += st.n; small += st.small; } }
    if (n >= 10 && small < n * 0.6) continue;
    const id = cotos.length;
    for (const b of members) owner.set(b, id);
    // the barda: each member block's outline where it faces neither a private street nor another block of the coto,
    // pulled in to the property line
    const walls = [];
    for (const b of members) {
      const poly = b.poly;
      const n = poly.length;
      const wallEdge = poly.map((a, i) => {
        const c = poly[(i + 1) % n];
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (L < 0.5) return false;
        let nx = (c[1] - a[1]) / L, nz = -(c[0] - a[0]) / L;
        const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
        if (inRing(poly, mx + nx * 0.5, mz + nz * 0.5)) { nx = -nx; nz = -nz; }
        const px = mx + nx * 3, pz = mz + nz * 3;
        if (isPriv(px, pz)) return false;
        const other = byLab.get(labAt(px, pz));
        return !(other && owner.get(other) === id);
      });
      // runs of wall edges as polylines (starting after a gap, so a run never wraps)
      const start = wallEdge.findIndex((e) => !e);
      if (start < 0 && wallEdge.length) {
        walls.push(insetRing(poly, SIDEWALK + 0.15).concat([insetRing(poly, SIDEWALK + 0.15)[0]]));
        continue;
      }
      let run = null;
      for (let k = 1; k <= n; k++) {
        const i = (start + k) % n;
        if (wallEdge[i]) {
          if (!run) run = [i];
          run.push((i + 1) % n);
        } else if (run) { walls.push(insetRun(poly, run, SIDEWALK + 0.15)); run = null; }
      }
      if (run) walls.push(insetRun(poly, run, SIDEWALK + 0.15));
    }
    // the gates: each mouth of the network onto a public street, the booth 12 m inside along the private street (past
    // the public one's half width & sidewalk); where a public street ends on a private one part way along, 10 m back
    // along the public street, facing the coto
    const gates = [];
    const addGate = (at, width) => {
      if (!at) return;
      for (let g = 0; g < gates.length; g += 4) if (Math.hypot(gates[g] - at.x, gates[g + 1] - at.z) < 12) return; // (entry & exit drawn as two ways: one booth)
      gates.push(q(at.x), q(at.z), Math.round(Math.atan2(at.uz, at.ux) * 1000), q(width));
    };
    for (const { w, r, pts } of segs) {
      const last = pts.length - 1;
      w.geometry.forEach((g, e) => {
        const k = nodeKey(g);
        if (!pubNodes.has(k)) return;
        if (e === 0 || e === last) {
          addGate(walk(pts, e, e === 0 ? 1 : -1, 12), r * 2 - 0.6);
          return;
        }
        for (const end of pubEnds.get(k) || []) {
          const pp = end.w.geometry.map((p) => toWorld(p.lon, p.lat));
          const at = walk(pp, end.e, end.e === 0 ? 1 : -1, 10);
          if (at) addGate({ x: at.x, z: at.z, ux: -at.ux, uz: -at.uz }, roadSpec(end.w.tags).w - 0.6);
        }
      });
    }
    const lots = walls.filter((pl) => pl.length > 1).map((pl) => flat(rdp(pl, 0.4)));
    cotos.push([lots, gates]);
    walled += members.size;
  }
  // the houses inside: one look per coto (a colour, two storeys mostly), no shops; anything bigger than a house (the
  // clubhouse, a school, a tower of flats) keeps its own
  let cotoHouses = 0;
  const built = new Set();
  for (let i = 0; i < houses.length; i += HS) {
    const b = byLab.get(labAt(houses[i] / 10, houses[i + 1] / 10));
    const id = b ? owner.get(b) : undefined;
    if (id === undefined) continue;
    built.add(b);
    if (houses[i + 6] & (KIND.big | KIND.strip) || (houses[i + 2] * houses[i + 3]) / 100 > HOUSE_SIZED) continue;
    houses[i + 5] = id % 5 === 3 ? 1 : 2;
    houses[i + 6] = (houses[i + 6] & 3) | KIND.coto | ((id + 1) << COTO_SHIFT);
    cotoHouses++;
  }
  // Blocks of a coto none of the footprints stand on (newer fraccionamientos than the ML imagery): rows of the coto's
  // house, 7 m fronts by 12 m deep, along the sides facing its private streets
  let rowHouses = 0;
  const taken = new Set(); // raster cells under the row houses placed so far
  // the cells under a house centred on (cx, cz), w along (ex, ez) by d along (nx, nz), sampled every 0.7 m
  const cellsUnder = (cx, cz, ex, ez, nx, nz, w, d) => {
    const out = [];
    for (let u = -w / 2 + 0.2; u <= w / 2 - 0.2; u += 0.7) for (let v = -d / 2 + 0.2; v <= d / 2 - 0.2; v += 0.7) out.push(cellAt(cx + ex * u + nx * v, cz + ez * u + nz * v));
    return out;
  };
  for (const [b, id] of owner) {
    if (built.has(b) || b.area > 40000) continue;
    const poly = b.poly, n = poly.length;
    for (let e = 0; e < n; e++) {
      const a = poly[e], c = poly[(e + 1) % n];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L < 9) continue;
      const ex = (c[0] - a[0]) / L, ez = (c[1] - a[1]) / L;
      let nx = ez, nz = -ex; // inward normal
      if (!inRing(poly, (a[0] + c[0]) / 2 + nx * 0.5, (a[1] + c[1]) / 2 + nz * 0.5)) { nx = -nx; nz = -nz; }
      if (!isPriv((a[0] + c[0]) / 2 - nx * 3, (a[1] + c[1]) / 2 - nz * 3)) continue; // a side on a private street
      const th = Math.atan2(-ez, ex); // local u along the edge, local v = (-ez, ex)
      const front = -ez * nx + ex * nz > 0 ? 2 : 3; // the street lies against the inward normal
      const W0 = 7, D0 = 12, set = SIDEWALK + 0.4;
      const count = Math.floor((L - 2) / W0);
      const t0 = (L - count * W0) / 2;
      for (let k = 0; k < count; k++) {
        const t = t0 + (k + 0.5) * W0;
        const cx = a[0] + ex * t + nx * (set + D0 / 2), cz = a[1] + ez * t + nz * (set + D0 / 2);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => [cx + ex * su * W0 * 0.48 + nx * sv * D0 * 0.48, cz + ez * su * W0 * 0.48 + nz * sv * D0 * 0.48]);
        if (!corners.every(([x, z]) => propAt(x, z) && byLab.get(labAt(x, z)) === b)) continue;
        // (a house already there from another side of the block: the opposite one, or round the corner)
        const under = cellsUnder(cx, cz, ex, ez, nx, nz, W0, D0);
        if (under.some((k) => taken.has(k))) continue;
        for (const k of under) taken.add(k);
        houses.push(Math.round(cx * 10), Math.round(cz * 10), W0 * 10, D0 * 10, Math.round(th * 1000), id % 5 === 3 ? 1 : 2,
          front | KIND.coto | ((id + 1) << COTO_SHIFT), 0);
        rowHouses++;
      }
    }
  }
  log(`gated communities: ${rowHouses} row houses on their empty blocks`);
  log(`gated communities: ${cotos.length} cotos of ${priv.length} private streets, ${walled} blocks, ${cotoHouses} houses (${owner.size - built.size} blocks with none), ${cotos.reduce((t, c) => t + c[1].length / 4, 0)} gates`);
}

// =====================================================================================================================
// 5C. SHOP SIGNS: the businesses of Overture Maps' places on the buildings they stand in. Chains get a parody name in
//     their colours on a fascia band, local businesses their own name on the awning (the centro's first, while the
//     sign atlas has room), every other shop a generic sign of its trade
// =====================================================================================================================
const signs = [];
{
  // the chain stores' looks & parody names live in js/world/storefronts (one module per kind of store)
  const CHAINS = STOREFRONTS;
  const GENERIC = [
    [/tortiller/i, 'TORTILLERÍA'], [/carnicer/i, 'CARNICERÍA'], [/papeler/i, 'PAPELERÍA'], [/marisc/i, 'MARISCOS'],
    [/pollo/i, 'POLLOS ASADOS'], [/\btaco/i, 'TACOS'], [/birria/i, 'BIRRIA'], [/torta/i, 'TORTAS AHOGADAS'],
    [/panader|bakery/i, 'PANADERÍA'], [/ferreter|hardware/i, 'FERRETERÍA'], [/abarrote|food_and_beverage|grocery/i, 'ABARROTES'],
    [/mini ?s[uú]per|convenience/i, 'MINI SÚPER'], [/farmac|pharmacy/i, 'FARMACIA'], [/est[eé]tica|beauty|salon|barber/i, 'ESTÉTICA'],
    [/taller|automotive_service/i, 'TALLER MECÁNICO'], [/refaccion|vehicle_parts/i, 'REFACCIONARIA'], [/llant/i, 'LLANTERA'],
    [/dental/i, 'CONSULTORIO DENTAL'], [/ropa|boutique|fashion/i, 'BOUTIQUE'], [/zapat|shoe/i, 'ZAPATERÍA'],
    [/flor|flowers/i, 'FLORERÍA'], [/celular|electronics/i, 'CELULARES'], [/caf[eé]|cafe/i, 'CAFÉ'], [/bar\b|cantina/i, 'CANTINA'],
    [/hamburgues|fast_food/i, 'HAMBURGUESAS'], [/lonch|casual_eatery|food_truck/i, 'LONCHERÍA'], [/restaurant/i, 'RESTAURANTE'],
    [/gym|gimnas/i, 'GIMNASIO'], [/hotel|motel/i, 'HOTEL'], [/lavander/i, 'LAVANDERÍA'], [/cerrajer/i, 'CERRAJERÍA'],
    [/veterinari|pet/i, 'VETERINARIA'], [/optic/i, 'ÓPTICA'], [/muebler/i, 'MUEBLERÍA'], [/dulcer/i, 'DULCERÍA'], [/nieve|helad/i, 'NEVERÍA']
  ];
  const STREET_TRADES = ['ABARROTES', 'TORTILLERÍA', 'PAPELERÍA', 'MISCELÁNEA', 'FARMACIA', 'ESTÉTICA', 'TACOS', 'LONCHERÍA', 'CARNICERÍA',
    'FERRETERÍA', 'CELULARES', 'REFACCIONARIA', 'DULCERÍA', 'NEVERÍA', 'BIRRIA', 'MARISCOS', 'PANADERÍA', 'POLLOS ASADOS'];
  const LOCAL_COLOURS = [['#1f4e8c', '#ffffff'], ['#9e1b1b', '#fff3d6'], ['#1d6b3a', '#ffffff'], ['#f2b705', '#1a1a1a'], ['#ffffff', '#b3121b'],
    ['#6a1b9a', '#ffffff'], ['#e8611a', '#ffffff'], ['#0b7a75', '#ffffff'], ['#222222', '#ffd34d']];
  const ATLAS_SLOTS = 816; // js/world/buildings.js sign atlas: 8 columns x 102 rows
  const signIndex = new Map();
  const addSign = (key, entry) => {
    if (signIndex.has(key)) return signIndex.get(key);
    if (signs.length >= ATLAS_SLOTS) return 0;
    signs.push(entry);
    signIndex.set(key, signs.length);
    return signs.length;
  };
  const hashS = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };
  // chains first, then the trades, so neither is ever crowded out by local names
  CHAINS.forEach((sf, k) => addSign(`chain:${sf.id}`, { text: sf.name, ...sf.sign, chain: 1, big: sf.big ? 1 : 0, store: k }));
  for (const t of new Set([...GENERIC.map((g) => g[1]), ...STREET_TRADES, 'MISCELÁNEA'])) {
    const [bg, fg] = LOCAL_COLOURS[hashS(t) % LOCAL_COLOURS.length];
    addSign(`trade:${t}`, { text: t, bg, fg, border: fg });
  }
  const tradeOf = (name, cat) => {
    for (const [re, t] of GENERIC) if (re.test(name) || re.test(cat)) return t;
    return null;
  };

  // houses in 20 m cells, to find the building a business stands in
  const CELL = 20;
  const cells = new Map();
  for (let i = 0; i < houses.length; i += HS) {
    const k = `${Math.floor(houses[i] / 10 / CELL)},${Math.floor(houses[i + 1] / 10 / CELL)}`;
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(i);
  }
  const houseAt = (x, z, reach) => {
    let best = -1, bd = Infinity;
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      for (const i of cells.get(`${ix + a},${iz + b}`) || []) {
        const cx = houses[i] / 10, cz = houses[i + 1] / 10, hw = houses[i + 2] / 20, hd = houses[i + 3] / 20, th = houses[i + 4] / 1000;
        const dx = x - cx, dz = z - cz;
        const u = Math.abs(dx * Math.cos(th) - dz * Math.sin(th)) - hw, v = Math.abs(dx * Math.sin(th) + dz * Math.cos(th)) - hd;
        const d = Math.hypot(Math.max(0, u), Math.max(0, v)); // 0 inside the footprint
        if (d < bd || (d === 0 && bd === 0 && houses[i + 2] * houses[i + 3] < houses[best + 2] * houses[best + 3])) { bd = d; best = i; }
      }
    }
    return bd <= reach ? best : -1;
  };
  // the biggest building within `reach` m (a supermarket's pin often falls on its car park, its kiosk or the street)
  const biggestAt = (x, z, reach) => {
    let best = -1, ba = 0;
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      for (const i of cells.get(`${ix + a},${iz + b}`) || []) {
        const area = houses[i + 2] * houses[i + 3];
        if (area > ba && Math.hypot(x - houses[i] / 10, z - houses[i + 1] / 10) - Math.hypot(houses[i + 2], houses[i + 3]) / 20 <= reach) { ba = area; best = i; }
      }
    }
    return best;
  };

  const file = path.join(DATA, 'overture', 'places.geojsonl');
  const locals = [];
  let chains = 0, named = 0, generic = 0, plazas = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      const p = f.properties || {};
      const name = ((p.names && p.names.primary) || '').trim();
      const brand = (p.brand && p.brand.names && p.brand.names.primary) || '';
      const cat = p.basic_category || (p.taxonomy && p.taxonomy.primary) || '';
      if (!name || !f.geometry || f.geometry.type !== 'Point') continue;
      if (/school|place_of_learning|government|worship|college|university|real_estate|attorney|professional_service|home_service|event_or_party|manufacturer/.test(cat)) continue;
      const [x, z] = toWorld(f.geometry.coordinates[0], f.geometry.coordinates[1]);
      if (!inBox(x, z)) continue;
      // a shopping centre (Plaza Cigarrera, Plaza del Valle...; not a public square): the building it stands in is a row
      // of locales, unless it's a hall already
      if ((cat === 'shopping_mall' || /^plaza\b|centro comercial/i.test(name)) && !/public_plaza|park/.test(cat)) {
        const i = houseAt(x, z, 12);
        if (i >= 0 && !(houses[i + 6] & (KIND.big | KIND.coto))) { houses[i + 6] |= KIND.strip | KIND.shop; plazas++; }
      }
      const chain = CHAINS.find((sf) => sf.match.test(name) || sf.match.test(brand));
      if (chain) {
        const i = chain.big ? biggestAt(x, z, 40) : houseAt(x, z, 15);
        if (i < 0) continue;
        // (a convenience store or pharmacy inside a hall or a mall: the hall keeps its own front, height & name)
        if (!chain.big && houses[i + 6] & KIND.big) continue;
        houses[i + 7] = signIndex.get(`chain:${chain.id}`);
        houses[i + 6] |= KIND.shop;
        if (chain.big) houses[i + 6] = (houses[i + 6] | KIND.big) & ~KIND.strip;
        houses[i + 5] = chain.big ? Math.max(2, Math.min(houses[i + 5], 3)) : 1;
        chains++;
        continue;
      }
      const i = houseAt(x, z, 8);
      if (i < 0 || houses[i + 7] || houses[i + 6] & KIND.coto) continue; // (no shops inside a coto)
      locals.push({ i, name, cat, d: Math.hypot(x, z) });
    }
  }
  // local names, nearest the plaza first, while the atlas has room; the rest by trade
  locals.sort((a, b) => a.d - b.d);
  for (const l of locals) {
    if (houses[l.i + 7]) continue; // (several businesses in one building: the one nearest the plaza names it)
    let text = l.name.toUpperCase().replace(/\s+/g, ' ');
    if (text.length > 30) text = text.slice(0, 29).trim() + '…';
    const [bg, fg] = LOCAL_COLOURS[hashS(text) % LOCAL_COLOURS.length];
    let k = addSign(`name:${text}`, { text, bg, fg, border: fg });
    if (k) named++;
    else if (houses[l.i + 6] & KIND.big) continue; // (a hall carries its own name or none, never a trade's)
    else {
      k = signIndex.get(`trade:${tradeOf(l.name, l.cat) || 'MISCELÁNEA'}`);
      generic++;
    }
    houses[l.i + 7] = k;
    houses[l.i + 6] |= KIND.shop;
  }
  // shops with no business on record: a trade by the house's hash
  for (let i = 0; i < houses.length; i += HS) {
    if (!(houses[i + 6] & KIND.shop) || houses[i + 7] || houses[i + 6] & KIND.big) continue;
    const t = STREET_TRADES[hashS(`${houses[i]},${houses[i + 1]}`) % STREET_TRADES.length];
    houses[i + 7] = signIndex.get(`trade:${t}`);
  }
  log(`shop signs: ${plazas} shopping centres, ${chains} chain stores, ${named + generic} shops from ${locals.length} local businesses (${named} named, ${generic} by trade), ${signs.length} sign faces`);
}

// =====================================================================================================================
// 5D. TERRAIN: the hills around the valley (Cerro de San Juan, Cerro de la Cruz, the lomas) from the Terrarium elevation
//     tiles (tools/data/tepic/fetch-terrain.sh). The city itself stays flat: the valley floor's slow tilt (a wide blur
//     of the elevation under the streets & blocks) is taken off, and what rises above it fades in away from them.
//     That tilt is kept apart as `ground`, the town's own slopes (js/world/ground.js)
// =====================================================================================================================
const { ground = null, ...terrainGrid } = (() => {
  const dir = path.join(DATA, 'terrain');
  if (!fs.existsSync(dir)) return {};
  const Z = 12, N = 2 ** Z;
  const tiles = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = /^12_(\d+)_(\d+)\.png$/.exec(f);
    if (m) tiles.set(`${m[1]}_${m[2]}`, decodePNG(fs.readFileSync(path.join(dir, f)), zlib.inflateSync));
  }
  if (!tiles.size) return {};
  const pixel = (gx, gy) => {
    const t = tiles.get(`${Math.floor(gx / 256)}_${Math.floor(gy / 256)}`);
    if (!t) return NaN;
    const o = ((gy & 255) * 256 + (gx & 255)) * t.channels;
    return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768;
  };
  const elevation = (lon, lat) => {
    const r = (lat * Math.PI) / 180;
    const fx = ((lon + 180) / 360) * N * 256 - 0.5;
    const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N * 256 - 0.5;
    const x = Math.floor(fx), y = Math.floor(fy), tx = fx - x, ty = fy - y;
    return (pixel(x, y) * (1 - tx) + pixel(x + 1, y) * tx) * (1 - ty) + (pixel(x, y + 1) * (1 - tx) + pixel(x + 1, y + 1) * tx) * ty;
  };
  const CELL = 75;
  const TX0 = -17000, TZ0 = -16000, TX1 = 21000, TZ1 = 21000;
  const TW = Math.round((TX1 - TX0) / CELL) + 1, TH = Math.round((TZ1 - TZ0) / CELL) + 1;
  const E = new Float32Array(TW * TH), U = new Float32Array(TW * TH);
  // the built-up city: cells with houses, a cell around them, and the streets within three cells of them (roads &
  // tracks up the hills alone don't flatten them)
  const houseCount = new Uint16Array(TW * TH);
  for (let k = 0; k < houses.length; k += HS) {
    const i = Math.round((houses[k] / 10 - TX0) / CELL), j = Math.round((houses[k + 1] / 10 - TZ0) / CELL);
    if (i >= 0 && j >= 0 && i < TW && j < TH) houseCount[j * TW + i]++;
  }
  // (a chapel or antennas on a summit don't make it town: four buildings to a cell do)
  const built = houseCount.map((n) => (n >= 4 ? 1 : 0));
  const dilate = (src, r) => {
    const dst = new Uint8Array(src.length);
    for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
      if (!src[j * TW + i]) continue;
      for (let b = Math.max(0, j - r); b <= Math.min(TH - 1, j + r); b++) for (let a = Math.max(0, i - r); a <= Math.min(TW - 1, i + r); a++) dst[b * TW + a] = 1;
    }
    return dst;
  };
  const builtNear = dilate(built, 1), builtArea = dilate(built, 3), outskirts = dilate(built, 6);
  // The grid points around every roadway (the four corners of each cell a street crosses): the streets are drawn flat,
  // so no triangle under one may rise, or a stretch of street vanishes under a brown hump of hillside and comes out
  // the other side (the streets of the colonias up the lomas, the boulevards past empty lots)
  const roadV = new Uint8Array(TW * TH);
  // (the airfield likewise: the runway & taxiways as their strips, the apron cell by cell)
  for (const ring of airportRings) {
    const bb = bbox(ring);
    for (let z = bb.z0; z <= bb.z1; z += CELL / 4) for (let x = bb.x0; x <= bb.x1; x += CELL / 4) {
      if (!inRing(ring, x, z)) continue;
      const i = Math.floor((x - TX0) / CELL), j = Math.floor((z - TZ0) / CELL);
      if (i < 0 || j < 0 || i >= TW - 1 || j >= TH - 1) continue;
      roadV[j * TW + i] = roadV[j * TW + i + 1] = roadV[(j + 1) * TW + i] = roadV[(j + 1) * TW + i + 1] = 1;
    }
  }
  for (const s of [...drivePieces, ...airfieldPieces]) {
    const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    for (let t = 0; t <= L; t += CELL / 6) {
      const x = s.x0 + ((s.x1 - s.x0) * t) / Math.max(L, 1e-6), z = s.z0 + ((s.z1 - s.z0) * t) / Math.max(L, 1e-6);
      // (the roadway's edges too: a wide avenue near a cell line reaches into the next cell)
      for (const [ox, oz] of [[0, 0], [s.r, 0], [-s.r, 0], [0, s.r], [0, -s.r]]) {
        const i = Math.floor((x + ox - TX0) / CELL), j = Math.floor((z + oz - TZ0) / CELL);
        if (i < 0 || j < 0 || i >= TW - 1 || j >= TH - 1) continue;
        roadV[j * TW + i] = roadV[j * TW + i + 1] = roadV[(j + 1) * TW + i] = roadV[(j + 1) * TW + i + 1] = 1;
      }
    }
  }
  const roadAt = (x, z) => { const k = cellAt(x, z); return k >= 0 && lab[k] === 0; }; // (off the raster: no road)
  let missing = 0;
  for (let j = 0; j < TH; j++) {
    for (let i = 0; i < TW; i++) {
      const x = TX0 + i * CELL, z = TZ0 + j * CELL;
      const [lon, lat] = toLonLat(x, z);
      let e = elevation(lon, lat);
      if (!Number.isFinite(e)) { e = NaN; missing++; }
      E[j * TW + i] = e;
      // the city: built-up cells, and streets near them (a 4 x 4 sample of the cell)
      let road = 0;
      if (builtArea[j * TW + i]) {
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (roadAt(x + (a - 1.5) * CELL / 4, z + (b - 1.5) * CELL / 4)) road++;
      }
      U[j * TW + i] = builtNear[j * TW + i] || road >= 3 ? 1 : 0;
    }
  }
  // fill tiles we don't have with the mean
  let sum = 0, cnt = 0;
  for (const e of E) if (Number.isFinite(e)) { sum += e; cnt++; }
  for (let k = 0; k < E.length; k++) if (!Number.isFinite(E[k])) E[k] = sum / cnt;
  // separable box blur (3 passes ~ a Gaussian of sigma ~ r cells) over a w x h grid, the hills' by default
  const blur = (src, r, w = TW, h = TH, passes = 3) => {
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    for (let pass = 0; pass < passes; pass++) {
      for (let j = 0; j < h; j++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += a[j * w + Math.min(w - 1, Math.max(0, i))];
        for (let i = 0; i < w; i++) {
          b[j * w + i] = acc / (2 * r + 1);
          acc += a[j * w + Math.min(w - 1, i + r + 1)] - a[j * w + Math.max(0, i - r)];
        }
      }
      for (let i = 0; i < w; i++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += b[Math.min(h - 1, Math.max(0, j)) * w + i];
        for (let j = 0; j < h; j++) {
          a[j * w + i] = acc / (2 * r + 1);
          acc += b[Math.min(h - 1, j + r + 1) * w + i] - b[Math.max(0, j - r) * w + i];
        }
      }
    }
    return a;
  };
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  // The hills' heights h (m) over the valley floor, the floor being the elevation of the city cells U (1) nearby (near,
  // far: the blurred floor & its weights; D: metres to the city)
  const shape = (U) => {
    const EU = E.map((e, k) => e * U[k]);
    const near = [blur(EU, 7), blur(U, 7)];
    const far = [blur(EU, 30), blur(U, 30)];
    let usum = 0, ucnt = 0;
    for (let k = 0; k < E.length; k++) if (U[k]) { usum += E[k]; ucnt++; }
    const floorMean = ucnt ? usum / ucnt : sum / cnt;
    // distance (m) to the city: two-pass chamfer
    const D = new Float32Array(TW * TH).fill(1e9);
    for (let k = 0; k < D.length; k++) if (U[k]) D[k] = 0;
    const DG = CELL * Math.SQRT2;
    for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
      const k = j * TW + i;
      if (i > 0) D[k] = Math.min(D[k], D[k - 1] + CELL);
      if (j > 0) {
        D[k] = Math.min(D[k], D[k - TW] + CELL);
        if (i > 0) D[k] = Math.min(D[k], D[k - TW - 1] + DG);
        if (i < TW - 1) D[k] = Math.min(D[k], D[k - TW + 1] + DG);
      }
    }
    for (let j = TH - 1; j >= 0; j--) for (let i = TW - 1; i >= 0; i--) {
      const k = j * TW + i;
      if (i < TW - 1) D[k] = Math.min(D[k], D[k + 1] + CELL);
      if (j < TH - 1) {
        D[k] = Math.min(D[k], D[k + TW] + CELL);
        if (i < TW - 1) D[k] = Math.min(D[k], D[k + TW + 1] + DG);
        if (i > 0) D[k] = Math.min(D[k], D[k + TW - 1] + DG);
      }
    }
    const h = new Float32Array(TW * TH);
    for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
      const k = j * TW + i;
      // the valley floor here: the city's elevation nearby, else further out, else its mean
      const wN = near[1][k], wF = far[1][k];
      const base = wN > 0.05 ? near[0][k] / wN : wF > 0.01 ? far[0][k] / wF : floorMean;
      h[k] = Math.max(0, E[k] - base) * smooth(15, 150, D[k]);
      // fade out at the edge of the grid
      const edge = Math.min(i, j, TW - 1 - i, TH - 1 - j) * CELL;
      h[k] *= smooth(0, 2500, edge);
    }
    return { h, near, far, D, floorMean };
  };
  // The streets in town and out to 450 m from it under up to 30 m of hill join the valley floor (the colonias' streets
  // up the lomas, the boulevards past empty lots: a cut sloping back ~20° over the next 75-150 m); the ones deeper in a
  // hill stay under it rather than cut a canyon into the cerro
  const h0 = shape(U).h;
  let lifted = 0;
  for (let k = 0; k < U.length; k++) if (!U[k] && roadV[k] && outskirts[k] && h0[k] < 30) { U[k] = 1; lifted++; }
  const { h: hills, near, far, D, floorMean } = shape(U);
  const out = new Int16Array(TW * TH);
  let peak = 0;
  for (let k = 0; k < hills.length; k++) {
    let h = hills[k];
    // out in the country a road cuts through the low rises (up to 8 m) instead of under them; the highways over the
    // sierra stay where they are
    if (roadV[k] && h < 8) h = 0;
    out[k] = Math.round(Math.min(3200, h) * 10);
    if (h > peak) peak = h;
  }
  // The ground under the town (js/world/ground.js): the city's own elevation on a 37.5 m grid (about the elevation
  // tiles' own ~38 m pixels), its lone spikes taken off and lightly blurred: SRTM measures roofs & treetops, and what's
  // wanted is a street's grade, not each house, but a wide blur flattened the town's short steep streets into long
  // gentle rises. Like the hills'
  // floor it is the built-up cells' elevation only (a normalised blur), so a hill beside a street doesn't lift it, and
  // away from the city (and towards the grid's edge) it eases to the city's mean, the floor the hills stand on now. Its
  // cells halve the hills' 75 m ones, so the world laid on the ground is cut along one lattice for both
  // (ground.js clipToLattice).
  // Heights are over the datum, the lowest point of the town (built-up cells in BOX), so its ground is never under y = 0
  const GCELL = CELL / 2, GMARGIN = 1200, GEDGE = 600;
  // over the detailed city (BOX) and a margin for the roads leaving it, on whole cells of the hills' grid
  const GX0 = TX0 + Math.floor((BOX.x0 - GMARGIN - TX0) / CELL) * CELL, GZ0 = TZ0 + Math.floor((BOX.z0 - GMARGIN - TZ0) / CELL) * CELL;
  const GW = 2 * Math.ceil((BOX.x1 + GMARGIN - GX0) / CELL) + 1, GH = 2 * Math.ceil((BOX.z1 + GMARGIN - GZ0) / CELL) + 1;
  // a field of the hills' grid at (x, z), bilinear
  const coarse = (arr, x, z) => {
    const fx = Math.min(TW - 1.001, Math.max(0, (x - TX0) / CELL)), fz = Math.min(TH - 1.001, Math.max(0, (z - TZ0) / CELL));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * TW + i;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - tz) + (arr[k + TW] * (1 - tx) + arr[k + TW + 1] * tx) * tz;
  };
  const GE = new Float32Array(GW * GH), GU = new Float32Array(GW * GH), GD = new Float32Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i, x = GX0 + i * GCELL, z = GZ0 + j * GCELL;
    const e = elevation(...toLonLat(x, z));
    GE[k] = Number.isFinite(e) ? e : coarse(E, x, z);
    GU[k] = coarse(U, x, z);
    GD[k] = coarse(D, x, z);
  }
  // the roofs & treetops standing out of the ground one pixel at a time taken off (a 3 x 3 median), then a light blur
  const median = new Float32Array(GE.length);
  const around = new Float32Array(9);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    let n = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) around[n++] = GE[Math.min(GH - 1, Math.max(0, j + b)) * GW + Math.min(GW - 1, Math.max(0, i + a))];
    median[j * GW + i] = around.sort()[4];
  }
  const GEU = median.map((e, k) => e * GU[k]);
  const gNear = [blur(GEU, 1, GW, GH, 1), blur(GU, 1, GW, GH, 1)]; // (one pass over 3 x 3 cells, σ ~ 30 m)
  const gFar = [blur(GEU, 13, GW, GH), blur(GU, 13, GW, GH)]; // (~500 m)
  const GF = new Float32Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i;
    const wN = gNear[1][k], wF = gFar[1][k];
    const f = wN > 0.05 ? gNear[0][k] / wN : wF > 0.01 ? gFar[0][k] / wF : floorMean;
    const edge = Math.min(i, j, GW - 1 - i, GH - 1 - j) * GCELL;
    GF[k] = f + (floorMean - f) * Math.max(smooth(300, GMARGIN, GD[k]), 1 - smooth(0, GEDGE, edge));
  }
  // the datum is the lowest node under the town's streets & houses (a node of a cell with a built-up corner in BOX),
  // so no point of the town is under it
  const town = (i, j) => {
    const x = GX0 + i * GCELL, z = GZ0 + j * GCELL;
    return inBox(x, z) && coarse(U, x, z) >= 0.5;
  };
  let datum = Infinity, datumAt = [0, 0];
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    let near = false;
    for (let b = Math.max(0, j - 1); b <= Math.min(GH - 1, j + 1) && !near; b++) for (let a = Math.max(0, i - 1); a <= Math.min(GW - 1, i + 1); a++) if (town(a, b)) { near = true; break; }
    if (near && GF[j * GW + i] < datum) { datum = GF[j * GW + i]; datumAt = [GX0 + i * GCELL, GZ0 + j * GCELL]; }
  }
  datum = Math.round(datum * 10) / 10;
  const groundOut = new Int16Array(GW * GH);
  for (let k = 0; k < GF.length; k++) groundOut[k] = Math.round((GF[k] - datum) * 10);
  // the ground between the nodes, on the same triangles as ground.js (each cell split from its +x corner to its +z)
  const gAt = (x, z) => {
    const fx = (x - GX0) / GCELL, fz = (z - GZ0) / GCELL;
    const i = Math.min(GW - 2, Math.max(0, Math.floor(fx))), j = Math.min(GH - 2, Math.max(0, Math.floor(fz)));
    const tx = fx - i, tz = fz - j, k = j * GW + i;
    const h00 = groundOut[k], h10 = groundOut[k + 1], h01 = groundOut[k + GW], h11 = groundOut[k + GW + 1];
    return (tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz)) / 10;
  };
  {
    // the grades the town's streets get: drivable ways, sampled every 10 m, in the built-up city
    const grades = [];
    let top = 0;
    for (const w of ways) {
      if (!DRIVE.has(w.tags.highway)) continue;
      const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
        const len = Math.hypot(bx - ax, bz - az);
        for (let s = 0; s + 10 <= len; s += 10) {
          const x0 = ax + (bx - ax) * s / len, z0 = az + (bz - az) * s / len;
          const x1 = ax + (bx - ax) * (s + 10) / len, z1 = az + (bz - az) * (s + 10) / len;
          if (coarse(U, x0, z0) < 0.5 || !inBox(x0, z0)) continue;
          grades.push(Math.abs(gAt(x1, z1) - gAt(x0, z0)) / 10);
          top = Math.max(top, gAt(x0, z0));
        }
      }
    }
    grades.sort((a, b) => a - b);
    const pc = (q) => (grades[Math.floor(q * (grades.length - 1))] * 100).toFixed(1);
    const [dLon, dLat] = toLonLat(...datumAt);
    log(`ground: ${GW} x ${GH} cells of ${GCELL} m, datum ${datum} m a.s.l. (at ${dLat.toFixed(4)},${dLon.toFixed(4)}), town up to ${top.toFixed(0)} m over it, plaza ${gAt(0, 0).toFixed(1)} m; street grades p50 ${pc(0.5)}%, p90 ${pc(0.9)}%, p99 ${pc(0.99)}%, max ${pc(1)}%`);
  }
  const ground = { x0: GX0, z0: GZ0, cell: GCELL, w: GW, h: GH, datum, floor: Math.round((floorMean - datum) * 10) / 10, data: Buffer.from(groundOut.buffer).toString('base64') };

  // the cross on Cerro de la Cruz
  const crossPoi = (poisOSM.elements || []).find((e) => e.tags && /cerro de la cruz/i.test(e.tags.name || ''));
  const cross = crossPoi ? toWorld(crossPoi.lon, crossPoi.lat).map(q) : null;

  // The ways up the hills (the cobbled calzada to the cross, its stairs & footpaths, the tracks): each as
  // [surface (0 cobbles, 1 concrete / paving, 2 earth), width (m), flat points] where it climbs over 4 m of hill
  const heightAt = (x, z) => {
    const fx = (x - TX0) / CELL, fz = (z - TZ0) / CELL;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= TW - 1 || j >= TH - 1) return 0;
    const tx = fx - i, tz = fz - j, k = j * TW + i;
    return ((out[k] * (1 - tx) + out[k + 1] * tx) * (1 - tz) + (out[k + TW] * (1 - tx) + out[k + TW + 1] * tx) * tz) / 10;
  };
  const CLIMB = /^(unclassified|residential|tertiary|service|pedestrian|footway|path|steps|track|living_street)$/;
  const paths = [];
  let pathLen = 0;
  for (const w of ways) {
    const t = w.tags;
    if (!CLIMB.test(t.highway)) continue;
    const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
    let top = 0;
    for (const [x, z] of pts) top = Math.max(top, heightAt(x, z));
    if (top < 4) continue;
    // the trails & tracks of the far hills only near Cerro de la Cruz
    const minor = /^(path|track)$/.test(t.highway);
    if (minor && (!cross || Math.min(...pts.map(([x, z]) => Math.hypot(x - cross[0], z - cross[1]))) > 1500)) continue;
    const surf = t.surface || '';
    const surface = /cobble|sett|unhewn/.test(surf) ? 0 : /paving|concrete|asphalt|paved/.test(surf) || t.highway === 'steps' || t.highway === 'pedestrian' ? 1 : /^(unclassified|residential|tertiary|living_street)$/.test(t.highway) ? 0 : 2;
    const width = t.highway === 'path' ? 1.6 : t.highway === 'steps' || t.highway === 'footway' ? 2.2 : t.highway === 'pedestrian' ? 4 : t.highway === 'track' ? 3.2 : 5.5;
    const line = rdp(pts, 0.6);
    for (let i = 1; i < line.length; i++) pathLen += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    paths.push([surface, width, flat(line)]);
  }
  log(`hill paths: ${paths.length} ways, ${(pathLen / 1000).toFixed(1)} km`);
  if (process.env.TERRAIN_DEBUG) {
    for (const [name, x, z] of [['cross', ...(cross || [0, 0])], ['san juan', -3900, 1400], ['plaza', 0, 0]]) {
      const i = Math.round((x - TX0) / CELL), j = Math.round((z - TZ0) / CELL), k = j * TW + i;
      const wN = near[1][k], wF = far[1][k];
      const base = wN > 0.05 ? near[0][k] / wN : wF > 0.01 ? far[0][k] / wF : floorMean;
      log(`  ${name}: elevation ${E[k].toFixed(0)}, floor ${base.toFixed(0)}, urban ${U[k]}, ${D[k].toFixed(0)} m from the city, height ${out[k] / 10}`);
    }
  }
  log(`terrain: ${lifted} grid points under streets brought down to the valley floor`);
  log(`terrain: ${TW} x ${TH} cells of ${CELL} m, highest ${Math.round(peak)} m over the valley floor (${Math.round(floorMean)} m a.s.l.), ${missing} cells off the tiles`);
  return { x0: TX0, z0: TZ0, cell: CELL, w: TW, h: TH, floor: Math.round(floorMean), data: Buffer.from(out.buffer).toString('base64'), cross, paths, ground };
})();
const terrain = ground ? terrainGrid : null;

// =====================================================================================================================
// 6. TELEPORTS & START: named spots snapped onto the nearest drivable street
// =====================================================================================================================
const SPOTS = [
  ['plaza', 'Plaza Principal y Catedral', 'Av. México · Centro Histórico', 21.51224, -104.89269, 21.51184, -104.89121],
  ['alameda', 'La Alameda', 'Parque Juan Escutia · Centro', 21.50991, -104.90109],
  ['loma', 'Parque La Loma', 'Av. Insurgentes · La Loma', 21.50388, -104.89890],
  ['mercado', 'Mercado Morelos', 'Centro Histórico', 21.51075, -104.89532],
  ['uan', 'Estadio de Béisbol UAN', 'Ciudad de la Cultura · Av. Insurgentes', 21.49074, -104.88983],
  ['central', 'Central de Autobuses', 'Av. Insurgentes · Ciudad del Valle', 21.49839, -104.88706],
  ['estacion', 'Antigua estación del tren', 'Av. Allende · Ferrocarril', 21.50392, -104.88208],
  ['juventud', 'Parque Lineal Juventud', 'Colonia Juventud', 21.49525, -104.87694],
  ['xalisco', 'Xalisco Centro', 'Plaza Benito Juárez · Xalisco', 21.44370, -104.90170],
  ['bonaterra', 'Bonaterra', 'Libramiento · Bonaterra', 21.46550, -104.84385],
  ['aeropuerto', 'Aeropuerto de Tepic', 'Terminal · Pantanal', 21.41720, -104.83820, 21.41700, -104.83930]
];
const linkPts = links.map(([a, b, , , , dir, inner]) => {
  const pts = [gnodes[a]];
  for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
  pts.push(gnodes[b]);
  return { pts, dir };
});
function snapToStreet(x, z, faceX, faceZ) {
  let best = null;
  for (const l of linkPts) {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const px = ax + t * dx, pz = az + t * dz;
      const d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { d, px, pz, dx: dx / Math.sqrt(L2), dz: dz / Math.sqrt(L2), dir: l.dir };
    }
  }
  if (!best || best.d > 260) return null;
  let { dx, dz } = best;
  // travel direction: the street's one-way direction, else towards the thing to face
  if (best.dir < 0 || (best.dir === 0 && Number.isFinite(faceX) && dx * (faceX - best.px) + dz * (faceZ - best.pz) < 0)) { dx = -dx; dz = -dz; }
  const rx = -dz, rz = dx; // right of travel
  return { x: q(best.px + rx * 1.8), z: q(best.pz + rz * 1.8), heading: Math.round(Math.atan2(dx, dz) * 1000) / 1000 };
}
const teleports = {};
for (const [key, name, sub, lat, lon, flat2, flon] of SPOTS) {
  const [x, z] = toWorld(lon, lat);
  const face = flat2 !== undefined ? toWorld(flon, flat2) : [NaN, NaN];
  const s = snapToStreet(x, z, face[0], face[1]);
  if (!s) { log(`teleport ${key}: no street within 120 m`); continue; }
  teleports[key] = { name, sub, ...s };
}
log(`teleports: ${Object.keys(teleports).join(', ')}`);

// =====================================================================================================================
// 6B. PUBLIC TRANSPORT: the Secretaría de Movilidad's routes, driven along the road graph
// =====================================================================================================================
// Tepic's routes are run by camiones (midibuses painted in their route's colours, its name across the windshield)
// and combis (white Urvan & Hiace vans with the route's sign on the roof). The map doesn't say which serves which;
// photos of the streets do for some, and the game puts both on the rest.
const ROUTE_FLEET = [[/^Progreso/, 'bus'], [/^Mololoa/, 'bus'], [/^Cantera Hospitales/, 'combi'], [/^Allende$/, 'combi']];
const transit = { groups: [], routes: [] };
{
  const file = path.join(DATA, 'semovi_routes.json');
  if (fs.existsSync(file)) {
    const src = JSON.parse(fs.readFileSync(file, 'utf8'));
    const groups = src.geojson.groups || [];
    transit.groups = groups.map((g) => g.title.replace(/^Rutas? Tepic - /, ''));
    const match = createRouteMatcher(linkPts.map(({ pts, dir }, i) => ({ a: links[i][0], b: links[i][1], pts, dir })));
    let drawn = 0, on = 0;
    for (const f of src.geojson.features) {
      if (!f.geometry || f.geometry.type !== 'LineString') continue;
      const name = f.properties.title.trim();
      const r = match(f.geometry.coordinates.map(([lon, lat]) => toWorld(lon, lat)));
      drawn += r.samples;
      on += r.matched;
      if (!r.pieces.length) { log(`route ${name}: not on the map`); continue; }
      const fleet = (ROUTE_FLEET.find(([re]) => re.test(name)) || [, ''])[1];
      // [name, group index, the map's line colour, 'bus' | 'combi' | '' (both), loops 1 | 0, pieces: signed link refs]
      transit.routes.push([name, Math.max(0, groups.findIndex((g) => g.id === f.properties.group)), f.properties.stroke || '#5a5a5a',
        fleet, r.loop ? 1 : 0, r.pieces]);
      if (r.pieces.length > 1 || !r.loop) log(`route ${name}: ${r.pieces.length} piece(s), ${r.loop ? 'loops' : 'open'}, ${Math.round((100 * r.matched) / r.samples)}% on the map`);
    }
    log(`transit: ${transit.routes.length} routes, ${((100 * on) / Math.max(1, drawn)).toFixed(1)}% of their drawn length matched to streets`);
  } else log('transit: no semovi_routes.json (tools/data/tepic/fetch-routes.sh)');
}

// =====================================================================================================================
// 7. ASSEMBLE
// =====================================================================================================================
const GEO = {
  version: 2,
  frame: {
    city: 'Tepic', grid: false, waterfront: false,
    bearingDeg: Math.round((THETA * 180) / Math.PI * 100) / 100, origin: 'Plaza Principal de Tepic', units: 'm',
    lat0: LAT0, lon0: LON0,
    cutZ: BOX.z0 - 50, strip: 0, sidewalk: SIDEWALK,
    box: { ...BOX },
    start: teleports.plaza ? { x: teleports.plaza.x, z: teleports.plaza.z, heading: teleports.plaza.heading } : { x: 0, z: 0, heading: 0 }
  },
  manhattan: flat(boxRing),
  upperManhattan: [],
  innerShore: flat(boxRing),
  islands: {},
  boroughs: {},
  streets: [],
  avenues: [],
  broadway: [],
  plazas: [],
  roads: roadLines.map((r) => [r.name, q(r.w), r.dir, r.lanes, r.hw ? 1 : 0, flat(r.pts)]),
  // links: [a, b, name, width, lanes, dir, inner, lifts (dm over the ground at a, inner..., b; 0 when all at grade),
  // bridge (1: a bridge way)]
  roadGraph: { nodes: gnodes.flatMap(([x, z]) => [q(x), q(z)]), links, names, signals },
  // The railway: [flat points, lifts (dm, or 0), bridge (1: a bridge way), main line (1) or siding / yard (0)]
  rails,
  // [outline, lot rects, park share, park name, rectangular, frontage frames | 0, open country (no buildings) 1 | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0, b.rural ? 1 : 0]),
  parks,
  // [kind (river, stream, canal, drain, ditch), half-width of the gap between the blocks (m), name, flags (1
  // intermittent, 2 underground), flat points downstream]
  waterways,
  centralPark: null,
  piers: [],
  bridges: {},
  landmarks,
  points: {},
  places,
  pois,
  teleports,
  // Real buildings (Overture Maps), 8 integers each: centre x, z (dm), width, depth (dm, local x / z), turn θ
  // (mrad, world = c + R_y(θ)·local), storeys, front side (0 w, 1 e, 2 n, 3 s of the local frame) + KIND bits (4 a shop, 8 a big box, 16 a strip plaza, 32 a coto's house, its number + 1 from bit 6 up), sign
  // (1-based index into `signs`, 0 none)
  houseStride: HS,
  houses,
  // Gated communities (5B2), [walls, gates] each: walls, polylines along the property line (flat x, z); gates, 4 numbers
  // each: booth x, z (m), heading into the coto (mrad, atan2 of z over x), private street width (m)
  cotos,
  // Shop sign faces: { text, bg, fg, border, chain?, big? } (chains carry parody names)
  signs,
  // The hills around the valley: heights (dm, Int16 little-endian, base64) over the flat city on a w x h grid of
  // `cell` m from (x0, z0), row by row; `cross`: the Cerro de la Cruz summit
  terrain,
  // The ground under the town: heights (dm, Int16 little-endian, base64) over `datum` (m a.s.l., the
  // town's lowest point) on a w x h grid of `cell` m from (x0, z0), row by row; `floor`: its height away from town
  ground,
  // Bus & combi routes (6B): groups, the zones' names; routes, [name, group, colour, fleet 'bus' | 'combi' | '' (both),
  // loops 1 | 0, pieces], each piece the roadGraph links driven in turn (index + 1 from a to b, -(index + 1) back)
  transit,
  // The airport (4): runways & taxiways [ref, width (m), flat centreline], aprons & helipads (flat rings), gates (the
  // boarding bridges [x, z at the terminal, x, z at the aircraft])
  airport
};

const json = JSON.stringify(GEO);
const header = `// js/world/city-geodata.js — GENERATED by tools/build-tepic-geodata.mjs, do not edit by hand.
// Tepic, Nayarit in the simulation's world frame: 1 unit = 1 m, x = east along the centro's grid, z = south,
// origin at the Plaza Principal, axes turned ${GEO.frame.bearingDeg}° from true north.
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Source: © OpenStreetMap contributors (ODbL), via Overpass (tools/data/tepic/); bus & combi routes from the
// Secretaría de Movilidad del Estado de Nayarit.
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
