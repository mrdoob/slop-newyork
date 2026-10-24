// tools/build-geodata.mjs — writes js/nyc-geodata.js (see geo-base.mjs for the frame and the data sources)
// usage: GEO_DATA=tools/data node --max-old-space-size=8192 tools/build-geodata.mjs [out.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geo, toWorld, rdp, rdpRing, ringArea, bbox, load, log, centroid } from './geo-base.mjs';
import { pieces, STREETS, AVENUES } from './geo-streets.mjs';
import { blocks, innerRing, roads, PLAZAS, CUT_Z, STRIP, SIDEWALK } from './geo-blocks.mjs';
import { parkShapes, piers, bridges, nj, islands, manhattanSouth, manhattanNorth } from './geo-extra.mjs';
import { buildRoadGraph } from './geo-roadgraph.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/nyc-geodata.js', import.meta.url));
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const inDetail = (z) => z > CUT_Z - 250;

// --- Broadway as one ordered polyline (north to south) through the detailed island --------------------------------
function broadwayLine() {
  const segs = roads.filter((s) => s.name === 'BROADWAY').map((s) => (s.z0 < s.z1 ? [[s.x0, s.z0], [s.x1, s.z1]] : [[s.x1, s.z1], [s.x0, s.z0]]));
  // Keep the carriageways' centre: bucket by z, average x of the pieces covering each 10 m of z
  const zmin = Math.max(CUT_Z, Math.min(...segs.map((s) => s[0][1])));
  const zmax = Math.max(...segs.map((s) => s[1][1]));
  const line = [];
  for (let z = zmin; z <= zmax; z += 10) {
    const xs = [];
    for (const [[xa, za], [xb, zb]] of segs) if (z >= za && z <= zb && zb > za) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
    if (!xs.length) continue;
    // dual carriageways: midpoint of the cluster nearest the previous point
    xs.sort((a, b) => a - b);
    const prev = line.length ? line[line.length - 1][0] : xs[0];
    const near = xs.filter((x) => Math.abs(x - prev) < 60);
    const pick = near.length ? near : [xs.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a))];
    line.push([(Math.min(...pick) + Math.max(...pick)) / 2, z]);
  }
  return rdp(line, 1.5);
}
const broadway = broadwayLine();
log(`Broadway: ${broadway.length} pts from z=${Math.round(broadway[0][1])} to ${Math.round(broadway[broadway.length - 1][1])}`);

// --- Roads (at-grade centreline pieces merged into polylines per street & width), for maps & the road graph ---------
function mergeRoads() {
  const byKey = new Map();
  for (const p of pieces) {
    if (p.level !== '13' || !['1', '2'].includes(p.rw)) continue;
    if (/DRIVEWAY|PEDESTRIAN|ALLEY|CONNECTOR/.test(p.name)) continue;
    if (!inDetail(Math.min(p.z0, p.z1))) continue;
    const key = `${p.name}|${Math.round(p.w)}|${p.dir}|${p.lanes}|${p.rw}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push([[p.x0, p.z0], [p.x1, p.z1]]);
  }
  const out = [];
  for (const [key, segs] of byKey) {
    const [name, w, dir, lanes, rw] = key.split('|');
    // chain pieces end to start
    const ends = new Map();
    const k = (p) => `${q(p[0])},${q(p[1])}`;
    for (const s of segs) ends.set(k(s[0]), s);
    const used = new Set();
    for (const s of segs) {
      if (used.has(s)) continue;
      // walk back to the first piece of this chain
      let first = s;
      const seen = new Set([s]);
      for (;;) {
        const prev = segs.find((t) => !seen.has(t) && !used.has(t) && k(t[1]) === k(first[0]));
        if (!prev) break;
        seen.add(prev);
        first = prev;
      }
      const line = [first[0]];
      let cur = first;
      while (cur && !used.has(cur)) {
        used.add(cur);
        line.push(cur[1]);
        cur = ends.get(k(cur[1]));
      }
      out.push({ name, w: +w, dir, lanes: +lanes, hw: rw === '2', pts: rdp(line, 0.8) });
    }
  }
  return out;
}
const roadLines = mergeRoads();
log(`${roadLines.length} road polylines (${roadLines.reduce((t, r) => t + r.pts.length, 0)} pts)`);

// --- Central Park: features from OpenStreetMap ------------------------------------------------------------------------
const osmCP = load('osm_centralpark.json');
const cpPark = parkShapes.find((p) => p.name === 'Central Park');
const cpBB = bbox(cpPark.rings.reduce((a, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(a)) ? r : a)));
const insideCP = ([x, z]) => x > cpBB.x0 - 5 && x < cpBB.x1 + 5 && z > cpBB.z0 - 5 && z < cpBB.z1 + 5;
const cp = { bounds: { minX: q(cpBB.x0), maxX: q(cpBB.x1), minZ: q(cpBB.z0), maxZ: q(cpBB.z1) }, outline: null, water: [], lawns: [], drives: [], paths: [], sites: [] };
cp.outline = flat(rdpRing(cpPark.rings.reduce((a, r) => (Math.abs(ringArea(r)) > Math.abs(ringArea(a)) ? r : a)), 0.8));
const WATER_NAMES = new Set(['Jacqueline Kennedy Onassis Reservoir', 'The Lake', 'The Pond', 'Harlem Meer', 'Turtle Pond', 'Conservatory Water', 'The Pool']);
const LAWN_NAMES = new Set(['Sheep Meadow', 'The Great Lawn', 'North Meadow', 'Great Hill', 'Heckscher Ballfields', 'East Meadow', 'Cedar Hill', 'Pilgrim Hill', 'The Dene', 'Conservatory Garden', 'Strawberry Fields']);
const SITE_NAMES = ['Bethesda Fountain', 'Bow Bridge', 'Belvedere Castle', 'Gapstow Bridge', "Cleopatra's Needle", 'Central Park Carousel', 'The Dairy (Visitor Center and Gift Shop)', 'Delacorte Theater', 'Kerbs Boathouse', 'The Arsenal', 'Central Park Zoo', 'Columbus Circle', 'Pulitzer Fountain', 'Charles A. Dana Discovery Center', 'Loeb Boathouse', 'Wollman Rink', 'Bethesda Terrace'];
function elemRing(e) {
  if (e.type === 'way') return (e.geometry || []).map((g) => toWorld(g.lon, g.lat));
  let best = [];
  for (const m of e.members || []) if (m.role === 'outer' && m.geometry && m.geometry.length > best.length) best = m.geometry.map((g) => toWorld(g.lon, g.lat));
  return best;
}
function elemRings(e) {
  // relations (The Lake, Turtle Pond, Harlem Meer) come as several outer ways: chain them into closed rings
  if (e.type === 'way') return [(e.geometry || []).map((g) => toWorld(g.lon, g.lat))];
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
    rings.push(ring);
  }
  return rings;
}
const seenSites = new Set();
for (const e of osmCP.elements) {
  const t = e.tags || {};
  const n = t.name || '';
  const isWater = t.natural === 'water' && (WATER_NAMES.has(n) || (!n && t.water === 'pond'));
  if (isWater) {
    for (const r of elemRings(e)) {
      if (r.length < 4 || !insideCP(centroid(r)) || Math.abs(ringArea(r)) < 200) continue;
      const s = rdpRing(r.slice(0, -1), 0.6);
      if (ringArea(s) > 0) s.reverse();
      cp.water.push({ name: n, ring: flat(s) });
    }
  } else if (LAWN_NAMES.has(n) && (t.landuse === 'grass' || t.leisure)) {
    const r = elemRing(e);
    if (r.length > 3 && insideCP(centroid(r))) {
      const s = rdpRing(r.slice(0, -1), 0.8);
      if (ringArea(s) > 0) s.reverse();
      cp.lawns.push({ name: n, ring: flat(s) });
    }
  } else if (e.type === 'way' && t.highway && /^(East Drive|West Drive|Center Drive|Terrace Drive)$/.test(n)) {
    const r = elemRing(e);
    if (r.length > 1 && insideCP(r[0])) cp.drives.push({ name: n, w: t.highway === 'service' ? 6 : 9, pts: flat(rdp(r, 0.8)) });
  } else if (e.type === 'way' && t.highway && /Transverse/.test(n) && t.highway !== 'footway') {
    const r = elemRing(e);
    if (r.length > 1) cp.drives.push({ name: n, w: 10, transverse: true, pts: flat(rdp(r, 0.8)) });
  } else if (SITE_NAMES.includes(n) && !seenSites.has(n)) {
    const r = elemRing(e);
    if (!r.length) continue;
    const b = bbox(r);
    seenSites.add(n);
    // long axis of the outline (bridges: the span) by principal component
    const [mx, mz] = centroid(r);
    let sxx = 0, szz = 0, sxz = 0;
    for (const [x, z] of r) { sxx += (x - mx) ** 2; szz += (z - mz) ** 2; sxz += (x - mx) * (z - mz); }
    const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    cp.sites.push({ name: n, x: q((b.x0 + b.x1) / 2), z: q((b.z0 + b.z1) / 2), w: q(b.x1 - b.x0), d: q(b.z1 - b.z0), ang: Math.round(ang * 1000) / 1000 });
  }
}
// Transverses from the centreline (OSM marks parts of them as footways)
for (const p of roadLines) if (/TRANSVERSE/.test(p.name)) cp.drives.push({ name: p.name, w: p.w || 10, transverse: true, pts: flat(p.pts) });
log(`Central Park: ${cp.water.length} water bodies, ${cp.lawns.length} lawns, ${cp.drives.length} drive pieces, ${cp.sites.length} sites`);

// --- Landmarks: real footprints (grid-aligned bounding boxes) from OSM ---------------------------------------------
const osmLM = load('osm_landmarks.json');
const landmarks = {};
for (const e of osmLM.elements) {
  const t = e.tags || {};
  const r = elemRing(e);
  if (!r.length || !t.name) continue;
  const b = bbox(r);
  const area = Math.abs(ringArea(r));
  const prev = landmarks[t.name];
  if (prev && prev.area >= area) continue;
  landmarks[t.name] = { x: q((b.x0 + b.x1) / 2), z: q((b.z0 + b.z1) / 2), w: q(b.x1 - b.x0), d: q(b.z1 - b.z0), h: t.height ? parseFloat(t.height) : null, area: Math.round(area), ring: flat(rdpRing(r.slice(0, -1), 0.4)) };
}
log(`${Object.keys(landmarks).length} landmark footprints`);

// --- Assemble -----------------------------------------------------------------------------------------------------------
const streetsOut = STREETS.filter((s) => inDetail(s.z)).map((s) => ({ n: s.n, z: s.z, segs: s.segs.map(([a, b, d, w]) => [q(a), q(b), d, q(w)]) }));
const avenuesOut = AVENUES.map((a) => ({
  id: a.id, label: a.label, x: a.x,
  segs: a.segs.filter((s) => s.z1 > CUT_Z - 200).map((s) => ({ z0: Math.max(s.z0, CUT_Z - 200), z1: s.z1, dir: s.dir, w: s.w, lanes: s.lanes, names: s.names }))
})).filter((a) => a.segs.length);

// --- Points of note from their real coordinates (bridge towers beyond the island, the statue, ferry terminals) --------
const POINTS = {
  gwbManhattanTower: [40.85012, -73.94693], gwbNJTower: [40.85361, -73.95804],
  verrazzanoBrooklynTower: [40.60799, -74.03864], verrazzanoStatenTower: [40.60458, -74.05385],
  statueOfLiberty: [40.68925, -74.0445], whitehallTerminal: [40.70123, -74.0131], pier17: [40.70578, -74.00185],
  castleClinton: [40.70355, -74.01686], peterMinuitPlaza: [40.70187, -74.01334], bowlingGreen: [40.70496, -74.01352]
};
const points = Object.fromEntries(Object.entries(POINTS).map(([k, [lat, lon]]) => [k, toWorld(lon, lat).map(q)]));

const GEO = {
  version: 1,
  frame: { bearingDeg: q((geo.THETA * 180) / Math.PI * 10) / 10, origin: '5th Ave & 42nd St (centreline)', units: 'm', cutZ: CUT_Z, strip: STRIP, sidewalk: SIDEWALK },
  manhattan: flat(manhattanSouth),
  upperManhattan: flat(manhattanNorth),
  innerShore: flat(innerRing),
  islands: Object.fromEntries(Object.entries(islands).map(([k, r]) => [k, flat(r)])),
  boroughs: {
    brooklyn: geo.boroughs.brooklyn.map(flat),
    queens: geo.boroughs.queens.map(flat),
    bronx: geo.boroughs.bronx.map(flat),
    statenIsland: geo.boroughs.statenIsland.map(flat),
    newJersey: [flat(nj)]
  },
  streets: streetsOut,
  avenues: avenuesOut,
  broadway: flat(broadway),
  plazas: PLAZAS.map((p) => ({ name: p.name, a: p.a.map(q), b: p.b.map(q), w: p.w })),
  roads: roadLines.map((r) => [r.name, r.w ? q(r.w) : 0, r.dir || '', r.lanes || 0, r.hw ? 1 : 0, flat(r.pts)]),
  // Street centreline graph for Lower Manhattan and northern non-grid roads (geo-roadgraph.mjs): nodes [x, z, ...],
  // links [node a, node b, name index, curb-to-curb width, travel lanes, direction (1: a -> b, -1: b -> a, 0: both),
  // inner shape points [x, z, ...]]
  roadGraph: buildRoadGraph(),
  // [outline, lot rects, park share, park name, rectangular, frontage frames [[θ, px, pz, lot rects in the frame], ...] | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park || 0, b.parkName || '', b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0]),
  parks: parkShapes.map((p) => ({ name: p.name, cat: p.cat, acres: p.acres, rings: p.rings.map(flat) })),
  centralPark: cp,
  piers: piers.map((p) => ({ name: p.name, cx: q(p.cx), cz: q(p.cz), len: q(p.len), wid: q(p.wid), ang: Math.round(p.ang * 1e4) / 1e4, ring: flat(p.ring) })),
  bridges: Object.fromEntries(Object.entries(bridges).map(([k, b]) => [k, { a: b.a.map(q), mid: b.mid.map(q), dir: [Math.round(b.ux * 1e5) / 1e5, Math.round(b.uz * 1e5) / 1e5] }])),
  landmarks,
  points
};

const json = JSON.stringify(GEO);
const header = `// js/nyc-geodata.js — GENERATED by tools/build-geodata.mjs, do not edit by hand.
// Real New York geography in the simulation's world frame: 1 unit = 1 m, x = Manhattan-grid east, z = grid south,
// origin at the centreline intersection of 5th Ave & 42nd St, axes turned ${GEO.frame.bearingDeg}° from true north.
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Sources: NYC DCP Borough Boundaries, NYC Street Centerline (CSCL) & NYC Parks Properties (NYC Open Data);
// Central Park features, piers, landmark footprints & the New Jersey shore © OpenStreetMap contributors (ODbL).
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true }); // js/world/ in a fresh checkout or a bare test copy
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);
