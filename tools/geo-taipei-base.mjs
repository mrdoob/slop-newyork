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
//   - No harbour islands, piers or coastline: both areas are inland.
//
// Areas (GEO_AREA=<name>, default xinyi). Each has its own frame origin, box, landmarks, inputs and output file, so a
// second district is a second dataset rather than a wider box:
//   xinyi   the whole of Xinyi District (信義區, OSM relation 2881027; queries select the district area, the box is its
//           bounding box): the best-mapped area. Earlier milestones used 1 km and 2 km boxes around Taipei 101. The
//           south-east quarter is the Four Beasts hills (Elephant Mountain…), drawn flat until terrain data is in.
//   city    Xinyi + Da'an Districts (大安區, OSM relation 2869465) in one world, origin still Taipei 101: the city growing
//           district by district (Xinyi stays as its own area, the baseline). Da'an is well mapped, flat but for the
//           Fuzhou Shan / Treasure Hill edge to the south-east.
//   wanhua  1 km box around Lungshan Temple (艋舺龍山寺, way 198401479, centre 25.037276 N, 121.499881 E): the old
//           district, low walk-ups and shophouses, sparse OSM height tags; stresses the height fallback. No landmark
//           height is pinned (no published, sourced figure for the temple roof).
//
// Inputs (tools/data-taipei/, fetched with tools/overpass.sh from the q_*.overpassql files there):
//   osm_buildings.json   building + building:part ways & relations in BOX   © OpenStreetMap contributors (ODbL)
//   osm_roads.json       highway ways in BOX                                © OpenStreetMap contributors (ODbL)
//   osm_street.json      trees, tree rows, traffic signals, parks/green     © OpenStreetMap contributors (ODbL)
//   osm_furniture.json   lamps, bus stops, MRT entrances, YouBike, hydrants… © OpenStreetMap contributors (ODbL)
//   osm_open.json        open ground (parking, schools, plazas, water…)     © OpenStreetMap contributors (ODbL)
//   osm_boundary.json    the area's administrative boundary (when it is a district) © OpenStreetMap contributors (ODbL)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFrame } from './geo-frame.mjs';

// Boxes are [S, W, N, E] degrees and must match the q_*.overpassql bounds in the area's data directory (at 25° N,
// 1 km ≈ 0.00902° of latitude and ≈ 0.00991° of longitude). Xinyi: the district's bounding box (its queries select the
// district area itself; the 2 km milestone box was [25.0249, 121.5546, 25.043, 121.5744]). Wanhua: ±0.5 km of the temple.
// `boundary`: the OSM relation(s) of the district outline(s) (osm_boundary.json), exported as GEO.frame.boundary.
// `terrain`: ground heights from open elevation tiles (tools/geo-terrain.mjs, tiles cached in data-taipei/terrain/ for
// every area); without it the area is flat.
// `landmarks`: names (LANDMARKS) whose sourced height the build checks.
// `permits`: add building-permit footprints (permits.json, tools/extract-permits.mjs) where OSM maps no building.
// `infill`: add stand-in buildings where OSM maps none (tools/geo-infill.mjs). Chosen per area from the local check
// against measured buildings (tools/validate-heights.mjs): in Wanhua, where OSM lacks whole blocks, 14% of stand-ins
// have no measured building within 12 m; in Xinyi, where unmapped frontage is mostly real open space (plazas, tower
// setbacks, the Elephant Mountain slopes), 46% do. For the whole district (local check, 18,049 measured buildings, 5,585
// without an OSM footprint) the frontage rules alone put 55–60% of stand-ins on open ground; limited to built-up fabric
// (minCover), off trunk/primary/secondary frontage and 15 m clear of large buildings, 39% (7,500 lots covering ~1,500
// gaps). That is too uncertain to show by default: `infillShown: false` starts them hidden (the viewer's I button).
const AREAS = {
  xinyi: { lat0: 25.033964, lon0: 121.564468, origin: 'Taipei 101', box: [25.0081, 121.5526, 25.0496, 121.5923], boundary: 2881027, data: 'data-taipei/', out: 'taipei-geodata.js',
    // stand-ins only inside built-up fabric, off the big roads, clear of towers; hidden until the viewer turns them on
    infill: { skipClasses: ['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link'], largeClear: 15, minCover: 0.2 },
    infillShown: false, permits: true, terrain: true, landmarks: ['Taipei 101'] },
  city: { lat0: 25.033964, lon0: 121.564468, origin: 'Taipei 101', box: [25.0072, 121.5217, 25.0496, 121.5923], boundary: [2881027, 2869465], data: 'data-taipei/city/', out: 'taipei-city-geodata.js',
    // Xinyi's stand-in rules (checked again for Da'an with tools/validate-heights.mjs before trusting them)
    infill: { skipClasses: ['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link'], largeClear: 15, minCover: 0.2 },
    infillShown: false, permits: true, terrain: true, landmarks: ['Taipei 101'] },
  wanhua: { lat0: 25.037276, lon0: 121.499881, origin: 'Lungshan Temple', box: [25.0328, 121.4949, 25.0418, 121.5048], data: 'data-taipei/wanhua/', out: 'taipei-wanhua-geodata.js', infill: true, permits: true }
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
const ALL_LANDMARKS = {
  'Taipei 101': {
    height: 508, tol: 1, ref: 'architectural top incl. spire, CTBUH',
    tiers: { part: 'w198637969', baseTop: 117, baseScale: [1.05, 0.95], count: 8, moduleScale: [0.93, 1.06] }
  }
};
const LANDMARKS = Object.fromEntries((AREA.landmarks || []).map((n) => [n, ALL_LANDMARKS[n]]));

export { frame, toWorld, BOX, LANDMARKS, AREA, AREA_NAME, AREAS, load, log };
