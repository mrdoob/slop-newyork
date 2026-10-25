// js/world/flood-model.js
// Tepic floods when a storm drops more than its drains take: the water runs down the streets to the low ground, fills
// the hollows and stands in the streets along the valley's drainage lines, and the Río Mololoa rises in its channel and
// spills over its banks into the colonias beside it. Plain data (no three.js), for node --test; floods.js draws it.
// - FloodLevel: the storm's water, `level` (0 dry .. ~1 a big flood) from the Live weather's rain over time
// - floodDepths(heights, n, cell, level): the water's depth (m) on a square grid of ground heights round the camera
// - riverStage(level): how high (m) the river stands over its usual level

const DRAIN_RATE = 8; // mm/h of rain the drains & the ground take without the water standing
const FLOOD_RAIN = 45; // mm of rain past the drains for a big flood (level 1)
const RECEDE = 0.35; // level a dry hour takes away

// The rain falling (mm/h) by the Live weather (weather.js conditions): the measured rate, or the code's usual one
function rainRate(w) {
  if (!w) return 0;
  const coded = w.code >= 95 ? 28 : w.code === 82 ? 18 : w.code === 65 || w.code === 81 ? 9 : w.code === 63 || w.code === 80 ? 4 : 0;
  return Math.max(w.rainRate || 0, coded);
}

class FloodLevel {
  constructor() {
    this.level = 0;
    this.started = false;
    this.held = null; // ?flood=<0..1> pins it, to preview
  }

  hold(level) {
    this.held = Number.isFinite(level) ? Math.max(0, Math.min(1.5, level)) : null;
  }

  // dt s, w the Live weather's conditions (weather.js): its rain past the drains raises the water, dry weather drains it
  update(dt, w) {
    if (this.held !== null) return (this.level = this.held);
    if (!this.started) {
      this.started = true;
      // the rain of the past hours (mm) may have left water standing already
      this.level = Math.min(1.2, Math.max(0, ((w && w.recentRain) || 0) - 15) / FLOOD_RAIN);
    }
    const rate = rainRate(w);
    if (rate > DRAIN_RATE) this.level = Math.min(1.5, this.level + ((rate - DRAIN_RATE) / FLOOD_RAIN) * (dt / 3600));
    else this.level = Math.max(0, this.level - RECEDE * (dt / 3600) * (1 - rate / DRAIN_RATE * 0.7));
    return this.level;
  }
}

// How high the river stands over its usual water (m): it fills its ~3 m channel first, then spills
function riverStage(level) {
  return Math.min(5, level * 4.2);
}

// A min-heap of [height, cell] for the priority flood
class Heap {
  constructor() {
    this.h = [];
    this.c = [];
  }

  push(h, c) {
    const H = this.h, C = this.c;
    let k = H.length;
    H.push(h);
    C.push(c);
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (H[p] <= H[k]) break;
      [H[p], H[k]] = [H[k], H[p]];
      [C[p], C[k]] = [C[k], C[p]];
      k = p;
    }
  }

  pop(out) {
    const H = this.h, C = this.c;
    out[0] = H[0];
    out[1] = C[0];
    const lh = H.pop(), lc = C.pop();
    if (H.length) {
      H[0] = lh;
      C[0] = lc;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < H.length && H[l] < H[m]) m = l;
        if (r < H.length && H[r] < H[m]) m = r;
        if (m === k) break;
        [H[m], H[k]] = [H[k], H[m]];
        [C[m], C[k]] = [C[k], C[m]];
        k = m;
      }
    }
    return out;
  }

  get size() {
    return this.h.length;
  }
}

/**
 * The ground's hollows on an n x n grid of heights (row-major, `cell` m apart): how deep (m) each cell lies under the
 * level water would fill it to before spilling (a priority flood from the grid's edges, which spill)
 */
function hollows(heights, n) {
  const fill = new Float32Array(n * n).fill(Infinity);
  const heap = new Heap();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i && j && i < n - 1 && j < n - 1) continue;
      const k = i * n + j;
      fill[k] = heights[k];
      heap.push(heights[k], k);
    }
  }
  const top = [0, 0];
  while (heap.size) {
    heap.pop(top);
    const h = top[0], k = top[1];
    const i = (k / n) | 0, j = k - i * n;
    for (let d = 0; d < 4; d++) {
      const a = i + (d === 0 ? 1 : d === 1 ? -1 : 0), b = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const q = a * n + b;
      if (fill[q] !== Infinity) continue;
      fill[q] = Math.max(heights[q], h);
      heap.push(fill[q], q);
    }
  }
  for (let k = 0; k < fill.length; k++) fill[k] -= heights[k];
  return fill;
}

/**
 * How far (m) each cell lies under the mean of the ground round it (a box `radius` cells across each way): the
 * valley's floors and the drainage lines the water runs down and stands in
 */
function lowness(heights, n, radius) {
  // a summed-area table makes every box mean four lookups
  const S = new Float64Array((n + 1) * (n + 1));
  for (let i = 0; i < n; i++) {
    let row = 0;
    for (let j = 0; j < n; j++) {
      row += heights[i * n + j];
      S[(i + 1) * (n + 1) + j + 1] = S[i * (n + 1) + j + 1] + row;
    }
  }
  const out = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - radius), i1 = Math.min(n, i + radius + 1);
    for (let j = 0; j < n; j++) {
      const j0 = Math.max(0, j - radius), j1 = Math.min(n, j + radius + 1);
      const sum = S[i1 * (n + 1) + j1] - S[i0 * (n + 1) + j1] - S[i1 * (n + 1) + j0] + S[i0 * (n + 1) + j0];
      out[i * n + j] = sum / ((i1 - i0) * (j1 - j0)) - heights[i * n + j];
    }
  }
  return out;
}

/**
 * The flood's terrain on a grid: { hollow, low } (m per cell), worked out once per grid (when the camera has moved on)
 * and turned into depths for any level by floodDepth
 */
function floodTerrain(heights, n, cell) {
  return { hollow: hollows(heights, n), low: lowness(heights, n, Math.max(2, Math.round(60 / cell))) };
}

/**
 * The water's depth (m) in a cell at `level`: the hollows fill (all of them by level 0.6), the low ground along the
 * drainage lines stands in water up to half the level; `river` m of the river's spill (riverSpill) on top
 */
function floodDepth(hollow, low, level, river = 0) {
  if (level <= 0 && river <= 0) return 0;
  const pond = Math.min(hollow, hollow * level / 0.6 + level * 0.1);
  const t = Math.max(0, Math.min(1, low / 1.5));
  const sheet = level * 0.5 * t * t * (3 - 2 * t);
  return Math.max(pond, sheet, river);
}

/**
 * The river's spill (m of water) at a point `above` m over the river's bank there and `distance` m from its channel,
 * when it stands `stage` m high (riverStage): over its ~3 m channel it floods the ground beside it that lies low
 * enough, less the further it has to spread
 */
function riverSpill(stage, above, distance) {
  const over = stage - 3 - above - distance * 0.012;
  return distance > 160 ? 0 : Math.max(0, over);
}

export { FloodLevel, rainRate, riverStage, hollows, lowness, floodTerrain, floodDepth, riverSpill };
