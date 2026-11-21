// Lazily connected sidewalk tracks; junctions stay on the same curb island. Crosswalk tracks are separate,
// and pedestrian-system.js checks traffic permissions before entering them.
function createPedestrianRoutes({ walkable, onSidewalk }, blockAt) {
  const sidewalks = new Map(), crossings = new Map(), junctions = new Map(), connections = new WeakMap();
  const point = (track, end) => ({ x: track.ax + track.ux * track.len * end, z: track.az + track.uz * track.len * end });
  const segment = (a, b, extra = {}) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    return { ax: a.x, az: a.z, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len,
      len, node: null, side: 0, line: 0, ...extra };
  };

  function clear(a, b, block = null) {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
    let x = a.x, z = a.z;
    for (let i = 0; i <= steps; i++) {
      const nx = a.x + (b.x - a.x) * i / (steps || 1), nz = a.z + (b.z - a.z) * i / (steps || 1);
      if (!walkable(Math.min(x, nx) - 0.4, Math.max(x, nx) + 0.4, Math.min(z, nz) - 0.4, Math.max(z, nz) + 0.4)) return false;
      if (block && blockAt(nx, nz) !== block) return false;
      x = nx; z = nz;
    }
    return true;
  }

  // A two-way road is a pair of directed edges along one centreline (one-way roads have a single edge): both share one
  // set of sidewalks, laid out along the first of the pair asked for
  const twins = new Map();
  function twin(e) {
    if (!twins.has(e)) twins.set(e, e.to.out.find((o) => o.to === e.from && o.dx * e.dx + o.dz * e.dz < -0.99) || null);
    return twins.get(e);
  }

  function along(e) {
    if (sidewalks.has(e)) return sidewalks.get(e);
    const other = twin(e);
    if (other && sidewalks.has(other)) {
      sidewalks.set(e, sidewalks.get(other));
      return sidewalks.get(e);
    }
    const result = [];
    sidewalks.set(e, result);
    if (other) sidewalks.set(other, result);
    // Two walking lines on each side leave room for people to pass or stop together.
    for (const sign of [-1, 1]) {
      for (const inset of [1.7, 2.8]) {
        const off = sign * (e.half + inset);
        const a = { x: e.sx + e.rx * off, z: e.sz + e.rz * off };
        const b = { x: a.x + e.dx * e.len, z: a.z + e.dz * e.len };
        const block = blockAt(a.x, a.z);
        if (!block || blockAt(b.x, b.z) !== block) continue;
        if (!e.general && (!onSidewalk(a.x, a.z) || !onSidewalk(b.x, b.z))) continue;
        const points = clear(a, b, block) ? [a, b] : detour(a, b, block);
        for (let i = 1, previous = null; i < points.length; i++) {
          const track = segment(points[i - 1], points[i], { edge: e, from: e.from, to: e.to, block });
          if (previous) { previous.after = track; track.before = previous; }
          result.push(track);
          previous = track;
        }
      }
    }
    return result;
  }

  function across(n) {
    if (crossings.has(n)) return crossings.get(n);
    const result = [];
    crossings.set(n, result);
    if (!n.signal) return result;
    for (let side = 0; side < 4; side++) {
      const road = n.road[side];
      if (!road) continue;
      const avenue = side >= 2, sign = side % 2 === 0 ? 1 : -1;
      for (const line of avenue ? [sign * 0.75] : [-0.75, 0.75]) {
        const a = { x: avenue ? road.x0 - road.half - 2 : n.x + sign * (n.hx + 1.25) + line,
          z: avenue ? n.z + sign * (n.hz + 1.25) + line : road.z0 - road.half - 2 };
        const len = road.half * 2 + 4;
        const b = { x: a.x + (avenue ? len : 0), z: a.z + (avenue ? 0 : len) };
        if (!onSidewalk(a.x, a.z) || !onSidewalk(b.x, b.z) || !clear(a, b)) continue;
        result.push(segment(a, b, { node: n, side, line, from: n, to: n }));
      }
    }
    return result;
  }

  function ports(n) {
    if (junctions.has(n)) return junctions.get(n);
    const result = [], seen = new Set();
    junctions.set(n, result);
    for (const e of [...n.in, ...n.out]) {
      for (const track of along(e)) {
        if (seen.has(track)) continue;
        seen.add(track);
        const end = track.from === n ? 0 : 1; // (the track runs along whichever edge of a two-way pair laid it out)
        if (!(end ? track.after : track.before)) result.push({ track, end });
      }
    }
    for (const track of across(n)) result.push({ track, end: 0 }, { track, end: 1 });
    return result;
  }

  // Stay in the sidewalk band even where angled building colliders are deliberately omitted from the road graph.
  function cornerClear(a, b, block, sidewalk = false) {
    if (!clear(a, b, block)) return false;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / (steps || 1), z = a.z + (b.z - a.z) * i / (steps || 1);
      if (sidewalk && !onSidewalk(x, z)) return false;
      let distance = Infinity;
      for (let j = 0, k = block.poly.length - 1; j < block.poly.length; k = j++) {
        const p = block.poly[j], q = block.poly[k], dx = q.x - p.x, dz = q.z - p.z;
        const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (z - p.z) * dz) / (dx * dx + dz * dz || 1)));
        distance = Math.min(distance, Math.hypot(x - p.x - dx * t, z - p.z - dz * t));
      }
      if (distance > 4) return false;
    }
    return true;
  }

  // Search a small sidewalk strip only when its usual walking line is blocked. The edge keeps the result.
  function detour(a, b, block) {
    const len = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const rows = Math.max(2, Math.ceil(len / 2)), width = 9, middle = 4;
    const step = len / rows;
    const sidewalkClear = (p, q) => cornerClear(p, q, block, true);
    if (!sidewalkClear(a, a) || !sidewalkClear(b, b)) return [];
    const lead = Math.min(8, len / 3);
    for (const offset of [0.6, -0.6, 1.2, -1.2]) {
      const c = { x: a.x + ux * lead - uz * offset, z: a.z + uz * lead + ux * offset };
      const d = { x: b.x - ux * lead - uz * offset, z: b.z - uz * lead + ux * offset };
      if (sidewalkClear(c, d) && sidewalkClear(a, c) && sidewalkClear(d, b)) return [a, c, d, b];
    }
    let previous = Array.from({ length: width }, (_, j) => j === middle ? { ...a, cost: 0, previous: null } : null);
    for (let i = 1; i <= rows; i++) {
      const row = new Array(width).fill(null);
      for (let j = 0; j < width; j++) {
        if (i === rows && j !== middle) continue;
        const offset = (j - middle) * 0.6;
        const p = { x: a.x + ux * step * i - uz * offset, z: a.z + uz * step * i + ux * offset,
          cost: Infinity, previous: null };
        if (!sidewalkClear(p, p)) continue;
        for (let k = Math.max(0, j - 1); k <= Math.min(width - 1, j + 1); k++) {
          const q = previous[k];
          if (!q) continue;
          const cost = q.cost + Math.hypot(p.x - q.x, p.z - q.z) + Math.abs(offset) * 0.02;
          if (cost >= p.cost || !sidewalkClear(q, p)) continue;
          p.cost = cost; p.previous = q;
        }
        if (p.previous) row[j] = p;
      }
      if (!row.some(Boolean)) return [];
      previous = row;
    }
    let end = previous[middle];
    if (!end) return [];
    const points = [];
    while (end) { points.push(end); end = end.previous; }
    points.reverse();
    // Remove collinear samples before the longer visibility checks.
    const corners = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const p = corners[corners.length - 1], q = points[i], r = points[i + 1];
      if (Math.abs((q.x - p.x) * (r.z - q.z) - (q.z - p.z) * (r.x - q.x)) > 1e-6) corners.push(q);
    }
    corners.push(points[points.length - 1]);
    const result = [corners[0]];
    for (let i = 2; i < corners.length; i++) {
      if (!sidewalkClear(result[result.length - 1], corners[i])) result.push(corners[i - 1]);
    }
    result.push(corners[corners.length - 1]);
    return result;
  }

  function links(track, dir) {
    let ends = connections.get(track);
    if (!ends) connections.set(track, ends = []);
    const end = dir > 0 ? 1 : 0;
    if (ends[end]) return ends[end];
    const result = ends[end] = [];
    const continuation = end ? track.after : track.before;
    if (continuation) { result.push([{ track: continuation, dir }]); return result; }
    const n = end ? track.to : track.from;
    if (!n) return result;
    const a = point(track, end), block = blockAt(a.x, a.z);
    if (!block) return result;
    for (const port of ports(n)) {
      const next = port.track, nextDir = port.end ? -1 : 1;
      if (next === track) continue;
      const b = point(next, port.end), distance = Math.hypot(b.x - a.x, b.z - a.z);
      if (distance > 32 || blockAt(b.x, b.z) !== block) continue;
      const path = [];
      if (distance > 0.01) {
        if (cornerClear(a, b, block)) {
          path.push({ track: segment(a, b), dir: 1 });
        } else {
          // Meeting the two offset sidewalk lines rounds the curb instead of cutting diagonally through a lot.
          const ax = track.ux * dir, az = track.uz * dir, bx = next.ux * nextDir, bz = next.uz * nextDir;
          const cross = ax * bz - az * bx;
          if (Math.abs(cross) < 0.2) continue;
          const t = ((b.x - a.x) * bz - (b.z - a.z) * bx) / cross;
          const c = { x: a.x + ax * t, z: a.z + az * t };
          if (t < 0 || t > 20 || (b.x - c.x) * bx + (b.z - c.z) * bz < 0 || Math.hypot(b.x - c.x, b.z - c.z) > 20) continue;
          if (!cornerClear(a, c, block) || !cornerClear(c, b, block)) continue;
          if (t > 0.01) path.push({ track: segment(a, c), dir: 1 });
          if (Math.hypot(b.x - c.x, b.z - c.z) > 0.01) path.push({ track: segment(c, b), dir: 1 });
        }
      }
      path.push({ track: next, dir: nextDir });
      result.push(path);
    }
    return result;
  }

  function next(track, dir, goalX, goalZ, penalty = null) {
    let best = null, bestScore = -Infinity;
    const a = point(track, dir > 0 ? 1 : 0);
    const gx = goalX - a.x, gz = goalZ - a.z, distance = Math.hypot(gx, gz) || 1;
    for (const path of links(track, dir)) {
      const last = path[path.length - 1], target = last.track;
      const ux = target.ux * last.dir, uz = target.uz * last.dir;
      const back = ux * track.ux * dir + uz * track.uz * dir < -0.8;
      const score = (ux * gx + uz * gz) / distance + Math.random() * 0.7 - (back ? 2 : 0) - (penalty ? penalty(path) : 0);
      if (score > bestScore) { best = path; bestScore = score; }
    }
    return best;
  }

  function canDodge(p, offset) {
    const block = blockAt(p.x, p.z);
    const target = { x: p.ax + p.ux * p.t + p.uz * offset, z: p.az + p.uz * p.t - p.ux * offset };
    return !!block && onSidewalk(target.x, target.z) && cornerClear(p, target, block);
  }

  // How much of a road an edge stands for, to spread people by sidewalk length: half of a two-way road
  const share = (e) => (twin(e) ? 0.5 : 1);

  return { along, across, next, canDodge, share };
}

export { createPedestrianRoutes };
