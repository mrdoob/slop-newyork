const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const treesSource = readFileSync(join(__dirname, '../js/trees.js'), 'utf8');
const buildingCollision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));

// Minimal 2D canvas + Three.js math/mesh stubs so createTreeField runs unchanged in Node.
function makeStubDocument() {
  const noop = () => {};
  const buf = new Uint8ClampedArray(1024 * 1024 * 4);
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1,
    fillRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    closePath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    getImageData: () => ({ data: buf })
  };
  return {
    createElement() {
      return { width: 0, height: 0, getContext: () => ctx };
    }
  };
}

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiply(v) { this.x *= v.x; this.y *= v.y; this.z *= v.z; return this; }
  divide(v) { this.x /= v.x; this.y /= v.y; this.z /= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
  max(v) {
    this.x = Math.max(this.x, v.x);
    this.y = Math.max(this.y, v.y);
    this.z = Math.max(this.z, v.z);
    return this;
  }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.crossVectors(this.clone(), v); }
  crossVectors(a, b) {
    this.x = a.y * b.z - a.z * b.y;
    this.y = a.z * b.x - a.x * b.z;
    this.z = a.x * b.y - a.y * b.x;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  distanceToSquared(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }
  distanceTo(v) { return Math.sqrt(this.distanceToSquared(v)); }
  normalize() {
    const l = this.length() || 1;
    this.x /= l; this.y /= l; this.z /= l;
    return this;
  }
  applyAxisAngle(axis, angle) {
    const q = new Quaternion().setFromAxisAngle(axis, angle);
    return this.applyQuaternion(q);
  }
  applyQuaternion(q) {
    const { x, y, z } = this;
    const { x: qx, y: qy, z: qz, w: qw } = q;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  setFromMatrixPosition(m) {
    this.x = m.elements[12];
    this.y = m.elements[13];
    this.z = m.elements[14];
    return this;
  }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5, s = Math.sin(half);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
    return this;
  }
  setFromUnitVectors(vFrom, vTo) {
    let r = vFrom.dot(vTo) + 1;
    if (r < 1e-6) {
      r = 0;
      if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) {
        this.x = -vFrom.y; this.y = vFrom.x; this.z = 0; this.w = r;
      } else {
        this.x = 0; this.y = -vFrom.z; this.z = vFrom.y; this.w = r;
      }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }
    const len = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= len; this.y /= len; this.z /= len; this.w /= len;
    return this;
  }
}

class Matrix4 {
  constructor() {
    this.elements = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  toArray(target, offset = 0) {
    target.set(this.elements, offset);
    return target;
  }
}

class Box3 {
  constructor(min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)) {
    this.min = min;
    this.max = max;
  }
  copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
  union(b) {
    this.min.x = Math.min(this.min.x, b.min.x);
    this.min.y = Math.min(this.min.y, b.min.y);
    this.min.z = Math.min(this.min.z, b.min.z);
    this.max.x = Math.max(this.max.x, b.max.x);
    this.max.y = Math.max(this.max.y, b.max.y);
    this.max.z = Math.max(this.max.z, b.max.z);
    return this;
  }
  setFromPoints(pts) {
    this.min.set(Infinity, Infinity, Infinity);
    this.max.set(-Infinity, -Infinity, -Infinity);
    for (const p of pts) {
      if (p.x < this.min.x) this.min.x = p.x;
      if (p.y < this.min.y) this.min.y = p.y;
      if (p.z < this.min.z) this.min.z = p.z;
      if (p.x > this.max.x) this.max.x = p.x;
      if (p.y > this.max.y) this.max.y = p.y;
      if (p.z > this.max.z) this.max.z = p.z;
    }
    return this;
  }
  getCenter(out) {
    return out.set((this.min.x + this.max.x) * 0.5, (this.min.y + this.max.y) * 0.5, (this.min.z + this.max.z) * 0.5);
  }
  getSize(out) {
    return out.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z);
  }
  applyMatrix4(m) {
    const e = m.elements;
    const xs = [this.min.x, this.max.x], ys = [this.min.y, this.max.y], zs = [this.min.z, this.max.z];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const x of xs) for (const y of ys) for (const z of zs) {
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }
    this.min.set(minX, minY, minZ);
    this.max.set(maxX, maxY, maxZ);
    return this;
  }
  expandByScalar(s) {
    this.min.x -= s; this.min.y -= s; this.min.z -= s;
    this.max.x += s; this.max.y += s; this.max.z += s;
    return this;
  }
}

class Sphere {
  constructor(center = new Vector3(), radius = 0) { this.center = center; this.radius = radius; }
}

class Color {
  constructor() { this.r = 1; this.g = 1; this.b = 1; }
  setHex(hex) {
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
    this.updateRanges = [];
    this.uploads = 0;
  }
  clearUpdateRanges() { this.updateRanges.length = 0; }
  addUpdateRange(start, count) { this.updateRanges.push([start, count]); }
  set needsUpdate(v) { if (v) this.uploads++; }
}

class Float32BufferAttribute extends BufferAttribute {
  constructor(arr, itemSize) { super(arr instanceof Float32Array ? arr : new Float32Array(arr), itemSize); }
}
class Uint16BufferAttribute extends BufferAttribute {
  constructor(arr, itemSize) { super(arr instanceof Uint16Array ? arr : new Uint16Array(arr), itemSize); }
}
class Uint32BufferAttribute extends BufferAttribute {
  constructor(arr, itemSize) { super(arr instanceof Uint32Array ? arr : new Uint32Array(arr), itemSize); }
}
class InstancedBufferAttribute extends BufferAttribute {}

class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.index = null;
    this.boundingBox = null;
    this.boundingSphere = null;
    this.userData = {};
  }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  setIndex(idx) { this.index = idx; return this; }
  computeBoundingBox() {
    const pos = this.attributes.position.array;
    const box = new Box3();
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < box.min.x) box.min.x = x; if (x > box.max.x) box.max.x = x;
      if (y < box.min.y) box.min.y = y; if (y > box.max.y) box.max.y = y;
      if (z < box.min.z) box.min.z = z; if (z > box.max.z) box.max.z = z;
    }
    this.boundingBox = box;
  }
  computeBoundingSphere() {
    if (!this.boundingBox) this.computeBoundingBox();
    const c = this.boundingBox.getCenter(new Vector3());
    const { max } = this.boundingBox;
    this.boundingSphere = new Sphere(c, Math.hypot(max.x - c.x, max.y - c.y, max.z - c.z));
  }
}

class Object3D {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = new Matrix4();
    this.children = [];
    this.visible = true;
    this.matrixAutoUpdate = true;
    this.matrixWorldAutoUpdate = true;
    this.userData = {};
  }
  add(...kids) { this.children.push(...kids); return this; }
  traverse(fn) {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
  updateMatrix() {
    const c = Math.cos(this.rotation.y), s = Math.sin(this.rotation.y);
    const sx = this.scale.x, sy = this.scale.y, sz = this.scale.z;
    const e = this.matrix.elements;
    e[0] = c * sx; e[1] = 0; e[2] = -s * sx; e[3] = 0;
    e[4] = 0; e[5] = sy; e[6] = 0; e[7] = 0;
    e[8] = s * sz; e[9] = 0; e[10] = c * sz; e[11] = 0;
    e[12] = this.position.x; e[13] = this.position.y; e[14] = this.position.z; e[15] = 1;
  }
}

class Group extends Object3D {}

class InstancedMesh extends Object3D {
  constructor(geo, mat, count) {
    super();
    this.isInstancedMesh = true;
    this.geometry = geo;
    this.material = mat;
    this.count = count;
    this.instanceMatrix = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
    this.boundingSphere = new Sphere();
  }
  computeBoundingSphere() {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const arr = this.instanceMatrix.array;
    for (let i = 0; i < this.count; i++) {
      const x = arr[i * 16 + 12], y = arr[i * 16 + 13], z = arr[i * 16 + 14];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    this.boundingSphere = new Sphere(new Vector3(cx, cy, cz), Math.hypot(maxX - cx, maxY - cy, maxZ - cz) + 8);
  }
}

class DataTexture {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; this.mipmaps = []; }
}

const threeStub = {
  Vector3,
  Quaternion,
  Matrix4,
  Box3,
  Sphere,
  Color,
  BufferGeometry,
  Float32BufferAttribute,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  InstancedBufferAttribute,
  Object3D,
  Group,
  InstancedMesh,
  DataTexture,
  RGBAFormat: 1023,
  UnsignedByteType: 1009,
  LinearMipmapLinearFilter: 1008,
  LinearFilter: 1006,
  ClampToEdgeWrapping: 1001,
  NoColorSpace: ''
};

let sqrtCalls = 0;
const realSqrt = Math.sqrt;
const countedMath = Object.create(Math);
countedMath.sqrt = (x) => {
  sqrtCalls++;
  return realSqrt(x);
};

const { createTreeField } = loadModule(treesSource, {
  imports: {
    'three/webgpu': threeStub,
    './tsl-materials.js': { createTreeMaterial: () => ({ name: 'TreeMat' }) },
    './building-collision.js': buildingCollision
  },
  globals: {
    document: makeStubDocument(),
    Math: countedMath,
    Float32Array,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int32Array,
    Map,
    Set,
    Array,
    Object,
    Infinity,
    Number
  },
  filename: 'js/trees.js'
});

// Brute-force per-tree reference matching pre-#4 HEAD's exact Math.sqrt LOD + hysteresis rules.
function makeBruteForceOracle(sites) {
  const hashPos = (x, y, z) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const MAX_DIST = [3000, 1600, 950];
  const LOW_CUTOFF = 1150;
  const LOD_NEAR = 105;
  const LOD_MID = 420;
  const LOD_HYSTERESIS = 6;
  const N = sites.length;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pz = new Float32Array(N);
  const tier = new Uint8Array(N);
  const spArr = new Uint8Array(N);
  const varArr = new Uint8Array(N);
  const lod = new Uint8Array(N).fill(255);

  sites.forEach((t, i) => {
    const sp = Math.min(2, Math.max(0, t.species || 0));
    const r1 = hashPos(t.x, 1.3, t.z);
    const variant = hashPos(t.x, 5.9, t.z) < 0.5 ? 0 : 1;
    const s = t.scale * (0.9 + r1 * 0.2);
    px[i] = t.x;
    py[i] = (t.y || 0) + 6 * s;
    pz[i] = t.z;
    tier[i] = Math.min(2, t.tier || 0);
    spArr[i] = sp;
    varArr[i] = variant;
  });

  const last = new Vector3(Infinity, Infinity, Infinity);
  function update(pos) {
    const cam = new Vector3().copy(pos);
    if (cam.distanceToSquared(last) < 16) return false;
    last.copy(cam);
    const low = cam.y < 40;
    let changed = false;
    for (let i = 0; i < N; i++) {
      const dx = px[i] - cam.x, dy = py[i] - cam.y, dz = pz[i] - cam.z;
      const d = realSqrt(dx * dx + dy * dy + dz * dz);
      const maxD = low ? Math.min(MAX_DIST[tier[i]], LOW_CUTOFF) : MAX_DIST[tier[i]];
      const curL = lod[i] === 255 ? 3 : lod[i];
      let nextL = d < LOD_NEAR ? 0 : d < LOD_MID ? 1 : d < maxD ? 2 : 3;
      if (Math.abs(nextL - curL) === 1) {
        const edge = [LOD_NEAR, LOD_MID, maxD][Math.min(nextL, curL)];
        if (Math.abs(d - edge) < LOD_HYSTERESIS) nextL = curL;
      }
      const next = nextL === 3 ? 255 : nextL;
      if (next !== lod[i]) {
        lod[i] = next;
        changed = true;
      }
    }
    return changed;
  }

  function totalsByLod() {
    const out = [0, 0, 0];
    for (let i = 0; i < N; i++) if (lod[i] !== 255) out[lod[i]]++;
    return out;
  }

  update(new Vector3(0, 10, 140));
  return { update, totalsByLod };
}

test('createTreeField leaves scene.onBeforeRender untouched and matches per-tree oracle across trajectories', () => {
  const sites = [];
  for (let i = 0; i < 2400; i++) {
    const gx = (i % 15) - 7;
    const gz = Math.floor(i / 15) - 80;
    sites.push({
      x: gx * 165 + ((i * 37) % 29),
      y: (i % 7 === 0) ? 3.5 : 0.2,
      z: gz * 72 + ((i * 53) % 31),
      scale: 0.85 + (i % 5) * 0.08,
      species: i % 3,
      tier: i % 3
    });
  }

  const sentinelHook = () => {};
  const scene = { onBeforeRender: sentinelHook };
  const field = createTreeField(scene, sites, []);
  const oracle = makeBruteForceOracle(sites);

  assert.equal(scene.onBeforeRender, sentinelHook, 'must not monkey-patch scene.onBeforeRender');
  assert.equal(field.stats.trees, sites.length);

  for (const m of field.meshes) {
    assert.equal(m.matrixAutoUpdate, false);
    assert.equal(m.matrixWorldAutoUpdate, false);
  }

  const fieldTotalsByLod = () => {
    const out = [0, 0, 0];
    for (const m of field.meshes) {
      if (!m.visible) {
        assert.equal(m.count, 0);
        continue;
      }
      const match = /_lod([012])_/.exec(m.name);
      out[Number(match[1])] += m.count;
    }
    return out;
  };

  assert.deepEqual(fieldTotalsByLod(), oracle.totalsByLod(), 'initial Midtown warmup view matches oracle');

  // Exercise micro-steps (<4m), street walks across hysteresis bands, altitude climbs (y<40 <-> y>=40), and teleports
  const trajectory = [
    new Vector3(1, 10, 141), // <4m move: must skip
    new Vector3(0, 3.2, 130),
    new Vector3(0, 3.2, 100),
    new Vector3(0, 3.2, 94),
    new Vector3(0, 3.2, 104), // reverse inside hysteresis band
    new Vector3(0, 3.2, 112), // cross hysteresis band outward
    new Vector3(180, 3.2, -320),
    new Vector3(180, 38.0, -320), // just below y=40 low cutoff
    new Vector3(180, 44.0, -320), // cross y=40 to aloft MAX_DIST
    new Vector3(180, 210.0, -320),
    new Vector3(-750, 2.5, 4200), // teleport to Financial District
    new Vector3(-4000, 120.0, 14000), // far over Upper Bay: all cells hidden (uniformLod = 255)
    new Vector3(-4020, 120.0, 14020), // move while all cells hidden: 100% O(cells) fast-skip
    new Vector3(0, 12.0, -2400) // teleport back into Central Park
  ];
  for (let step = 0; step < 30; step++) {
    trajectory.push(new Vector3(Math.sin(step * 0.4) * 350, step % 9 === 0 ? 65 : 3.5, -2400 + step * 85));
  }

  for (const pos of trajectory) {
    const gotChanged = field.update(pos);
    const wantChanged = oracle.update(pos);
    assert.equal(gotChanged, wantChanged, `changed flag mismatch at (${pos.x}, ${pos.y}, ${pos.z})`);
    assert.deepEqual(fieldTotalsByLod(), oracle.totalsByLod(), `LOD counts mismatch at (${pos.x}, ${pos.y}, ${pos.z})`);
  }

  // Verify cell-hierarchical culling executes only O(cells) Math.sqrt calls instead of O(trees)
  const cellCount = field.group.children.length;
  sqrtCalls = 0;
  field.update(new Vector3(12, 3.5, 190));
  assert.equal(
    sqrtCalls,
    cellCount,
    `expected exactly 1 Math.sqrt per cell (${cellCount}, 0 per-tree Math.sqrt), got ${sqrtCalls}`
  );
});
