// tools/hk/build-hk-geodata.mjs — writes js/hk-geodata.js (see seed-hk.mjs for the sources).
//
// usage: node tools/hk/build-hk-geodata.mjs [out.js]
//
// Output schema (GEO v2, "world" tagged) is deliberately the same *shape* as the New York one where the concept
// carries over — flat [x0, z0, x1, z1, …] arrays, 0.1 m rounding, blocks + landmarks + districts — and drops the
// parts that cannot carry over: Manhattan's numbered streets and avenue coordinates have no Hong Kong equivalent,
// so Hong Kong gets named road corridors with real bearings instead.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORIGIN, MPD_LAT, MPD_LON, toWorld, toLatLon, rdp, flat, round, bboxOf, pointInRing } from './frame.mjs';
import { ROADS, LAND, LANDMARKS, DISTRICTS, TRAM, FERRY, TUNNELS, HEIGHT_PROFILE } from './seed-hk.mjs';
import { buildLots } from './blocks.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../../js/hk-geodata.js', import.meta.url));
const log = (...a) => console.log('[hk-geodata]', ...a);

// --- frame ---------------------------------------------------------------------------------------------------------
const frame = {
  originLat: ORIGIN.lat,
  originLon: ORIGIN.lon,
  origin: ORIGIN.name,
  mPerDegLat: round(MPD_LAT, 2),
  mPerDegLon: round(MPD_LON, 2),
  units: 'm',
  northUp: true,
  waterLevel: -2.2,
  seed: true,
  note: 'Seed geography (hand-curated, ~50 m accuracy) — replace with tools/data/hk/* Overpass dumps to get the real city.'
};

// --- land ----------------------------------------------------------------------------------------------------------
const land = LAND.map((l) => ({
  id: l.id,
  zh: l.zh,
  en: l.en,
  ring: flat(rdp(l.ring.map(toWorld), 1.0))
}));

// --- roads ---------------------------------------------------------------------------------------------------------
const roads = ROADS.map((r, i) => {
  const pts = rdp(r.pts.map(toWorld), 1.0);
  const b = bboxOf(pts);
  return {
    id: `r${i}`,
    zh: r.zh,
    en: r.en,
    cls: r.cls,
    w: r.w,
    lanes: r.lanes,
    oneway: !!r.oneway,
    pts: flat(pts),
    bounds: [round(b.minX), round(b.minZ), round(b.maxX), round(b.maxZ)]
  };
});

// --- districts (lon/lat boxes → world boxes) ---------------------------------------------------------------
const districts = DISTRICTS.map((d) => {
  const [x0, z1] = toWorld([d.box[0], d.box[1]]);
  const [x1, z0] = toWorld([d.box[2], d.box[3]]);
  return { id: d.id, zh: d.zh, en: d.en, x0: round(x0), z0: round(z0), x1: round(x1), z1: round(z1) };
});
const districtAt = (x, z) => {
  for (const d of districts) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return d.id;
  return 'central';
};

// --- landmarks -----------------------------------------------------------------------------------------------------
const landmarks = LANDMARKS.map((l) => {
  const [x, z] = toWorld(l.lonlat);
  return {
    id: l.id,
    zh: l.zh,
    en: l.en,
    x: round(x),
    z: round(z),
    w: l.w,
    d: l.d,
    h: l.h,
    kind: l.kind,
    district: districtAt(x, z)
  };
});

// --- lots & buildings ----------------------------------------------------------------------------------------------
const t0 = Date.now();
const pairs = (flatArr) => {
  const out = [];
  for (let i = 0; i + 1 < flatArr.length; i += 2) out.push([flatArr[i], flatArr[i + 1]]);
  return out;
};
const { buildings, stats } = buildLots({
  roads: roads.map((r) => ({ w: r.w, en: r.en, pts: pairs(r.pts) })),
  land: land.map((l) => ({ ring: pairs(l.ring) })),
  heights: HEIGHT_PROFILE,
  districtAt
});
log(`raster ${stats.cells} cells · ${stats.landCells} land · ${stats.roadwayCells} roadway · ${stats.buildings} buildings (${stats.towers} towers) in ${Date.now() - t0} ms`);

const bbox = bboxOf(land.flatMap((l) => {
  const out = [];
  for (let i = 0; i < l.ring.length; i += 2) out.push([l.ring[i], l.ring[i + 1]]);
  return out;
}));
log(`land bounds x ${Math.round(bbox.minX)}…${Math.round(bbox.maxX)} · z ${Math.round(bbox.minZ)}…${Math.round(bbox.maxZ)}`);
if (!buildings.length) throw new Error('no buildings generated — check the land outlines and road widths');
for (const b of buildings) {
  if (!Number.isFinite(b.x) || !Number.isFinite(b.h) || b.h <= 0) throw new Error('bad building record');
}

// --- transport -----------------------------------------------------------------------------------------------------
const tram = flat(rdp(TRAM.map(toWorld), 1.0));
const tunnels = TUNNELS.map((t) => ({ id: t.id, zh: t.zh, en: t.en, pts: flat(t.pts.map(toWorld)) }));
const ferryPiers = FERRY;
const pierPos = (id) => {
  const l = landmarks.find((m) => m.id === id);
  return l ? [l.x, l.z] : [0, 0];
};

const GEO = {
  version: 2,
  world: 'hong-kong',
  frame,
  land,
  roads,
  buildings: buildings.map((b) => ({
    x: round(b.x), z: round(b.z), w: round(b.w, 1), d: round(b.d, 1), h: round(b.h, 1), rot: round(b.rot, 3),
    district: districtAt(b.x, b.z), tower: b.tower ? 1 : 0, road: b.road
  })),
  landmarks,
  districts,
  tram,
  ferry: { from: pierPos(FERRY.from), to: pierPos(FERRY.to), minutes: FERRY.minutes, piers: [FERRY.from, FERRY.to] },
  tunnels
};

const json = JSON.stringify(GEO);
const header = `// js/hk-geodata.js — GENERATED by tools/hk/build-hk-geodata.mjs, do not edit by hand.
// Hong Kong in the simulation's world frame: 1 unit = 1 m, x = east, z = south (north = −z), true north up.
// Origin: ${ORIGIN.name} (${ORIGIN.lat}, ${ORIGIN.lon}).
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// ${frame.seed ? 'SEED DATA: hand-curated centrelines & landmark positions (~50 m accuracy).' : 'Sources: OpenStreetMap contributors (ODbL), HK Lands Department open data.'}
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} kB)`);

// sanity: the projection must round-trip, and the land polygons must be where the origin says they are
const probe = toWorld([114.17, 22.3]);
const [lon, lat] = toLatLon(probe);
if (Math.abs(lon - 114.17) > 1e-9 || Math.abs(lat - 22.3) > 1e-9) throw new Error('frame projection does not round-trip');
const ringOf = (l) => {
  const ring = [];
  for (let i = 0; i < l.ring.length; i += 2) ring.push([l.ring[i], l.ring[i + 1]]);
  return ring;
};
// Statue Square (the origin) sits on reclaimed Central ground; TST's clock tower is on the Kowloon side.
if (!land.some((l) => pointInRing(ringOf(l), 0, 0))) throw new Error('origin is not on land — the seed land outlines are wrong');
const clock = landmarks.find((m) => m.id === 'clock-tower');
if (!land.some((l) => pointInRing(ringOf(l), clock.x, clock.z))) throw new Error('the clock tower is not on the Kowloon land outline');
log('frame + land outlines verified');
