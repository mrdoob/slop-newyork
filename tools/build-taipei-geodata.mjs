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
import { roofOf, facadeOf, ROOF_SHAPES, FACADES } from './geo-building-style.mjs';
import { buildOsmRoadGraph, PATH_KINDS, WIDTH_SOURCES } from './geo-osm-roadgraph.mjs';
import { fitRoadWidths, inferSidewalks, sidewalkFootways } from './geo-sidewalks.mjs';
import { buildFurniture, FURNITURE_KINDS, FURNITURE_SOURCES } from './geo-furniture.mjs';

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
  // Parts take the outline's material (a mirror-glass tower's parts are glass too)
  const styleTags = outline && !b.tags['building:material'] && outline.tags['building:material'] ? { ...b.tags, 'building:material': outline.tags['building:material'] } : b.tags;
  buildings.push({ b, h, colour, roof: roofOf(b.tags, b.area, h.top, h.base), facade: facadeOf(styleTags, b.kind, h.top, h.base) });
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

// --- Landmark shapes: a part split into a tapered base and flared modules (LANDMARKS[...].tiers) -----------------------
for (const [name, ref] of Object.entries(LANDMARKS)) {
  const T = ref.tiers;
  if (!T) continue;
  const i = buildings.findIndex((x) => x.b.id === T.part);
  if (i < 0) throw new Error(`landmark "${name}": tier part ${T.part} not found`);
  const src = buildings[i];
  const [cx, cz] = centroid(src.b.outer);
  const scaled = (k) => src.b.outer.map(([x, z]) => [cx + (x - cx) * k, cz + (z - cz) * k]);
  const piece = (suffix, base, top, [k0, k1]) => ({ ...src, b: { ...src.b, id: `${src.b.id}_${suffix}`, outer: scaled(k0), holes: [] },
    h: { ...src.h, base, top }, topScale: k1 / k0 });
  const step = (src.h.top - T.baseTop) / T.count;
  const rows = [piece('base', src.h.base, T.baseTop, T.baseScale)];
  for (let k = 0; k < T.count; k++) rows.push(piece(`m${k + 1}`, T.baseTop + k * step, T.baseTop + (k + 1) * step, T.moduleScale));
  buildings.splice(i, 1, ...rows);
  log(`landmark ${name}: part ${T.part} shaped as a base and ${T.count} flared modules of ${step.toFixed(1)} m`);
}

// --- Report ----------------------------------------------------------------------------------------------------------
const count = Object.fromEntries(SOURCES.map((s) => [s, buildings.filter((x) => x.h.source === s).length]));
const est = buildings.filter((x) => x.h.source === 'estimate').map((x) => x.h.top);
log(`${buildings.length} extruded: ${SOURCES.map((s) => `${count[s]} ${s}`).join(', ')}`);
log(`roofs: ${ROOF_SHAPES.map((r) => `${buildings.filter((x) => x.roof.shape === r).length} ${r}`).join(', ')}; facades: ${FACADES.map((f) => `${buildings.filter((x) => x.facade === f).length} ${f}`).join(', ')}`);
log(`estimated tops: ${new Set(est).size} distinct values, ${Math.min(...est).toFixed(1)}–${Math.max(...est).toFixed(1)} m`);

// --- Roads ------------------------------------------------------------------------------------------------------------
const street = load('osm_street.json').elements;
const signalIds = new Set(street.filter((e) => e.type === 'node' && e.tags && (e.tags.highway === 'traffic_signals' || e.tags.crossing === 'traffic_signals')).map((e) => e.id));
const { roadGraph, paths } = buildOsmRoadGraph(load('osm_roads.json').elements, toWorld, log, { signalIds });
// Road widths checked against mapped sidewalks, then sidewalks along kerbs that have none mapped
const groundRings = buildings.filter((x) => x.h.base < 1).map((x) => x.b.outer);
const fit = fitRoadWidths(roadGraph, paths, PATH_KINDS, (x, z) => groundRings.some((r) => pointInRing(x, z, r)));
const PATH_SOURCES = ['mapped', 'tagged', 'inferred'];
for (const p of paths) p.push(0);
const promoted = sidewalkFootways(roadGraph, paths, PATH_KINDS);
for (const pi of promoted) paths[pi][0] = PATH_KINDS.indexOf('sidewalk');
const inferred = inferSidewalks(roadGraph, paths, PATH_KINDS);
for (const [line, w, source] of inferred) paths.push([PATH_KINDS.indexOf('sidewalk'), w, 0, line, 0, PATH_SOURCES.indexOf(source)]);
log(`${promoted.length} mapped footways along kerbs drawn as sidewalks; ${inferred.corners} sidewalk corners`);
log(`road widths fitted to mapped sidewalks: ${fit.widened} widened, ${fit.narrowed} narrowed; sidewalks: ${PATH_SOURCES.map((s, i) => `${paths.filter((p) => PATH_KINDS[p[0]] === 'sidewalk' && p[5] === i).length} ${s}`).join(', ')}`);
const widthSource = roadGraph.widthSource;
delete roadGraph.highway;
delete roadGraph.sidewalk;
delete roadGraph.sidewalkWidth;
const qp = (pts) => flat(pts);
roadGraph.nodes = roadGraph.nodes.map(q);
roadGraph.links = roadGraph.links.map(([a, b, n, w, lanes, dir, inner]) => [a, b, n, q(w), lanes, dir, qp(inner)]);

// --- Green areas & trees ---------------------------------------------------------------------------------------------
// Green ground: parks (often paved plazas in Xinyi), gardens, grass, woods
const GREEN_KINDS = ['park', 'garden', 'grass', 'forest'];
const greenKind = (t) => (t.landuse === 'forest' || t.natural === 'wood' ? 'forest' : t.leisure === 'park' ? 'park' : t.leisure === 'garden' ? 'garden' : t.landuse === 'grass' ? 'grass' : null);
const green = [];
for (const e of street) {
  const kind = e.type !== 'node' && e.tags ? greenKind(e.tags) : null;
  if (!kind) continue;
  for (const [outer] of polygons(e)) if (Math.abs(ringArea(outer)) > 4) green.push({ kind, outer });
}
// Trees: OSM tree nodes as mapped; tree rows (natural=tree_row) carry no per-tree positions, so one tree is placed every
// TREE_ROW_M along the row; wooded areas carry none either, so they are filled on a jittered WOOD_M grid. Trees standing
// inside a ground-level building footprint are dropped.
const TREE_SOURCES = ['osm tree', `tree row (every ${7} m)`, `wooded area (every ~${9} m)`];
const TREE_ROW_M = 7;
const WOOD_M = 9;
const groundFootprints = buildings.filter((x) => x.h.base < 1).map((x) => x.b.outer);
const inBuilding = (x, z) => groundFootprints.some((r) => pointInRing(x, z, r));
const hash = (x, z, k) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };
const trees = [];
const plant = (x, z, source, h) => { if (!inBuilding(x, z)) trees.push([q(x), q(z), source, h ? q(h) : 0]); };
for (const e of street) {
  const t = e.tags || {};
  if (e.type === 'node' && t.natural === 'tree') plant(...toWorld(e.lon, e.lat), 0, parseFloat(t.height) || 0);
  else if (e.type === 'way' && t.natural === 'tree_row' && e.geometry) {
    const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
    let carry = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let d = carry; d <= L; d += TREE_ROW_M) plant(ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L, 1, 0);
      carry = (carry - L) % TREE_ROW_M;
      if (carry < 0) carry += TREE_ROW_M;
    }
  }
}
for (const g of green.filter((g) => g.kind === 'forest')) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of g.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  for (let x = x0; x <= x1; x += WOOD_M) {
    for (let z = z0; z <= z1; z += WOOD_M) {
      const jx = x + (hash(x, z, 1) - 0.5) * WOOD_M * 0.8, jz = z + (hash(x, z, 2) - 0.5) * WOOD_M * 0.8;
      if (pointInRing(jx, jz, g.outer)) plant(jx, jz, 2, 0);
    }
  }
}
log(`${green.length} green areas; ${trees.length} trees: ${TREE_SOURCES.map((s, i) => `${trees.filter((t) => t[2] === i).length} ${s}`).join(', ')}`);

// --- Street furniture -------------------------------------------------------------------------------------------------
const furniture = buildFurniture(load('osm_furniture.json').elements, toWorld, roadGraph, (x, z) => groundRings.some((r) => pointInRing(x, z, r)));
log(`street furniture: ${FURNITURE_KINDS.map((k, i) => [k, furniture.filter((f) => f[0] === i)]).filter(([, l]) => l.length)
  .map(([k, l]) => `${l.length} ${k}${l.some((f) => f[4] === 1) ? ` (${l.filter((f) => f[4] === 1).length} inferred)` : ''}`).join(', ')}`);

// --- Assemble --------------------------------------------------------------------------------------------------------
const GEO = {
  version: 1,
  city: 'taipei',
  frame: { lat0: 25.033964, lon0: 121.564468, bearingDeg: 0, origin: 'Taipei 101', units: 'm', box: BOX },
  // Height sources, indexed by a building's `source` field. 'estimate' means inferred by tools/geo-height.mjs
  // estimateHeight() from building type and footprint area: NOT measured data.
  heightSources: SOURCES,
  kinds,
  // [OSM id, outer ring [x, z, ...], holes [[x, z, ...], ...], top m, base m, height source index, kind index,
  //  wall colour | 0, roof shape index, roof height m (included in top), roof colour | 0, facade index,
  //  top scale (footprint scale at the top relative to the base, 1 = prism; landmark shapes only)]
  // Roof shapes & facades: tools/geo-building-style.mjs (facades are a style hint inferred from tags).
  roofShapes: ROOF_SHAPES,
  facades: FACADES,
  buildings: buildings.map(({ b, h, colour, roof, facade, topScale }) => [b.id, flat(b.outer), b.holes.map(flat), q(h.top), q(h.base), SOURCES.indexOf(h.source), kindId(b.kind), colour,
    ROOF_SHAPES.indexOf(roof.shape), q(roof.height), roof.colour, FACADES.indexOf(facade), Math.round((topScale ?? 1) * 1000) / 1000]),
  landmarks,
  // Street centreline graph of the drivable roads (tools/geo-osm-roadgraph.mjs; same shape as NYC's GEO.roadGraph):
  // nodes [x, z, ...], links [node a, node b, name index, curb-to-curb width, travel lanes, direction (1: a -> b,
  // -1: b -> a, 0: both), inner shape points [x, z, ...]], names, signals, and per link `widthSource` (index into
  // widthSources): only 'width tag' is a mapped width; the others are estimates (lanes × 3.25 m, class defaults, or the
  // gap between mapped sidewalks).
  widthSources: WIDTH_SOURCES,
  roadGraph: { ...roadGraph, widthSource },
  // Walking ways: [kind index into pathKinds, width m, elevation m (skywalks; estimated from OSM layer), [x, z, ...],
  // per-vertex heights for ramps (stairs up to a skywalk) | 0, source index into pathSources]. 'mapped' ways are OSM
  // geometry; 'tagged' / 'inferred' sidewalks are drawn along kerbs from the road's sidewalk tags or, untagged, assumed
  // on streets ≥ 6 m wide (tools/geo-sidewalks.mjs), with default widths.
  pathKinds: PATH_KINDS,
  pathSources: PATH_SOURCES,
  paths: paths.map(([k, w, y, pts, ys, src]) => [k, q(w), y, qp(pts), ys ? ys.map(q) : 0, src]),
  // Green ground: [kind index into greenKinds, outer ring [x, z, ...]]
  greenKinds: GREEN_KINDS,
  green: green.map((g) => [GREEN_KINDS.indexOf(g.kind), flat(g.outer)]),
  // Trees: [x, z, source index into treeSources, tagged height m | 0]. Only 'osm tree' positions are mapped trees; the
  // other sources space trees along mapped rows and through mapped woods.
  treeSources: TREE_SOURCES,
  trees,
  // Street furniture: [kind index into furnitureKinds, x, z, yaw (front towards the nearest road), source index into
  // furnitureSources, extra (bicycle_rental: docks)]. 'inferred': lamps spaced along kerbs, scooters filling mapped
  // parking areas (tools/geo-furniture.mjs).
  furnitureKinds: FURNITURE_KINDS,
  furnitureSources: FURNITURE_SOURCES,
  furniture: furniture.map(([k, x, z, yaw, src, extra]) => [k, q(x), q(z), Math.round(yaw * 1000) / 1000, src, extra])
};

const json = JSON.stringify(GEO);
const header = `// js/taipei-geodata.js — GENERATED by tools/build-taipei-geodata.mjs, do not edit by hand.
// Taipei geography in the simulation's world frame: 1 unit = 1 m, x = east, z = south, origin at Taipei 101.
// Polygons are flat [x0, z0, x1, z1, ...] arrays.
// Building footprints, tagged heights, roads, signals, trees, green areas & street furniture © OpenStreetMap contributors (ODbL). Heights with source 'estimate'
// (${count.estimate} of ${buildings.length}) are inferred from building type and footprint area, not measured.
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
