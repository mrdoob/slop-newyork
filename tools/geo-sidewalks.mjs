// tools/geo-sidewalks.mjs
// Sidewalks for an OSM street graph (tools/geo-osm-roadgraph.mjs output), in two steps:
//
// 1. fitRoadWidths(roadGraph, paths): estimated road widths (class defaults, or lanes × 3.25 m) are checked against
//    sidewalks mapped alongside (footways running parallel to the road). Where mapped sidewalks flank a road with a
//    class-default width on both sides, the road takes the width between them; where a mapped sidewalk would overlap an
//    estimated road, the road narrows to its kerb. A widened road steps back where its kerbs would run into buildings
//    (`solid(x, z)`). Tagged widths are never changed. Fitted links get widthSource 'fitted to sidewalks'.
// 2. inferSidewalks(roadGraph, paths): a sidewalk strip along each kerb that has none mapped. Sides tagged
//    sidewalk=yes/both/left/right get one ('tagged'); sides tagged no or separate get none; untagged sides of streets
//    at least MIN_STREET_W wide get one unless a mapped sidewalk already runs there ('inferred': Taipei maps few
//    sidewalks, but streets this wide nearly all have them; the strip's width is a default, not a measurement).
//
// Returned sidewalks: [[x, z], ...] centre line, width m, source ('tagged' | 'inferred').

const MIN_STREET_W = 6; // m: narrower streets (alleys, lanes) get no inferred sidewalks
const SAMPLE_M = 4; // m between samples along a road
const SEARCH_M = 22; // m beyond the estimated kerb searched for a mapped sidewalk (boulevards are far wider than estimated)
const MIN_LATERAL = 3; // m: walkways closer to the centre line run along a median, not a kerb
const PARALLEL = 0.94; // |cos| between road and sidewalk directions
const MIN_SHARE = 0.4; // share of a link's samples that must see a mapped sidewalk on a side
const DEFAULT_SIDEWALK_W = (w) => (w >= 9 ? 3 : 2); // m: wide streets get wider sidewalks

const nodeAt = (RG, i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
function linkLine(RG, [a, b, , , , , inner]) {
  const pts = [nodeAt(RG, a)];
  for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
  pts.push(nodeAt(RG, b));
  return pts;
}

// Mapped walkways at ground level, as segments in a 10 m grid for lookups
function walkIndex(paths, pathKinds) {
  const ok = new Set(['sidewalk', 'footway', 'pedestrian'].map((k) => pathKinds.indexOf(k)));
  const grid = new Map();
  for (const [k, w, elev, pts] of paths) {
    if (!ok.has(k) || elev > 0) continue;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.5) continue;
      const seg = { x0, z0, x1, z1, dx: (x1 - x0) / L, dz: (z1 - z0) / L, L, w };
      const cells = new Set();
      for (let d = 0; d <= L; d += 5) cells.add(`${Math.floor((x0 + seg.dx * d) / 10)},${Math.floor((z0 + seg.dz * d) / 10)}`);
      cells.add(`${Math.floor(x1 / 10)},${Math.floor(z1 / 10)}`);
      for (const c of cells) {
        if (!grid.has(c)) grid.set(c, []);
        grid.get(c).push(seg);
      }
    }
  }
  return grid;
}

// Lateral distances (left negative, right positive of travel a -> b) from the road centre line to parallel mapped
// walkways, per side: median distance & walkway width where at least MIN_SHARE of the samples see one, else null
function sidesOf(pts, w, grid) {
  const found = [[], []];
  let samples = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 1) continue;
    const dx = (x1 - x0) / L, dz = (z1 - z0) / L, nx = -dz, nz = dx; // right of travel: (-dz, dx) in x-east z-south
    for (let d = SAMPLE_M / 2; d < L; d += SAMPLE_M) {
      samples++;
      const x = x0 + dx * d, z = z0 + dz * d;
      const best = [null, null];
      const seen = new Set();
      for (let gx = -2; gx <= 2; gx++) {
        for (let gz = -2; gz <= 2; gz++) {
          for (const s of grid.get(`${Math.floor(x / 10) + gx},${Math.floor(z / 10) + gz}`) || []) {
            if (seen.has(s)) continue;
            seen.add(s);
            if (Math.abs(s.dx * dx + s.dz * dz) < PARALLEL) continue;
            // closest point of the walkway segment to (x, z)
            const t = Math.max(0, Math.min(s.L, (x - s.x0) * s.dx + (z - s.z0) * s.dz));
            const px = s.x0 + s.dx * t, pz = s.z0 + s.dz * t;
            const along = (px - x) * dx + (pz - z) * dz;
            if (Math.abs(along) > SAMPLE_M) continue;
            const lat = (px - x) * nx + (pz - z) * nz;
            if (Math.abs(lat) < MIN_LATERAL || Math.abs(lat) > w / 2 + SEARCH_M) continue;
            const side = lat > 0 ? 1 : 0;
            if (!best[side] || Math.abs(lat) < best[side].d) best[side] = { d: Math.abs(lat), w: s.w };
          }
        }
      }
      for (const side of [0, 1]) if (best[side]) found[side].push(best[side]);
    }
  }
  const median = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
  return found.map((f) => (samples && f.length >= MIN_SHARE * samples ? { d: median(f.map((v) => v.d)), w: median(f.map((v) => v.w)) } : null));
}

// Share of kerb samples (both sides, every SAMPLE_M) of a road of width w that fall where solid(x, z)
function kerbBlocked(pts, w, solid) {
  let n = 0, bad = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 1) continue;
    const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
    for (let d = SAMPLE_M / 2; d < L; d += SAMPLE_M) {
      const x = x0 + ((x1 - x0) * d) / L, z = z0 + ((z1 - z0) * d) / L;
      for (const s of [-1, 1]) { n++; if (solid(x + nx * s * w / 2, z + nz * s * w / 2)) bad++; }
    }
  }
  return n ? bad / n : 0;
}

export function fitRoadWidths(roadGraph, paths, pathKinds, solid = () => false) {
  const grid = walkIndex(paths, pathKinds);
  const FITTED = 3;
  let widened = 0, narrowed = 0;
  roadGraph.links.forEach((l, i) => {
    const src = roadGraph.widthSource[i];
    if (src === 0) return; // tagged width: keep
    const w = l[3];
    const [left, right] = sidesOf(linkLine(roadGraph, l), w, grid);
    let next = w;
    if (left && right && src === 2) {
      next = 2 * Math.min(left.d - left.w / 2, right.d - right.w / 2); // kerb to kerb, centred on the mapped centre line
    } else {
      for (const s of [left, right]) if (s) next = Math.min(next, 2 * (s.d - s.w / 2)); // don't run under a sidewalk
    }
    next = Math.round(Math.max(l[5] === 0 ? 5.5 : 3, Math.min(40, next)) * 10) / 10; // two-way roads keep two lanes
    const line = linkLine(roadGraph, l);
    while (next > w && kerbBlocked(line, next, solid) > 0.05) next = Math.max(w, next - 1); // clear of buildings
    if (Math.abs(next - w) < 0.5) return;
    if (next > w) widened++;
    else narrowed++;
    l[3] = next;
    l[4] = Math.max(1, Math.min(Math.max(l[4], Math.floor(next / 3.4)), Math.floor(next / 2.6))); // lanes that fit
    roadGraph.widthSource[i] = FITTED;
  });
  return { widened, narrowed };
}

// Offset a polyline `off` m to the right of its direction (mitred), then trim d0 / d1 m off its ends
function offsetTrim(pts, off, d0, d1) {
  const out = pts.map((p, i) => {
    const seg = (a, b) => {
      const dx = pts[b][0] - pts[a][0], dz = pts[b][1] - pts[a][1];
      const L = Math.hypot(dx, dz) || 1e-9;
      return [-dz / L, dx / L];
    };
    const na = i > 0 ? seg(i - 1, i) : seg(0, 1);
    const nb = i < pts.length - 1 ? seg(i, i + 1) : na;
    let mx = na[0] + nb[0], mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz) || 1e-9;
    mx /= ml;
    mz /= ml;
    const k = Math.min(2, 1 / Math.max(0.3, mx * na[0] + mz * na[1]));
    return [p[0] + mx * off * k, p[1] + mz * off * k];
  });
  const cum = [0];
  for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total - d0 - d1 < 4) return null;
  const at = (s) => {
    let i = 1;
    while (i < out.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [out[i - 1][0] + (out[i][0] - out[i - 1][0]) * t, out[i - 1][1] + (out[i][1] - out[i - 1][1]) * t];
  };
  const res = [at(d0)];
  for (let i = 1; i < out.length - 1; i++) if (cum[i] > d0 && cum[i] < total - d1) res.push(out[i]);
  res.push(at(total - d1));
  return res;
}

// Does segment p-q cross segment a-b (proper intersection)?
function crosses([px, pz], [qx, qz], [ax, az], [bx, bz]) {
  const d = (x0, z0, x1, z1, x2, z2) => (x1 - x0) * (z2 - z0) - (z1 - z0) * (x2 - x0);
  const d1 = d(ax, az, bx, bz, px, pz), d2 = d(ax, az, bx, bz, qx, qz), d3 = d(px, pz, qx, qz, ax, az), d4 = d(px, pz, qx, qz, bx, bz);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function inferSidewalks(roadGraph, paths, pathKinds) {
  const grid = walkIndex(paths, pathKinds);
  const RG = roadGraph;
  const nodeCount = RG.nodes.length / 2;
  const reach = new Float32Array(nodeCount), degree = new Uint16Array(nodeCount);
  for (const [a, b, , w] of RG.links) for (const n of [a, b]) { reach[n] = Math.max(reach[n], w / 2); degree[n]++; }
  // One-way links' midpoints & travel directions, to find the opposite carriageway of a dual carriageway
  const mids = RG.links.map((l) => {
    const pts = linkLine(RG, l);
    const [x0, z0] = pts[0], [x1, z1] = pts[pts.length - 1];
    const L = Math.hypot(x1 - x0, z1 - z0) || 1;
    const sign = l[5] === -1 ? -1 : 1;
    return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, dx: ((x1 - x0) / L) * sign, dz: ((z1 - z0) / L) * sign, L, oneway: l[5] !== 0 };
  });
  // Side (0 left, 1 right of a -> b) of link i that faces an opposite one-way carriageway, or -1
  function medianSide(i) {
    const m = mids[i];
    if (!m.oneway) return -1;
    const ax = mids[i].dx * (RG.links[i][5] === -1 ? -1 : 1), az = mids[i].dz * (RG.links[i][5] === -1 ? -1 : 1); // a -> b
    for (let j = 0; j < mids.length; j++) {
      const o = mids[j];
      if (j === i || !o.oneway || m.dx * o.dx + m.dz * o.dz > -0.9) continue; // opposite travel
      const rx = o.x - m.x, rz = o.z - m.z;
      const lat = rx * -az + rz * ax; // right of a -> b positive
      const along = rx * ax + rz * az;
      if (Math.abs(lat) > 3 && Math.abs(lat) < 45 && Math.abs(along) < m.L / 2 + 20) return lat > 0 ? 1 : 0;
    }
    return -1;
  }
  const out = [];
  const ends = new Map(); // node -> [{ p, toward: unit vector along the sidewalk towards the node, sw, link }]
  const addEnd = (n, p, q, sw, link) => {
    const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    if (!ends.has(n)) ends.set(n, []);
    ends.get(n).push({ p, toward: [(p[0] - q[0]) / L, (p[1] - q[1]) / L], sw, link });
  };
  RG.links.forEach((l, i) => {
    const [a, b, , w] = l;
    const tags = RG.sidewalk[i];
    const street = w >= MIN_STREET_W && RG.highway[i] !== 'service';
    const mapped = sidesOf(linkLine(RG, l), w, grid);
    const sw = RG.sidewalkWidth[i] || DEFAULT_SIDEWALK_W(w);
    const median = medianSide(i);
    [0, 1].forEach((side) => {
      const tag = tags[side];
      if (tag === 2 || tag === 3 || mapped[side]) return; // no / separate / already mapped
      if (tag === 0 && (!street || side === median)) return; // untagged: streets only, not along a median
      // stop short of crossing streets' kerbs (and their sidewalks) at junctions
      const trim = (n) => (degree[n] >= 3 ? reach[n] + sw : 0);
      const line = offsetTrim(linkLine(RG, l), (side ? 1 : -1) * (w / 2 + sw / 2), trim(a), trim(b));
      if (!line) return;
      out.push([line, sw, tag === 1 ? 'tagged' : 'inferred']);
      if (degree[a] >= 3) addEnd(a, line[0], line[1], sw, i);
      if (degree[b] >= 3) addEnd(b, line[line.length - 1], line[line.length - 2], sw, i);
    });
  });
  // Corners: around each junction, join consecutive sidewalk ends of different streets with a curve, unless the join
  // would cross a street (an arm without sidewalks)
  let corners = 0;
  for (const [n, list] of ends) {
    const [nx, nz] = nodeAt(RG, n);
    const arms = RG.links.filter(([a, b]) => a === n || b === n).map((l) => {
      const pts = linkLine(RG, l);
      return l[0] === n ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
    });
    list.sort((e1, e2) => Math.atan2(e1.p[1] - nz, e1.p[0] - nx) - Math.atan2(e2.p[1] - nz, e2.p[0] - nx));
    for (let k = 0; k < list.length && list.length > 1; k++) {
      const e1 = list[k], e2 = list[(k + 1) % list.length];
      if (e1.link === e2.link || Math.hypot(e1.p[0] - e2.p[0], e1.p[1] - e2.p[1]) > 40) continue;
      if (arms.some(([p, q]) => crosses(e1.p, e2.p, p, [p[0] + (q[0] - p[0]) * 4, p[1] + (q[1] - p[1]) * 4]))) continue;
      // control point: where the two sidewalks' lines meet (else the midpoint pulled towards the junction)
      const [ax, az] = e1.p, [ux, uz] = e1.toward, [bx, bz] = e2.p, [vx, vz] = e2.toward;
      const den = ux * vz - uz * vx;
      let c = [(ax + bx) / 2 * 0.7 + nx * 0.3, (az + bz) / 2 * 0.7 + nz * 0.3];
      if (Math.abs(den) > 1e-3) {
        const t = ((bx - ax) * vz - (bz - az) * vx) / den;
        if (t > 0 && t < 30) c = [ax + ux * t, az + uz * t];
      }
      const line = [];
      for (let s = 0; s <= 6; s++) {
        const t = s / 6, u = 1 - t;
        line.push([u * u * ax + 2 * u * t * c[0] + t * t * bx, u * u * az + 2 * u * t * c[1] + t * t * bz]);
      }
      out.push([line, Math.min(e1.sw, e2.sw), 'inferred']);
      corners++;
    }
  }
  out.corners = corners;
  return out;
}

// Mapped footways running alongside a road, at its kerb, are sidewalks (OSM often tags them only highway=footway):
// returns the indices of such paths. A path qualifies when at least 60% of its samples lie parallel to a road,
// between its kerb and KERB_BAND_M beyond.
const KERB_BAND_M = 12;
export function sidewalkFootways(roadGraph, paths, pathKinds) {
  const footway = pathKinds.indexOf('footway');
  const segs = [];
  for (const l of roadGraph.links) {
    const pts = linkLine(roadGraph, l);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L > 0.5) segs.push({ x0, z0, dx: (x1 - x0) / L, dz: (z1 - z0) / L, L, w: l[3] });
    }
  }
  const out = [];
  paths.forEach(([k, , elev, pts], pi) => {
    if (k !== footway || elev > 0) return;
    let n = 0, hit = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.5) continue;
      const dx = (x1 - x0) / L, dz = (z1 - z0) / L;
      for (let d = 1; d < L; d += SAMPLE_M) {
        n++;
        const x = x0 + dx * d, z = z0 + dz * d;
        if (segs.some((s) => {
          if (Math.abs(s.dx * dx + s.dz * dz) < PARALLEL) return false;
          const t = (x - s.x0) * s.dx + (z - s.z0) * s.dz;
          if (t < 0 || t > s.L) return false;
          const lat = Math.abs((x - s.x0) * -s.dz + (z - s.z0) * s.dx);
          return lat > s.w / 2 - 0.5 && lat < s.w / 2 + KERB_BAND_M;
        })) hit++;
      }
    }
    if (n && hit >= 0.6 * n) out.push(pi);
  });
  return out;
}
