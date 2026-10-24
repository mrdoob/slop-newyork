// tools/geo-taipei-base.mjs
// Taipei's world frame and source data for the build. Same 1:1 frame as NYC (tools/geo-frame.mjs): 1 unit = 1 m,
// x = east, z = south (north = -z).
//
// What differs from NYC and why:
//   - NYC turns its axes 29° to the Manhattan avenue grid and puts the origin at 5th Ave & 42nd St, both measured from
//     the street centerline. Taipei has no citywide grid (Xinyi's semi-grid is local), so the frame is north-up
//     (theta = 0) and needs no calibration data.
//   - The origin is Taipei 101 (25.033964 N, 121.564468 E), which is also the projection's tangent point, so world
//     origin = projection origin. Checked against OSM: the Taipei 101 outline (way 1159328965) averages to (14, 2) m
//     from the origin, i.e. the origin lies on the tower's site.
//   - No harbour islands, piers or coastline: both boxes are inland.
//
// Areas (GEO_AREA=<name>, default xinyi). Each has its own frame origin, box, landmarks, inputs and output file, so a
// second district is a second dataset rather than a wider box:
//   xinyi   2 km box around Taipei 101: the best-mapped area, the first milestone.
//   wanhua  1 km box around Lungshan Temple (艋舺龍山寺, way 198401479, centre 25.037276 N, 121.499881 E): the old
//           district, low walk-ups and shophouses, sparse OSM height tags; stresses the height fallback. No landmark
//           height is pinned (no published, sourced figure for the temple roof).
//
// Inputs (tools/data-taipei/, fetched with tools/overpass.sh from the q_*.overpassql files there):
//   osm_buildings.json   building + building:part ways & relations in BOX   © OpenStreetMap contributors (ODbL)
//   osm_roads.json       highway ways in BOX                                © OpenStreetMap contributors (ODbL)
//   osm_street.json      trees, tree rows, traffic signals, parks/green     © OpenStreetMap contributors (ODbL)
//   osm_furniture.json   lamps, bus stops, MRT entrances, YouBike, hydrants… © OpenStreetMap contributors (ODbL)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFrame } from './geo-frame.mjs';

// Boxes are [S, W, N, E] degrees and must match the q_*.overpassql bounds in the area's data directory (at 25° N,
// 1 km ≈ 0.00902° of latitude and ≈ 0.00991° of longitude). Xinyi: ±1 km of Taipei 101 (the first milestone used the
// 1 km box [25.029, 121.559, 25.039, 121.570]). Wanhua: ±0.5 km of the temple.
// `infill`: add stand-in buildings where OSM maps none (tools/geo-infill.mjs). Chosen per area from the local check
// against measured buildings (tools/validate-heights.mjs): in Wanhua, where OSM lacks whole blocks, 14% of stand-ins
// have no measured building within 12 m; in Xinyi, where unmapped frontage is mostly real open space (plazas, tower
// setbacks, the Elephant Mountain slopes), 46% do, so Xinyi gets none.
const AREAS = {
  xinyi: { lat0: 25.033964, lon0: 121.564468, origin: 'Taipei 101', box: [25.0249, 121.5546, 25.043, 121.5744], data: 'data-taipei/', out: 'taipei-geodata.js', infill: false },
  wanhua: { lat0: 25.037276, lon0: 121.499881, origin: 'Lungshan Temple', box: [25.0328, 121.4949, 25.0418, 121.5048], data: 'data-taipei/wanhua/', out: 'taipei-wanhua-geodata.js', infill: true }
};
const AREA_NAME = process.env.GEO_AREA || 'xinyi';
const AREA = AREAS[AREA_NAME];
if (!AREA) throw new Error(`unknown GEO_AREA ${AREA_NAME} (${Object.keys(AREAS).join(', ')})`);

const DATA = process.env.GEO_DATA || fileURLToPath(new URL(AREA.data, import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log(`[taipei-geodata:${AREA_NAME}]`, ...a);

const frame = makeFrame({ lat0: AREA.lat0, lon0: AREA.lon0, theta: 0, origin: [0, 0] });
const { toWorld } = frame;
const BOX = AREA.box;

// Landmarks whose height is known from outside OSM, matched on `name:en` (OSM's primary `name` is Chinese). The build
// fails if the rendered top (the outline, or its tallest building:part when parts model it) differs by more than
// `tol` m, so a mis-tagged or mis-modelled landmark can't slip through at the wrong scale.
//
// `tiers` reshapes one building:part of the landmark where OSM's prism loses its defining form. Taipei 101's shaft
// (way 198637969, 0–386 m in OSM) is, by its design, a tapered base followed by eight flared modules of eight floors
// ("pagoda" segments, each wider at its top); the footprint and heights stay OSM's, the base/module split and flare
// are a shape model of the published design, not survey data.
const LANDMARKS = AREA_NAME !== 'xinyi' ? {} : {
  'Taipei 101': {
    height: 508, tol: 1, ref: 'architectural top incl. spire, CTBUH',
    tiers: { part: 'w198637969', baseTop: 117, baseScale: [1.05, 0.95], count: 8, moduleScale: [0.93, 1.06] }
  }
};

export { frame, toWorld, BOX, LANDMARKS, AREA, AREA_NAME, load, log };
