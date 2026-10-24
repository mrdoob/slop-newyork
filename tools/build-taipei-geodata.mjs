// tools/build-taipei-geodata.mjs — writes js/taipei-geodata.js (see geo-taipei-base.mjs for the frame and sources)
// usage: [GEO_AREA=xinyi|wanhua] [GEO_DATA=tools/data-taipei] node tools/build-taipei-geodata.mjs [out.js]
// (writes js/taipei-geodata.js for xinyi, js/taipei-wanhua-geodata.js for wanhua)
//
// Buildings follow OSM's Simple 3D Buildings convention: every `building:part` is extruded from its base to its top,
// and a `building` outline is extruded only when no part lies inside it (its parts model it instead: Taipei 101's
// outline is tagged 508 m but covers the whole podium, while its parts step up to the spire). Heights come from
// tools/geo-height.mjs and keep their source (tag, levels or estimate) in the output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frame, toWorld, BOX, LANDMARKS, AREA, AREA_NAME, load, log } from './geo-taipei-base.mjs';
import { buildingHeight, estimateHeight, LEVEL_M } from './geo-height.mjs';
import { roofOf, facadeOf, ROOF_SHAPES, FACADES } from './geo-building-style.mjs';
import { buildOsmRoadGraph, PATH_KINDS, WIDTH_SOURCES } from './geo-osm-roadgraph.mjs';
import { fitRoadWidths, inferSidewalks, sidewalkFootways, medianSides } from './geo-sidewalks.mjs';
import { buildFurniture, expandDocks, FURNITURE_KINDS, FURNITURE_SOURCES } from './geo-furniture.mjs';
import { infillBuildings, INFILL } from './geo-infill.mjs';
import { kerbClear } from './geo-kerb.mjs';
import { buildTerrain } from './geo-terrain.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL(`../js/${AREA.out}`, import.meta.url));
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
// Point-in-any-ring test over many rings, bucketed on a grid by bounding box (a whole district has ~9,000 footprints)
function ringIndex(rings, cell = 25) {
  const cells = new Map();
  for (const r of rings) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of r) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const item = { r, x0, z0, x1, z1 };
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++) {
        const k = `${i},${j}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(item);
      }
    }
  }
  return (x, z) => (cells.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) || [])
    .some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pointInRing(x, z, b.r));
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

// --- District outline (areas defined by an administrative boundary) ---------------------------------------------------
const boundary = [];
if (AREA.boundary) {
  const ids = [AREA.boundary].flat(), els = load('osm_boundary.json').elements;
  for (const id of ids) {
    const rel = els.find((e) => e.type === 'relation' && e.id === id);
    if (!rel) throw new Error(`boundary relation ${id} not in osm_boundary.json`);
    for (const [outer] of polygons(rel)) boundary.push(outer);
  }
  log(`boundary: relation ${ids.join(' + ')}, ${boundary.length} ring(s), ${Math.round(boundary.reduce((t, r) => t + Math.abs(ringArea(r)), 0) / 1e4) / 100} km²`);
}
const inBoundary = (x, z) => !boundary.length || boundary.some((r) => pointInRing(x, z, r));

// --- Terrain (AREA.terrain; tools/geo-terrain.mjs): ground heights from open SRTM-based elevation tiles, cached in the
// area's data directory (terrain/). Exported every TERRAIN_STEP m (decimetres) as GEO.terrain.
const TERRAIN_STEP = 20;
let terrain = null;
if (AREA.terrain) {
  const t = await buildTerrain(BOX, frame, fileURLToPath(new URL('data-taipei/terrain/', import.meta.url)), log);
  const k = TERRAIN_STEP / t.step, nx = Math.floor((t.nx - 1) / k) + 1, nz = Math.floor((t.nz - 1) / k) + 1;
  const h = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h.push(t.h[j * k * t.nx + i * k]);
  terrain = { x0: t.x0, z0: t.z0, step: TERRAIN_STEP, nx, nz, h, max: t.max,
    source: 'AWS Terrain Tiles (Mapzen terrarium; SRTM, NASA), buildings filtered out, basin floor at 0; approximate' };
}

// --- Collect outlines and parts --------------------------------------------------------------------------------------
const osm = load('osm_buildings.json');
const outlines = [];
const parts = [];
let underground = 0, broken = 0;
for (const e of osm.elements) {
  const t = e.tags || {};
  // Below ground: tagged so, on a negative layer, on negative levels only (level=-1, -2;-1), or with no storeys above
  // ground but some below (an underground station hall drawn as a part)
  const levels = String(t.level ?? '').split(/[;,]/).map(parseFloat).filter(Number.isFinite);
  const belowOnly = (levels.length && levels.every((l) => l < 0)) || (t['building:levels'] === '0' && parseFloat(t['building:levels:underground']));
  if (t.location === 'underground' || parseFloat(t.layer) < 0 || belowOnly) { underground++; continue; }
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
// (parts bucketed by centroid on a 25 m grid; each outline tests only the parts in the cells its bounding box covers)
let replaced = 0;
const PART_CELL = 25, partCells = new Map(), outlineOf = new Map();
parts.forEach((p, i) => {
  const k = `${Math.floor(p.c[0] / PART_CELL)},${Math.floor(p.c[1] / PART_CELL)}`;
  if (!partCells.has(k)) partCells.set(k, []);
  partCells.get(k).push(i);
});
for (const o of outlines) {
  const xs = o.outer.map((q) => q[0]), zs = o.outer.map((q) => q[1]), near = [];
  for (let i = Math.floor(Math.min(...xs) / PART_CELL); i <= Math.floor(Math.max(...xs) / PART_CELL); i++) {
    for (let j = Math.floor(Math.min(...zs) / PART_CELL); j <= Math.floor(Math.max(...zs) / PART_CELL); j++) near.push(...(partCells.get(`${i},${j}`) || []));
  }
  o.parts = near.sort((a, b) => a - b).map((i) => parts[i])
    .filter((p) => pointInRing(...p.c, o.outer) && !o.holes.some((h) => pointInRing(...p.c, h)));
  for (const p of o.parts) if (!outlineOf.has(p)) outlineOf.set(p, o);
  if (o.parts.length) replaced++;
}
log(`${outlines.length} outlines (${replaced} modelled by parts), ${parts.length} parts; skipped ${underground} underground, ${broken} without geometry`);

// --- Heights ---------------------------------------------------------------------------------------------------------
// 'permit': floors from Taipei's building-permit drawings (footprint and floor count both from the permit, not OSM)
const SOURCES = ['height', 'levels', 'estimate', 'permit'];
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
for (const p of parts) emit(p, outlineOf.get(p) || null);

// --- Building-permit footprints where OSM maps no building (permits.json, tools/extract-permits.mjs) -----------------------
// 臺北市建築執照套繪圖 (Taipei building-permit drawings, OGDL v1): real footprints of buildings permitted since ~2001, with
// floor counts. Used only where no OSM building stands (OSM stays the base), only for permits issued by PERMIT_MAX_YEAR
// (newer ones may not be built yet; the cut-off is checked locally against measured buildings, validate-heights.mjs), and
// newest first where amendments of one permit overlap. Height = floors × LEVEL_M, source 'permit'; no floor count: an
// estimate, labelled so.
// Checked against measured buildings (Xinyi District, local): permits up to 2018 have a building standing in 76–77% of
// cases, 2019–22 in 49%, 2023 on ~20% (or still the old, lower building being replaced)
const PERMIT_MAX_YEAR = 2018;
const PERMIT_MIN_AREA = 15; // m²: pavilions, lift shafts and kiosks below this are left out
const permitStats = { used: 0, overOsm: 0, tooNew: 0, small: 0, outside: 0, duplicate: 0 };
if (AREA.permits) {
  const file = load('permits.json');
  const osmGround = ringIndex(buildings.filter((x) => x.h.base < 1).map((x) => x.b.outer));
  const osmCentres = buildings.filter((x) => x.h.base < 1).map((x) => x.b.c || centroid(x.b.outer));
  const accepted = [];
  const feats = file.features.slice().sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  feats.forEach((f, i) => {
    const rings = f.rings.map((r) => openRing(r.map(([lon, lat]) => toWorld(lon, lat)))).filter(Boolean);
    if (!rings.length) return;
    rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
    const outer = rings[0], c = centroid(outer);
    const holes = rings.slice(1).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) >= 1 && pointInRing(...centroid(h), outer));
    const area = Math.abs(ringArea(outer)) - holes.reduce((t, h) => t + Math.abs(ringArea(h)), 0);
    if (!inBoundary(...c)) { permitStats.outside++; return; }
    if (f.year && f.year > PERMIT_MAX_YEAR) { permitStats.tooNew++; return; }
    if (area < PERMIT_MIN_AREA) { permitStats.small++; return; }
    // over an OSM building: its centre, or most of its outline, inside one; or an OSM building's centre inside it
    const samples = [c, ...outer.filter((_, k) => k % Math.max(1, Math.floor(outer.length / 12)) === 0)];
    const inside = samples.filter(([x, z]) => osmGround(x, z)).length;
    if (osmGround(...c) || inside / samples.length > 0.3 || osmCentres.some(([x, z]) => Math.abs(x - c[0]) < 80 && Math.abs(z - c[1]) < 80 && pointInRing(x, z, outer))) {
      permitStats.overOsm++;
      return;
    }
    if (accepted.some((r) => pointInRing(...c, r) || pointInRing(...centroid(r), outer))) { permitStats.duplicate++; return; }
    accepted.push(outer);
    permitStats.used++;
    const b = { id: `p${i}`, tags: {}, outer, holes, area, kind: 'yes', c };
    const h = f.floors > 0 ? { top: f.floors * LEVEL_M, base: 0, source: 'permit' } : { top: estimateHeight('yes', area), base: 0, source: 'estimate' };
    buildings.push({ b, h, colour: 0, roof: roofOf({}, area, h.top, 0), facade: facadeOf({}, 'yes', h.top, 0) });
  });
  log(`permit footprints (${file.source}, OGDL v1): ${permitStats.used} added where OSM has none; skipped ${permitStats.overOsm} over OSM buildings, ` +
    `${permitStats.tooNew} permitted after ${PERMIT_MAX_YEAR}, ${permitStats.duplicate} overlapping amendments, ${permitStats.small} < ${PERMIT_MIN_AREA} m², ${permitStats.outside} outside the area`);
}

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
const inGround = ringIndex(groundRings);
const fit = fitRoadWidths(roadGraph, paths, PATH_KINDS, inGround);
const PATH_SOURCES = ['mapped', 'tagged', 'inferred'];
for (const p of paths) p.push(0);
const promoted = sidewalkFootways(roadGraph, paths, PATH_KINDS);
for (const pi of promoted) paths[pi][0] = PATH_KINDS.indexOf('sidewalk');
const inferred = inferSidewalks(roadGraph, paths, PATH_KINDS);
for (const [line, w, source] of inferred) paths.push([PATH_KINDS.indexOf('sidewalk'), w, 0, line, 0, PATH_SOURCES.indexOf(source)]);
log(`${promoted.length} mapped footways along kerbs drawn as sidewalks; ${inferred.corners} sidewalk corners`);
log(`road widths fitted to mapped sidewalks: ${fit.widened} widened, ${fit.narrowed} narrowed; sidewalks: ${PATH_SOURCES.map((s, i) => `${paths.filter((p) => PATH_KINDS[p[0]] === 'sidewalk' && p[5] === i).length} ${s}`).join(', ')}`);
const widthSource = roadGraph.widthSource;
const linkClass = roadGraph.highway; // OSM highway class per link (stand-in rules use it)
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
const inBuilding = ringIndex(groundFootprints);
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

// --- Stand-in buildings where OSM maps none (tools/geo-infill.mjs): inferred footprints AND heights ----------------------
// Kept out of `buildings` (GEO.infill) so they stay labelled; open ground from osm_open.json (parking, schoolyards,
// temple courts, plazas, water, rail…) and green areas get none.
const unflat = (a) => { const r = []; for (let i = 0; i < a.length; i += 2) r.push([a[i], a[i + 1]]); return r; };
const node = (i) => [roadGraph.nodes[2 * i], roadGraph.nodes[2 * i + 1]];
const medians = medianSides(roadGraph);
const streetLines = roadGraph.links.map(([a, b, , w, , , inner], i) => ({ pts: [node(a), ...unflat(inner), node(b)], w, median: medians[i], cls: linkClass[i] }));
const openRings = [], railLines = [];
for (const e of load('osm_open.json').elements) {
  const t = e.tags || {};
  const line = e.type === 'way' && e.geometry && (t.railway || t.man_made || t.barrier) && (e.geometry[0].lat !== e.geometry.at(-1).lat || e.geometry[0].lon !== e.geometry.at(-1).lon);
  if (line) railLines.push({ pts: e.geometry.map((g) => toWorld(g.lon, g.lat)), w: t.railway ? 6 : 4 }); // rail, dykes, floodwalls
  else for (const [outer] of polygons(e)) openRings.push(outer);
}
// Elevated roads (viaducts; left out of the street graph) still stand on piers over the ground: no lots under them.
// Width: the width tag, else lanes × 3.25 m + 1 m, else 10 m (a default, not a measurement).
const ELEVATED_CLASSES = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
for (const e of load('osm_roads.json').elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || !ELEVATED_CLASSES.test(t.highway || '') || !(parseFloat(t.layer) > 0 || t.bridge)) continue;
  const w = parseFloat(t.width) || (parseInt(t.lanes, 10) ? parseInt(t.lanes, 10) * 3.25 + 1 : 10);
  railLines.push({ pts: e.geometry.map((g) => toWorld(g.lon, g.lat)), w });
}
const [bx0, bz1] = toWorld(BOX[1], BOX[0]), [bx1, bz0] = toWorld(BOX[3], BOX[2]);
// Every at-grade OSM highway way, drawn or not (private lanes, area outlines, ways the graph leaves out), is a corridor
// too: a stand-in never stands on a mapped way. 2 m wide unless tagged (a default, not a measurement).
const rawWays = [];
for (const e of load('osm_roads.json').elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || !t.highway || t.tunnel || t.indoor || parseFloat(t.layer) < 0 || parseFloat(t.layer) > 0 || t.bridge || /^-/.test(t.level || '')) continue;
  rawWays.push({ pts: e.geometry.map((g) => toWorld(g.lon, g.lat)), w: parseFloat(t.width) || 2 });
}
// AREA.infill: true, or the stand-in rules for the area (geo-infill.mjs INFILL options); GEO_INFILL (JSON) overrides
// them for local experiments against measured buildings
const infillOpts = process.env.GEO_INFILL ? JSON.parse(process.env.GEO_INFILL) : AREA.infill;
const LARGE_M2 = 2500; // m²: footprints this big are 'large' for the stand-in rules
const permitBuildings = buildings.filter((x) => x.b.id.startsWith('p')).map((x) => x.b);
const infill = !infillOpts ? [] : infillBuildings({
  links: streetLines,
  corridors: [...streetLines, ...paths.filter((p) => !(p[2] > 0)).map((p) => ({ pts: p[3], w: Math.max(1, p[1]) })), ...railLines, ...rawWays],
  obstacles: [...outlines, ...parts, ...permitBuildings].map((x) => x.outer),
  large: [...outlines, ...permitBuildings].filter((x) => x.area > LARGE_M2).map((x) => ({ x: x.c[0], z: x.c[1], r: Math.sqrt(x.area / Math.PI) })),
  open: [...openRings, ...green.map((g) => g.outer)],
  bounds: [bx0, bz0, bx1, bz1],
  context: buildings.filter((x) => x.h.source !== 'estimate' && x.h.base < 1 && !x.b.id.includes('_')).map((x) => ({ x: x.b.c[0], z: x.b.c[1], top: x.h.top, area: x.b.area }))
}, infillOpts === true ? {} : infillOpts).filter((b) => inBoundary(...b.outer[0]) && inBoundary(...b.outer[2])); // inside the district
if (infillOpts) log(`stand-in buildings (inferred, not mapped): ${infill.length} lots, ${infill.filter((b) => b.context).length} with heights from ≥ 3 mapped neighbours, ` +
  `${Math.min(...infill.map((b) => b.storeys))}–${Math.max(...infill.map((b) => b.storeys))} storeys; ${openRings.length} open-ground areas kept clear`);

// --- Street furniture -------------------------------------------------------------------------------------------------
const solidRings = [...groundRings, ...infill.map((b) => b.outer)];
const solid = ringIndex(solidRings);
const builtFurniture = buildFurniture(load('osm_furniture.json').elements, toWorld, roadGraph, solid);

// --- Off the drawn carriageways (tools/geo-kerb.mjs) -------------------------------------------------------------------
// Drawn road widths are often estimates, so items mapped at the real kerb can fall inside the drawn road. Mapped items
// move straight out to the drawn kerb (by KERB_MARGIN: how far the model reaches towards the road), as do trees spaced
// along a mapped tree row; inferred ones (lamps, scooters, trees filling a wood) that land on a road are dropped. Items with no clear kerb spot are dropped.
const KERB_MARGIN = { bus_shelter: 1.0, subway_entrance: 3.3, bicycle_rental: 0.8, vending_machine: 0.6, telephone: 0.6, tree: 1.2 };
const clear = kerbClear(roadGraph, solid);
const kerbed = { moved: 0, dropped: 0, why: {} };
const drop = (what) => { kerbed.dropped++; kerbed.why[what] = (kerbed.why[what] || 0) + 1; };
const furniture = [];
for (const f of builtFurniture) {
  const kind = FURNITURE_KINDS[f[0]], inferredItem = FURNITURE_SOURCES[f[4]] === 'inferred';
  const c = clear(f[1], f[2], KERB_MARGIN[kind] ?? 0.5);
  if (!c || (c.moved && inferredItem)) { drop(`${kind}${inferredItem ? ' (inferred)' : ''}${c ? '' : ' (no clear kerb)'}`); continue; }
  if (c.moved) kerbed.moved++;
  furniture.push(c.moved ? [f[0], c.x, c.z, c.yaw, f[4], f[5]] : f);
}
// Bikes at stations & racks, after their kiosk has moved: the row goes where it is off the roads and out of buildings
const docks = expandDocks(furniture, (x, z) => { const c = clear(x, z, 0.4); return c && !c.moved && !solid(x, z); });
furniture.push(...docks);
const treeCount = trees.length;
for (let i = trees.length - 1; i >= 0; i--) {
  const [x, z, src] = trees[i];
  const c = clear(x, z, KERB_MARGIN.tree);
  if (!c || (c.moved && TREE_SOURCES[src] === TREE_SOURCES[2])) { trees.splice(i, 1); drop(`${TREE_SOURCES[src]}${c ? '' : ' (no clear kerb)'}`); continue; }
  if (c.moved) { trees[i] = [q(c.x), q(c.z), src, trees[i][3]]; kerbed.moved++; }
}
log(`off the drawn roads: ${kerbed.moved} mapped items moved to the kerb, ${kerbed.dropped} dropped (furniture ${builtFurniture.length} -> ${furniture.length}, trees ${treeCount} -> ${trees.length}): ${JSON.stringify(kerbed.why)}`);
log(`street furniture: ${FURNITURE_KINDS.map((k, i) => [k, furniture.filter((f) => f[0] === i)]).filter(([, l]) => l.length)
  .map(([k, l]) => `${l.length} ${k}${l.some((f) => f[4] === 1) ? ` (${l.filter((f) => f[4] === 1).length} inferred)` : ''}`).join(', ')}`);

// --- Assemble --------------------------------------------------------------------------------------------------------
const GEO = {
  version: 1,
  city: 'taipei',
  area: AREA_NAME,
  frame: { lat0: AREA.lat0, lon0: AREA.lon0, bearingDeg: 0, origin: AREA.origin, units: 'm', box: BOX, boundary: boundary.map(flat) },
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
  // Ground heights (tools/geo-terrain.mjs): { x0, z0, step, nx, nz, h: decimetres row by row (z, then x), source } or
  // absent (flat). Approximate (30 m SRTM, buildings filtered out); everything stands on it in the viewer.
  ...(terrain ? { terrain } : {}),
  // Stand-in buildings: rows of lots along street frontages where OSM maps no building and no open ground
  // (tools/geo-infill.mjs). Footprint AND height are inferred (height: the median of mapped neighbours' heights,
  // ±1 storey), NOT mapped data; same row shape as `buildings` (source 'estimate', kind 'infill'), ids 'i<n>'.
  infillShown: AREA.infillShown ?? true, // whether the viewer starts with the stand-ins shown
  infillNote: !infillOpts ? 'none: stand-ins are off for this area' : `inferred stand-ins, not OSM buildings: lots ${INFILL.lotWidth.join('–')} m wide facing streets with no mapped building`,
  infill: infill.map((b, i) => [`i${i}`, flat(b.outer), [], q(b.top), 0, SOURCES.indexOf('estimate'), kindId('infill'), 0, 0, 0, 0, FACADES.indexOf('punched'), 1]),
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
const header = `// js/${AREA.out} — GENERATED by tools/build-taipei-geodata.mjs (GEO_AREA=${AREA_NAME}), do not edit by hand.
// Taipei geography in the simulation's world frame: 1 unit = 1 m, x = east, z = south, origin at ${AREA.origin}.
// Polygons are flat [x0, z0, x1, z1, ...] arrays.
// Building footprints, tagged heights, roads, signals, trees, green areas & street furniture © OpenStreetMap contributors (ODbL).
// Building footprints with ids p<n> and height source 'permit': 臺北市建築執照套繪圖, 臺北市建築管理工程處 (Taipei City
// building-permit drawings, Open Government Data License v1.0, https://data.gov.tw/dataset/151936).
// Heights with source 'estimate' (${count.estimate} of ${buildings.length}) are inferred from building type and footprint
// area, not measured.
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
