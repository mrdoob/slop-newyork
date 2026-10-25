// js/sim/transit.js
// Tepic's bus & combi routes (GEO.transit: the Secretaría de Movilidad de Nayarit's map, driven along the road graph
// by tools/build-tepic-geodata.mjs 6B) as polylines for the traffic to follow. A vehicle on a route keeps a cursor,
// metres along its path; at each intersection it takes the move whose road runs on along the path from there
// (pickMove). Paths that loop (most routes run out and back) wrap round, so a bus keeps to its route for as long as it
// stays near the player. No three.js here, so node --test can load it.

const CELL = 32; // m, the spatial hash of path segments
const ON_PATH = 4.5; // m: a road this close to a path, running its way, is on it
const ALIGNED = 0.85; // cos of the largest angle between a road and the path it is on

// Decodes GEO.transit over GEO.roadGraph: one path per piece of each route, its polyline from the links it drives
function decodeTransit(transit, roadGraph) {
  const paths = [];
  if (!transit || !roadGraph) return paths;
  const N = roadGraph.nodes;
  const links = roadGraph.links;
  transit.routes.forEach(([name, group, color, fleet, loops, pieces], routeIndex) => {
    for (const piece of pieces) {
      const xs = [];
      const push = (x, z) => {
        const n = xs.length;
        if (n && Math.abs(xs[n - 2] - x) < 0.05 && Math.abs(xs[n - 1] - z) < 0.05) return;
        xs.push(x, z);
      };
      for (const ref of piece) {
        const [a, b, , , , , inner] = links[Math.abs(ref) - 1];
        const pts = [N[2 * a], N[2 * a + 1], ...inner, N[2 * b], N[2 * b + 1]];
        if (ref > 0) for (let k = 0; k < pts.length; k += 2) push(pts[k], pts[k + 1]);
        else for (let k = pts.length - 2; k >= 0; k -= 2) push(pts[k], pts[k + 1]);
      }
      if (xs.length < 4) continue;
      const pts = Float64Array.from(xs);
      const segs = pts.length / 2 - 1;
      const cum = new Float64Array(segs + 1);
      for (let i = 0; i < segs; i++) cum[i + 1] = cum[i] + Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
      paths.push({
        name, group, color, fleet, routeIndex, pts, cum, len: cum[segs],
        loop: loops === 1 && pieces.length === 1
      });
    }
  });
  return paths;
}

function createTransit(transit, roadGraph) {
  const paths = decodeTransit(transit, roadGraph);
  const routeNames = transit ? transit.routes.map((r) => r[0]) : [];
  const grid = new Map();
  paths.forEach((p, pi) => {
    for (let i = 0; i + 1 < p.pts.length / 2; i++) {
      const ax = p.pts[2 * i], az = p.pts[2 * i + 1], bx = p.pts[2 * i + 2], bz = p.pts[2 * i + 3];
      for (let ix = Math.floor(Math.min(ax, bx) / CELL); ix <= Math.floor(Math.max(ax, bx) / CELL); ix++) {
        for (let iz = Math.floor(Math.min(az, bz) / CELL); iz <= Math.floor(Math.max(az, bz) / CELL); iz++) {
          const key = ix * 100003 + iz;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(pi, i);
        }
      }
    }
  });

  // The segment of path p that s falls in (s wrapped round a loop, else clamped)
  function segmentAt(p, s) {
    if (p.loop) s = ((s % p.len) + p.len) % p.len;
    else s = Math.max(0, Math.min(p.len, s));
    let lo = 0, hi = p.cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // The nearest point of path p to (x, z) between s0 and s0 + span metres along it (wrapping round a loop), running
  // within ALIGNED of direction (dx, dz) when given: out.s (unwrapped, from s0's lap), out.d; false if p has none there
  function project(p, x, z, s0, span, dx, dz, out) {
    const segs = p.cum.length - 1;
    let i = segmentAt(p, s0);
    let lap = p.loop ? Math.floor(s0 / p.len) * p.len : 0;
    let best = Infinity;
    for (let walked = 0; walked < segs; walked++) {
      const ax = p.pts[2 * i], az = p.pts[2 * i + 1];
      const ex = p.pts[2 * i + 2] - ax, ez = p.pts[2 * i + 3] - az;
      const L = p.cum[i + 1] - p.cum[i];
      if (lap + p.cum[i] > s0 + span) break;
      if (L > 1e-6 && (dx === undefined || (ex * dx + ez * dz) / L >= ALIGNED)) {
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (L * L)));
        const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
        const s = lap + p.cum[i] + t * L;
        if (d < best && s >= s0 - 1) {
          best = d;
          out.s = s;
          out.d = d;
        }
      }
      if (++i >= segs) {
        if (!p.loop) break;
        i = 0;
        lap += p.len;
      }
    }
    return best < Infinity;
  }

  // The paths a straight road from (ax, az) to (bx, bz) lies on, running its way: [{ path, s }] with s where the road
  // ends on each (spawning a vehicle there, and keeping its cursor from then on)
  const probe = { s: 0, d: 0 };
  function pathsAlong(ax, az, bx, bz) {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1) return [];
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const found = [];
    const seen = new Set();
    const ix0 = Math.floor(mx / CELL), iz0 = Math.floor(mz / CELL);
    for (let ix = ix0 - 1; ix <= ix0 + 1; ix++) {
      for (let iz = iz0 - 1; iz <= iz0 + 1; iz++) {
        const list = grid.get(ix * 100003 + iz);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const pi = list[k];
          const p = paths[pi];
          const i = list[k + 1];
          const key = pi * 1e6 + i;
          if (seen.has(key)) continue;
          seen.add(key);
          // the segment's own neighbourhood of the path: the midpoint and both ends of the road on it, in order
          const s0 = Math.max(p.loop ? -Infinity : 0, p.cum[i] - L - 10);
          if (!project(p, mx, mz, s0, 2 * L + 20 + (p.cum[i + 1] - p.cum[i]), dx, dz, probe) || probe.d > ON_PATH) continue;
          const sm = probe.s;
          if (!project(p, bx, bz, sm, L + 10, dx, dz, probe) || probe.d > ON_PATH) continue;
          const se = probe.s;
          if (se - sm > L * 0.5 + 8) continue;
          if (found.some((f) => f.path === p && Math.abs(f.s - se) < 5)) continue;
          found.push({ path: p, s: p.loop ? ((se % p.len) + p.len) % p.len : se });
        }
      }
    }
    return found;
  }

  // Of the moves out of a road, the one that carries on along path p from cursor s (the end of the road the vehicle is
  // on): each move's road is probed along its length; the one closest to the path ahead, running its way, wins.
  // Returns its index and where its road ends on the path, or index -1 when none runs on along it (the vehicle has
  // strayed off its route). `ok(m)` filters the moves (those the vehicle's lane allows).
  const pick = { index: -1, s: 0 };
  function pickMove(p, s, moves, ok = null, reach = 0) {
    pick.index = -1;
    let bestScore = ON_PATH * 2;
    for (let k = 0; k < moves.length; k++) {
      const m = moves[k];
      if (ok && !ok(m)) continue;
      const f = m.to;
      const ex = f.sx + f.dx * f.len, ez = f.sz + f.dz * f.len;
      const span = f.len + 40 + reach;
      const probeLen = Math.min(f.len, 24);
      if (!project(p, f.sx + f.dx * probeLen, f.sz + f.dz * probeLen, s - 8, span, f.dx, f.dz, probe)) continue;
      const near = probe.d;
      const sNear = probe.s;
      if (!project(p, ex, ez, sNear, f.len + 20, f.dx, f.dz, probe)) continue;
      const score = Math.max(near, probe.d);
      if (score < bestScore) {
        bestScore = score;
        pick.index = k;
        pick.s = probe.s;
      }
    }
    if (pick.index >= 0 && p.loop) pick.s = ((pick.s % p.len) + p.len) % p.len;
    return pick;
  }

  return { paths, routeNames, pathsAlong, pickMove, project, segmentAt };
}

export { createTransit, decodeTransit };
