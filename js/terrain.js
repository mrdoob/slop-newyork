import * as THREE from 'three/webgpu';

// js/terrain.js
// Ground heights for footprint cities. GEO.terrain (optional; tools/geo-terrain.mjs) is a height grid in decimetres:
// { x0, z0, step, nx, nz, h }. Without it every height is 0 and the city stays flat, so renderers can call these
// unconditionally. City-agnostic: everything comes from `geo`.
//
//   heightAt(geo)(x, z) -> m          bilinear ground height (0 outside the grid)
//   drape(geometry, height, maxEdge)  subdivide a flat ground mesh until no triangle edge exceeds maxEdge m, then lift
//                                     every vertex by the ground height under it (returns a new, non-indexed geometry)
//   resample(pts, maxStep)            add points along a polyline so ribbons built on it can follow the ground
//   buildTerrainMesh(geo, material)   the ground itself, as a grid mesh (null without terrain)
//
// Underpass ramps (GEO.roadGraph.rampDepth: per link 0, or the road's depth below the street at each of its points):
//   rampProfile(geo, li)              (s) -> depth m at arc length s along link li, or null for a link at street level
//   rampDepthAt(geo)                  (x, z) -> depth m of the ramp road under (x, z) (0 off the ramps)
//   rampOutlines(geo, pad)            the ramps' footprints (where they are below the street), widened by `pad` m, as
//                                     polygons [[x, z], ...]
//   groundOpening(geo, pad)           an invisible lid over the ramps that keeps the ground from covering the trench
//                                     (see the function for the draw order it needs), or null without ramps

function heightAt(geo) {
  const t = geo.terrain;
  if (!t) return () => 0;
  const { x0, z0, step, nx, nz, h } = t;
  return (x, z) => {
    const gx = (x - x0) / step, gz = (z - z0) / step;
    const i = Math.floor(gx), j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return 0;
    const fx = gx - i, fz = gz - j, k = j * nx + i;
    return ((h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fz) + (h[k + nx] * (1 - fx) + h[k + nx + 1] * fx) * fz) / 10;
  };
}

function drape(geometry, height, maxEdge = 12) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  const src = g.attributes.position.array;
  const out = [];
  const tri = (a, b, c, depth) => {
    const d = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2]);
    const ab = d(a, b), bc = d(b, c), ca = d(c, a), m = Math.max(ab, bc, ca);
    if (m <= maxEdge || depth > 12) { out.push(...a, ...b, ...c); return; }
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    // split the longest edge (keeps the triangles well shaped)
    if (m === ab) { const e = mid(a, b); tri(a, e, c, depth + 1); tri(e, b, c, depth + 1); }
    else if (m === bc) { const e = mid(b, c); tri(a, b, e, depth + 1); tri(a, e, c, depth + 1); }
    else { const e = mid(c, a); tri(a, b, e, depth + 1); tri(e, b, c, depth + 1); }
  };
  for (let i = 0; i < src.length; i += 9) tri([src[i], src[i + 1], src[i + 2]], [src[i + 3], src[i + 4], src[i + 5]], [src[i + 6], src[i + 7], src[i + 8]], 0);
  for (let i = 0; i < out.length; i += 3) out[i + 1] += height(out[i], out[i + 2]);
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  r.computeVertexNormals();
  if (g !== geometry) g.dispose();
  return r;
}

function resample(pts, maxStep = 8) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / maxStep);
    for (let k = 1; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
    out.push(pts[i]);
  }
  return out;
}

function buildTerrainMesh(geo, material) {
  const t = geo.terrain;
  if (!t) return null;
  const { x0, z0, step, nx, nz, h } = t;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      pos[k * 3] = x0 + i * step;
      pos[k * 3 + 1] = h[k] / 10 - 0.02; // a hair below the roads & lots drawn on it
      pos[k * 3 + 2] = z0 + j * step;
    }
  }
  const index = [];
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

const linkPoints = (RG, [a, b, , , , , inner]) => {
  const pts = [[RG.nodes[2 * a], RG.nodes[2 * a + 1]]];
  for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
  pts.push([RG.nodes[2 * b], RG.nodes[2 * b + 1]]);
  return pts;
};

function rampProfile(geo, li) {
  const RG = geo.roadGraph, depths = RG.rampDepth?.[li];
  if (!depths) return null;
  const pts = linkPoints(RG, RG.links[li]), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return (s) => {
    if (s <= 0) return depths[0];
    for (let i = 1; i < cum.length; i++) {
      if (s <= cum[i]) return depths[i - 1] + ((depths[i] - depths[i - 1]) * (s - cum[i - 1])) / (cum[i] - cum[i - 1] || 1);
    }
    return depths[depths.length - 1];
  };
}

function rampDepthAt(geo) {
  const RG = geo.roadGraph;
  if (!RG.rampDepth) return () => 0;
  const segs = [];
  RG.rampDepth.forEach((depths, li) => {
    if (!depths) return;
    const pts = linkPoints(RG, RG.links[li]), hw = RG.links[li][3] / 2;
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1], depths[i], depths[i + 1], hw]);
  });
  return (x, z) => {
    let best = 0, bd = Infinity;
    for (const [[x0, z0], [x1, z1], d0, d1, hw] of segs) {
      if (Math.abs(x - x0) > 200 && Math.abs(x - x1) > 200) continue;
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
      const d = Math.hypot(x0 + dx * t - x, z0 + dz * t - z);
      if (d <= hw && d < bd) { bd = d; best = d0 + (d1 - d0) * t; }
    }
    return best;
  };
}

function rampOutlines(geo, pad = 0) {
  const RG = geo.roadGraph, out = [];
  (RG.rampDepth || []).forEach((depths, li) => {
    if (!depths) return;
    const pts = linkPoints(RG, RG.links[li]), hw = RG.links[li][3] / 2 + pad;
    const left = [], right = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[Math.max(0, i - 1)], [bx, bz] = pts[Math.min(pts.length - 1, i + 1)];
      const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L;
      left.push([pts[i][0] - nx * hw, pts[i][1] - nz * hw]);
      right.push([pts[i][0] + nx * hw, pts[i][1] + nz * hw]);
    }
    out.push([...left, ...right.reverse()]);
  });
  return out;
}

// The ground's openings over the ramps, as an invisible lid: drawn (renderOrder) after the roads and the cars, which go
// down into the trench, and before the ground, it writes depth but no colour at street level, so the ground fails the
// depth test over the ramps and the trench drawn before it shows. Everything else is depth-tested against it as against
// the ground. Openings are square at their ends (none past a portal or the ramp's top) and reach the retaining walls
// (`pad` m beyond the road's edge). null without ramps.
function groundOpening(geo, pad) {
  const RG = geo.roadGraph;
  if (!RG.rampDepth) return null;
  const ground = heightAt(geo), pos = [];
  RG.rampDepth.forEach((depths, li) => {
    if (!depths) return;
    const pts = linkPoints(RG, RG.links[li]), hw = RG.links[li][3] / 2 + pad;
    for (let i = 0; i + 1 < pts.length; i++) {
      if (depths[i] < 0.05 && depths[i + 1] < 0.05) continue;
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az) || 1, nx = (-(bz - az) / L) * hw, nz = ((bx - ax) / L) * hw;
      const q = [[ax - nx, az - nz], [bx - nx, bz - nz], [bx + nx, bz + nz], [ax + nx, az + nz]].map(([x, z]) => [x, ground(x, z) + 0.01, z]);
      for (const k of [0, 1, 2, 0, 2, 3]) pos.push(...q[k]);
    }
  });
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'ground-openings';
  mesh.frustumCulled = false;
  return mesh;
}

export { heightAt, drape, resample, buildTerrainMesh, rampProfile, rampDepthAt, rampOutlines, groundOpening };
