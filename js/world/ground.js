// js/world/ground.js
// The ground everything stands on, as heights over the world's y = 0. Two grids from tools/build-tepic-geodata.mjs:
// - GEO.terrain, the hills around the valley over its flat floor (zero under the town);
// - GEO.ground, the town's own slopes (its blurred elevation over the datum, the town's lowest point), which ?slopes=0
//   leaves out (the flat city, as it was built before).
// Everything the city builds at y = 0 is raised by the ground under it (liftAt), its flat layers laid on it (drape.js).
// No three.js here, so node --test imports it directly.
import { GEO } from './city-geodata.js';

const SINK = 0.08; // the flat parts of the hills' mesh sit just under the streets & meadows

// A grid's heights (dm, Int16 little-endian, base64) in metres
function decodeHeights(grid) {
  const bin = atob(grid.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dm = new Int16Array(bytes.buffer);
  const heights = new Float32Array(dm.length);
  for (let i = 0; i < dm.length; i++) heights[i] = dm[i] / 10;
  return heights;
}

// Height on a grid at (x, z), on the very triangles a mesh of it draws (each cell split from its +x corner to its +z
// corner), `outside` beyond it
function gridSampler(grid, heights, outside) {
  const { x0, z0, cell, w, h } = grid;
  return (x, z) => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (!(fx >= 0 && fz >= 0 && fx < w - 1 && fz < h - 1)) return outside;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * w + i;
    const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + w], h11 = heights[k + w + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  };
}

function createGround(geo, { slopes = false } = {}) {
  const hillHeights = geo.terrain ? decodeHeights(geo.terrain) : null;
  /** Height (m) of the hills over the valley floor at (x, z): 0 in town and beyond the data */
  const terrainHeight = hillHeights ? gridSampler(geo.terrain, hillHeights, 0) : () => 0;
  /** The hills' ground for anything standing on them (0 in town) */
  const hillGround = (x, z) => {
    const h = terrainHeight(x, z);
    return h > SINK ? h - SINK : 0;
  };

  const townHeights = slopes && geo.ground ? decodeHeights(geo.ground) : null;
  const town = townHeights ? gridSampler(geo.ground, townHeights, geo.ground.floor) : null;
  /** Height (m) of the town's floor at (x, z): its slopes, or 0 in the flat city (?slopes=0) */
  const townHeight = town || (() => 0);
  /** Height (m) of the ground at (x, z): the town's floor and the hills over it */
  const groundHeight = town ? (x, z) => town(x, z) + hillGround(x, z) : hillGround;
  /**
   * The ground's gradient at (x, z) into out: [rise per metre east (+x), rise per metre south (+z)], central differences
   * over a metre (the grids' triangles are 25-75 m, so this is their plane's tilt but for a metre at their edges)
   */
  const groundSlope = (x, z, out = [0, 0]) => {
    out[0] = (groundHeight(x + 0.5, z) - groundHeight(x - 0.5, z));
    out[1] = (groundHeight(x, z + 0.5) - groundHeight(x, z - 0.5));
    return out;
  };

  return {
    slopes: Boolean(town),
    datum: geo.ground ? geo.ground.datum : null,
    // the town's grid { x0, z0, cell, w, h, floor, heights } with slopes (for the shaders), else null
    townGrid: townHeights ? { ...geo.ground, data: undefined, heights: townHeights } : null,
    hillHeights,
    terrainHeight,
    hillGround,
    townHeight,
    groundHeight,
    groundSlope
  };
}

/**
 * Triangles cut along a ground lattice { x0, z0, cell }: the lines x = x0 + k·cell, z = z0 + k·cell and
 * x + z = x0 + z0 + k·cell (each cell's diagonal, from its +x corner to its +z corner), so every piece lies on one of the
 * ground's triangles and, laid on it, follows it exactly instead of cutting across its folds.
 * `arrays` are the vertex attributes ([0] the positions, x y z), `sizes` their item sizes, `index` the triangles (or
 * null: consecutive vertices). Every attribute is interpolated along the cuts. Returns new arrays, non-indexed.
 */
function clipToLattice(arrays, sizes, index, lattice) {
  const { x0, z0, cell } = lattice;
  const stride = sizes.reduce((t, s) => t + s, 0);
  const pos = arrays[0], ps = sizes[0];
  const tris = (index ? index.length : pos.length / ps) / 3;
  const corner = (t, c) => (index ? index[t * 3 + c] : t * 3 + c);
  // the three families of lines, as a coordinate whose integer values are the lines
  const families = [
    (x, z) => (x - x0) / cell,
    (x, z) => (z - z0) / cell,
    (x, z) => (x - x0 + z - z0) / cell
  ];
  const EPS = 1e-7;
  const firstLine = (lo) => Math.floor(lo + EPS) + 1; // the first line past lo

  // The vertices of the pieces, all their attributes in one growing pool (the pieces are lists of indices into it)
  let pool = new Float64Array(stride * 1024);
  let used = 0;
  const grow = () => {
    if ((used + 1) * stride <= pool.length) return;
    const next = new Float64Array(pool.length * 2);
    next.set(pool);
    pool = next;
  };
  const vertex = (i) => {
    grow();
    let o = used * stride;
    for (let a = 0; a < arrays.length; a++) {
      const size = sizes[a], arr = arrays[a];
      for (let c = 0; c < size; c++) pool[o++] = arr[i * size + c];
    }
    return used++;
  };
  const between = (a, b, t) => {
    grow();
    const o = used * stride, oa = a * stride, ob = b * stride;
    for (let c = 0; c < stride; c++) pool[o + c] = pool[oa + c] + (pool[ob + c] - pool[oa + c]) * t;
    return used++;
  };
  const at = (f, v) => f(pool[v * stride], pool[v * stride + 2]);
  // a convex piece cut by the line f = k: the part with f <= k and the part with f >= k (either may be empty)
  const cut = (poly, f, k) => {
    const below = [], above = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = at(f, a) - k, sb = at(f, b) - k;
      if (sa <= EPS) below.push(a);
      if (sa >= -EPS) above.push(a);
      if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
        const p = between(a, b, sa / (sa - sb));
        below.push(p);
        above.push(p);
      }
    }
    return [below, above];
  };

  // The triangles inside one ground triangle go through as they are (most of the small ones); the rest are cut,
  // family by family, into convex pieces
  const whole = [];
  let polys = [];
  for (let t = 0; t < tris; t++) {
    const i0 = corner(t, 0), i1 = corner(t, 1), i2 = corner(t, 2);
    let inside = true;
    for (const f of families) {
      const a = f(pos[i0 * ps], pos[i0 * ps + 2]), b = f(pos[i1 * ps], pos[i1 * ps + 2]), c = f(pos[i2 * ps], pos[i2 * ps + 2]);
      if (firstLine(Math.min(a, b, c)) < Math.max(a, b, c) - EPS) { inside = false; break; }
    }
    if (inside) whole.push(i0, i1, i2);
    else polys.push([vertex(i0), vertex(i1), vertex(i2)]);
  }
  for (const f of families) {
    const next = [];
    for (let poly of polys) {
      let lo = Infinity, hi = -Infinity;
      for (const v of poly) {
        const s = at(f, v);
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      for (let k = firstLine(lo); k < hi - EPS; k++) {
        const [below, above] = cut(poly, f, k);
        if (below.length >= 3) next.push(below);
        poly = above;
        if (poly.length < 3) break;
      }
      if (poly.length >= 3) next.push(poly);
    }
    polys = next;
  }

  // the whole triangles, then fans of the (convex) pieces in their triangle's winding
  let n = whole.length;
  for (const p of polys) n += (p.length - 2) * 3;
  const out = sizes.map((size) => new Float32Array(n * size));
  let w = 0;
  for (const i of whole) {
    for (let a = 0; a < out.length; a++) {
      const size = sizes[a];
      for (let c = 0; c < size; c++) out[a][w * size + c] = arrays[a][i * size + c];
    }
    w++;
  }
  const emit = (v) => {
    let o = v * stride;
    for (let a = 0; a < out.length; a++) {
      const size = sizes[a];
      for (let c = 0; c < size; c++) out[a][w * size + c] = pool[o++];
    }
    w++;
  };
  for (const p of polys) {
    for (let i = 1; i + 1 < p.length; i++) {
      emit(p[0]);
      emit(p[i]);
      emit(p[i + 1]);
    }
  }
  return out;
}

// The town on its slopes, unless ?slopes=0 asks for the flat city
const SLOPES = typeof location === 'undefined' || new URLSearchParams(location.search).get('slopes') !== '0';
const ground = createGround(GEO, { slopes: SLOPES });
const { townGrid, hillHeights, terrainHeight, hillGround, townHeight, groundHeight, groundSlope } = ground;
// The lattice of both grids' triangles: the town's, whose cells halve the hills' 75 m ones on their own lines (see the
// geodata builder), so its triangles lie each in one of theirs
const LATTICE = GEO.ground ? { x0: GEO.ground.x0, z0: GEO.ground.z0, cell: GEO.ground.cell }
  : GEO.terrain ? { x0: GEO.terrain.x0, z0: GEO.terrain.z0, cell: GEO.terrain.cell } : null;
/**
 * How far up to set something the city builds at y = 0 (a lamppost, a tree, a house's floor) standing at (x, z): the
 * ground, or 0 in the flat city (?slopes=0)
 */
const liftAt = SLOPES ? groundHeight : () => 0;

/**
 * The decks of the bridges & their ramps (geodata roadGraph links' `lifts`: m over the ground at each vertex, piecewise
 * linear between them), as segments in 32 m cells: { ax, az, bx, bz, la, lb, half }
 */
function createDecks(geo) {
  const RG = geo.roadGraph;
  const segments = [];
  const junctions = []; // raised junctions: { x, z, r, lift } discs of deck joining the links that meet there
  if (RG) {
    const N = RG.nodes;
    const ends = new Map(); // node -> [links meeting there, their lift there, the widest half width]
    for (const link of RG.links) {
      for (const [n, k] of [[link[0], 0], [link[1], -1]]) {
        const e = ends.get(n) || [0, 0, 0];
        e[0]++;
        if (link[7]) e[1] = Math.max(e[1], link[7].at(k) / 10);
        e[2] = Math.max(e[2], link[3] / 2 + 0.4);
        ends.set(n, e);
      }
    }
    for (const [n, [count, lift, half]] of ends) {
      if (count > 2 && lift > 0) junctions.push({ x: N[n * 2], z: N[n * 2 + 1], r: half + 1.5, lift });
    }
    for (const link of RG.links) {
      const lifts = link[7];
      if (!lifts) continue;
      const pts = [[N[link[0] * 2], N[link[0] * 2 + 1]]];
      for (let k = 0; k < link[6].length; k += 2) pts.push([link[6][k], link[6][k + 1]]);
      pts.push([N[link[1] * 2], N[link[1] * 2 + 1]]);
      for (let i = 0; i + 1 < pts.length; i++) {
        const la = lifts[i] / 10, lb = lifts[i + 1] / 10;
        if (la <= 0 && lb <= 0) continue;
        segments.push({ ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], la, lb, half: link[3] / 2 + 0.4 });
      }
    }
  }
  const CELL = 32;
  const cells = new Map();
  // (a junction's disc as a segment of no length: every point within its radius)
  for (const j of junctions) segments.push({ ax: j.x, az: j.z, bx: j.x, bz: j.z, la: j.lift, lb: j.lift, half: j.r });
  for (const sg of segments) {
    const r = sg.half;
    for (let ix = Math.floor((Math.min(sg.ax, sg.bx) - r) / CELL); ix <= Math.floor((Math.max(sg.ax, sg.bx) + r) / CELL); ix++) {
      for (let iz = Math.floor((Math.min(sg.az, sg.bz) - r) / CELL); iz <= Math.floor((Math.max(sg.az, sg.bz) + r) / CELL); iz++) {
        const k = ix * 100003 + iz;
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(sg);
      }
    }
  }
  /**
   * The lift (m over the ground) of the highest deck at (x, z) that a body `over` m over the ground there can step or
   * drive onto (up to `step` m above it: up a ramp, never up onto a span overhead), or 0
   */
  const deckLift = (x, z, over = Infinity, step = 1.2) => {
    const list = cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!list) return 0;
    let best = 0;
    for (const sg of list) {
      const ux = sg.bx - sg.ax, uz = sg.bz - sg.az;
      const L2 = ux * ux + uz * uz;
      let tc = 0;
      if (L2 === 0) {
        if (Math.hypot(x - sg.ax, z - sg.az) > sg.half) continue; // a junction's disc
      } else {
        // along the segment (a little past its ends, so a deck's joints hold), and across it within its half width
        const t = ((x - sg.ax) * ux + (z - sg.az) * uz) / L2;
        const L = Math.sqrt(L2);
        if (t < -sg.half / L || t > 1 + sg.half / L) continue;
        tc = Math.min(1, Math.max(0, t));
        if (Math.abs((x - sg.ax) * uz - (z - sg.az) * ux) / L > sg.half) continue;
      }
      const lift = sg.la + (sg.lb - sg.la) * tc;
      if (lift > best && lift <= over + step) best = lift;
    }
    return best;
  };
  return { segments, junctions, deckLift };
}

const decks = createDecks(GEO);
const { deckLift } = decks;
/**
 * The surface under a body at (x, z) whose feet (or wheels) are at height y: the ground, or a bridge's deck it is on or
 * reaches up a ramp; with y left out the ground alone
 */
const surfaceHeight = (x, z, y = -Infinity) => {
  const g = groundHeight(x, z);
  return y === -Infinity ? g : g + deckLift(x, z, y - g);
};

export {
  SINK, SLOPES, LATTICE, createGround, clipToLattice, liftAt, townGrid,
  hillHeights, terrainHeight, hillGround, townHeight, groundHeight, groundSlope,
  createDecks, decks, deckLift, surfaceHeight
};
