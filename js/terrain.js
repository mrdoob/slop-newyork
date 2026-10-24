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

export { heightAt, drape, resample, buildTerrainMesh };
