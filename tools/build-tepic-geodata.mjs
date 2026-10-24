// tools/build-tepic-geodata.mjs — writes js/city-geodata.js for Tepic, Nayarit, from OpenStreetMap.
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
//
// usage: node --max-old-space-size=8192 tools/build-tepic-geodata.mjs [outFile]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { log, ringArea, bbox, centroid, rdp, rdpRing, extractBlocks, ringCells, clearCapsule, minAreaRect, decodePNG } from './tepic-lib.mjs';
import { STOREFRONTS } from '../js/storefronts/index.js';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/tepic/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../js/city-geodata.js', import.meta.url));
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
// of Xalisco: the whole metropolitan area of Tepic & Xalisco
const BOX = { x0: -5800, x1: 9400, z0: -4800, z1: 9900 };
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
  for (const ch of chains) {
    for (const piece of clipChain(ch)) {
      const line = rdp(piece, 0.4);
      const a = nodeAt(...line[0]);
      const b = nodeAt(...line[line.length - 1]);
      if (a === b) continue;
      const inner = line.slice(1, -1).flatMap(([x, z]) => [q(x), q(z)]);
      links.push([a, b, ni, spec.w, spec.lanes, spec.dir, inner]);
      for (let i = 0; i + 1 < line.length; i++) {
        drivePieces.push({ x0: line[i][0], z0: line[i][1], x1: line[i + 1][0], z1: line[i + 1][1], r: spec.w / 2 + 0.3, major: spec.major });
      }
    }
  }
  for (const piece of clipChain(pts)) {
    roadLines.push({ name, w: spec.w, dir: spec.dir === 0 ? 'TW' : spec.dir > 0 ? 'FT' : 'TF', lanes: spec.lanes, hw: spec.major, pts: rdp(piece, 0.8) });
  }
}
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
const landOSM = load('osm_tepic_land.json');
const bldOSM = load('osm_tepic_buildings.json');
for (const e of landOSM.elements) {
  if (e.type !== 'way' || !e.geometry || !e.tags) continue;
  const t = e.tags;
  const r = t.railway === 'rail' ? 5 : t.waterway === 'river' ? 6 : t.waterway === 'stream' ? 2.5 : 0;
  if (!r) continue;
  const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
  for (let i = 0; i + 1 < pts.length; i++) cutters.push({ x0: pts[i][0], z0: pts[i][1], x1: pts[i + 1][0], z1: pts[i + 1][1], r });
}
for (const s of drivePieces) clearCapsule(land, W, H, X0, Z0, RES, s);
for (const s of cutters) clearCapsule(land, W, H, X0, Z0, RES, s);
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

// --- Parks, pitches, schoolyards, scrub & water onto the blocks ---------------------------------------------------------
function elemRings(e) {
  if (e.type === 'way') {
    const r = (e.geometry || []).map((g) => toWorld(g.lon, g.lat));
    return r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.5 ? [r.slice(0, -1)] : [];
  }
  const parts = (e.members || []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry.map((g) => toWorld(g.lon, g.lat)));
  const rings = [];
  const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 500 && !close(ring[0], ring[ring.length - 1]); guard++) {
      const i = parts.findIndex((p) => close(p[0], ring[ring.length - 1]) || close(p[p.length - 1], ring[ring.length - 1]));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(close(p[0], ring[ring.length - 1]) ? p.slice(1) : p.reverse().slice(1));
    }
    if (ring.length > 3) rings.push(close(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring);
  }
  return rings;
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
const houses = [];
{
  const file = path.join(DATA, 'overture', 'buildings.geojsonl');
  const labAt = (x, z) => {
    const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
    return i >= 0 && j >= 0 && i < W && j < H ? lab[j * W + i] : 0;
  };
  const propAt = (x, z) => {
    const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
    return i >= 0 && j >= 0 && i < W && j < H ? prop[j * W + i] : 0;
  };
  const hashf = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  let read = 0, small = 0, outside = 0, squeezed = 0;
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
      if (area < 25 || area > 30000) { small++; continue; }
      const r = minAreaRect(ring);
      if (!r || !inBox(r.cx, r.cz) || !labAt(r.cx, r.cz)) { outside++; continue; }
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
      // Ground floor shops: tagged commercial buildings, most of the centro, a few on every street
      const shop = /commercial|retail|office|supermarket|hotel/.test(cls) || (bestD < 6 && (centro ? hr > 0.25 : hashf(cz, cx) < 0.12));
      houses.push(Math.round(cx * 10), Math.round(cz * 10), Math.round(w * 10), Math.round(d * 10), Math.round(th * 1000), floors, front + (shop ? 4 : 0), 0);
    }
  }
  log(`houses: ${houses.length / HS} built of ${read} Overture footprints (${small} too small or large, ${outside} off the blocks, ${squeezed} squeezed out by the streets)`);
}

// =====================================================================================================================
// 5C. SHOP SIGNS: the businesses of Overture Maps' places on the buildings they stand in. Chains get a parody name in
//     their colours on a fascia band, local businesses their own name on the awning (the centro's first, while the
//     sign atlas has room), every other shop a generic sign of its trade
// =====================================================================================================================
const signs = [];
{
  // the chain stores' looks & parody names live in js/storefronts (one module per kind of store)
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
  const ATLAS_SLOTS = 816; // js/buildings.js sign atlas: 8 columns x 102 rows
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

  const file = path.join(DATA, 'overture', 'places.geojsonl');
  const locals = [];
  let chains = 0, named = 0, generic = 0;
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
      const chain = CHAINS.find((sf) => sf.match.test(name) || sf.match.test(brand));
      if (chain) {
        const i = houseAt(x, z, chain.big ? 40 : 15);
        if (i < 0) continue;
        houses[i + 7] = signIndex.get(`chain:${chain.id}`);
        houses[i + 6] |= 4; // a shop
        houses[i + 5] = Math.min(houses[i + 5], chain.big ? 2 : 1);
        chains++;
        continue;
      }
      const i = houseAt(x, z, 8);
      if (i < 0 || houses[i + 7]) continue;
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
    else {
      k = signIndex.get(`trade:${tradeOf(l.name, l.cat) || 'MISCELÁNEA'}`);
      generic++;
    }
    houses[l.i + 7] = k;
    houses[l.i + 6] |= 4;
  }
  // shops with no business on record: a trade by the house's hash
  for (let i = 0; i < houses.length; i += HS) {
    if (houses[i + 6] < 4 || houses[i + 7]) continue;
    const t = STREET_TRADES[hashS(`${houses[i]},${houses[i + 1]}`) % STREET_TRADES.length];
    houses[i + 7] = signIndex.get(`trade:${t}`);
  }
  log(`shop signs: ${chains} chain stores, ${named + generic} shops from ${locals.length} local businesses (${named} named, ${generic} by trade), ${signs.length} sign faces`);
}

// =====================================================================================================================
// 5D. TERRAIN: the hills around the valley (Cerro de San Juan, Cerro de la Cruz, the lomas) from the Terrarium elevation
//     tiles (tools/data/tepic/fetch-terrain.sh). The city itself stays flat: the valley floor's slow tilt (a wide blur
//     of the elevation under the streets & blocks) is taken off, and what rises above it fades in away from them
// =====================================================================================================================
const terrain = (() => {
  const dir = path.join(DATA, 'terrain');
  if (!fs.existsSync(dir)) return null;
  const Z = 12, N = 2 ** Z;
  const tiles = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = /^12_(\d+)_(\d+)\.png$/.exec(f);
    if (m) tiles.set(`${m[1]}_${m[2]}`, decodePNG(fs.readFileSync(path.join(dir, f)), zlib.inflateSync));
  }
  if (!tiles.size) return null;
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
  const builtNear = dilate(built, 1), builtArea = dilate(built, 3);
  const labAt = (x, z) => {
    const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
    return i >= 0 && j >= 0 && i < W && j < H ? lab[j * W + i] : -1;
  };
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
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (labAt(x + (a - 1.5) * CELL / 4, z + (b - 1.5) * CELL / 4) === 0) road++;
      }
      U[j * TW + i] = builtNear[j * TW + i] || road >= 3 ? 1 : 0;
    }
  }
  // fill tiles we don't have with the mean
  let sum = 0, cnt = 0;
  for (const e of E) if (Number.isFinite(e)) { sum += e; cnt++; }
  for (let k = 0; k < E.length; k++) if (!Number.isFinite(E[k])) E[k] = sum / cnt;
  // separable box blur (3 passes ~ a Gaussian of sigma ~ r)
  const blur = (src, r) => {
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    for (let pass = 0; pass < 3; pass++) {
      for (let j = 0; j < TH; j++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += a[j * TW + Math.min(TW - 1, Math.max(0, i))];
        for (let i = 0; i < TW; i++) {
          b[j * TW + i] = acc / (2 * r + 1);
          acc += a[j * TW + Math.min(TW - 1, i + r + 1)] - a[j * TW + Math.max(0, i - r)];
        }
      }
      for (let i = 0; i < TW; i++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += b[Math.min(TH - 1, Math.max(0, j)) * TW + i];
        for (let j = 0; j < TH; j++) {
          a[j * TW + i] = acc / (2 * r + 1);
          acc += b[Math.min(TH - 1, j + r + 1) * TW + i] - b[Math.max(0, j - r) * TW + i];
        }
      }
    }
    return a;
  };
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
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const out = new Int16Array(TW * TH);
  let peak = 0;
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const k = j * TW + i;
    // the valley floor here: the city's elevation nearby, else further out, else its mean
    const wN = near[1][k], wF = far[1][k];
    const base = wN > 0.05 ? near[0][k] / wN : wF > 0.01 ? far[0][k] / wF : floorMean;
    let h = Math.max(0, E[k] - base);
    h *= smooth(15, 150, D[k]);
    // fade out at the edge of the grid
    const edge = Math.min(i, j, TW - 1 - i, TH - 1 - j) * CELL;
    h *= smooth(0, 2500, edge);
    out[k] = Math.round(Math.min(3200, h) * 10);
    if (h > peak) peak = h;
  }
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
  log(`terrain: ${TW} x ${TH} cells of ${CELL} m, highest ${Math.round(peak)} m over the valley floor (${Math.round(floorMean)} m a.s.l.), ${missing} cells off the tiles`);
  return { x0: TX0, z0: TZ0, cell: CELL, w: TW, h: TH, floor: Math.round(floorMean), data: Buffer.from(out.buffer).toString('base64'), cross, paths };
})();

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
  ['bonaterra', 'Bonaterra', 'Libramiento · Bonaterra', 21.46550, -104.84385]
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
  roadGraph: { nodes: gnodes.flatMap(([x, z]) => [q(x), q(z)]), links, names, signals },
  // [outline, lot rects, park share, park name, rectangular, frontage frames | 0, open country (no buildings) 1 | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0, b.rural ? 1 : 0]),
  parks,
  centralPark: null,
  piers: [],
  bridges: {},
  landmarks,
  points: {},
  places,
  pois,
  teleports,
  // Real buildings (Overture Maps), 8 integers each: centre x, z (dm), width, depth (dm, local x / z), turn θ
  // (mrad, world = c + R_y(θ)·local), storeys, front side (0 w, 1 e, 2 n, 3 s of the local frame) + 4 with a shop, sign
  // (1-based index into `signs`, 0 none)
  houseStride: HS,
  houses,
  // Shop sign faces: { text, bg, fg, border, chain?, big? } (chains carry parody names)
  signs,
  // The hills around the valley: heights (dm, Int16 little-endian, base64) over the flat city on a w x h grid of
  // `cell` m from (x0, z0), row by row; `cross`: the Cerro de la Cruz summit
  terrain
};

const json = JSON.stringify(GEO);
const header = `// js/city-geodata.js — GENERATED by tools/build-tepic-geodata.mjs, do not edit by hand.
// Tepic, Nayarit in the simulation's world frame: 1 unit = 1 m, x = east along the centro's grid, z = south,
// origin at the Plaza Principal, axes turned ${GEO.frame.bearingDeg}° from true north.
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Source: © OpenStreetMap contributors (ODbL), via Overpass (tools/data/tepic/).
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
