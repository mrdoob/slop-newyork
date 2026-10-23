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

export function inferSidewalks(roadGraph, paths, pathKinds) {
  const grid = walkIndex(paths, pathKinds);
  const RG = roadGraph;
  const nodeCount = RG.nodes.length / 2;
  const reach = new Float32Array(nodeCount), degree = new Uint16Array(nodeCount);
  for (const [a, b, , w] of RG.links) for (const n of [a, b]) { reach[n] = Math.max(reach[n], w / 2); degree[n]++; }
  const out = [];
  RG.links.forEach((l, i) => {
    const [a, b, , w] = l;
    const tags = RG.sidewalk[i];
    const street = w >= MIN_STREET_W && RG.highway[i] !== 'service';
    const mapped = sidesOf(linkLine(RG, l), w, grid);
    const sw = RG.sidewalkWidth[i] || DEFAULT_SIDEWALK_W(w);
    [0, 1].forEach((side) => {
      const tag = tags[side];
      if (tag === 2 || tag === 3 || mapped[side]) return; // no / separate / already mapped
      if (tag === 0 && !street) return;
      // stop short of crossing streets' kerbs (and their sidewalks) at junctions
      const trim = (n) => (degree[n] >= 3 ? reach[n] + sw : degree[n] === 2 ? 0 : 0);
      const line = offsetTrim(linkLine(RG, l), (side ? 1 : -1) * (w / 2 + sw / 2), trim(a), trim(b));
      if (line) out.push([line, sw, tag === 1 ? 'tagged' : 'inferred']);
    });
  });
  return out;
}
