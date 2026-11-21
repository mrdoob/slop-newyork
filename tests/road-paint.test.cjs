const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// Minimal Three.js math/object stub sufficient for road-paint.js and scene-culling.js
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return this;
  }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  copy(m) { this.elements = m.elements.slice(); return this; }
  fromArray(a, o = 0) { this.elements = Array.from(a.slice(o, o + 16)); return this; }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        te[j * 4 + i] = ae[i] * be[j * 4] + ae[i + 4] * be[j * 4 + 1] + ae[i + 8] * be[j * 4 + 2] + ae[i + 12] * be[j * 4 + 3];
      }
    }
    return this;
  }
  getMaxScaleOnAxis() { return 1; }
}

class Sphere {
  constructor(center = new Vector3(), radius = 0) { this.center = center; this.radius = radius; }
  clone() { return new Sphere(new Vector3(this.center.x, this.center.y, this.center.z), this.radius); }
  applyMatrix4(m) {
    this.center.applyMatrix4(m);
    return this;
  }
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = ArrayBuffer.isView(array) ? array : new Float32Array(array);
    this.itemSize = itemSize;
    this.count = this.array.length / itemSize;
  }
  getX(i) { return this.array[i * this.itemSize]; }
}
class Float32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) { super(new Float32Array(array), itemSize); }
}
class Uint16BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) { super(new Uint16Array(array), itemSize); this.isUint16 = true; }
}
class Uint32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) { super(new Uint32Array(array), itemSize); this.isUint32 = true; }
}

class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.index = null;
    this.boundingSphere = null;
    this.groups = [];
    this.drawRange = { start: 0, count: Infinity };
  }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  setIndex(idx) {
    this.index = idx instanceof BufferAttribute ? idx : new Uint32BufferAttribute(idx, 1);
    return this;
  }
  computeBoundingSphere() {
    const pos = this.attributes.position.array;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
      minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
      minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    let r2 = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i] - cx, dy = pos[i + 1] - cy, dz = pos[i + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    this.boundingSphere = new Sphere(new Vector3(cx, cy, cz), Math.sqrt(r2));
  }
}

class Object3D {
  constructor() {
    this.name = '';
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.frustumCulled = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.renderOrder = 0;
    this.layers = { mask: 1, set(l) { this.mask = 1 << l; }, enable(l) { this.mask |= 1 << l; } };
    this.userData = {};
    this.position = new Vector3();
    this.quaternion = { x: 0, y: 0, z: 0, w: 1, copy() {} };
    this.scale = new Vector3(1, 1, 1);
    this.matrixAutoUpdate = true;
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
  }
  add(child) {
    child.parent = this;
    this.children.push(child);
    return this;
  }
  remove(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); child.parent = null; }
  }
  updateMatrixWorld() {
    this.matrixWorld.elements[12] = this.position.x;
    this.matrixWorld.elements[13] = this.position.y;
    this.matrixWorld.elements[14] = this.position.z;
    for (const c of this.children) c.updateMatrixWorld();
  }
  traverse(fn) {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
}

class Group extends Object3D {
  constructor() { super(); this.isGroup = true; }
}
class Scene extends Object3D {}
class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    this.isMesh = true;
    this.geometry = geometry;
    this.material = material;
  }
}

const THREE = {
  Color: class { constructor(hex) { this.r = ((hex >> 16) & 255) / 255; this.g = ((hex >> 8) & 255) / 255; this.b = (hex & 255) / 255; } },
  Vector3,
  Matrix4,
  BufferAttribute,
  Float32BufferAttribute,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  BufferGeometry,
  Object3D,
  Group,
  Scene,
  Mesh
};

const sharedMat = { name: 'RoadPaintMat', transparent: true };
const roadPaintSrc = readFileSync(join(__dirname, '../js/road-paint.js'), 'utf8');
const sceneCullingSrc = readFileSync(join(__dirname, '../js/scene-culling.js'), 'utf8');

const { buildRoadPaint, createRoadPaintChunkBuilder } = loadModule(roadPaintSrc, {
  filename: 'road-paint.js',
  imports: {
    'three/webgpu': THREE,
    './road-network.js': { CROSSWALK: 3.8 },
    './tsl-materials.js': { createRoadPaintMaterial: () => sharedMat }
  }
});

const { setupSceneCulling, updateSceneCulling } = loadModule(sceneCullingSrc, {
  filename: 'scene-culling.js',
  imports: { 'three/webgpu': THREE }
});

test('buildRoadPaint splits markings into spatial chunks that cull with distance, with padded bounds', () => {
  const makeEdge = (id0, id1, x0, z, len) => ({
    from: { id: id0, shape: false },
    to: { id: id1, shape: false },
    x0, z0: z, sx: x0, sz: z,
    dx: 1, dz: 0, rx: 0, rz: 1,
    len, span: len, half: 7.0,
    axis: 'ave',
    lanes: [-3.5, 0, 3.5]
  });

  const scene = new Scene();
  // Two streets 3.2 km apart in Z (wholly inside cellX = 0) -> must land in 2 separate 450 m spatial chunks
  const network = {
    edges: [
      makeEdge(1, 2, 100, -1600, 160),
      makeEdge(3, 4, 100, 1600, 160)
    ],
    isRoadClear: () => true
  };

  const group = buildRoadPaint(scene, network);
  assert.equal(group.children.length, 2, 'distant blocks split into separate spatial chunks');

  const [c0, c1] = group.children;
  assert.equal(c0.material, sharedMat);
  assert.equal(c1.material, sharedMat);
  assert.equal(c0.receiveShadow, true);
  assert.equal(c0.userData.cullDistance, 1650);
  assert.ok(c0.geometry.boundingSphere.radius > 80 + 16, 'boundingSphere includes screen-space widen padding');

  // Verify scene-culling hides distant road-paint chunks and keeps nearby ones visible
  setupSceneCulling(scene, [group], null);
  updateSceneCulling({ x: 180, y: 10, z: -1600 });
  assert.equal(c0.visible, true, 'nearby chunk stays visible');
  assert.equal(c1.visible, false, 'chunk 3.2 km away is distance-culled');

  updateSceneCulling({ x: 180, y: 10, z: 1600 });
  assert.equal(c0.visible, false);
  assert.equal(c1.visible, true);
});

test('createRoadPaintChunkBuilder subdivides long strips across cells with continuous dash phase and ramp height', () => {
  const builder = createRoadPaintChunkBuilder('ShoreHighwayMarkings', { cellSize: 450 });
  // 700 m sloped highway stripe from y=0.012 to y=7.012 with period=12, duty=0.25, phase=3.5
  builder.strip3D(0, 0.012, 0, 0, 7.012, 700, 0.15, { r: 1, g: 1, b: 1 }, 12, 0.25, 3.5, 1);
  const group = builder.build();
  assert.equal(group.children.length, 2, '700 m run spans two 450 m cells after 200 m subdivision');

  // Collect all 4-vertex quads in Z order and verify continuous u (paint.x) and y ramp
  const quads = [];
  for (const chunk of group.children) {
    const pos = chunk.geometry.attributes.position.array;
    const pnt = chunk.geometry.attributes.paint.array;
    for (let v = 0; v < pos.length / 3; v += 4) {
      quads.push({
        y0: pos[v * 3 + 1],
        z0: pos[v * 3 + 2],
        y1: pos[(v + 2) * 3 + 1],
        z1: pos[(v + 2) * 3 + 2],
        u0: pnt[v * 3],
        u1: pnt[(v + 2) * 3]
      });
    }
  }
  quads.sort((a, b) => a.z0 - b.z0);
  assert.equal(quads.length, 4, 'ceil(700 / 200) = 4 sub-quads');
  assert.ok(Math.abs(quads[0].u0 - 3.5) < 1e-5);
  assert.ok(Math.abs(quads[3].u1 - 703.5) < 1e-4);
  assert.ok(Math.abs(quads[3].y1 - 7.012) < 1e-4);
  for (let i = 1; i < quads.length; i++) {
    assert.ok(Math.abs(quads[i].z0 - quads[i - 1].z1) < 1e-4, 'seamless Z join');
    assert.ok(Math.abs(quads[i].y0 - quads[i - 1].y1) < 1e-4, 'seamless Y ramp');
    assert.ok(Math.abs(quads[i].u0 - quads[i - 1].u1) < 1e-4, 'continuous dash phase');
  }
});

test('road paint stays plain white when dry and far, and fades out before its chunk is culled', () => {
  const env = {
    posWorld: [0, 0.012, 0],
    camPos: [0, 4, 20]
  };

  const arr = (v) => (v instanceof TNode ? v.eval() : typeof v === 'number' ? [v] : v);
  const broadcast = (a, b, fn) => {
    const va = arr(a), vb = arr(b), n = Math.max(va.length, vb.length);
    return Array.from({ length: n }, (_, i) => fn(va[i % va.length], vb[i % vb.length]));
  };
  const smoothstepScalar = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  class TNode {
    constructor(fn) {
      this._fn = typeof fn === 'function' ? fn : () => fn;
      // (methods it doesn't evaluate give nodes that are never evaluated)
      return new Proxy(this, { get: (target, key) => (key in target ? target[key] : inert) });
    }
    eval() { return this._fn(); }
    get x() { return new TNode(() => [this.eval()[0]]); }
    get y() { return new TNode(() => [this.eval()[1]]); }
    get z() { return new TNode(() => [this.eval()[2]]); }
    get w() { return new TNode(() => [this.eval()[3]]); }
    get xy() { return new TNode(() => this.eval().slice(0, 2)); }
    get xz() { return new TNode(() => { const v = this.eval(); return [v[0], v[2]]; }); }
    add(b) { return new TNode(() => broadcast(this, b, (x, y) => x + y)); }
    sub(b) { return new TNode(() => broadcast(this, b, (x, y) => x - y)); }
    mul(b) { return new TNode(() => broadcast(this, b, (x, y) => x * y)); }
    div(b) { return new TNode(() => broadcast(this, b, (x, y) => x / y)); }
    max(b) { return new TNode(() => broadcast(this, b, Math.max)); }
    greaterThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x > y ? 1 : 0))); }
    toVar() {
      let slot = this.eval().slice();
      const v = new TNode(() => slot);
      v.assign = (rhs) => { slot = arr(rhs).slice(); };
      return v;
    }
  }
  const wrap = (v) => (v instanceof TNode ? v : new TNode(Array.isArray(v) ? v : [v]));
  const unary = (fn) => (a) => new TNode(() => arr(a).map(fn));

  // The shader nodes the road paint uses evaluate numerically; everything else the module builds is never evaluated
  const inert = new Proxy(function () {}, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : inert), apply: () => inert, construct: () => inert
  });
  const orInert = (stub) => new Proxy(stub, { get: (target, key) => (key in target ? target[key] : inert) });
  const tsl = {
    uniform: (value) => {
      const node = new TNode(() => [typeof node.value === 'number' ? node.value : 0]);
      node.value = value;
      return node;
    },
    positionGeometry: wrap([0, 0.012, 0]),
    positionWorld: new TNode(() => env.posWorld),
    cameraPosition: new TNode(() => env.camPos),
    cameraProjectionMatrix: { mul: (v) => v },
    cameraViewMatrix: { mul: (v) => v },
    screenSize: wrap([1920, 1080]),
    attribute: (name) => (name === 'paint' ? wrap([3.0, 12.0, 1.0]) : wrap([0.065, 0.0])),
    varying: (v) => v,
    Fn: (builder) => (...args) => new TNode(() => arr(args.length ? builder(args) : builder())),
    If: (cond, body) => { if (arr(cond)[0] > 0) body(); return { ElseIf() { return this; }, Else() { return this; } }; },
    float: wrap,
    vec2: (...args) => new TNode(() => args.flatMap(arr).slice(0, 2)),
    vec3: (...args) => new TNode(() => { const f = args.flatMap(arr); return f.length === 1 ? [f[0], f[0], f[0]] : f.slice(0, 3); }),
    vec4: (...args) => new TNode(() => args.flatMap(arr).slice(0, 4)),
    sin: unary(Math.sin),
    floor: unary(Math.floor),
    fract: unary((x) => x - Math.floor(x)),
    min: (a, b) => new TNode(() => broadcast(a, b, Math.min)),
    max: (a, b) => new TNode(() => broadcast(a, b, Math.max)),
    clamp: (v, lo, hi) => new TNode(() => broadcast(broadcast(v, lo, Math.max), hi, Math.min)),
    mix: (a, b, t) => new TNode(() => {
      const va = arr(a), vb = arr(b), vt = arr(t), n = Math.max(va.length, vb.length);
      return Array.from({ length: n }, (_, i) => va[i % va.length] * (1 - vt[i % vt.length]) + vb[i % vb.length] * vt[i % vt.length]);
    }),
    step: (e, x) => new TNode(() => broadcast(e, x, (a, b) => (b < a ? 0 : 1))),
    smoothstep: (e0, e1, x) => new TNode(() => {
      const v0 = arr(e0), v1 = arr(e1), vx = arr(x), n = Math.max(v0.length, v1.length, vx.length);
      return Array.from({ length: n }, (_, i) => smoothstepScalar(v0[i % v0.length], v1[i % v1.length], vx[i % vx.length]));
    }),
    dot: (a, b) => new TNode(() => { const va = arr(a), vb = arr(b); return [va.reduce((s, x, i) => s + x * vb[i], 0)]; }),
    length: (v) => new TNode(() => [Math.hypot(...arr(v))]),
    fwidth: () => wrap([0.01])
  };

  const { createRoadPaintMaterial, cityUniforms } = loadModule(readFileSync(join(__dirname, '../js/tsl-materials.js'), 'utf8'), {
    imports: {
      'three/webgpu': orInert({ MeshStandardNodeMaterial: class { constructor(o) { Object.assign(this, o); } } }),
      'three/tsl': orInert(tsl),
      './city-config.js': orInert({})
    }
  });
  const m1 = createRoadPaintMaterial();

  // Dry midday at 120 m
  cityUniforms.uRoadWetness.value = 0.08;
  env.camPos = [0, 8, 120];
  const opMid = m1.opacityNode.eval()[0];
  const colDry = m1.colorNode.eval();
  assert.ok(opMid > 0, 'visible at 120 m');
  assert.deepEqual(colDry, [1, 1, 1]);

  // Smoothly fades to 0 by the 1,650 m chunk cull distance
  env.camPos = [0, 40, 1660];
  assert.equal(m1.opacityNode.eval()[0], 0, 'fades cleanly to zero before chunk cull distance');
});
