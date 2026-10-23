// tools/build-taipei-geodata.mjs — writes js/taipei-geodata.js (see geo-taipei-base.mjs for the frame and sources)
// usage: [GEO_DATA=tools/data-taipei] node tools/build-taipei-geodata.mjs [out.js]
//
// Buildings follow OSM's Simple 3D Buildings convention: every `building:part` is extruded from its base to its top,
// and a `building` outline is extruded only when no part lies inside it (its parts model it instead: Taipei 101's
// outline is tagged 508 m but covers the whole podium, while its parts step up to the spire). Heights come from
// tools/geo-height.mjs and keep their source (tag, levels or estimate) in the output.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toWorld, BOX, LANDMARKS, load, log } from './geo-taipei-base.mjs';
import { buildingHeight } from './geo-height.mjs';
import { buildOsmRoadGraph, PATH_KINDS } from './geo-osm-roadgraph.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/taipei-geodata.js', import.meta.url));
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Area-weighted centroid (falls back to the vertex mean for degenerate rings)
function centroid(r) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cz += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
  return [cx / (3 * a), cz / (3 * a)];
}
// Open ring (no repeated closing vertex), at least 3 distinct points
function openRing(pts) {
  const r = pts.slice();
  while (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r.length >= 3 ? r : null;
}
// A multipolygon's member ways of one role, chained end to end into closed rings
function chainRings(parts) {
  parts = parts.slice();
  const rings = [];
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 1000 && !same(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      const i = parts.findIndex((p) => same(p[0], end) || same(p[p.length - 1], end));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(same(p[0], end) ? p.slice(1) : p.slice().reverse().slice(1));
    }
    if (same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}
// [[outer, holes], ...] in world coordinates for a way or multipolygon relation
function polygons(e) {
  const wr = (g) => g.map((p) => toWorld(p.lon, p.lat));
  if (e.type === 'way') {
    const r = e.geometry && openRing(wr(e.geometry));
    return r ? [[r, []]] : [];
  }
  const members = (role) => (e.members || []).filter((m) => m.type === 'way' && m.role === role && m.geometry).map((m) => wr(m.geometry));
  const outers = chainRings(members('outer')).map(openRing).filter(Boolean);
  const inners = chainRings(members('inner')).map(openRing).filter(Boolean);
  return outers.map((o) => [o, inners.filter((h) => pointInRing(...h[0], o))]);
}

// --- Collect outlines and parts --------------------------------------------------------------------------------------
const osm = load('osm_buildings.json');
const outlines = [];
const parts = [];
let underground = 0, broken = 0;
for (const e of osm.elements) {
  const t = e.tags || {};
  if (t.location === 'underground' || parseFloat(t.layer) < 0) { underground++; continue; }
  const isPart = t['building:part'] && t['building:part'] !== 'no';
  if (!isPart && !(t.building && t.building !== 'no')) continue;
  const polys = polygons(e);
  if (!polys.length) { broken++; continue; }
  for (const [outer, holes] of polys) {
    const area = Math.abs(ringArea(outer)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
    const item = { id: `${e.type[0]}${e.id}`, tags: t, outer, holes, area, kind: isPart ? t['building:part'] : t.building, c: centroid(outer) };
    (isPart ? parts : outlines).push(item);
  }
}
// An outline is modelled by its parts when any part's centroid lies inside it
let replaced = 0;
for (const o of outlines) {
  o.parts = parts.filter((p) => pointInRing(...p.c, o.outer) && !o.holes.some((h) => pointInRing(...p.c, h)));
  if (o.parts.length) replaced++;
}
log(`${outlines.length} outlines (${replaced} modelled by parts), ${parts.length} parts; skipped ${underground} underground, ${broken} without geometry`);

// --- Heights ---------------------------------------------------------------------------------------------------------
const SOURCES = ['height', 'levels', 'estimate'];
const kinds = [];
const kindId = (k) => (kinds.includes(k) ? kinds.indexOf(k) : kinds.push(k) - 1);
const buildings = [];
function emit(b, outline) {
  // Parts lacking a height of their own take the outline's tags before falling back to an estimate
  let h = buildingHeight(b.tags, b.area, b.kind);
  if (h.source === 'estimate' && outline) {
    const inherited = buildingHeight({ ...outline.tags, min_height: b.tags.min_height, 'building:min_level': b.tags['building:min_level'] }, b.area, b.kind);
    if (inherited.source !== 'estimate') h = inherited;
  }
  const colour = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)$/i.test(b.tags['building:colour'] || '') ? b.tags['building:colour'].toLowerCase() : 0;
  buildings.push({ b, h, colour });
}
for (const o of outlines) {
  if (!o.parts.length) emit(o, null);
}
for (const p of parts) emit(p, outlines.find((o) => o.parts.includes(p)) || null);

// --- Landmarks: the rendered top must match the known height ---------------------------------------------------------
const landmarks = {};
for (const [name, ref] of Object.entries(LANDMARKS)) {
  const o = outlines.find((x) => x.tags['name:en'] === name);
  if (!o) throw new Error(`landmark "${name}" not found in osm_buildings.json`);
  const own = o.parts.length ? buildings.filter((x) => o.parts.includes(x.b)) : buildings.filter((x) => x.b === o);
  const top = Math.max(...own.map((x) => x.h.top));
  if (Math.abs(top - ref.height) > ref.tol) throw new Error(`landmark "${name}" renders ${top} m tall, expected ${ref.height} m (${ref.ref})`);
  landmarks[name] = { x: q(o.c[0]), z: q(o.c[1]), top, ref: ref.ref };
  log(`landmark ${name}: top ${top} m from ${o.parts.length ? `${o.parts.length} parts` : 'its outline'} (expected ${ref.height} m)`);
}

// --- Report ----------------------------------------------------------------------------------------------------------
const count = Object.fromEntries(SOURCES.map((s) => [s, buildings.filter((x) => x.h.source === s).length]));
const est = buildings.filter((x) => x.h.source === 'estimate').map((x) => x.h.top);
log(`${buildings.length} extruded: ${SOURCES.map((s) => `${count[s]} ${s}`).join(', ')}`);
log(`estimated tops: ${new Set(est).size} distinct values, ${Math.min(...est).toFixed(1)}–${Math.max(...est).toFixed(1)} m`);

// --- Roads ------------------------------------------------------------------------------------------------------------
const { roadGraph, paths } = buildOsmRoadGraph(load('osm_roads.json').elements, toWorld, log);
const qp = (pts) => flat(pts);
roadGraph.nodes = roadGraph.nodes.map(q);
roadGraph.links = roadGraph.links.map(([a, b, n, w, lanes, dir, inner]) => [a, b, n, q(w), lanes, dir, qp(inner)]);

// --- Assemble --------------------------------------------------------------------------------------------------------
const GEO = {
  version: 1,
  city: 'taipei',
  frame: { lat0: 25.033964, lon0: 121.564468, bearingDeg: 0, origin: 'Taipei 101', units: 'm', box: BOX },
  // Height sources, indexed by a building's `source` field. 'estimate' means inferred by tools/geo-height.mjs
  // estimateHeight() from building type and footprint area: NOT measured data.
  heightSources: SOURCES,
  kinds,
  // [OSM id, outer ring [x, z, ...], holes [[x, z, ...], ...], top m, base m, height source index, kind index, colour | 0]
  buildings: buildings.map(({ b, h, colour }) => [b.id, flat(b.outer), b.holes.map(flat), q(h.top), q(h.base), SOURCES.indexOf(h.source), kindId(b.kind), colour]),
  landmarks,
  // Street centreline graph of the drivable roads (tools/geo-osm-roadgraph.mjs; same shape as NYC's GEO.roadGraph):
  // nodes [x, z, ...], links [node a, node b, name index, curb-to-curb width, travel lanes, direction (1: a -> b,
  // -1: b -> a, 0: both), inner shape points [x, z, ...]], names. Untagged widths are per-class defaults.
  roadGraph,
  // Walking ways: [kind index into pathKinds, width m, elevation m (skywalks; estimated from OSM layer), [x, z, ...]]
  pathKinds: PATH_KINDS,
  paths: paths.map(([k, w, y, pts]) => [k, q(w), y, qp(pts)])
};

const json = JSON.stringify(GEO);
const header = `// js/taipei-geodata.js — GENERATED by tools/build-taipei-geodata.mjs, do not edit by hand.
// Taipei geography in the simulation's world frame: 1 unit = 1 m, x = east, z = south, origin at Taipei 101.
// Polygons are flat [x0, z0, x1, z1, ...] arrays.
// Building footprints, tagged heights & roads © OpenStreetMap contributors (ODbL). Heights with source 'estimate'
// (${count.estimate} of ${buildings.length}) are inferred from building type and footprint area, not measured.
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
