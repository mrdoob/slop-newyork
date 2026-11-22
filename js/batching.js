import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Static geometry merged into one mesh per material, so that a whole set of parts costs one draw call per material in
// every pass

/**
 * Collects static parts per material. Each part's geometry is copied (non-indexed) and transformed by its matrix,
 * keeping position & normal (and uv with keepUV). The merged mesh casts / receives shadows if any of its parts does,
 * or if build() is told so for all of them.
 */
function createPartCollector({ keepUV = false } = {}) {
  const buckets = new Map();
  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const add = (material, geometry, matrix = null, castShadow = false, receiveShadow = false) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal' && !(keepUV && key === 'uv')) g.deleteAttribute(key);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (matrix) g.applyMatrix4(matrix);
    let b = buckets.get(material);
    if (!b) buckets.set(material, (b = { geometries: [], castShadow: false, receiveShadow: false }));
    b.geometries.push(g);
    b.castShadow ||= castShadow;
    b.receiveShadow ||= receiveShadow;
  };
  const matrixOf = (x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) =>
    m.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), s.set(sx, sy, sz)).clone();
  return {
    add,
    matrixOf,
    // Box with its base centre at (x, y, z)
    box(material, x, y, z, w, h, d, ry = 0) {
      add(material, unitBox, matrixOf(x, y, z, w, h, d, 0, ry, 0));
    },
    build(parent, { castShadow = false, receiveShadow = false } = {}) {
      for (const [material, b] of buckets) {
        const merged = b.geometries.length === 1 ? b.geometries[0] : mergeGeometries(b.geometries, false);
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = castShadow || b.castShadow;
        mesh.receiveShadow = receiveShadow || b.receiveShadow;
        parent.add(mesh);
      }
    }
  };
}

/**
 * Merges the static meshes in rootGroup (not instanced, with position, normal & uv) that share a material into one mesh
 * per material, except for excludeMaterials and materials only one mesh uses.
 */
function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();
  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) buckets.set(obj.material, []);
    buckets.get(obj.material).push(obj);
  });
  const parts = createPartCollector({ keepUV: true });
  for (const [material, meshes] of buckets) {
    if (meshes.length < 2) continue;
    for (const mesh of meshes) {
      parts.add(material, mesh.geometry, new THREE.Matrix4().multiplyMatrices(invRoot, mesh.matrixWorld), mesh.castShadow, mesh.receiveShadow);
      if (mesh.parent) mesh.parent.remove(mesh);
    }
  }
  parts.build(rootGroup);
}

/** A geometry from flat position, normal & uv arrays */
function geometryFromArrays(pos, nor, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export { createPartCollector, batchStaticGroupMeshes, geometryFromArrays };
