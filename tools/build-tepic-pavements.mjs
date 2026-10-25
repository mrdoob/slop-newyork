// tools/build-tepic-pavements.mjs
// Writes js/world/pavement-data.js: the streets of Tepic that are not asphalt, from OpenStreetMap's `surface` tags
// (tools/data/tepic/osm_tepic_roads.json), in the game's frame (the same projection & grid bearing as
// build-tepic-geodata.mjs), plus the colonias known to be cobbled whose streets OpenStreetMap leaves untagged (COBBLED
// below). Only some 230 of Tepic's 13,000 ways carry a cobble tag: tagging more in OpenStreetMap, or adding a colonia
// here, paves more of the town. Run: node tools/build-tepic-pavements.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/tepic/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../js/world/pavement-data.js', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(DATA + f, 'utf8'));

// The frame of build-tepic-geodata.mjs (section 1): origin at the Plaza Principal, axes along the centro's grid
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
const enu = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
const DRIVE = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const roads = load('osm_tepic_roads.json').elements.filter((e) => e.type === 'way' && e.geometry && e.tags && DRIVE.has(e.tags.highway));
// the grid bearing: the length-weighted circular mean (mod 90°) of the street directions within 1.2 km of the plaza
let THETA;
{
  let sx = 0, sy = 0;
  for (const w of roads) {
    const g = w.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const [e0, n0] = enu(g[i].lon, g[i].lat);
      const [e1, n1] = enu(g[i + 1].lon, g[i + 1].lat);
      if (Math.hypot(e0, n0) > 1200) continue;
      const L = Math.hypot(e1 - e0, n1 - n0);
      if (L < 5) continue;
      const a = Math.atan2(e1 - e0, n1 - n0);
      sx += L * Math.cos(4 * a);
      sy += L * Math.sin(4 * a);
    }
  }
  THETA = Math.atan2(sy, sx) / 4;
}
function toWorld(lon, lat) {
  const [e, n] = enu(lon, lat);
  const c = Math.cos(THETA), s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}
const BOX = { x0: -5800, x1: 10400, z0: -4800, z1: 10100 }; // (build-tepic-geodata.mjs's)

// Kinds: 0 empedrado (river stones set in the ground), 1 adoquín (cut setts & pavers), 2 tierra (earth & gravel),
// 3 concreto hidráulico (poured slabs)
function kindOf(surface) {
  if (/^(cobblestone|unhewn_cobblestone|pebblestone|cobblestone:flattened)$/.test(surface)) return 0;
  if (/^(sett|paving_stones|bricks)$/.test(surface)) return 1;
  if (/^(dirt|ground|earth|unpaved|gravel|fine_gravel|compacted|mud|sand|rock)$/.test(surface)) return 2;
  if (/^concrete/.test(surface)) return 3;
  return -1;
}

// Colonias whose streets are cobbled though OpenStreetMap doesn't say so (local knowledge): their residential streets
// with no surface tag within `r` metres of the place (an OpenStreetMap node: the colonia's own, or its church)
const COBBLED = [
  { name: 'Gobernadores', lat: 21.4865263, lon: -104.8732954, r: 380 },
  { name: 'Santa Teresita (Iglesia Santa Teresita)', lat: 21.5227947, lon: -104.9018655, r: 380 }
];
const cobbled = COBBLED.map((c) => ({ ...c, at: toWorld(c.lon, c.lat) }));

// Curb-to-curb width (m), as build-tepic-geodata.mjs's roadSpec
const num = (v) => { const n = parseFloat(String(v || '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
function widthOf(t) {
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.oneway === '-1' || t.junction === 'roundabout';
  const widths = {
    motorway: [11, 11], trunk: [10.5, 16], primary: [10, 14], secondary: [9, 12], tertiary: [8, 10],
    unclassified: [7.4, 7.4], residential: [7.4, 7.4], living_street: [6, 6]
  }[t.highway] || [7, 7];
  const w = num(t.width);
  return w >= 4 && w <= 30 ? w : oneway ? widths[0] : widths[1];
}

const q = (v) => Math.round(v * 10) / 10;
const out = [];
const counts = [0, 0, 0, 0];
let byColonia = 0;
for (const w of roads) {
  const t = w.tags;
  let kind = kindOf(t.surface || '');
  const pts = w.geometry.map((g) => toWorld(g.lon, g.lat));
  if (kind < 0 && !t.surface && /^(residential|living_street|unclassified)$/.test(t.highway)) {
    const mid = pts[Math.floor(pts.length / 2)];
    if (cobbled.some((c) => Math.hypot(mid[0] - c.at[0], mid[1] - c.at[1]) < c.r)) {
      kind = 0;
      byColonia++;
    }
  }
  if (kind < 0) continue;
  if (!pts.some(([x, z]) => x >= BOX.x0 && x <= BOX.x1 && z >= BOX.z0 && z <= BOX.z1)) continue;
  counts[kind]++;
  out.push([kind, q(widthOf(t)), pts.flatMap(([x, z]) => [q(x), q(z)])]);
}

const header = `// js/world/pavement-data.js
// GENERATED by tools/build-tepic-pavements.mjs from OpenStreetMap (© OpenStreetMap contributors, ODbL): do not edit by
// hand. The streets that are not asphalt: [kind (0 empedrado, 1 adoquín, 2 tierra, 3 concreto), curb-to-curb width (m),
// centreline [x, z, ...] (m, the game's frame)]; ${counts[0]} empedradas (${byColonia} of them in colonias known to be
// cobbled), ${counts[1]} de adoquín, ${counts[2]} de tierra, ${counts[3]} de concreto.
`;
fs.writeFileSync(OUT, `${header}export const PAVEMENTS = ${JSON.stringify(out)};\n`);
console.log(`[pavements] grid bearing ${((THETA * 180) / Math.PI).toFixed(2)}°: ${out.length} streets (${counts.join(' / ')}), ${byColonia} by colonia -> ${OUT}`);
