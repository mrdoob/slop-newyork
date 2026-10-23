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
//   - No harbour islands, piers or coastline: the 1 km Xinyi box is inland.
//
// Inputs (tools/data-taipei/, fetched with tools/overpass.sh from the q_*.overpassql files there):
//   osm_buildings.json   building + building:part ways & relations in BOX   © OpenStreetMap contributors (ODbL)
//   osm_roads.json       highway ways in BOX                                © OpenStreetMap contributors (ODbL)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFrame } from './geo-frame.mjs';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data-taipei/', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[taipei-geodata]', ...a);

const frame = makeFrame({ lat0: 25.033964, lon0: 121.564468, theta: 0, origin: [0, 0] });
const { toWorld } = frame;

// 1 km test box around Taipei 101, [S, W, N, E] degrees; must match the q_*.overpassql bounds. At 25° N it spans
// x -552..558, z -558..550 m: about 1.11 km each way, centred on the origin.
const BOX = [25.029, 121.559, 25.039, 121.570];

// Landmarks whose height is known from outside OSM, matched on `name:en` (OSM's primary `name` is Chinese). The build
// fails if the rendered top (the outline, or its tallest building:part when parts model it) differs by more than
// `tol` m, so a mis-tagged or mis-modelled landmark can't slip through at the wrong scale.
const LANDMARKS = {
  'Taipei 101': { height: 508, tol: 1, ref: 'architectural top incl. spire, CTBUH' }
};

export { frame, toWorld, BOX, LANDMARKS, load, log };
