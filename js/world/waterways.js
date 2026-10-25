// js/world/waterways.js
// The rivers & arroyos cut into the ground (city-geodata.js `waterways`, OpenStreetMap waterway=river | stream): the
// Río Mololoa and the arroyos run in channels sunk into the gap the blocks leave them, with sloping stone banks, a
// muddy bed and water in it. Where a street crosses one, the street stays (a bridge) and the channel runs on under it.
// This module is the channels' shape: the ground they carve (offset, for everyone standing or driving in one), the
// holes they cut in the road deck (cutHoles) and their meshes' vertices (meshData, river-channels.js draws them), all
// heights over the town's floor under them (drape.js lays them on it). No three.js here, so node --test imports it.

// A channel's cross-section by kind: its banks' tops `margin` m inside the gap between the blocks (so a curb jutting
// a little into the gap never overhangs the channel), the bed `bed` of the top's width across, `depth` m under the
// banks' tops, and `water` m of water over it (less in an intermittent arroyo). The Mololoa through Tepic runs a few
// metres down between stone walls; the arroyos are ditches a metre or two deep.
const CHANNELS = {
  river: { margin: 1.0, bed: 0.44, depth: 3.2, water: 0.7, dry: 0.45 },
  stream: { margin: 0.6, bed: 0.38, depth: 1.4, water: 0.25, dry: 0.1 }
};
const STEP = 2.5; // m between a channel's cross-sections along its course
const BRIDGE_MARGIN = 1.0; // m of street past its edge a bridge spans before the channel opens again
const HILL = 0.1; // m of hill over the town's floor where a channel goes under the hills' mesh (not cut, not drawn)
const MAX_EXTRA = 2.0; // m a bed may sink under its usual depth to keep the water running downhill
const UNDER = 1.2; // m under a bridge's deck a body must be to be under it (in the channel) rather than on it
const LIP = 0.35; // m the banks' tops reach on under the deck, so no crack opens along the hole's edge
const SLAB = 0.8; // m deep, a bridge's deck seen from the channel
const CELL = 10; // m, the cells of the lookup of the channels' pieces

// A polyline [[x, z], ...] with its corners cut twice (Chaikin), keeping its ends: the OSM ways' sharp bends would
// fold a 10 m wide channel's inner bank over on itself
function smooth(pts) {
  let p = pts;
  for (let pass = 0; pass < 2 && p.length > 2; pass++) {
    const out = [p[0]];
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      if (i > 0) out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      if (i + 2 < p.length) out.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// Points every `step` m (or less) along a polyline, its ends included
function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

// The drivable streets' centrelines bucketed by cell, for the bridges: { near(x, z, pad) } is true within `pad` m of a
// roadway's edge
function streetLookup(roads) {
  const cells = new Map();
  const S = 32;
  const segs = [];
  for (const { w, pts } of roads) {
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const s = { ax: pts[k], az: pts[k + 1], bx: pts[k + 2], bz: pts[k + 3], r: w / 2 };
      segs.push(s);
      const i0 = Math.floor((Math.min(s.ax, s.bx) - s.r - 4) / S), i1 = Math.floor((Math.max(s.ax, s.bx) + s.r + 4) / S);
      const j0 = Math.floor((Math.min(s.az, s.bz) - s.r - 4) / S), j1 = Math.floor((Math.max(s.az, s.bz) + s.r + 4) / S);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const key = i * 100003 + j;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(s);
      }
    }
  }
  return {
    near(x, z, pad) {
      const list = cells.get(Math.floor(x / S) * 100003 + Math.floor(z / S));
      if (!list) return false;
      for (const s of list) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1e-9)));
        if (Math.hypot(x - s.ax - dx * t, z - s.az - dz * t) < s.r + pad) return true;
      }
      return false;
    }
  };
}

/**
 * The channels of the waterways `list` (GEO.waterways: [kind, half-width of the gap between the blocks, name, flags,
 * flat points downstream]) on the town's floor `floor(x, z)`, out of the hills `hills(x, z)` (their height over it),
 * bridged by the streets `roads` ([{ w, pts }]: full width, flat centreline points).
 */
function createWaterways(list, { floor = () => 0, hills = () => 0, roads = [] } = {}) {
  const streets = streetLookup(roads);
  const channels = [];
  for (const [kind, cut, name, flags, flat] of list || []) {
    const spec = CHANNELS[kind];
    // (only the waterways the blocks leave a gap for, above ground)
    if (!spec || !(cut > spec.margin) || flags & 2 || flat.length < 4) continue;
    const half = cut - spec.margin, bedHalf = half * spec.bed;
    const line = [];
    for (let k = 0; k + 1 < flat.length; k += 2) line.push([flat[k], flat[k + 1]]);
    const pts = resample(smooth(line), STEP);
    if (pts.length < 2) continue;
    const s = [];
    let along = 0, bed = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const [px, pz] = pts[Math.max(0, i - 1)], [qx, qz] = pts[Math.min(pts.length - 1, i + 1)];
      const tl = Math.hypot(qx - px, qz - pz) || 1;
      const tx = (qx - px) / tl, tz = (qz - pz) / tl;
      const nx = -tz, nz = tx; // (left of the flow)
      if (i > 0) along += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      const lx = x + nx * half, lz = z + nz * half, rx = x - nx * half, rz = z - nz * half;
      const hill = hills(x, z) > HILL || hills(lx, lz) > HILL || hills(rx, rz) > HILL;
      const bridge = streets.near(x, z, BRIDGE_MARGIN) || streets.near(lx, lz, BRIDGE_MARGIN) || streets.near(rx, rz, BRIDGE_MARGIN);
      // The bed downstream never rises above the bed upstream (the water runs downhill on the town's blurred floor,
      // which may not), unless it would sink more than MAX_EXTRA under its depth
      const top = floor(x, z);
      bed = Math.max(Math.min(bed, top - spec.depth), top - spec.depth - MAX_EXTRA);
      s.push({ x, z, nx, nz, along, rel: bed - top, hill, bridge });
    }
    channels.push({ kind, name, half, bedHalf, water: flags & 1 ? spec.dry : spec.water, s });
  }

  // The wet pieces (between two cross-sections out of the hills), bucketed for offset(): [channel, cross-section]
  const pieces = [];
  const cells = new Map();
  channels.forEach((ch, c) => {
    const { s, half } = ch;
    for (let i = 0; i + 1 < s.length; i++) {
      if (s[i].hill || s[i + 1].hill) continue;
      const id = pieces.length / 2;
      pieces.push(c, i);
      const a = s[i], b = s[i + 1], r = half + 0.5;
      const i0 = Math.floor((Math.min(a.x, b.x) - r) / CELL), i1 = Math.floor((Math.max(a.x, b.x) + r) / CELL);
      const j0 = Math.floor((Math.min(a.z, b.z) - r) / CELL), j1 = Math.floor((Math.max(a.z, b.z) + r) / CELL);
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
        const key = ii * 100003 + j;
        let l = cells.get(key);
        if (!l) cells.set(key, (l = []));
        l.push(id);
      }
    }
  });
  const wet = (ch, i) => i >= 0 && i + 1 < ch.s.length && !ch.s[i].hill && !ch.s[i + 1].hill;
  // where (x, z) projects along piece i of a channel: 0 at its start, 1 at its end
  const along = (ch, i, x, z) => {
    const a = ch.s[i], b = ch.s[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    return ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1e-9);
  };

  /**
   * How far (m, <= 0) the channels carve the ground at (x, z) under the town's floor: their banks & bed, 0 off them.
   * Under a bridge only for a body coming from `fromY` well under the deck (one in the channel); on it, or with no
   * `fromY`, the street.
   */
  function offset(x, z, fromY) {
    const list = cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!list) return 0;
    let best = 0;
    for (const id of list) {
      const ch = channels[pieces[id * 2]], i = pieces[id * 2 + 1];
      const a = ch.s[i], b = ch.s[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const raw = along(ch, i, x, z);
      // Past a piece's end only on the outside of a bend, beyond the next piece's start too (square ends where a
      // channel stops: no rounded cap past its last cross-section)
      if (raw < 0 && !(wet(ch, i - 1) && along(ch, i - 1, x, z) > 1)) continue;
      if (raw > 1 && !(wet(ch, i + 1) && along(ch, i + 1, x, z) < 0)) continue;
      const t = Math.max(0, Math.min(1, raw));
      const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
      if (d >= ch.half) continue;
      if ((a.bridge || b.bridge) && !(fromY < floor(x, z) - UNDER)) continue;
      const rel = a.rel + (b.rel - a.rel) * t;
      const k = d <= ch.bedHalf ? 1 : (ch.half - d) / (ch.half - ch.bedHalf);
      if (rel * k < best) best = rel * k;
    }
    return best;
  }

  /** The holes the channels open in the road deck, as triangles (flat x0, z0, x1, z1, x2, z2): not under the bridges */
  function holes() {
    const out = [];
    for (const ch of channels) {
      const { s, half } = ch;
      for (let i = 0; i + 1 < s.length; i++) {
        const a = s[i], b = s[i + 1];
        if (a.hill || b.hill || a.bridge || b.bridge) continue;
        const alx = a.x + a.nx * half, alz = a.z + a.nz * half, arx = a.x - a.nx * half, arz = a.z - a.nz * half;
        const blx = b.x + b.nx * half, blz = b.z + b.nz * half, brx = b.x - b.nx * half, brz = b.z - b.nz * half;
        out.push(alx, alz, blx, blz, brx, brz, alx, alz, brx, brz, arx, arz);
      }
    }
    return out;
  }

  /**
   * The channels' meshes as plain triangle lists, heights over the town's floor: { banks, water, bridges }, each
   * { position (x, y, z), uv } and, for the banks, `wet` (0 at the banks' tops, 1 down on the bed). The water's uv are
   * metres along the flow & across it (-1 left bank, 1 right).
   */
  function meshData() {
    const banks = { position: [], uv: [], wet: [] }, water = { position: [], uv: [] }, bridges = { position: [], uv: [] };
    const tri = (m, p, uv, extra) => {
      for (let k = 0; k < 3; k++) {
        m.position.push(p[k][0], p[k][1], p[k][2]);
        m.uv.push(uv[k][0], uv[k][1]);
        if (extra) m.wet.push(extra[k]);
      }
    };
    const quad = (m, p0, p1, p2, p3, u0, u1, u2, u3, w) => {
      tri(m, [p0, p1, p2], [u0, u1, u2], w && [w[0], w[1], w[2]]);
      tri(m, [p0, p2, p3], [u0, u2, u3], w && [w[0], w[2], w[3]]);
    };
    for (const ch of channels) {
      const { s, half, bedHalf } = ch;
      // a cross-section's bank points, left to right: [x, y, z, wet, across]
      const section = (a) => {
        const at = (off, y, w) => [a.x + a.nx * off, y, a.z + a.nz * off, w, off];
        return [at(half + LIP, -0.03, 0), at(half, 0, 0), at(bedHalf, a.rel, 1), at(-bedHalf, a.rel, 1), at(-half, 0, 0), at(-half - LIP, -0.03, 0)];
      };
      const wall = (a, facing) => {
        // the channel's square end: its cross-section, filled (seen from inside)
        const p = section(a).slice(1, 5).map((v) => [v[0], v[1], v[2]]);
        const u = p.map((v, k) => [a.along, k]);
        if (facing > 0) quad(banks, p[0], p[1], p[2], p[3], u[0], u[1], u[2], u[3], [0, 1, 1, 0]);
        else quad(banks, p[3], p[2], p[1], p[0], u[3], u[2], u[1], u[0], [0, 1, 1, 0]);
      };
      for (let i = 0; i + 1 < s.length; i++) {
        if (!wet(ch, i)) continue;
        const a = s[i], b = s[i + 1];
        const A = section(a), B = section(b);
        for (let k = 0; k + 1 < A.length; k++) {
          const p = (v) => [v[0], v[1], v[2]];
          quad(banks, p(A[k]), p(B[k]), p(B[k + 1]), p(A[k + 1]),
            [a.along, A[k][4]], [b.along, B[k][4]], [b.along, B[k + 1][4]], [a.along, A[k + 1][4]],
            [A[k][3], B[k][3], B[k + 1][3], A[k + 1][3]]);
        }
        // the water: level `water` m over the bed, out to where it meets the banks
        const wa = bedHalf + (half - bedHalf) * Math.min(1, ch.water / -a.rel) + 0.05;
        const wb = bedHalf + (half - bedHalf) * Math.min(1, ch.water / -b.rel) + 0.05;
        const ya = a.rel + ch.water, yb = b.rel + ch.water;
        quad(water, [a.x + a.nx * wa, ya, a.z + a.nz * wa], [b.x + b.nx * wb, yb, b.z + b.nz * wb],
          [b.x - b.nx * wb, yb, b.z - b.nz * wb], [a.x - a.nx * wa, ya, a.z - a.nz * wa],
          [a.along, -1], [b.along, -1], [b.along, 1], [a.along, 1]);
        if (!wet(ch, i - 1)) wall(a, 1);
        if (!wet(ch, i + 1)) wall(b, -1);
      }
      // The bridges: the deck seen from the channel, from the last open cross-section before a street to the first
      // after it, with its faces down to the slab's depth at either end
      for (let i = 0; i < s.length; i++) {
        if (!s[i].bridge || (i > 0 && s[i - 1].bridge)) continue;
        let j = i;
        while (j + 1 < s.length && s[j + 1].bridge) j++;
        const a0 = Math.max(0, i - 1), b0 = Math.min(s.length - 1, j + 1);
        if (!wet(ch, a0) && !wet(ch, b0 - 1)) continue;
        for (let k = a0; k < b0; k++) {
          const a = s[k], b = s[k + 1];
          const w = half + LIP;
          quad(bridges, [a.x - a.nx * w, -SLAB, a.z - a.nz * w], [b.x - b.nx * w, -SLAB, b.z - b.nz * w],
            [b.x + b.nx * w, -SLAB, b.z + b.nz * w], [a.x + a.nx * w, -SLAB, a.z + a.nz * w],
            [a.along, -w], [b.along, -w], [b.along, w], [a.along, w]);
        }
        for (const [e, dir] of [[s[a0], 1], [s[b0], -1]]) {
          const l = [e.x + e.nx * half, 0, e.z + e.nz * half], r = [e.x - e.nx * half, 0, e.z - e.nz * half];
          const ld = [l[0], -SLAB, l[2]], rd = [r[0], -SLAB, r[2]];
          const u = [[0, 0], [0, SLAB], [half * 2, SLAB], [half * 2, 0]];
          if (dir > 0) quad(bridges, l, ld, rd, r, ...u);
          else quad(bridges, r, rd, ld, l, ...u);
        }
      }
    }
    const typed = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Float32Array.from(v)]));
    return { banks: typed(banks), water: typed(water), bridges: typed(bridges) };
  }

  return { channels, offset, holes, meshData };
}

/**
 * The triangles `arrays` (vertex attributes, [0] the positions x y z; `sizes` their item sizes; `index` the triangles
 * or null) with the holes (flat triangles x0, z0, x1, z1, x2, z2, in plan) taken out of them, every attribute
 * interpolated along the cuts. Returns new, non-indexed arrays. (The road deck, where the channels open in it.)
 */
function cutHoles(arrays, sizes, index, holes) {
  const S = 16;
  const tris = [];
  const cells = new Map();
  for (let h = 0; h + 5 < holes.length; h += 6) {
    let [ax, az, bx, bz, cx, cz] = holes.slice(h, h + 6);
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area) < 1e-6) continue;
    if (area < 0) [bx, bz, cx, cz] = [cx, cz, bx, bz]; // (wound so its inside is left of each edge)
    const t = { p: [ax, az, bx, bz, cx, cz], x0: Math.min(ax, bx, cx), x1: Math.max(ax, bx, cx), z0: Math.min(az, bz, cz), z1: Math.max(az, bz, cz) };
    const id = tris.length;
    tris.push(t);
    for (let j = Math.floor(t.z0 / S); j <= Math.floor(t.z1 / S); j++) for (let i = Math.floor(t.x0 / S); i <= Math.floor(t.x1 / S); i++) {
      const key = i * 100003 + j;
      let l = cells.get(key);
      if (!l) cells.set(key, (l = []));
      l.push(id);
    }
  }
  const stride = sizes.reduce((t, s) => t + s, 0);
  const pos = arrays[0], ps = sizes[0];
  const n = (index ? index.length : pos.length / ps) / 3;
  const corner = (t, c) => (index ? index[t * 3 + c] : t * 3 + c);
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
    for (let a = 0; a < arrays.length; a++) for (let c = 0; c < sizes[a]; c++) pool[o++] = arrays[a][i * sizes[a] + c];
    return used++;
  };
  const between = (a, b, t) => {
    grow();
    const o = used * stride, oa = a * stride, ob = b * stride;
    for (let c = 0; c < stride; c++) pool[o + c] = pool[oa + c] + (pool[ob + c] - pool[oa + c]) * t;
    return used++;
  };
  const X = (v) => pool[v * stride], Z = (v) => pool[v * stride + 2];
  const EPS = 1e-9;
  // a convex piece split by the line through (ax, az) -> (bx, bz): [left (inside the hole's edge), right]
  const split = (poly, ax, az, bx, bz) => {
    const side = (v) => (bx - ax) * (Z(v) - az) - (bz - az) * (X(v) - ax);
    const left = [], right = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const sa = side(a), sb = side(b);
      if (sa >= -EPS) left.push(a);
      if (sa <= EPS) right.push(a);
      if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
        const p = between(a, b, sa / (sa - sb));
        left.push(p);
        right.push(p);
      }
    }
    return [left, right];
  };
  const whole = [];
  const cutPieces = [];
  const seen = new Set();
  for (let t = 0; t < n; t++) {
    const i0 = corner(t, 0), i1 = corner(t, 1), i2 = corner(t, 2);
    const xs = [pos[i0 * ps], pos[i1 * ps], pos[i2 * ps]], zs = [pos[i0 * ps + 2], pos[i1 * ps + 2], pos[i2 * ps + 2]];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    seen.clear();
    const near = [];
    for (let j = Math.floor(z0 / S); j <= Math.floor(z1 / S); j++) for (let i = Math.floor(x0 / S); i <= Math.floor(x1 / S); i++) {
      for (const id of cells.get(i * 100003 + j) || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const h = tris[id];
        if (h.x1 > x0 && h.x0 < x1 && h.z1 > z0 && h.z0 < z1) near.push(h);
      }
    }
    if (!near.length) { whole.push(i0, i1, i2); continue; }
    let pieces = [[vertex(i0), vertex(i1), vertex(i2)]];
    for (const h of near) {
      const next = [];
      const [ax, az, bx, bz, cx, cz] = h.p;
      for (const piece of pieces) {
        let rest = piece;
        for (const [ux, uz, vx, vz] of [[ax, az, bx, bz], [bx, bz, cx, cz], [cx, cz, ax, az]]) {
          const [inside, outside] = split(rest, ux, uz, vx, vz);
          if (outside.length >= 3) next.push(outside);
          rest = inside;
          if (rest.length < 3) break;
        }
        // (what is left inside all three edges is in the hole)
      }
      pieces = next;
      if (!pieces.length) break;
    }
    for (const p of pieces) cutPieces.push(p);
  }
  let count = whole.length;
  for (const p of cutPieces) count += (p.length - 2) * 3;
  const out = sizes.map((size) => new Float32Array(count * size));
  let w = 0;
  for (const i of whole) {
    for (let a = 0; a < out.length; a++) for (let c = 0; c < sizes[a]; c++) out[a][w * sizes[a] + c] = arrays[a][i * sizes[a] + c];
    w++;
  }
  const emit = (v) => {
    let o = v * stride;
    for (let a = 0; a < out.length; a++) for (let c = 0; c < sizes[a]; c++) out[a][w * sizes[a] + c] = pool[o++];
    w++;
  };
  for (const p of cutPieces) for (let i = 1; i + 1 < p.length; i++) { emit(p[0]); emit(p[i]); emit(p[i + 1]); }
  return out;
}

export { CHANNELS, createWaterways, cutHoles };
