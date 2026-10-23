// tools/build-geodata.mjs
// Builds js/nyc-geodata.js: real New York geography in the simulation's 1:1 world frame, from NYC Open Data and
// OpenStreetMap. Frame: 1 unit = 1 m, x = Manhattan-grid east, z = grid south (north = -z), origin at the centreline
// intersection of 5th Ave & 42nd St, axes turned 29.0° from true north (the grid's measured bearing).
//
// Inputs (tools/data/, see tools/fetch-geodata.sh):
//   dcp_boroughs.json      NYC DCP Borough Boundaries (water areas excluded)  data.cityofnewyork.us gthc-hcne
//   cscl_manhattan.json    NYC street centerline (CSCL), Manhattan             data.cityofnewyork.us inkn-q76z
//   nycparks_manhattan.json NYC Parks properties, Manhattan                    data.cityofnewyork.us enfh-gkve
//   osm_*.json             OpenStreetMap via Overpass (Central Park features, piers, NJ coastline)
//
// usage: GEO_DATA=tools/data node tools/build-geodata.mjs [outFile]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFrame } from './geo-frame.mjs';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[geodata]', ...a);

// =====================================================================================================================
// 1. FRAME
// =====================================================================================================================
// NYC frame: tangent plane near 5th Ave & 42nd St, turned to the Manhattan grid. THETA and ORIGIN start from these
// estimates and are measured from the centreline in section 3.
const frame = makeFrame({ lat0: 40.75318, lon0: -73.98185, theta: (29.017 * Math.PI) / 180 });
const { enu, gridUV, toWorld } = frame;

// =====================================================================================================================
// 2. GEOMETRY HELPERS
// =====================================================================================================================
const r1 = (x) => Math.round(x * 10) / 10;
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
// Ramer-Douglas-Peucker on an open polyline
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring (split at the two farthest-apart vertices)
function rdpRing(ring, eps) {
  let i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
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

// ---------------------------------------------------------------------------------------------------------------------
// Raster tools (for cutting piers off the shoreline and merging polygons)
// ---------------------------------------------------------------------------------------------------------------------
class Raster {
  constructor(x0, z0, x1, z1, res) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Uint8Array(this.w * this.h);
  }
  // Scanline fill of a ring (even-odd) with `val`
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k];
        const [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Squared Euclidean distance (in cells) from every cell to the nearest cell where mask(v) is true (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const out = new Float32Array(w * h);
    const v = new Int32Array(Math.max(w, h));
    const zz = new Float64Array(Math.max(w, h) + 1);
    const dt1 = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0;
      zz[0] = -INF;
      zz[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zz[k] = s;
        zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => (out[q * w + i] = val));
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => (out[j * w + q] = val));
    return out;
  }
  // Morphological opening of the 1-cells with a disc of radius r metres
  open(r) {
    const rc = (r / this.res) ** 2;
    const toWater = this.edt((x) => x === 0);
    const eroded = new Uint8Array(this.d.length);
    for (let i = 0; i < eroded.length; i++) eroded[i] = toWater[i] > rc ? 1 : 0;
    const save = this.d;
    this.d = eroded;
    const toEroded = this.edt((x) => x === 1);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = this.d[i] && toEroded[i] <= rc + 1e-6 ? 1 : 0;
  }
  // Morphological closing (fills inlets / gaps narrower than 2r)
  close(r) {
    const rc = (r / this.res) ** 2;
    const toLand = this.edt((x) => x === 1);
    const dil = new Uint8Array(this.d.length);
    for (let i = 0; i < dil.length; i++) dil[i] = toLand[i] <= rc ? 1 : 0;
    const save = this.d;
    this.d = dil;
    const toGap = this.edt((x) => x === 0);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = dil[i] && toGap[i] > rc ? 1 : 0;
  }
  // Keep only the 4-connected component containing the most cells
  keepLargest() {
    const { w, h, d } = this;
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, cur = 0;
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!d[s] || lab[s]) continue;
      cur++;
      let n = 0;
      stack.push(s);
      lab[s] = cur;
      while (stack.length) {
        const p = stack.pop();
        n++;
        const i = p % w, j = (p - i) / w;
        if (i > 0 && d[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
        if (i < w - 1 && d[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
        if (j > 0 && d[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
        if (j < h - 1 && d[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
      }
      if (n > bestN) { bestN = n; best = cur; }
    }
    for (let i = 0; i < w * h; i++) d[i] = lab[i] === best ? 1 : 0;
  }
  // Outer boundary of the (single) region as a ring of cell-corner points (Moore-neighbour style edge walk)
  traceOuter() {
    const { w, h, d, res, x0, z0 } = this;
    const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h ? d[j * w + i] : 0);
    // Directed boundary edges keep land on the left: start at the first land cell's top edge
    let si = -1, sj = -1;
    outer: for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (at(i, j)) { si = i; sj = j; break outer; }
    // Walk corners: position (cx, cz) in corner coordinates, direction index 0:+x 1:+z 2:-x 3:-z
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    let cx = si, cz = sj, dir = 0; // top edge of cell (si, sj), walking +x with land below (on the right in screen, z down)
    const pts = [];
    const start = `${cx},${cz},${dir}`;
    let guard = 0;
    // For a corner walk with land on the right (z down means right = +z side when walking +x):
    // cells around corner (cx, cz): A=(cx-1,cz-1) B=(cx,cz-1) C=(cx-1,cz) D=(cx,cz)
    do {
      pts.push([x0 + cx * res, z0 + cz * res]);
      cx += DX[dir];
      cz += DZ[dir];
      // Cells ahead-left and ahead-right relative to the walking direction
      const cellAt = (dxl, dzl) => at(cx + dxl, cz + dzl);
      // Determine the cells: for each direction, the two cells in front of the corner
      let left, right;
      if (dir === 0) { left = cellAt(0, -1); right = cellAt(0, 0); }
      else if (dir === 1) { left = cellAt(0, 0); right = cellAt(-1, 0); }
      else if (dir === 2) { left = cellAt(-1, 0); right = cellAt(-1, -1); }
      else { left = cellAt(-1, -1); right = cellAt(0, -1); }
      if (left && right) dir = (dir + 3) % 4; // turn left (land ahead): keep land on the right
      else if (!left && right) { /* straight */ }
      else dir = (dir + 1) % 4; // turn right
      if (++guard > 50000000) throw new Error('trace runaway');
    } while (`${cx},${cz},${dir}` !== start);
    // Merge collinear runs, then take edge midpoints (turns the raster's stairs into 45° runs before simplifying)
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
      if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
    }
    return out.map((q, i) => {
      const n = out[(i + 1) % out.length];
      return [(q[0] + n[0]) / 2, (q[1] + n[1]) / 2];
    });
  }
}

// =====================================================================================================================
// 3. FRAME CALIBRATION FROM THE CENTERLINE
// =====================================================================================================================
const cscl = load('cscl_manhattan.json');
function segLines(s) {
  const g = s.the_geom;
  if (!g) return [];
  return g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
}
{
  // Bearing: length-weighted median direction of the long straight avenue segments
  const AVE = new Set(['1 AVE', '2 AVE', '3 AVE', 'LEXINGTON AVE', 'PARK AVE', 'MADISON AVE', '5 AVE', 'AVE OF THE AMERICAS', '7 AVE', '8 AVE',
    '9 AVE', '10 AVE', 'AMSTERDAM AVE', 'COLUMBUS AVE', 'CENTRAL PARK W', 'YORK AVE', 'W  END AVE']);
  const angs = [];
  for (const s of cscl) {
    if (!AVE.has(s.full_street_name) || s.rw_type !== '1') continue;
    for (const ln of segLines(s)) {
      const [e0, n0] = enu(...ln[0]);
      const [e1, n1] = enu(...ln[ln.length - 1]);
      const L = Math.hypot(e1 - e0, n1 - n0);
      if (L < 60) continue;
      let a = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI;
      a = ((a % 180) + 180) % 180;
      angs.push([a, L]);
    }
  }
  angs.sort((p, q) => p[0] - q[0]);
  const tot = angs.reduce((t, a) => t + a[1], 0);
  let acc = 0;
  for (const [a, L] of angs) {
    acc += L;
    if (acc >= tot / 2) { frame.theta = (a * Math.PI) / 180; break; }
  }
  // Origin: the shared endpoint of 5 AVE and E/W 42 ST
  const ends = new Map();
  for (const s of cscl) {
    for (const ln of segLines(s)) {
      for (const p of [ln[0], ln[ln.length - 1]]) {
        const k = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
        if (!ends.has(k)) ends.set(k, { p, names: new Set() });
        ends.get(k).names.add(s.full_street_name);
      }
    }
  }
  for (const { p, names } of ends.values()) {
    if (names.has('5 AVE') && (names.has('E  42 ST') || names.has('W  42 ST'))) frame.origin = gridUV(p[0], p[1]);
  }
  log(`bearing ${(frame.theta * 180 / Math.PI).toFixed(3)}°, origin (5 Ave & 42 St) at grid ${frame.origin.map((v) => v.toFixed(1))}`);
}

// =====================================================================================================================
// 4. SHORELINES
// =====================================================================================================================
const dcp = load('dcp_boroughs.json');
const boro = {};
for (const f of dcp.features) {
  const rings = f.geometry.coordinates.map((poly) => poly[0].map(([lon, lat]) => toWorld(lon, lat)));
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  boro[f.properties.boroname] = rings;
}
const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];

// OSM piers (closed ways & multipolygons) in world coordinates, with names
const osmPiers = load('osm_piers.json');
const pierPolys = [];
for (const e of osmPiers.elements) {
  const t = e.tags || {};
  if (e.type === 'way' && e.geometry && e.nodes && e.nodes[0] === e.nodes[e.nodes.length - 1]) {
    pierPolys.push({ name: t.name || '', ring: e.geometry.map((g) => toWorld(g.lon, g.lat)) });
  } else if (e.type === 'relation') {
    for (const m of e.members || []) {
      if (m.role === 'outer' && m.geometry) pierPolys.push({ name: t.name || '', ring: m.geometry.map((g) => toWorld(g.lon, g.lat)) });
    }
  }
}
log(`${pierPolys.length} OSM pier polygons`);

// --- Manhattan island: DCP polygon, minus the piers, opened to drop slivers, as a bulkhead line ---------------------
const RES = 2;
const mnRing = boro.Manhattan[0];
const mbb = bbox(mnRing);
const ras = new Raster(mbb.x0 - 60, mbb.z0 - 60, mbb.x1 + 60, mbb.z1 + 60, RES);
ras.fillRing(mnRing, 1);
const pierCells = new Raster(mbb.x0 - 60, mbb.z0 - 60, mbb.x1 + 60, mbb.z1 + 60, RES);
// Piers off the island: OSM pier polygons whose area lies mostly beyond a slightly eroded shore get cut out
for (const p of pierPolys) {
  const [cx, cz] = centroid(p.ring);
  if (cz < mbb.z0 - 200 || cz > mbb.z1 + 200 || cx < mbb.x0 - 600 || cx > mbb.x1 + 600) continue;
  pierCells.fillRing(p.ring, 1);
}
{
  // Grow the pier mask by 4 m: OSM pier outlines and DCP's pier decks differ by a few metres
  const toPier = pierCells.edt((x) => x === 1);
  const grow = (4 / RES) ** 2;
  for (let i = 0; i < ras.d.length; i++) if (toPier[i] <= grow) ras.d[i] = 0;
}
ras.open(9); // slivers & stubs narrower than ~18 m (pier necks, fender lines, pile fields)
ras.close(5); // notches left where pier decks met the bulkhead
ras.keepLargest();
let manhattan = ras.traceOuter();
manhattan = rdpRing(manhattan, 1.6);
if (ringArea(manhattan) > 0) manhattan.reverse(); // same winding as the old MANHATTAN_COASTLINE (negative shoelace area in x, z)
log(`Manhattan bulkhead ring: ${manhattan.length} pts, area ${(Math.abs(ringArea(manhattan)) / 1e6).toFixed(2)} km² (DCP ${(Math.abs(ringArea(mnRing)) / 1e6).toFixed(2)})`);

// Shore profile: westernmost / easternmost land x at every 2 m of z (outer crossings of the ring)
function shoreProfile(ring, step = 2) {
  const bb = bbox(ring);
  const z0 = Math.ceil(bb.z0 / step) * step;
  const n = Math.floor((bb.z1 - z0) / step) + 1;
  const west = new Float32Array(n), east = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const z = z0 + k * step + 1e-3;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xa, za] = ring[j];
      const [xb, zb] = ring[i];
      if ((za > z) !== (zb > z)) {
        const x = xa + ((z - za) * (xb - xa)) / (zb - za);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    }
    west[k] = lo;
    east[k] = hi;
  }
  return { z0, step, west, east };
}

// --- Harbour islands (Manhattan borough parts) -----------------------------------------------------------------------
function nearestPart(rings, x, z) {
  let best = null, bd = Infinity;
  for (const r of rings) {
    const [cx, cz] = centroid(r);
    const d = Math.hypot(cx - x, cz - z);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
const islands = {
  roosevelt: nearestPart(boro.Manhattan, 1793 - 54, -1825 + 69),
  randalls: nearestPart(boro.Manhattan, 1961 - 54, -6032 + 69),
  governors: nearestPart(boro.Manhattan, 750 - 54, 7705 + 69),
  liberty: nearestPart(boro.Manhattan, -1389 - 54, 8791 + 69),
  millRock: nearestPart(boro.Manhattan, 1674 - 54, -4358 + 69)
};
for (const k of Object.keys(islands)) {
  islands[k] = rdpRing(islands[k], 1.6);
  if (ringArea(islands[k]) > 0) islands[k].reverse();
  log(`island ${k}: ${islands[k].length} pts, ${(Math.abs(ringArea(islands[k])) / 1e6).toFixed(3)} km²`);
}

// --- Outer boroughs ---------------------------------------------------------------------------------------------------
function simplifyRings(rings, eps, minArea) {
  return rings.filter((r) => Math.abs(ringArea(r)) >= minArea).map((r) => {
    const s = rdpRing(r, eps);
    if (ringArea(s) > 0) s.reverse();
    return s;
  });
}
const boroughs = {
  brooklyn: simplifyRings(boro.Brooklyn, 6, 60000),
  queens: simplifyRings(boro.Queens, 6, 60000),
  bronx: simplifyRings(boro.Bronx, 6, 60000),
  statenIsland: simplifyRings(boro['Staten Island'], 8, 60000)
};
for (const [k, v] of Object.entries(boroughs)) log(`borough ${k}: ${v.length} rings, ${v.reduce((t, r) => t + r.length, 0)} pts`);

// --- New Jersey from the OSM coastline (land on the left of each way) -------------------------------------------------
function chainCoastline(osm) {
  const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry);
  const byStart = new Map();
  for (const w of ways) byStart.set(w.nodes[0], w);
  const used = new Set();
  const chains = [];
  for (const w of ways) {
    if (used.has(w.id)) continue;
    // Walk back to the chain's first way
    let first = w;
    const seen = new Set([w.id]);
    for (;;) {
      const prev = ways.find((u) => !seen.has(u.id) && u.nodes[u.nodes.length - 1] === first.nodes[0]);
      if (!prev) break;
      seen.add(prev.id);
      first = prev;
      if (prev.id === w.id) break;
    }
    const nodes = [];
    let cur = first;
    while (cur && !used.has(cur.id)) {
      used.add(cur.id);
      const g = cur.geometry.map((p) => toWorld(p.lon, p.lat));
      nodes.push(...(nodes.length ? g.slice(1) : g));
      cur = byStart.get(cur.nodes[cur.nodes.length - 1]);
    }
    chains.push(nodes);
  }
  return chains;
}
const coastChains = chainCoastline(load('osm_coastline.json'));
coastChains.sort((a, b) => b.length - a.length);
log(`OSM coastline: ${coastChains.length} chains; longest ${coastChains.slice(0, 6).map((c) => c.length).join(', ')}`);

const geo = { THETA: frame.theta, ORIGIN: frame.origin, manhattan, islands, boroughs, coastChains, pierPolys, mnRing, shoreProfile };
export { geo, toWorld, gridUV, rdp, rdpRing, ringArea, bbox, pointInRing, Raster, r1, load, log, segLines, cscl, centroid };
