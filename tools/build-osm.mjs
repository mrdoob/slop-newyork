#!/usr/bin/env node
// tools/build-osm.mjs — generates js/building-geodata.js and js/tree-geodata.js (and their .bin.gz assets) for any
// city from OpenStreetMap, in the same formats as tools/build-buildings.py and tools/build-trees.py, so the runtime
// loads them unchanged. No dependencies beyond Node 18+.
//
// usage:
//   node tools/build-osm.mjs --bbox <south,west,north,east> [options]
//
// options:
//   --origin <lat,lon>     world origin (default: the centre of the bbox)
//   --bearing <degrees>    compass bearing of the world's -z ("north") axis, so a street grid lines up with the
//                          axes (default 0: -z is true north; Manhattan's grid is 29.02)
//   --nyc-frame            use this repository's Manhattan frame (tools/geo-base.mjs) instead of --origin/--bearing
//   --default-year <year>  construction year for buildings without one (facade styles follow it, see PORTING.md)
//   --level-height <m>     storey height for buildings tagged with levels but no height (default 3.2)
//   --input <file.json>    read a saved Overpass response instead of downloading
//   --save <file.json>     save the downloaded Overpass response
//   --out-dir <dir>        where to write the modules (default: js/)
//   --skip-buildings, --skip-trees
//
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright): credit it in your README.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRECISION = 0.5; // metres per stored coordinate unit
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://lz4.overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter'];

// Not buildings you could walk around: roofs over nothing, parking canopies, ruins, plans and skybridges
const EXCLUDED_BUILDINGS = new Set(['no', 'roof', 'carport', 'canopy', 'construction', 'proposed', 'planned', 'demolished',
  'destroyed', 'razed', 'ruins', 'abandoned', 'bridge', 'collapsed', 'disused', 'tent', 'container', 'shelter']);
// Storeys assumed when a building has neither height nor levels
const DEFAULT_LEVELS = {
  house: 2, detached: 2, semidetached_house: 2, terrace: 2, bungalow: 1, cabin: 1, farm: 2, hut: 1, shed: 1,
  garage: 1, garages: 1, kiosk: 1, toilets: 1, service: 1, greenhouse: 1, barn: 1, stable: 1, cowshed: 1, static_caravan: 1
};
const FALLBACK_LEVELS = 3;

// =====================================================================================================================
// Frame: local tangent plane, metres; x = east along the bearing, z = south (the same maths as tools/geo-base.mjs)
// =====================================================================================================================
export function createFrame({ lat, lon, bearing = 0 }) {
  const A = 6378137.0, E2 = 6.69437999014e-3;
  const phi = (lat * Math.PI) / 180, s = Math.sin(phi);
  const kx = (Math.PI / 180) * (A / Math.sqrt(1 - E2 * s * s)) * Math.cos(phi);
  const ky = (Math.PI / 180) * ((A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5));
  const theta = (bearing * Math.PI) / 180, c = Math.cos(theta), n = Math.sin(theta);
  return {
    description: `origin ${lat.toFixed(6)}, ${lon.toFixed(6)}; -z points ${bearing}° from true north`,
    toWorld(lonP, latP) {
      const e = (lonP - lon) * kx, nn = (latP - lat) * ky;
      return [e * c - nn * n, -(e * n + nn * c)];
    }
  };
}

async function nycFrame() {
  const log = console.log;
  console.log = () => {}; // geo-base reports its refinement of the grid frame
  try {
    const { toWorld } = await import(pathToFileURL(path.join(ROOT, 'tools/geo-base.mjs')).href);
    return { description: "this repository's Manhattan frame (tools/geo-base.mjs)", toWorld };
  } finally {
    console.log = log;
  }
}

// =====================================================================================================================
// Tags
// =====================================================================================================================
// Metres from an OSM length: "12", "12.5 m", "40 ft", "40'", "12'6\"" (OSM's default unit is the metre)
export function parseLength(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase().replace(',', '.');
  let m = /^(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/.exec(text);
  if (m) return (parseFloat(m[1]) * 12 + (m[2] ? parseFloat(m[2]) : 0)) * 0.0254;
  m = /^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|foot)?$/.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] && m[2].startsWith('f') ? v * 0.3048 : v;
}

// Construction year from start_date-style values: "1925", "1925-03-01", "~1900", "1890s", "before 1910", "C19"
export function parseYear(value) {
  if (value == null) return 0;
  const text = String(value);
  const m = /(1[6-9]\d\d|20\d\d|2100)/.exec(text);
  if (m) return +m[1];
  const century = /\bC(1[6-9]|20)\b/i.exec(text);
  return century ? (+century[1] - 1) * 100 + 50 : 0;
}

const levelsOf = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// Roof height in metres, or null for structures that should be skipped
export function buildingHeight(tags, levelHeight = 3.2) {
  if (tags.location === 'underground' || EXCLUDED_BUILDINGS.has(tags.building)) return null;
  // Raised structures (skybridges, overhangs) would float: their footprint isn't a building on the ground
  const minHeight = parseLength(tags.min_height);
  const minLevel = levelsOf(tags['building:min_level']);
  if ((minHeight && minHeight > 0) || (minLevel && minLevel > 0)) return null;
  const tagged = parseLength(tags.height) ?? parseLength(tags['building:height']);
  if (tagged != null && tagged > 0) return tagged;
  const levels = levelsOf(tags['building:levels']);
  const roof = levelsOf(tags['roof:levels']) || 0;
  if (levels != null && levels + roof > 0) return (levels + roof) * levelHeight;
  return (DEFAULT_LEVELS[tags.building] ?? FALLBACK_LEVELS) * levelHeight;
}

export function buildingYear(tags) {
  for (const key of ['start_date', 'building:start_date', 'construction_date', 'year_of_construction']) {
    const year = parseYear(tags[key]);
    if (year >= 1600 && year <= 2100) return year;
  }
  return 0;
}

// =====================================================================================================================
// Geometry: rings in world metres -> canonical integer rings on the 0.5 m grid
// =====================================================================================================================
export const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
};

export function pointInRing([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Ramer-Douglas-Peucker on a closed ring, dropping vertex jitter below `eps` metres
function simplifyRing(ring, eps) {
  if (ring.length < 4) return ring;
  const far = ring.reduce((best, p, i) => {
    const d = Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]);
    return d > best.d ? { d, i } : best;
  }, { d: -1, i: 0 }).i;
  const rdp = (pts) => {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, az] = pts[a], [bx, bz] = pts[b];
      const len = Math.hypot(bx - ax, bz - az) || 1e-9;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i][0] - ax) * (bz - az) - (pts[i][1] - az) * (bx - ax)) / len;
        if (d > best) { best = d; bi = i; }
      }
      if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const a = rdp(ring.slice(0, far + 1));
  const b = rdp([...ring.slice(far), ring[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsCross(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}

export function selfIntersects(ring) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the two edges meeting at vertex 0
      if (segmentsCross(a, b, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

// World ring [[x, z], ...] (open or closed) -> integer ring on the 0.5 m grid with no repeated, collinear or spike
// vertices, starting at its smallest point; null if nothing with an area is left
export function canonicalRing(ring) {
  let pts = ring.slice();
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  pts = simplifyRing(pts, PRECISION * 0.5).map(([x, z]) => [Math.round(x / PRECISION) || 0, Math.round(z / PRECISION) || 0]);
  for (let changed = true; changed && pts.length >= 3;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length >= 3; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length], p = pts[i], next = pts[(i + 1) % pts.length];
      if ((p[0] === prev[0] && p[1] === prev[1]) || cross(prev, p, next) === 0) {
        pts.splice(i, 1); // repeated, collinear or a spike back along the same line
        changed = true;
        i--;
      }
    }
  }
  if (pts.length < 3 || signedArea(pts) === 0) return null;
  return startAtSmallest(pts);
}

function startAtSmallest(pts) {
  const start = pts.reduce((best, p, i) => (p[0] < pts[best][0] || (p[0] === pts[best][0] && p[1] < pts[best][1]) ? i : best), 0);
  return [...pts.slice(start), ...pts.slice(0, start)];
}

// Integer ring turned to the requested winding (counterclockwise: positive area)
const orient = (ring, positive) => (signedArea(ring) > 0 === positive ? ring : startAtSmallest(ring.slice().reverse()));

// Closed rings from a relation's member ways, joined end to end where they share nodes
export function joinWays(ways) {
  const key = (p) => `${p[0]},${p[1]}`;
  const parts = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  while (parts.length) {
    let ring = parts.shift();
    while (key(ring[0]) !== key(ring[ring.length - 1])) {
      const end = key(ring[ring.length - 1]);
      const i = parts.findIndex((p) => key(p[0]) === end || key(p[p.length - 1]) === end);
      if (i < 0) break;
      const next = parts.splice(i, 1)[0];
      ring = ring.concat((key(next[0]) === end ? next : next.reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

// World polygons [{ outer, holes }] -> canonical polygons [[outer, ...holes], ...] (outer counterclockwise), or null
export function canonicalPolygons(polygons) {
  const out = [];
  for (const { outer, holes } of polygons) {
    const o = canonicalRing(outer);
    if (!o || selfIntersects(o)) continue;
    const shell = orient(o, true);
    const inner = [];
    for (const hole of holes) {
      const h = canonicalRing(hole);
      if (!h || selfIntersects(h) || !h.every((p) => pointInRing([p[0] + 0.25, p[1] + 0.25], shell) || pointInRing(p, shell))) continue;
      inner.push(orient(h, false));
    }
    inner.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    out.push([shell, ...inner]);
  }
  out.sort((a, b) => a[0][0][0] - b[0][0][0] || a[0][0][1] - b[0][0][1]);
  return out.length ? out : null;
}

// =====================================================================================================================
// OpenStreetMap -> buildings and trees
// =====================================================================================================================
export function overpassQuery([south, west, north, east], { buildings = true, trees = true } = {}) {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:600][maxsize:2147483648];
(
${buildings ? `  way["building"](${bbox});\n  relation["building"]["type"="multipolygon"](${bbox});\n` : ''}${trees ? `  node["natural"="tree"](${bbox});\n` : ''});
out geom;`;
}

async function download(query) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const endpoint of OVERPASS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'slop-city-builder/1.0 (three.js city sim)' },
          body: new URLSearchParams({ data: query })
        });
        const text = await res.text();
        if (res.ok) {
          const data = JSON.parse(text);
          if (Array.isArray(data.elements) && !data.remark) return text;
          console.warn(`[osm] ${endpoint}: ${data.remark || 'unexpected response'}`);
        } else {
          console.warn(`[osm] ${endpoint}: HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`[osm] ${endpoint}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  throw new Error('Overpass download failed on every endpoint.');
}

// Overpass JSON (out geom) -> { buildings: [{ height, year, polygons }], trees: [[x, z], ...], skipped }
export function extract(osm, { toWorld, bbox, defaultYear = 0, levelHeight = 3.2 }) {
  const [south, west, north, east] = bbox;
  const inBox = (lon, lat) => lat >= south && lat <= north && lon >= west && lon <= east;
  const project = (geometry) => geometry.map((g) => toWorld(g.lon, g.lat));
  const skipped = { excluded: 0, outside: 0, invalid: 0 };
  const candidates = [];

  // Building relations first: the ways that outline them (often tagged building too) are not separate buildings
  const outlineWays = new Set();
  for (const e of osm.elements) {
    if (e.type !== 'relation' || !e.tags || !e.tags.building) continue;
    for (const m of e.members || []) if (m.type === 'way' && m.role !== 'inner') outlineWays.add(m.ref);
  }
  for (const e of osm.elements) {
    const tags = e.tags || {};
    if (!tags.building || (e.type !== 'way' && e.type !== 'relation')) continue;
    if (e.type === 'way' && outlineWays.has(e.id)) continue;
    const height = buildingHeight(tags, levelHeight);
    if (height == null) { skipped.excluded++; continue; }
    let polygons;
    if (e.type === 'way') {
      if (!e.geometry || e.geometry.length < 4) { skipped.invalid++; continue; }
      polygons = [{ outer: project(e.geometry), holes: [] }];
    } else {
      const ways = (role) => (e.members || []).filter((m) => m.type === 'way' && m.geometry && (role === 'inner' ? m.role === 'inner' : m.role !== 'inner')).map((m) => project(m.geometry));
      const outers = joinWays(ways('outer'));
      const inners = joinWays(ways('inner'));
      polygons = outers.map((outer) => ({ outer, holes: inners.filter((h) => pointInRing(h[0], outer)) }));
    }
    const lonLat = e.type === 'way' ? e.geometry : (e.members || []).flatMap((m) => m.geometry || []);
    const lon = lonLat.reduce((s, g) => s + g.lon, 0) / lonLat.length, lat = lonLat.reduce((s, g) => s + g.lat, 0) / lonLat.length;
    if (!inBox(lon, lat)) { skipped.outside++; continue; }
    const canonical = canonicalPolygons(polygons);
    if (!canonical) { skipped.invalid++; continue; }
    const year = buildingYear(tags) || defaultYear;
    candidates.push({ height: Math.max(1, Math.round(height)), year: year >= 1600 && year <= 2100 ? Math.floor(year / 10) * 10 : 0, polygons: canonical });
  }

  const trees = new Map();
  for (const e of osm.elements) {
    if (e.type !== 'node' || !e.tags || e.tags.natural !== 'tree' || !inBox(e.lon, e.lat)) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    const p = [Math.round(x / PRECISION), Math.round(z / PRECISION)];
    trees.set(`${p[0]},${p[1]}`, p);
  }
  return { buildings: mortonOrder(candidates, (b) => b.polygons[0][0]), trees: mortonOrder([...trees.values()], (p) => p), skipped };
}

// Morton order keeps nearby items together, so the coordinate deltas stay small and compress well
function mortonOrder(items, pointOf) {
  if (!items.length) return items;
  const pts = items.map(pointOf);
  const ox = Math.min(...pts.map((p) => p[0])), oz = Math.min(...pts.map((p) => p[1]));
  const bits = Math.max(1, Math.max(...pts.map((p) => Math.max(p[0] - ox, p[1] - oz))).toString(2).length);
  const code = (p) => {
    let c = 0n;
    for (let i = 0; i < bits; i++) {
      c |= BigInt(((p[0] - ox) >> i) & 1) << BigInt(2 * i);
      c |= BigInt(((p[1] - oz) >> i) & 1) << BigInt(2 * i + 1);
    }
    return c;
  };
  return items.map((item, i) => ({ item, c: code(pts[i]) })).sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0)).map((e) => e.item);
}

// =====================================================================================================================
// Binary formats & modules (byte-compatible with tools/build-buildings.py and tools/build-trees.py)
// =====================================================================================================================
class Bytes {
  constructor() { this.data = []; }
  uint(v) {
    while (v > 127) { this.data.push((v & 127) | 128); v = Math.floor(v / 128); }
    this.data.push(v);
  }
  sint(v) { this.uint(v >= 0 ? v * 2 : -v * 2 - 1); }
}

export function packBuildings(buildings) {
  const meta = new Bytes(), xs = new Bytes(), zs = new Bytes();
  meta.uint(buildings.length);
  let x = 0, z = 0;
  for (const b of buildings) {
    meta.uint(b.height);
    meta.uint(b.year ? b.year / 10 - 159 : 0);
    meta.uint(b.polygons.length);
    for (const polygon of b.polygons) {
      meta.uint(polygon.length);
      for (const ring of polygon) {
        meta.uint(ring.length);
        for (const [px, pz] of ring) { xs.sint(px - x); zs.sint(pz - z); x = px; z = pz; }
      }
    }
  }
  const header = Buffer.alloc(12);
  header.write('NYB1', 0, 'latin1');
  header.writeUInt32LE(meta.data.length, 4);
  header.writeUInt32LE(xs.data.length, 8);
  return Buffer.concat([header, Buffer.from(meta.data), Buffer.from(xs.data), Buffer.from(zs.data)]);
}

export function packTrees(points) {
  const xs = new Bytes(), zs = new Bytes();
  let x = 0, z = 0;
  for (const [px, pz] of points) { xs.sint(px - x); zs.sint(pz - z); x = px; z = pz; }
  const header = Buffer.alloc(12);
  header.write('NYT1', 0, 'latin1');
  header.writeUInt32LE(points.length, 4);
  header.writeUInt32LE(xs.data.length, 8);
  return Buffer.concat([header, Buffer.from(xs.data), Buffer.from(zs.data)]);
}

const LOADER_PREAMBLE = (asset, what) => `const response = await fetch(new URL('./${asset}', import.meta.url));
if (!response.ok) throw new Error(\`${what} data request failed: \${response.status}\`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const data = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
const invalidData = () => new Error('Invalid ${what.toLowerCase()} data.');
if (data.length < 12) throw invalidData();
const header = new DataView(data.buffer);
`;

export function buildingModule(count, asset, source) {
  return `// Generated by tools/build-osm.mjs; do not edit.
// © OpenStreetMap contributors, ODbL 1.0: ${source}
// ${count.toLocaleString('en-US')} buildings. Coordinates: 0.5 m; roof heights: 1 m; construction years: decades (0 unknown).
${LOADER_PREAMBLE(asset, 'Building')}const xStart = 12 + header.getUint32(4, true), zStart = xStart + header.getUint32(8, true);
if (header.getUint32(0, true) !== 0x3142594e || zStart > data.length) throw invalidData();

// NYB1 stores separate metadata, X and Z streams; signed coordinate deltas use zigzag varints.
function stream(start, end) {
  let cursor = start;
  return {
    uint() {
      let value = 0, shift = 0, byte;
      do {
        if (cursor >= end || shift >= 28) throw invalidData();
        byte = data[cursor++];
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return value;
    },
    done: () => cursor === end
  };
}
const metadata = stream(12, xStart), xs = stream(xStart, zStart), zs = stream(zStart, data.length);
const uint = () => metadata.uint();
const delta = stream => { const value = stream.uint(); return (value >>> 1) ^ -(value & 1); };
const count = uint();
if (count > (xStart - 12) / 5) throw invalidData();
let x = 0, z = 0;

export const REAL_BUILDINGS = Array.from({ length: count }, () => {
  const height = uint(), decade = uint(), polygons = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let n = uint(); n > 0; n--) {
    const rings = [];
    for (let n = uint(); n > 0; n--) {
      const ring = [];
      for (let n = uint(); n > 0; n--) {
        x += delta(xs); z += delta(zs);
        const point = { x: x * 0.5, z: z * 0.5 };
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
        ring.push(point);
      }
      rings.push(ring);
    }
    polygons.push({ outer: rings[0], holes: rings.slice(1) });
  }
  return { height, year: decade ? (decade + 159) * 10 : 0, polygons,
    minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
});
if (!metadata.done() || !xs.done() || !zs.done()) throw invalidData();
`;
}

export function treeModule(count, asset, source) {
  return `// Generated by tools/build-osm.mjs; do not edit.
// © OpenStreetMap contributors, ODbL 1.0: ${source}
// ${count.toLocaleString('en-US')} unique tree locations, quantized to 0.5 m.
${LOADER_PREAMBLE(asset, 'Tree')}const count = header.getUint32(4, true), zStart = 12 + header.getUint32(8, true);
if (header.getUint32(0, true) !== 0x3154594e || count === 0 ||
  count > zStart - 12 || count > data.length - zStart) throw invalidData();

// NYT1 stores separate X/Z streams of signed coordinate deltas on a 0.5 m grid.
function stream(start, end) {
  let cursor = start;
  return {
    delta() {
      let value = 0, shift = 0, byte;
      do {
        if (cursor >= end || shift >= 28) throw invalidData();
        byte = data[cursor++];
        value |= (byte & 127) << shift;
        shift += 7;
      } while (byte & 128);
      return (value >>> 1) ^ -(value & 1);
    },
    done: () => cursor === end
  };
}
const xs = stream(12, zStart), zs = stream(zStart, data.length);
export const REAL_TREES = new Float32Array(count * 2);
let x = 0, z = 0;
for (let i = 0; i < REAL_TREES.length; i += 2) {
  x += xs.delta(); z += zs.delta();
  REAL_TREES[i] = x * 0.5;
  REAL_TREES[i + 1] = z * 0.5;
}
if (!xs.done() || !zs.done()) throw invalidData();
`;
}

function writeModule(dir, name, packed, moduleFor) {
  const asset = `${name}.bin.gz`;
  const compressed = zlib.gzipSync(packed, { level: 6 });
  compressed[4] = compressed[5] = compressed[6] = compressed[7] = 0; // no timestamp: identical input, identical file
  compressed[9] = 255; // "unknown OS", likewise
  fs.writeFileSync(path.join(dir, asset), compressed);
  const code = moduleFor(asset);
  fs.writeFileSync(path.join(dir, `${name}.js`), code);
  return { bytes: compressed.length, jsBytes: Buffer.byteLength(code) };
}

// =====================================================================================================================
// CLI
// =====================================================================================================================
export function parseArgs(argv) {
  const opts = { outDir: path.join(ROOT, 'js'), levelHeight: 3.2, defaultYear: 0, buildings: true, trees: true };
  const pair = (v, name) => {
    const p = String(v).split(',').map(Number);
    if (p.some((n) => !Number.isFinite(n))) throw new Error(`${name} expects numbers separated by commas`);
    return p;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--bbox') opts.bbox = pair(next(), '--bbox');
    else if (a === '--origin') opts.origin = pair(next(), '--origin');
    else if (a === '--bearing') opts.bearing = +next();
    else if (a === '--nyc-frame') opts.nycFrame = true;
    else if (a === '--default-year') opts.defaultYear = +next();
    else if (a === '--level-height') opts.levelHeight = +next();
    else if (a === '--input') opts.input = next();
    else if (a === '--save') opts.save = next();
    else if (a === '--out-dir') opts.outDir = path.resolve(next());
    else if (a === '--skip-buildings') opts.buildings = false;
    else if (a === '--skip-trees') opts.trees = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (opts.help) return opts;
  if (!opts.bbox || opts.bbox.length !== 4) throw new Error('--bbox <south,west,north,east> is required');
  const [s, w, n, e] = opts.bbox;
  if (!(s < n && w < e && s >= -90 && n <= 90 && w >= -180 && e <= 180)) throw new Error('--bbox must be south,west,north,east in degrees');
  if (opts.origin && opts.origin.length !== 2) throw new Error('--origin expects lat,lon');
  if (opts.nycFrame && (opts.origin || opts.bearing != null)) throw new Error('--nyc-frame replaces --origin and --bearing');
  if (opts.bearing != null && !Number.isFinite(opts.bearing)) throw new Error('--bearing expects degrees');
  if (opts.defaultYear && !(opts.defaultYear >= 1600 && opts.defaultYear <= 2100)) throw new Error('--default-year expects a year from 1600 to 2100');
  if (!(opts.levelHeight > 0)) throw new Error('--level-height expects metres');
  if (!opts.buildings && !opts.trees) throw new Error('Nothing to do: both buildings and trees are skipped');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nRun with --help for usage.`);
    process.exit(1);
  }
  if (opts.help) {
    const head = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//'));
    console.log(head.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const [s, w, n, e] = opts.bbox;
  const frame = opts.nycFrame ? await nycFrame()
    : createFrame({ lat: opts.origin ? opts.origin[0] : (s + n) / 2, lon: opts.origin ? opts.origin[1] : (w + e) / 2, bearing: opts.bearing ?? 0 });
  console.log(`[osm] frame: ${frame.description}`);

  let text;
  if (opts.input) {
    text = fs.readFileSync(opts.input, 'utf8');
  } else {
    console.log(`[osm] downloading bbox ${opts.bbox.join(',')} from Overpass...`);
    text = await download(overpassQuery(opts.bbox, opts));
    if (opts.save) fs.writeFileSync(opts.save, text);
  }
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  const source = `bbox ${opts.bbox.join(',')}, snapshot SHA-256 ${digest}`;
  const { buildings, trees, skipped } = extract(JSON.parse(text), { toWorld: frame.toWorld, bbox: opts.bbox, defaultYear: opts.defaultYear, levelHeight: opts.levelHeight });
  fs.mkdirSync(opts.outDir, { recursive: true });

  if (opts.buildings) {
    if (!buildings.length) throw new Error('No buildings in the bbox; nothing written.');
    const out = writeModule(opts.outDir, 'building-geodata', packBuildings(buildings), (asset) => buildingModule(buildings.length, asset, source));
    const heights = buildings.map((b) => b.height);
    console.log(`[osm] ${buildings.length} buildings (skipped ${skipped.excluded} non-buildings, ${skipped.outside} outside the bbox, ${skipped.invalid} invalid outlines)`);
    console.log(`[osm] ${Math.min(...heights)}–${Math.max(...heights)} m; ${buildings.filter((b) => b.year).length} with a construction decade; ${out.bytes} bytes gzip data`);
  }
  if (opts.trees) {
    if (trees.length) {
      const out = writeModule(opts.outDir, 'tree-geodata', packTrees(trees), (asset) => treeModule(trees.length, asset, source));
      console.log(`[osm] ${trees.length} trees; ${out.bytes} bytes gzip data`);
    } else {
      console.warn('[osm] no natural=tree nodes in the bbox: js/tree-geodata.js was left as it was (pass --skip-trees to silence this)');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`[osm] ${e.message}`);
    process.exit(1);
  });
}
