// tools/gap-tasks.mjs — LOCAL-ONLY mapping task list for buildings missing from OpenStreetMap
// usage: [GEO_AREA=xinyi|wanhua] node tools/gap-tasks.mjs   (run tools/validate-heights.mjs for the area first)
//
// Turns the gap cells of tools/validate-heights.mjs (50 m cells where Taipei's 3D city models have buildings with no
// OSM footprint) into a task list: one row per cell, busiest first, with links to open the cell in the OSM editor.
// Output: tools/data-local/gap-tasks-<area>.md and .geojson (cell squares; opens in JOSM, QGIS or geojson.io).
//
// The cells say only WHERE to look. They are derived from the 3D service, which has no open licence, so the output
// stays in the git-ignored tools/data-local/ and must not be uploaded or traced from: map each building in OSM from
// sources OSM allows (survey, imagery the OSM community has cleared for Taiwan), as with any other mapping.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { frame, AREA, AREA_NAME, log } from './geo-taipei-base.mjs';

const CELL = 50; // m, as validate-heights.mjs
const local = (f) => fileURLToPath(new URL(`data-local/${f}`, import.meta.url));
const suffix = AREA_NAME === 'xinyi' ? '' : `-${AREA_NAME}`;
const report = JSON.parse(fs.readFileSync(local(`height-validation${suffix}.json`), 'utf8'));

// World (x east, z south) -> lon/lat; north-up frame with the origin at the tangent point (theta 0, origin [0, 0])
const [kx] = frame.enu(frame.lon0 + 1, frame.lat0), [, ky] = frame.enu(frame.lon0, frame.lat0 + 1);
const toGeo = (x, z) => [frame.lon0 + x / kx, frame.lat0 - z / ky];

// Areas defined by a district outline: only cells whose centre lies inside it (the outline as the build chained it,
// GEO.frame.boundary in world metres)
const { GEO } = await import(new URL(`../js/${AREA.out}`, import.meta.url));
const rings = (GEO.frame.boundary || []).map((f) => { const r = []; for (let k = 0; k < f.length; k += 2) r.push([f[k], f[k + 1]]); return r; });
const inOutline = (x, z) => !rings.length || rings.some((r) => {
  let inside = false;
  for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
    const [xa, za] = r[a], [xb, zb] = r[b];
    if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
  }
  return inside;
});
const cells = report.gapCells.filter((c) => { const [x, z] = c.cell.split(',').map(Number); return inOutline(x + CELL / 2, z + CELL / 2); }).map((c, i) => {
  const [x, z] = c.cell.split(',').map(Number);
  const [lon, lat] = toGeo(x + CELL / 2, z + CELL / 2);
  const ring = [[x, z], [x + CELL, z], [x + CELL, z + CELL], [x, z + CELL], [x, z]].map(([a, b]) => toGeo(a, b).map((v) => +v.toFixed(6)));
  return { task: i + 1, ...c, lat: +lat.toFixed(6), lon: +lon.toFixed(6), ring };
});
const total = cells.reduce((t, c) => t + c.buildings, 0);
const edit = (c) => `https://www.openstreetmap.org/edit?editor=id#map=19/${c.lat}/${c.lon}`;
const view = (c) => `https://www.openstreetmap.org/#map=19/${c.lat}/${c.lon}`;

const geojson = {
  type: 'FeatureCollection',
  features: cells.map((c) => ({
    type: 'Feature',
    properties: { task: c.task, missing: c.buildings, tallest_m: c.tallest, edit: edit(c) },
    geometry: { type: 'Polygon', coordinates: [c.ring] }
  }))
};
// Cumulative share: how many cells cover half / 80% of the missing buildings
const reach = (f) => { let t = 0; return cells.findIndex((c) => (t += c.buildings) >= total * f) + 1; };

const md = [
  `# Missing OSM buildings: ${AREA_NAME}`,
  '',
  `LOCAL ONLY — derived from https://3d.taipei (no open licence). Do not commit, upload or trace from it.`,
  `Use it only to decide where to map; draw buildings from sources OSM allows.`,
  '',
  `${total} buildings ≥ 4 m tall in the 3D models have no OSM footprint, in ${cells.length} cells of ${CELL} m.`,
  `The first ${reach(0.5)} cells hold half of them, the first ${reach(0.8)} hold 80%.`,
  '',
  '| # | missing | tallest m | centre (lat, lon) | edit | view |',
  '|---|---|---|---|---|---|',
  ...cells.map((c) => `| ${c.task} | ${c.buildings} | ${c.tallest} | ${c.lat}, ${c.lon} | [iD](${edit(c)}) | [map](${view(c)}) |`),
  ''
].join('\n');

fs.writeFileSync(local(`gap-tasks${suffix}.md`), md);
fs.writeFileSync(local(`gap-tasks${suffix}.geojson`), JSON.stringify(geojson));
log(`${cells.length} cells, ${total} missing buildings; half in the first ${reach(0.5)} cells, 80% in ${reach(0.8)}`);
log(`wrote tools/data-local/gap-tasks${suffix}.md and .geojson (git-ignored)`);
