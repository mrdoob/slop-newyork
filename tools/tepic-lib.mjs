// tools/tepic-lib.mjs — pure geometry helpers for the Tepic geodata builder (no data loaded at import).
// Raster, polyline simplification and the curb-island extraction.

export const log = (...a) => console.log('[tepic]', ...a);

export function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
export function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
export const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// Ramer-Douglas-Peucker on an open polyline
export function rdp(pts, eps) {
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
export function rdpRing(ring, eps) {
  if (ring.length < 4) return ring.slice();
  const i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// Raster stairs -> lines: short edges (stair steps) are replaced by their midpoints, vertices between two long edges
// (true corners) are kept
export function destair(out, short) {
  const n = out.length;
  const len = (i) => { const a = out[i], b = out[(i + 1) % n]; return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]); };
  const res = [];
  for (let i = 0; i < n; i++) {
    const prevLong = len((i + n - 1) % n) > short;
    const nextLong = len(i) > short;
    if (prevLong && nextLong) res.push(out[i]);
    if (!nextLong) { const a = out[i], b = out[(i + 1) % n]; res.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  }
  return res;
}

// Greedy axis-aligned lot rects in a 0/1 mask (largest rectangle in a histogram), cleared as it goes: up to maxRects
// rects [i0, i1, j0, j1] (cells, inclusive) of at least minSide x minSide cells and minArea cells, until 93% is covered
export function maskRects(m, w, h, maxRects = 8, minSide = 8, minArea = 120) {
  let total = 0;
  for (let k = 0; k < w * h; k++) total += m[k];
  const rects = [];
  const hist = new Int32Array(w);
  const stack = new Int32Array(w + 1);
  let covered = 0;
  for (let it = 0; it < maxRects; it++) {
    hist.fill(0);
    let best = 0, bi0 = 0, bi1 = 0, bj0 = 0, bj1 = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) hist[i] = m[j * w + i] ? hist[i] + 1 : 0;
      let sp = 0;
      for (let i = 0; i <= w; i++) {
        const hh = i < w ? hist[i] : 0;
        while (sp && hist[stack[sp - 1]] >= hh) {
          const top = stack[--sp];
          const height = hist[top];
          const left = sp ? stack[sp - 1] + 1 : 0;
          const width = i - left;
          if (height >= minSide && width >= minSide) {
            const area = height * width;
            if (area > best) { best = area; bi0 = left; bi1 = i - 1; bj0 = j - height + 1; bj1 = j; }
          }
        }
        stack[sp++] = i;
      }
    }
    if (best < minArea || (rects.length && best < total * 0.06)) break;
    rects.push([bi0, bi1, bj0, bj1]);
    covered += best;
    for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) m[j * w + i] = 0;
    if (covered > total * 0.93) break;
  }
  return { rects, total, covered };
}

// Two-pass connected-component labelling (union-find, no flood-fill stack: islands may be tens of millions of cells).
// Labels the cells where `fg(k)` into `lab` as sign · 1..n (positive land, negative roadway) without touching the rest;
// `conn8` joins diagonal neighbours too. Returns n.
function labelPass(lab, W, H, fg, sign, conn8) {
  let parent = new Int32Array(1 << 16);
  let next = 1;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a === b) return a;
    if (a < b) { parent[b] = a; return a; }
    parent[a] = b;
    return b;
  };
  const own = (k) => { const v = lab[k] * sign; return v > 0 ? v : 0; };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!fg(k)) continue;
      let l = i > 0 ? own(k - 1) : 0;
      if (j > 0) {
        const up = own(k - W);
        if (up) l = l ? union(l, up) : up;
        if (conn8) {
          const ul = i > 0 ? own(k - W - 1) : 0;
          if (ul) l = l ? union(l, ul) : ul;
          const ur = i < W - 1 ? own(k - W + 1) : 0;
          if (ur) l = l ? union(l, ur) : ur;
        }
      }
      if (!l) {
        if (next >= parent.length) {
          const grown = new Int32Array(parent.length * 2);
          grown.set(parent);
          parent = grown;
        }
        parent[next] = next;
        l = next++;
      }
      lab[k] = sign * l;
    }
  }
  // final labels numbered 1..n in scan order of their first cell
  const final = new Int32Array(next);
  let n = 0;
  for (let k = 0; k < W * H; k++) {
    const v = lab[k] * sign;
    if (v <= 0) continue;
    const r = find(v);
    if (!final[r]) final[r] = ++n;
    lab[k] = sign * final[r];
  }
  return n;
}

// Land islands with their cell counts, bounds and first cell (the top-left one, where traceComponent starts)
function labelLand(lab, D, W, H) {
  const n = labelPass(lab, W, H, (k) => D[k] === 1, 1, false);
  const comps = [];
  for (let id = 1; id <= n; id++) comps.push({ id, n: 0, i0: W, i1: -1, j0: H, j1: -1, start: -1 });
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const id = lab[j * W + i];
      if (id <= 0) continue;
      const c = comps[id - 1];
      if (c.start < 0) c.start = j * W + i;
      c.n++;
      if (i < c.i0) c.i0 = i;
      if (i > c.i1) c.i1 = i;
      if (j < c.j0) c.j0 = j;
      if (j > c.j1) c.j1 = j;
    }
  }
  return comps;
}

// Patches of roadway (8-connected) that don't reach the raster's edge: each is enclosed by one island. Leaves them
// labelled negative in `lab` (the caller clears them). Returns [{ n, top, cells }]
function enclosedRoad(lab, D, W, H) {
  const n = labelPass(lab, W, H, (k) => D[k] === 0, -1, true);
  const edge = new Uint8Array(n + 1);
  const size = new Int32Array(n + 1);
  const top = new Int32Array(n + 1).fill(-1);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const id = -lab[k];
      if (id <= 0) continue;
      size[id]++;
      if (top[id] < 0) top[id] = k;
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) edge[id] = 1;
    }
  }
  const holes = [];
  const byId = new Map();
  for (let id = 1; id <= n; id++) {
    if (edge[id]) continue;
    const h = { n: size[id], top: top[id], cells: size[id] < 40 ? [] : null };
    holes.push(h);
    byId.set(id, h);
  }
  if (holes.some((h) => h.cells)) {
    for (let k = 0; k < W * H; k++) {
      const id = -lab[k];
      if (id <= 0) continue;
      const h = byId.get(id);
      if (h && h.cells) h.cells.push(k);
    }
  }
  return holes;
}

/**
 * Curb islands of a city: `land` is a 0/1 raster (w x h cells of `res` metres from (x0, z0)) where 1 is buildable land
 * and the roadways have already been cleared. Returns the labelled components with their outline polygons, lot rects
 * inside the property line (eroded by `sidewalk` metres) and frontage frames for islands that don't front the axes.
 * Output: [{ id, poly, area, bbox, rect, rects, frames, fill, _lab }].
 */
export function extractBlocks({ land, w: W, h: H, x0, z0, res: RES, sidewalk, minArea = 40, lotArea = 300, classify = null }) {
  const D = land;
  const lab = new Int32Array(W * H);
  // Islands are 4-connected land; the roadway between them 8-connected (so each enclosed patch of road borders one
  // island). An island ringing a road loop would be traced by its outer edge alone and cover the loop: small enclosed
  // patches (stubs of paths inside a block) are filled in, larger ones cut open to the outside with a 1 m slot
  // straight up from them, then the land is labelled afresh.
  let comps = labelLand(lab, D, W, H);
  for (let pass = 0; pass < 8; pass++) {
    const holes = enclosedRoad(lab, D, W, H);
    for (let k = 0; k < W * H; k++) if (lab[k] < 0) lab[k] = 0;
    if (!holes.length) break;
    let cut = 0;
    for (const h of holes) {
      if (h.n < 40) {
        for (const k of h.cells) D[k] = 1;
        continue;
      }
      const i = h.top % W;
      let j = (h.top - i) / W - 1;
      const L = j >= 0 ? lab[j * W + i] : 0;
      for (; j >= 0 && L && lab[j * W + i] === L; j--) D[j * W + i] = 0;
      cut++;
    }
    log(`pass ${pass + 1}: ${holes.length} enclosed patches of road (${cut} cut open, ${holes.length - cut} filled)`);
    lab.fill(0);
    comps = labelLand(lab, D, W, H);
  }
  log(`${comps.length} curb islands labelled`);
  // Islands that are open country rather than city blocks (fields, hills, scrub between the roads): no lots, no
  // frontage frames, a coarser outline
  const rural = classify ? classify(comps, lab) : new Set();

  function traceComponent(c) {
    const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i] === c.id ? 1 : 0);
    const si = c.start % W, sj = (c.start - si) / W;
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    let cx = si, cz = sj, dir = 0;
    const pts = [];
    const start = cx + ',' + cz + ',' + dir;
    let guard = 0;
    do {
      pts.push([x0 + cx * RES, z0 + cz * RES]);
      cx += DX[dir];
      cz += DZ[dir];
      let left, right;
      if (dir === 0) { left = at(cx, cz - 1); right = at(cx, cz); }
      else if (dir === 1) { left = at(cx, cz); right = at(cx - 1, cz); }
      else if (dir === 2) { left = at(cx - 1, cz); right = at(cx - 1, cz - 1); }
      else { left = at(cx - 1, cz - 1); right = at(cx, cz - 1); }
      if (left && right) dir = (dir + 3) % 4;
      else if (!right) dir = (dir + 1) % 4;
      if (++guard > 4e6) break;
    } while (cx + ',' + cz + ',' + dir !== start);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
      if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
    }
    return destair(out, RES * 1.5);
  }

  // Property line: square erosion of each island by the sidewalk width
  const ER = Math.max(1, Math.round(sidewalk / RES));
  const prop = new Uint8Array(W * H);
  {
    const tmp = new Uint8Array(W * H);
    const left = new Int32Array(W), right = new Int32Array(W);
    for (let j = 0; j < H; j++) {
      const row = j * W;
      let run = 0;
      for (let i = 0; i < W; i++) {
        const L = lab[row + i];
        run = L && i > 0 && lab[row + i - 1] === L ? run + 1 : L ? 1 : 0;
        left[i] = run;
      }
      run = 0;
      for (let i = W - 1; i >= 0; i--) {
        const L = lab[row + i];
        run = L && i < W - 1 && lab[row + i + 1] === L ? run + 1 : L ? 1 : 0;
        right[i] = run;
      }
      for (let i = 0; i < W; i++) tmp[row + i] = lab[row + i] && left[i] > ER && right[i] > ER ? 1 : 0;
    }
    const up = new Int32Array(H), dn = new Int32Array(H);
    for (let i = 0; i < W; i++) {
      let run = 0;
      for (let j = 0; j < H; j++) {
        const k = j * W + i, L = lab[k];
        run = L && j > 0 && lab[k - W] === L ? run + 1 : L ? 1 : 0;
        up[j] = run;
      }
      run = 0;
      for (let j = H - 1; j >= 0; j--) {
        const k = j * W + i, L = lab[k];
        run = L && j < H - 1 && lab[k + W] === L ? run + 1 : L ? 1 : 0;
        dn[j] = run;
      }
      for (let j = 0; j < H; j++) prop[j * W + i] = tmp[j * W + i] && up[j] > ER && dn[j] > ER ? 1 : 0;
    }
  }

  function lotRects(c, maxRects = 8) {
    const w = c.i1 - c.i0 + 1, h = c.j1 - c.j0 + 1;
    const m = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = (c.j0 + j) * W + c.i0 + i;
      if (prop[k] && lab[k] === c.id) m[j * w + i] = 1;
    }
    const { rects, total, covered } = maskRects(m, w, h, maxRects);
    return {
      rects: rects.map(([i0, i1, j0, j1]) => [x0 + (c.i0 + i0) * RES, x0 + (c.i0 + i1 + 1) * RES, z0 + (c.j0 + j0) * RES, z0 + (c.j0 + j1 + 1) * RES]),
      propArea: total,
      covered
    };
  }

  // Frontage frames of islands that don't front the axes
  const DEG = Math.PI / 180;
  const wrap90 = (a) => ((((a + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
  function blockFrames(c, poly) {
    const edges = [];
    let per = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i];
      const [bx, bz] = poly[(i + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      edges.push({ ax, az, bx, bz, L, phi: wrap90(Math.atan2(bz - az, bx - ax)), k: -1 });
      per += L;
    }
    const clusters = [];
    for (let n = 0; n < 3; n++) {
      let seed = null, seedW = 0;
      for (const e of edges) {
        if (e.k >= 0 || e.L < 4) continue;
        let w = 0;
        for (const f of edges) if (f.k < 0 && Math.abs(wrap90(f.phi - e.phi)) <= 7 * DEG) w += f.L;
        if (w > seedW) { seedW = w; seed = e; }
      }
      if (!seed || seedW < 14 || (n > 0 && seedW < per * 0.12)) break;
      const members = edges.filter((f) => f.k < 0 && Math.abs(wrap90(f.phi - seed.phi)) <= 7 * DEG);
      let sx = 0, sy = 0;
      for (const f of members) { sx += f.L * Math.cos(4 * f.phi); sy += f.L * Math.sin(4 * f.phi); }
      for (const f of members) f.k = clusters.length;
      clusters.push({ phi: Math.atan2(sy, sx) / 4 });
    }
    if (!clusters.length || (clusters.length === 1 && Math.abs(clusters[0].phi) < 2 * DEG)) return null;
    for (const e of edges) {
      if (e.k >= 0) continue;
      let bd = Infinity;
      clusters.forEach((cl, k) => { const d = Math.abs(wrap90(e.phi - cl.phi)); if (d < bd) { bd = d; e.k = k; } });
    }
    const w = c.i1 - c.i0 + 1, h = c.j1 - c.j0 + 1;
    const owner = new Int8Array(w * h).fill(-1);
    for (let j = 0; j < h; j++) {
      const pz = z0 + (c.j0 + j + 0.5) * RES;
      for (let i = 0; i < w; i++) {
        if (lab[(c.j0 + j) * W + c.i0 + i] !== c.id) continue;
        if (clusters.length === 1) { owner[j * w + i] = 0; continue; }
        const px = x0 + (c.i0 + i + 0.5) * RES;
        let bd = Infinity, bk = 0;
        for (const e of edges) {
          const dx = e.bx - e.ax, dz = e.bz - e.az;
          let t = ((px - e.ax) * dx + (pz - e.az) * dz) / (e.L * e.L);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = e.ax + t * dx - px, ez = e.az + t * dz - pz;
          const d = ex * ex + ez * ez;
          if (d < bd) { bd = d; bk = e.k; }
        }
        owner[j * w + i] = bk;
      }
    }
    const px = x0 + ((c.i0 + c.i1 + 1) * RES) / 2;
    const pz = z0 + ((c.j0 + c.j1 + 1) * RES) / 2;
    const views = clusters.map((cl, k) => {
      const th = -cl.phi;
      const cs = Math.cos(th), sn = Math.sin(th);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, z] of [[c.i0, c.j0], [c.i1 + 1, c.j0], [c.i0, c.j1 + 1], [c.i1 + 1, c.j1 + 1]]) {
        const dx = x0 + x * RES - px, dz = z0 + z * RES - pz;
        const u = px + dx * cs - dz * sn, v = pz + dx * sn + dz * cs;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      u0 = Math.floor(u0); v0 = Math.floor(v0);
      const lw = Math.ceil(u1 - u0) + 1, lh = Math.ceil(v1 - v0) + 1;
      const isl = new Uint8Array(lw * lh);
      const reg = new Uint8Array(lw * lh);
      const cell = new Int32Array(lw * lh).fill(-1);
      for (let j = 0; j < lh; j++) {
        const dv = v0 + j + 0.5 - pz;
        for (let i = 0; i < lw; i++) {
          const du = u0 + i + 0.5 - px;
          const x = px + du * cs + dv * sn, z = pz - du * sn + dv * cs;
          const gi = Math.floor((x - x0) / RES) - c.i0, gj = Math.floor((z - z0) / RES) - c.j0;
          if (gi < 0 || gj < 0 || gi >= w || gj >= h) continue;
          const o = owner[gj * w + gi];
          if (o < 0) continue;
          isl[j * lw + i] = 1;
          cell[j * lw + i] = gj * w + gi;
          if (o === k) reg[j * lw + i] = 1;
        }
      }
      const tmp = new Uint8Array(lw * lh);
      for (let j = 0; j < lh; j++) {
        let run = 0;
        const left = new Int32Array(lw);
        for (let i = 0; i < lw; i++) { run = isl[j * lw + i] ? run + 1 : 0; left[i] = run; }
        run = 0;
        for (let i = lw - 1; i >= 0; i--) { run = isl[j * lw + i] ? run + 1 : 0; tmp[j * lw + i] = left[i] > ER && run > ER ? 1 : 0; }
      }
      const propL = new Uint8Array(lw * lh);
      for (let i = 0; i < lw; i++) {
        let run = 0;
        const up = new Int32Array(lh);
        for (let j = 0; j < lh; j++) { run = isl[j * lw + i] ? run + 1 : 0; up[j] = run; }
        run = 0;
        for (let j = lh - 1; j >= 0; j--) {
          run = isl[j * lw + i] ? run + 1 : 0;
          propL[j * lw + i] = tmp[j * lw + i] && up[j] > ER && run > ER ? 1 : 0;
        }
      }
      return { th, u0, v0, lw, lh, prop: propL, reg, cell, rects: [] };
    });
    const used = new Uint8Array(w * h);
    const markUsed = (k) => {
      const gi = k % w, gj = (k - gi) / w;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = gi + di, j = gj + dj;
        if (i >= 0 && j >= 0 && i < w && j < h) used[j * w + i] = 1;
      }
    };
    for (const pass of [1, 2]) {
      for (const vw of views) {
        const { lw, lh, prop: pr, reg, cell } = vw;
        const m = new Uint8Array(lw * lh);
        for (let k = 0; k < lw * lh; k++) m[k] = pr[k] && (pass === 2 || reg[k]) && cell[k] >= 0 && !used[cell[k]] ? 1 : 0;
        const { rects } = maskRects(m, lw, lh, pass === 1 ? 6 : 4, 12);
        for (const [i0, i1, j0, j1] of rects) {
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (cell[j * lw + i] >= 0) markUsed(cell[j * lw + i]);
          vw.rects.push([vw.u0 + i0, vw.u0 + i1 + 1, vw.v0 + j0, vw.v0 + j1 + 1]);
        }
      }
    }
    const frames = views.filter((vw) => vw.rects.length).map((vw) => [vw.th, px, pz, vw.rects]);
    return frames.length ? frames : null;
  }

  const blocks = [];
  let small = 0;
  for (const c of comps) {
    const area = c.n * RES * RES;
    if (area < minArea) { small++; continue; }
    const isRural = rural.has(c.id);
    let poly = traceComponent(c);
    poly = rdpRing(poly, isRural ? 2.0 : 0.5);
    if (poly.length < 3) continue;
    if (ringArea(poly) > 0) poly.reverse();
    const bw = (c.i1 - c.i0 + 1) * RES, bd = (c.j1 - c.j0 + 1) * RES;
    const rectness = area / (bw * bd);
    const { rects, propArea, covered } = area >= lotArea && !isRural ? lotRects(c) : { rects: [], propArea: 0, covered: 0 };
    const frames = rectness <= 0.985 && area >= lotArea && !isRural ? blockFrames(c, poly) : null;
    blocks.push({
      id: blocks.length,
      _lab: c.id,
      cells: c.n,
      poly,
      area: Math.round(area),
      bbox: [x0 + c.i0 * RES, x0 + (c.i1 + 1) * RES, z0 + c.j0 * RES, z0 + (c.j1 + 1) * RES],
      rect: rectness > 0.985,
      rural: isRural,
      rects,
      frames,
      fill: propArea ? Math.round((covered / propArea) * 100) / 100 : 0
    });
  }
  log(`${blocks.filter((b) => b.rural).length} rural islands (open country)`);
  log(`${blocks.length} blocks (${blocks.filter((b) => b.rect).length} rectangular, ${blocks.filter((b) => !b.rects.length).length} without lots); ${small} specks dropped`);
  log(`${blocks.filter((b) => b.frames).length} irregular blocks with frontage frames (${blocks.reduce((t, b) => t + (b.frames ? b.frames.length : 0), 0)} frames)`);
  return { blocks, lab, prop };
}

// Scanline fill of a ring over a labelled raster: calls fn(label) for each covered cell with a label
export function ringCells(ring, { lab, w: W, h: H, x0, z0, res }, fn) {
  const bb = bbox(ring);
  const j0 = Math.max(0, Math.floor((bb.z0 - z0) / res)), j1 = Math.min(H - 1, Math.ceil((bb.z1 - z0) / res));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * res;
    xs.length = 0;
    for (let a = 0, k = ring.length - 1; a < ring.length; k = a++) {
      const [xa, za] = ring[k], [xb, zb] = ring[a];
      if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
    }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
      for (let i = i0; i <= i1; i++) {
        const L = lab[j * W + i];
        if (L) fn(L);
      }
    }
  }
}

// Stamp a capsule (segment of half width r) as 0 into a 0/1 raster
export function clearCapsule(D, W, H, X0, Z0, RES, s) {
  const ix0 = Math.max(0, Math.floor((Math.min(s.x0, s.x1) - s.r - X0) / RES));
  const ix1 = Math.min(W - 1, Math.ceil((Math.max(s.x0, s.x1) + s.r - X0) / RES));
  const iz0 = Math.max(0, Math.floor((Math.min(s.z0, s.z1) - s.r - Z0) / RES));
  const iz1 = Math.min(H - 1, Math.ceil((Math.max(s.z0, s.z1) + s.r - Z0) / RES));
  if (ix0 > ix1 || iz0 > iz1) return;
  const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
  const L2 = dx * dx + dz * dz || 1e-9;
  const r2 = s.r * s.r;
  for (let j = iz0; j <= iz1; j++) {
    const pz = Z0 + (j + 0.5) * RES;
    for (let i = ix0; i <= ix1; i++) {
      const k = j * W + i;
      if (!D[k]) continue;
      const px = X0 + (i + 0.5) * RES;
      let t = ((px - s.x0) * dx + (pz - s.z0) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = s.x0 + t * dx - px, ez = s.z0 + t * dz - pz;
      if (ex * ex + ez * ez <= r2) D[k] = 0;
    }
  }
}

// Convex hull (monotone chain) of [[x, z], ...]
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Minimum-area enclosing rectangle of a footprint (rotating the hull's edges), as the oriented box the game builds:
 * { cx, cz, w, d, th } with world = c + R_y(th)·local (three.js rotation about +y: x' = cs·x + sn·z, z' = -sn·x + cs·z),
 * local x along w. `th` is folded into (-45°, 45°] so the box keeps its long side wherever it falls.
 */
export function minAreaRect(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of hull) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uz, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let w = u1 - u0, d = v1 - v0;
  // local x runs along (ux, uz): x' = cs·x + sn·z with x = (1, 0) -> (cs, -sn) = (ux, uz), so cs = ux, sn = -uz
  let th = Math.atan2(-uz, ux);
  // fold into (-45°, 45°]: a quarter turn swaps the box's sides
  while (th > Math.PI / 4) { th -= Math.PI / 2; [w, d] = [d, w]; }
  while (th <= -Math.PI / 4) { th += Math.PI / 2; [w, d] = [d, w]; }
  return { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, w, d, th, area: best.area };
}

/**
 * Minimal PNG decoder for 8-bit RGB / RGBA, non-interlaced images (the Terrarium elevation tiles): returns
 * { width, height, channels, data: Uint8Array }. `inflate` is node:zlib's inflateSync.
 */
export function decodePNG(buf, inflate) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const channels = type === 6 ? 4 : 3;
  const raw = inflate(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[out + x - channels] : 0;
      const b = y > 0 ? data[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? data[out - stride + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[out + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}

/**
 * Map matching for hand-drawn routes (the bus & combi lines of tools/data/tepic/semovi_routes.json): a hidden Markov
 * model over the directed street graph, solved with Viterbi (Newson & Krumm, 2009). The drawn line is sampled every
 * `step` m; each sample may lie on any street direction within `radius` m that runs its way (emission: the distance
 * off the street, and how far the street turns from the line), and one sample leads to the next along the streets as
 * the line does (transition: how much longer or shorter the drive is than the drawn stretch). One-way streets are only
 * driven their way, so a line drawn against one goes round the block. Where no drive joins two samples (the line
 * leaves the map, or the streets don't connect) the route breaks into pieces.
 *
 * links: [{ a, b, pts: [[x, z], ...] from node a to node b, dir: 0 both ways, 1 a to b only, -1 b to a only }]
 * Returns match(line) for polylines [[x, z], ...] in the same frame: { pieces, samples, matched, loop }, where each
 * piece is a list of refs, link index + 1 driven a to b and -(index + 1) b to a, `matched` counts the samples on a
 * street, and `loop` says the one piece drives on from its end back into its start.
 */
export function createRouteMatcher(links, { step = 15, radius = 30, sigma = 8, beta = 12, k = 6, bridge = 1200 } = {}) {
  // Directed states: 2·link driven a to b, 2·link + 1 driven b to a
  const len = links.map((l) => {
    let s = 0;
    for (let i = 0; i + 1 < l.pts.length; i++) s += Math.hypot(l.pts[i + 1][0] - l.pts[i][0], l.pts[i + 1][1] - l.pts[i][1]);
    return s;
  });
  const allowed = (st) => { const d = links[st >> 1].dir; return d === 0 || (d > 0) === ((st & 1) === 0); };
  const startOf = (st) => (st & 1 ? links[st >> 1].b : links[st >> 1].a);
  const endOf = (st) => (st & 1 ? links[st >> 1].a : links[st >> 1].b);
  const out = new Map(); // node -> the states leaving it
  for (let st = 0; st < links.length * 2; st++) {
    if (!allowed(st)) continue;
    const n = startOf(st);
    if (!out.has(n)) out.set(n, []);
    out.get(n).push(st);
  }
  // Segments in 64 m cells
  const CELL = 64;
  const grid = new Map();
  links.forEach((l, li) => {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1];
      for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz++) {
          const key = ix * 100003 + iz;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(li);
        }
      }
    }
  });
  const stamp = new Int32Array(links.length).fill(-1);
  let stampNo = 0;

  // Where (x, z) projects onto link li: distance off it, metres from its node a, and its direction there
  function project(li, x, z) {
    const p = links[li].pts;
    let best = Infinity, u = 0, tx = 0, tz = 0, s0 = 0;
    for (let i = 0; i + 1 < p.length; i++) {
      const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1];
      const L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - p[i][0]) * dx + (z - p[i][1]) * dz) / (L * L)));
      const d = Math.hypot(p[i][0] + dx * t - x, p[i][1] + dz * t - z);
      if (d < best) { best = d; u = s0 + t * L; tx = dx / L; tz = dz / L; }
      s0 += L;
    }
    return { d: best, u, tx, tz };
  }

  function candidates(x, z, tx, tz) {
    stampNo++;
    const list = [];
    const ix0 = Math.floor(x / CELL), iz0 = Math.floor(z / CELL);
    for (let ix = ix0 - 1; ix <= ix0 + 1; ix++) {
      for (let iz = iz0 - 1; iz <= iz0 + 1; iz++) {
        for (const li of grid.get(ix * 100003 + iz) || []) {
          if (stamp[li] === stampNo) continue;
          stamp[li] = stampNo;
          const pr = project(li, x, z);
          if (pr.d > radius) continue;
          for (const back of [0, 1]) {
            const st = li * 2 + back;
            if (!allowed(st)) continue;
            const cos = back ? -(pr.tx * tx + pr.tz * tz) : pr.tx * tx + pr.tz * tz;
            if (cos < -0.3) continue; // the line runs the other way along this street
            list.push({ st, pos: back ? len[li] - pr.u : pr.u, cost: 0.5 * (pr.d / sigma) ** 2 + 3 * (1 - cos) });
          }
        }
      }
    }
    list.sort((p, q) => p.cost - q.cost);
    return list.slice(0, k);
  }

  // Shortest drives from a node, out to `limit` m (binary heap); prev: the state that reached each node
  function dijkstra(src, limit) {
    const dist = new Map([[src, 0]]);
    const prev = new Map();
    const heap = [[0, src]];
    while (heap.length) {
      const [d, n] = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      if (d > dist.get(n)) continue;
      for (const st of out.get(n) || []) {
        const m = endOf(st);
        const dm = d + len[st >> 1];
        if (dm > limit || dm >= (dist.has(m) ? dist.get(m) : Infinity)) continue;
        dist.set(m, dm);
        prev.set(m, st);
        heap.push([dm, m]);
        for (let i = heap.length - 1; i > 0;) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[i], heap[p]] = [heap[p], heap[i]];
          i = p;
        }
      }
    }
    return { dist, prev };
  }

  return function match(line) {
    // Samples every `step` m along the drawn line, with its direction there
    const samples = [];
    let carry = 0;
    for (let i = 0; i + 1 < line.length; i++) {
      const [ax, az] = line[i], [bx, bz] = line[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      let s = carry;
      for (; s < L; s += step) samples.push({ x: ax + ((bx - ax) * s) / L, z: az + ((bz - az) * s) / L, tx: (bx - ax) / L, tz: (bz - az) / L });
      carry = s - L;
    }
    const cands = samples.map((p) => candidates(p.x, p.z, p.tx, p.tz));
    // Viterbi, breaking into a new piece where no candidate is reachable from the last sample's
    const score = [], from = [], trees = [];
    const pieceStart = [];
    let open = false;
    for (let i = 0; i < samples.length; i++) {
      const cs = cands[i];
      score[i] = cs.map((c) => c.cost);
      from[i] = cs.map(() => -1);
      trees[i] = new Map();
      if (!cs.length) { open = false; continue; }
      if (!open || !cands[i - 1].length) { pieceStart.push(i); open = true; continue; }
      const limit = step * 3 + 80;
      let any = false;
      for (let b = 0; b < cs.length; b++) {
        let best = Infinity, arg = -1;
        for (let a = 0; a < cands[i - 1].length; a++) {
          const p = cands[i - 1][a], c = cs[b];
          let D;
          if (p.st === c.st && c.pos >= p.pos - 2) D = Math.max(0, c.pos - p.pos);
          else {
            const n = endOf(p.st);
            if (!trees[i].has(n)) trees[i].set(n, dijkstra(n, limit));
            const t = trees[i].get(n).dist.get(startOf(c.st));
            if (t === undefined) continue;
            D = len[p.st >> 1] - p.pos + t + c.pos;
            if ((p.st ^ 1) === c.st) D += 40; // a U-turn
          }
          const s = score[i - 1][a] + Math.abs(D - step) / beta;
          if (s < best) { best = s; arg = a; }
        }
        if (arg >= 0) { score[i][b] += best; from[i][b] = arg; any = true; }
      }
      if (!any) pieceStart.push(i); // nothing joins it to the last sample: a new piece, on its emissions alone
      else for (let b = 0; b < cs.length; b++) if (from[i][b] < 0) score[i][b] = Infinity;
    }
    // Back-track each piece from its best last candidate, then spell out the drive between candidates
    const pieces = [];
    const ends = [];
    for (let j = 0; j < pieceStart.length; j++) {
      let e = pieceStart[j];
      const stop = j + 1 < pieceStart.length ? pieceStart[j + 1] : samples.length;
      while (e + 1 < stop && cands[e + 1].length && from[e + 1].some((f) => f >= 0)) e++;
      ends.push([pieceStart[j], e]);
    }
    let matched = 0;
    for (const [s0, e] of ends) {
      let b = 0;
      for (let q = 1; q < score[e].length; q++) if (score[e][q] < score[e][b]) b = q;
      const chosen = [];
      for (let i = e; i >= s0; i--) { chosen.push(cands[i][b]); b = i > s0 ? from[i][b] : 0; }
      chosen.reverse();
      matched += chosen.length;
      const states = [chosen[0].st];
      for (let i = 1; i < chosen.length; i++) {
        const p = chosen[i - 1], c = chosen[i];
        if (p.st === c.st && c.pos >= p.pos - 2) continue;
        const tree = trees[s0 + i].get(endOf(p.st)) || dijkstra(endOf(p.st), step * 3 + 80);
        const path = [];
        for (let n = startOf(c.st); n !== endOf(p.st);) {
          const st = tree.prev.get(n);
          if (st === undefined) break;
          path.push(st);
          n = startOf(st);
        }
        states.push(...path.reverse(), c.st);
      }
      const refs = [];
      for (const st of states) {
        const ref = st & 1 ? -((st >> 1) + 1) : (st >> 1) + 1;
        if (refs[refs.length - 1] !== ref) refs.push(ref);
      }
      if (refs.length) pieces.push(refs);
    }
    // Bridge the breaks the streets can close (a line drawn the wrong way up a one-way street, a street missing from
    // the map): drive from one piece's end to the next piece's start, if that's under `bridge` m. And close the loop
    // when the line ends where it began, as most routes do (out and back), so the route runs round and round.
    const toState = (ref) => (ref > 0 ? (ref - 1) * 2 : (-ref - 1) * 2 + 1);
    const drive = (fromRef, toRef) => {
      const src = endOf(toState(fromRef)), dst = startOf(toState(toRef));
      if (src === dst) return [];
      const tree = dijkstra(src, bridge);
      if (!tree.dist.has(dst)) return null;
      const path = [];
      for (let n = dst; n !== src;) { const st = tree.prev.get(n); path.push(st & 1 ? -((st >> 1) + 1) : (st >> 1) + 1); n = startOf(st); }
      return path.reverse();
    };
    for (let j = 0; j + 1 < pieces.length;) {
      const a = pieces[j], b = pieces[j + 1];
      const path = drive(a[a.length - 1], b[0]);
      if (!path) { j++; continue; }
      pieces.splice(j, 2, [...a, ...path, ...b.slice(b[0] === a[a.length - 1] ? 1 : 0)]);
    }
    let loop = false;
    const [fx, fz] = line[0], [lx, lz] = line[line.length - 1];
    if (pieces.length === 1 && Math.hypot(lx - fx, lz - fz) < 100) {
      const p = pieces[0];
      const path = drive(p[p.length - 1], p[0]);
      if (path) { p.push(...path); loop = true; }
    }
    return { pieces, samples: samples.length, matched, loop };
  };
}
