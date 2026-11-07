// Generate js/subway-lines.js: the subway's services & stops under the detailed island, from OpenStreetMap.
// Usage: node tools/build-subway-lines.mjs (refresh the input with tools/overpass.sh data/osm_subway.json data/q_subway.overpassql)
//
// One route per service through Manhattan (its longest full-time run on the island, as track heights along it), and the
// stations with the services that call at each by day: each route's stops go to the nearest station node, so an
// express runs through the locals. Station complexes mapped as several nodes keep each node.
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { toWorld, rdp, load, log } from './geo-base.mjs';
import { GEO } from '../js/nyc-geodata.js';

const OUTPUT = new URL('../js/subway-lines.js', import.meta.url);

// Service order and the trunk-line colours of the MTA's map (OSM colours vary in case & shade between relations)
const SERVICES = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S'];
const COLORS = {
  1: '#ee352e', 2: '#ee352e', 3: '#ee352e', 4: '#00933c', 5: '#00933c', 6: '#00933c', 7: '#b933ad',
  A: '#0039a6', C: '#0039a6', E: '#0039a6', B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319',
  G: '#6cbe45', J: '#996633', Z: '#996633', L: '#a7a9ac', N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a', S: '#808183'
};
// '<6>' & '<7>' (the diamond expresses) run the 6 & 7's tracks
const serviceOf = (ref) => (ref || '').replace(/[<>]/g, '');

const q = (v) => Math.round(v * 10) / 10;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function onIsland([x, z]) {
  if (z < GEO.frame.cutZ) return false;
  const ring = GEO.manhattan;
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j], az = ring[j + 1], bx = ring[i], bz = ring[i + 1];
    if ((az > z) !== (bz > z) && x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
  }
  return inside;
}

// Track height: tunnels by OSM layer (-1: just under the street, each layer below ~5 m deeper), viaducts above it
function trackY(t) {
  const layer = parseInt(t.layer ?? t.level ?? '0', 10) || 0;
  if (t.tunnel === 'yes' || layer < 0) return -9 - 5 * Math.max(0, -layer - 1);
  if (t.bridge === 'yes' || layer > 0) return 9;
  return 0;
}

const osm = load('osm_subway.json').elements;
const ways = new Map();
const stopNodes = new Map();
const stations = [];
for (const e of osm) {
  if (e.type === 'way' && e.geometry) ways.set(e.id, e);
  else if (e.type === 'node' && e.tags?.railway === 'station' && e.tags.station === 'subway') {
    const p = toWorld(e.lon, e.lat);
    if (onIsland(p)) stations.push({ name: e.tags.name || e.tags.short_name || '', p, services: new Set() });
  } else if (e.type === 'node' && e.tags?.railway !== 'subway_entrance') stopNodes.set(e.id, toWorld(e.lon, e.lat));
}
const all = osm.filter((e) => e.type === 'relation' && e.tags?.network === 'NYC Subway' && SERVICES.includes(serviceOf(e.tags.ref)));
// The daytime service: part-time variants (late nights, rush hours, weekends: the 2 running local overnight...) only
// stand in for a service that has no full-time route
const partTime = (r) => /late night|rush|weekend/i.test(r.tags.name || '');
const fullTime = new Set(all.filter((r) => !partTime(r)).map((r) => serviceOf(r.tags.ref)));
const routes = all.filter((r) => !partTime(r) || !fullTime.has(serviceOf(r.tags.ref)));

// A relation's track in member order, as pieces on the island: each way turned to continue the previous one, a new
// piece wherever the route leaves the island or a member is missing (outside the downloaded area)
function routePieces(rel) {
  const pieces = [];
  let cur = null;
  for (const m of rel.members) {
    if (m.type !== 'way') continue;
    const w = ways.get(m.ref);
    if (!w) { cur = null; continue; }
    const y = trackY(w.tags || {});
    const pts = w.geometry.map((g) => [...toWorld(g.lon, g.lat), y]);
    const end = cur && cur[cur.length - 1];
    if (end && dist(end, pts[pts.length - 1]) < dist(end, pts[0])) pts.reverse();
    if (end && dist(end, pts[0]) > 30) cur = null;
    for (const p of pts) {
      if (!onIsland(p)) { cur = null; continue; }
      if (!cur) { cur = []; pieces.push(cur); }
      if (!cur.length || dist(cur[cur.length - 1], p) > 0.5) cur.push(p);
    }
  }
  return pieces.filter((pc) => pc.length > 1);
}
const length = (pc) => pc.reduce((t, p, i) => (i ? t + dist(pc[i - 1], p) : 0), 0);

const lines = [];
for (const ref of SERVICES) {
  let best = null, bestLen = 0;
  for (const rel of routes) {
    if (serviceOf(rel.tags.ref) !== ref) continue;
    const pieces = routePieces(rel).filter((pc) => length(pc) > 150);
    const len = pieces.reduce((t, pc) => t + length(pc), 0);
    if (len > bestLen) { best = pieces; bestLen = len; }
  }
  if (!best) continue;
  lines.push({ ref, color: COLORS[ref], paths: best.map((pc) => rdp(pc, 1.2).flatMap(([x, z, y]) => [q(x), q(z), y])) });
  log(`subway ${ref}: ${best.length} piece(s), ${(bestLen / 1000).toFixed(1)} km`);
}

for (const rel of routes) {
  const ref = serviceOf(rel.tags.ref);
  for (const m of rel.members) {
    const p = m.type === 'node' && /stop/.test(m.role) ? stopNodes.get(m.ref) : null;
    if (!p || !onIsland(p)) continue;
    let near = null, d = 250;
    for (const s of stations) {
      const ds = dist(s.p, p);
      if (ds < d) { d = ds; near = s; }
    }
    if (near) near.services.add(ref);
  }
}
const stops = stations
  .filter((s) => s.services.size)
  .map((s) => [s.name, q(s.p[0]), q(s.p[1]), SERVICES.filter((r) => s.services.has(r)).join('')]);

const output = `// Generated by tools/build-subway-lines.mjs; do not edit.
// The subway under the detailed island, © OpenStreetMap contributors (ODbL), see tools/data/q_subway.overpassql.
// Lines: one route per service, { ref, color, paths: [[x, z, y, ...]] } (y: track height, below 0 in tunnel).
// Stops: [name, x, z, services ('ACE')], the services calling there by day. Metres in the city frame.
export const SUBWAY_LINES = ${JSON.stringify(lines)};
export const SUBWAY_STOPS = ${JSON.stringify(stops)};
`;
fs.writeFileSync(OUTPUT, output);
log(`subway: ${lines.length} services, ${stops.length} stops; ${Buffer.byteLength(output)} bytes, ${gzipSync(output).length} gzip`);
