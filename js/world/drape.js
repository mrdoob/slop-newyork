import * as THREE from 'three/webgpu';
import { SLOPES, LATTICE, clipToLattice, townHeight } from './ground.js';

// js/world/drape.js
// Lays the city's ground layers, built flat at y = 0 (the road deck, sidewalks & curbs, meadows, park walks, yards,
// road paint), on the town's slopes (ground.js): their triangles are cut along the ground's lattice and each vertex
// raised by the town's floor under it, so a layer follows the ground exactly and the layers stacked on it keep their
// few centimetres apart. In the flat city (?slopes=0) everything is left as built.

const _inverse = new THREE.Matrix4();
const _identity = new THREE.Matrix4();

// The triangles of a geometry facing up or sideways (an index list): the undersides of the slabs lying on the ground
// are never seen, and cut along the lattice they would cost as much as their tops
function visibleTriangles(geo) {
  const pos = geo.attributes.position.array;
  const index = geo.index ? geo.index.array : null;
  const n = (index ? index.length : pos.length / 3) / 3;
  const keep = [];
  for (let t = 0; t < n; t++) {
    const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const ny = uz * vx - ux * vz, len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
    if (len > 0 && ny / len < -0.9) continue; // facing down
    keep.push(a, b, c);
  }
  return keep;
}

/**
 * A geometry in world space laid on the town's floor (a new, non-indexed geometry; the same one with ?slopes=0).
 * `undersides: false` leaves out the triangles facing down.
 */
function drapeGeometry(geo, { undersides = true } = {}) {
  if (!SLOPES || !LATTICE) return geo;
  const names = Object.keys(geo.attributes).sort((a, b) => (a === 'position' ? -1 : b === 'position' ? 1 : 0));
  const attrs = names.map((name) => geo.attributes[name]);
  const arrays = attrs.map((a) => (a.isInterleavedBufferAttribute ? Float32Array.from({ length: a.count * a.itemSize }, (_, i) => a.getComponent(Math.floor(i / a.itemSize), i % a.itemSize)) : a.array));
  const index = undersides ? (geo.index ? geo.index.array : null) : visibleTriangles(geo);
  const out = clipToLattice(arrays, attrs.map((a) => a.itemSize), index, LATTICE);
  const pos = out[0];
  for (let i = 0; i < pos.length; i += 3) pos[i + 1] += townHeight(pos[i], pos[i + 2]);
  // the faces that looked up now look square off the slope under them (each piece lies in one ground triangle's
  // plane); walls keep facing sideways
  const n = names.indexOf('normal');
  if (n >= 0 && attrs[n].itemSize === 3) tiltUpNormals(pos, out[n]);
  const draped = new THREE.BufferGeometry();
  names.forEach((name, k) => draped.setAttribute(name, new THREE.BufferAttribute(out[k], attrs[k].itemSize, attrs[k].normalized)));
  draped.computeBoundingBox();
  draped.computeBoundingSphere();
  return draped;
}

// The normals of a non-indexed geometry's up-facing triangles turned to their (draped) face normals
function tiltUpNormals(pos, normal) {
  for (let o = 0; o < pos.length; o += 9) {
    if (normal[o + 1] < 0.9 || normal[o + 4] < 0.9 || normal[o + 7] < 0.9) continue;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    const s = (ny < 0 ? -1 : 1) / len; // (up, whichever way the piece is wound)
    nx *= s; ny *= s; nz *= s;
    for (let k = 0; k < 9; k += 3) {
      normal[o + k] = nx;
      normal[o + k + 1] = ny;
      normal[o + k + 2] = nz;
    }
  }
}

/** Every plain (not instanced) mesh under `root` but those in `skip` laid on the town's floor, without its undersides */
function drapeMeshes(root, skip = null) {
  if (!SLOPES || !LATTICE) return;
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || (skip && skip.has(obj))) return;
    // (in world space: the city's ground layers are, most often, already)
    const placed = !obj.matrixWorld.equals(_identity);
    const world = placed ? obj.geometry.clone().applyMatrix4(obj.matrixWorld) : obj.geometry;
    const draped = drapeGeometry(world, { undersides: false });
    if (placed) {
      draped.applyMatrix4(_inverse.copy(obj.matrixWorld).invert());
      world.dispose();
    }
    obj.geometry.dispose();
    obj.geometry = draped;
  });
}

export { drapeGeometry, drapeMeshes };
