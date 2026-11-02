const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const fireEscapesSource = readFileSync(join(__dirname, '../js/fire-escapes.js'), 'utf8');

// Numeric TSL + 2x2 pixel-quad harness so hardware derivatives (dFdx, dFdy, fwidth) and WGSL
// derivative uniformity rules are tested directly on the production TSL node graph.
const shaderState = {
  quad: null, // Array of 4 vertex/fragment sample contexts: [p00, p10, p01, p11]
  stage: 'fragment',
  branchDepth: 0,
  derivativesInBranch: 0,
  totalDerivatives: 0,
  pulseAndBarCalls: 0,
  varyingCache: null
};

const toQuad = (v) => {
  if (v instanceof QuadNode) return v.eval();
  if (typeof v === 'number') return [[v], [v], [v], [v]];
  if (Array.isArray(v) && typeof v[0] === 'number') return [v.slice(), v.slice(), v.slice(), v.slice()];
  return v;
};

const mapQuad = (a, fn) => toQuad(a).map((lane, q) => lane.map((x, c) => fn(x, q, c)));
const zipQuad = (a, b, fn) => {
  const qa = toQuad(a), qb = toQuad(b);
  return [0, 1, 2, 3].map((q) => {
    const la = qa[q], lb = qb[q];
    const n = Math.max(la.length, lb.length);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = fn(la[i % la.length], lb[i % lb.length]);
    return out;
  });
};

class QuadNode {
  constructor(fn) {
    this._fn = typeof fn === 'function' ? fn : () => fn;
  }
  eval() { return this._fn(); }
  get x() { return new QuadNode(() => toQuad(this).map((v) => [v[0]])); }
  get y() { return new QuadNode(() => toQuad(this).map((v) => [v[1]])); }
  get z() { return new QuadNode(() => toQuad(this).map((v) => [v[2]])); }
  get w() { return new QuadNode(() => toQuad(this).map((v) => [v[3]])); }
  get xz() { return new QuadNode(() => toQuad(this).map((v) => [v[0], v[2]])); }
  add(b) { return new QuadNode(() => zipQuad(this, b, (x, y) => x + y)); }
  sub(b) { return new QuadNode(() => zipQuad(this, b, (x, y) => x - y)); }
  mul(b) { return new QuadNode(() => zipQuad(this, b, (x, y) => x * y)); }
  div(b) { return new QuadNode(() => zipQuad(this, b, (x, y) => x / y)); }
  greaterThan(b) { return new QuadNode(() => zipQuad(this, b, (x, y) => (x > y ? 1 : 0))); }
  lessThan(b) { return new QuadNode(() => zipQuad(this, b, (x, y) => (x < y ? 1 : 0))); }
  dFdx() {
    return new QuadNode(() => {
      shaderState.totalDerivatives++;
      if (shaderState.branchDepth > 0) shaderState.derivativesInBranch++;
      const q = toQuad(this);
      const d0 = q[0].map((_, c) => q[1][c] - q[0][c]);
      const d1 = q[2].map((_, c) => q[3][c] - q[2][c]);
      return [d0, d0.slice(), d1, d1.slice()];
    });
  }
  dFdy() {
    return new QuadNode(() => {
      shaderState.totalDerivatives++;
      if (shaderState.branchDepth > 0) shaderState.derivativesInBranch++;
      const q = toQuad(this);
      const d0 = q[0].map((_, c) => q[2][c] - q[0][c]);
      const d1 = q[1].map((_, c) => q[3][c] - q[1][c]);
      return [d0, d1, d0.slice(), d1.slice()];
    });
  }
  toVar() {
    let slot = shaderState.quad ? toQuad(this).map((v) => v.slice()) : null;
    const variable = new QuadNode(() => (slot ? slot.map((v) => v.slice()) : toQuad(this)));
    variable.assign = (rhs) => { slot = toQuad(rhs).map((v) => v.slice()); };
    return variable;
  }
}

const wrap = (v) => (v instanceof QuadNode ? v : new QuadNode(toQuad(v)));

const tslStub = {
  Fn: (builder) => (...args) => new QuadNode(() => {
    if (args.length > 0) shaderState.pulseAndBarCalls++;
    return toQuad(builder(args.map(wrap)));
  }),
  If: (cond, body) => {
    let matched = toQuad(cond)[0][0] > 0;
    if (matched) {
      shaderState.branchDepth++;
      try { body(); } finally { shaderState.branchDepth--; }
    }
    const chain = {
      ElseIf(c, b) {
        if (!matched && toQuad(c)[0][0] > 0) {
          matched = true;
          shaderState.branchDepth++;
          try { b(); } finally { shaderState.branchDepth--; }
        }
        return chain;
      },
      Else(b) {
        if (!matched) {
          matched = true;
          shaderState.branchDepth++;
          try { b(); } finally { shaderState.branchDepth--; }
        }
        return chain;
      }
    };
    return chain;
  },
  float: (v) => wrap(v),
  vec3: (...args) => new QuadNode(() => {
    const qs = args.map(toQuad);
    return [0, 1, 2, 3].map((q) => {
      const flat = qs.flatMap((x) => x[q]);
      return flat.length === 1 ? [flat[0], flat[0], flat[0]] : flat.slice(0, 3);
    });
  }),
  vec4: (...args) => new QuadNode(() => {
    const qs = args.map(toQuad);
    return [0, 1, 2, 3].map((q) => {
      const flat = qs.flatMap((x) => x[q]);
      return flat.length === 1 ? [flat[0], flat[0], flat[0], flat[0]] : flat.slice(0, 4);
    });
  }),
  attribute: (name) => new QuadNode(() => shaderState.quad.map((s) => s.attrs[name])),
  positionGeometry: new QuadNode(() => shaderState.quad.map((s) => s.positionGeometry)),
  positionLocal: new QuadNode(() => shaderState.quad.map((s) => s.positionGeometry)),
  normalGeometry: new QuadNode(() => shaderState.quad.map((s) => s.normalGeometry)),
  varying: (node, name) => {
    const key = name || Symbol('varying');
    return new QuadNode(() => {
      if (shaderState.varyingCache && shaderState.varyingCache.has(key)) {
        return shaderState.varyingCache.get(key);
      }
      const prev = shaderState.stage;
      shaderState.stage = 'vertex';
      const val = toQuad(node).map((v) => v.slice());
      shaderState.stage = prev;
      if (shaderState.varyingCache) shaderState.varyingCache.set(key, val);
      return val;
    });
  },
  vertexStage: (node) => new QuadNode(() => {
    const prev = shaderState.stage;
    shaderState.stage = 'vertex';
    const val = toQuad(node).map((v) => v.slice());
    shaderState.stage = prev;
    return val;
  }),
  abs: (a) => new QuadNode(() => mapQuad(a, Math.abs)),
  floor: (a) => new QuadNode(() => mapQuad(a, Math.floor)),
  fract: (a) => new QuadNode(() => mapQuad(a, (x) => x - Math.floor(x))),
  mod: (a, b) => new QuadNode(() => zipQuad(a, b, (x, y) => x - y * Math.floor(x / y))),
  round: (a) => new QuadNode(() => mapQuad(a, Math.round)),
  step: (edge, x) => new QuadNode(() => zipQuad(edge, x, (e, v) => (v < e ? 0 : 1))),
  fwidth: (a) => new QuadNode(() => {
    const n = wrap(a);
    return tslStub.abs(n.dFdx()).add(tslStub.abs(n.dFdy())).eval();
  }),
  max: (...args) => args.map(wrap).reduce((acc, cur) => new QuadNode(() => zipQuad(acc, cur, Math.max))),
  min: (...args) => args.map(wrap).reduce((acc, cur) => new QuadNode(() => zipQuad(acc, cur, Math.min))),
  mix: (a, b, t) => new QuadNode(() => {
    const qa = toQuad(a), qb = toQuad(b), qt = toQuad(t);
    return [0, 1, 2, 3].map((q) => {
      const la = qa[q], lb = qb[q], lt = qt[q];
      const n = Math.max(la.length, lb.length, lt.length);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        const u = la[i % la.length], v = lb[i % lb.length], k = lt[i % lt.length];
        out[i] = u + (v - u) * k;
      }
      return out;
    });
  }),
  clamp: (x, lo, hi) => new QuadNode(() => {
    const qx = toQuad(x), qlo = toQuad(lo), qhi = toQuad(hi);
    return [0, 1, 2, 3].map((q) => qx[q].map((v, i) => Math.min(qhi[q][i % qhi[q].length], Math.max(qlo[q][i % qlo[q].length], v))));
  })
};

const filteredPulseStub = tslStub.Fn(([x, a, b, w]) => {
  const p = tslStub.float(x).toVar();
  const lo = tslStub.float(a).toVar();
  const hi = tslStub.float(b).toVar();
  const hw = tslStub.max(tslStub.float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => tslStub.floor(t).mul(hi.sub(lo)).add(tslStub.clamp(tslStub.fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});

// Minimal geometry/math stubs sufficient to run escapeGeometry() and createFireEscapes() without WebGPU.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}

class Box3 {
  constructor(min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity)) {
    this.min = min;
    this.max = max;
  }
}

class Sphere {
  constructor(center = new Vector3(), radius = -1) {
    this.center = center;
    this.radius = radius;
  }
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array instanceof Float32Array || array instanceof Uint16Array || array instanceof Uint32Array
      ? array
      : new Float32Array(array);
    this.itemSize = itemSize;
    this.count = this.array.length / itemSize;
    this.usage = 0;
    this.updateRanges = [];
    this.needsUpdateCount = 0;
  }
  setUsage(u) { this.usage = u; return this; }
  clearUpdateRanges() { this.updateRanges.length = 0; }
  addUpdateRange(start, count) { this.updateRanges.push([start, count]); }
  set needsUpdate(v) { if (v) this.needsUpdateCount++; }
  setXY(i, x, y) {
    this.array[i * this.itemSize] = x;
    this.array[i * this.itemSize + 1] = y;
    return this;
  }
}

class Float32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) {
    super(array instanceof Float32Array ? array : new Float32Array(array), itemSize);
  }
}

class InstancedBufferAttribute extends BufferAttribute {}

class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.index = null;
    this.boundingBox = null;
    this.boundingSphere = null;
  }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  getAttribute(name) { return this.attributes[name]; }
  setIndex(idx) {
    this.index = idx instanceof BufferAttribute ? idx : new BufferAttribute(new Uint16Array(idx), 1);
    return this;
  }
  translate(dx, dy, dz) {
    const pos = this.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] += dx;
      pos[i + 1] += dy;
      pos[i + 2] += dz;
    }
    return this;
  }
  rotateY(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    for (const key of ['position', 'normal']) {
      const attr = this.attributes[key];
      if (!attr) continue;
      const a = attr.array;
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i], z = a[i + 2];
        a[i] = x * c + z * s;
        a[i + 2] = -x * s + z * c;
      }
    }
    return this;
  }
  computeVertexNormals() {
    const pos = this.attributes.position.array;
    const normals = new Float32Array(pos.length);
    const idx = this.index ? this.index.array : null;
    const triCount = idx ? idx.length / 3 : pos.length / 9;
    for (let t = 0; t < triCount; t++) {
      const i0 = (idx ? idx[t * 3] : t * 3) * 3;
      const i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3;
      const i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3;
      const e1x = pos[i1] - pos[i0], e1y = pos[i1 + 1] - pos[i0 + 1], e1z = pos[i1 + 2] - pos[i0 + 2];
      const e2x = pos[i2] - pos[i0], e2y = pos[i2 + 1] - pos[i0 + 1], e2z = pos[i2 + 2] - pos[i0 + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      for (const base of [i0, i1, i2]) {
        normals[base] += nx;
        normals[base + 1] += ny;
        normals[base + 2] += nz;
      }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
    this.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  }
  computeBoundingBox() {
    const pos = this.attributes.position.array;
    const box = new Box3();
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < box.min.x) box.min.x = pos[i];
      if (pos[i + 1] < box.min.y) box.min.y = pos[i + 1];
      if (pos[i + 2] < box.min.z) box.min.z = pos[i + 2];
      if (pos[i] > box.max.x) box.max.x = pos[i];
      if (pos[i + 1] > box.max.y) box.max.y = pos[i + 1];
      if (pos[i + 2] > box.max.z) box.max.z = pos[i + 2];
    }
    this.boundingBox = box;
  }
  computeBoundingSphere() {
    if (!this.boundingBox) this.computeBoundingBox();
    const { min, max } = this.boundingBox;
    const cx = 0.5 * (min.x + max.x), cy = 0.5 * (min.y + max.y), cz = 0.5 * (min.z + max.z);
    const r = Math.hypot(max.x - cx, max.y - cy, max.z - cz);
    this.boundingSphere = new Sphere(new Vector3(cx, cy, cz), r);
  }
}

class PlaneGeometry extends BufferGeometry {
  constructor(width = 1, height = 1) {
    super();
    const hw = width * 0.5, hh = height * 0.5;
    this.setAttribute('position', new Float32BufferAttribute([
      -hw, hh, 0, hw, hh, 0, -hw, -hh, 0, hw, -hh, 0
    ], 3));
    this.setAttribute('normal', new Float32BufferAttribute([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1
    ], 3));
    this.setAttribute('uv', new Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
    this.setIndex([0, 2, 1, 2, 3, 1]);
  }
}

function mergeGeometries(geos) {
  const merged = new BufferGeometry();
  const attrNames = Object.keys(geos[0].attributes);
  for (const name of attrNames) {
    const itemSize = geos[0].attributes[name].itemSize;
    const total = geos.reduce((s, g) => s + g.attributes[name].array.length, 0);
    const arr = new Float32Array(total);
    let offset = 0;
    for (const g of geos) {
      arr.set(g.attributes[name].array, offset);
      offset += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new Float32BufferAttribute(arr, itemSize));
  }
  const indices = [];
  let vertexOffset = 0;
  for (const g of geos) {
    for (const idx of g.index.array) indices.push(idx + vertexOffset);
    vertexOffset += g.attributes.position.count;
  }
  merged.setIndex(indices);
  return merged;
}

class Object3D {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Vector3();
    this.matrix = new Float32Array(16);
    this.children = [];
    this.userData = {};
    this.visible = true;
    this.matrixAutoUpdate = true;
    this.matrixWorldAutoUpdate = true;
  }
  add(child) { this.children.push(child); return this; }
  updateMatrix() {
    const ry = this.rotation.y;
    const c = Math.cos(ry), s = Math.sin(ry);
    this.matrix.set([
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      this.position.x, this.position.y, this.position.z, 1
    ]);
  }
}

class MeshStandardNodeMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
}

class InstancedMesh extends Object3D {
  constructor(geometry, material, count) {
    super();
    this.isInstancedMesh = true;
    this.geometry = geometry;
    this.material = material;
    this.maxCount = count;
    this.count = count;
    this.instanceMatrix = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
  }
  setMatrixAt(index, matrix) {
    this.instanceMatrix.array.set(matrix, index * 16);
  }
}

const threeStub = {
  BufferGeometry,
  PlaneGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  MeshStandardNodeMaterial,
  InstancedMesh,
  Object3D,
  Sphere,
  DoubleSide: 2,
  DynamicDrawUsage: 35048
};

const {
  escapeGeometry,
  createFireEscapeMaterial,
  createFireEscapes
} = loadModule(fireEscapesSource, {
  imports: {
    'three/webgpu': threeStub,
    'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries },
    'three/tsl': tslStub,
    './tsl-materials.js': { filteredPulse: filteredPulseStub }
  },
  filename: 'js/fire-escapes.js'
});

function evalSample(node, baseSample, dxSample = {}, dySample = {}) {
  const make = (over) => ({
    positionGeometry: over.positionGeometry || baseSample.positionGeometry,
    normalGeometry: over.normalGeometry || baseSample.normalGeometry,
    attrs: { ...baseSample.attrs, ...(over.attrs || {}) }
  });
  const p00 = make({});
  const p10 = make(dxSample);
  const p01 = make(dySample);
  const p11 = make({
    positionGeometry: p00.positionGeometry.map((v, i) => v + (p10.positionGeometry[i] - v) + (p01.positionGeometry[i] - v)),
    normalGeometry: p00.normalGeometry,
    attrs: p00.attrs
  });
  shaderState.quad = [p00, p10, p01, p11];
  shaderState.stage = 'fragment';
  shaderState.branchDepth = 0;
  shaderState.derivativesInBranch = 0;
  shaderState.totalDerivatives = 0;
  shaderState.pulseAndBarCalls = 0;
  shaderState.varyingCache = new Map();
  try {
    return node.eval()[0];
  } finally {
    shaderState.quad = null;
  }
}

// Reference scalar implementation of HEAD's opacityNode for parts 1, 3, 4, 5 to verify exact equivalence.
function headReferenceOpacity(pos00, pos10, pos01, normalZ, part, sizeX, sizeY) {
  const STOREY = 3.5;
  const fractS = (x) => x - Math.floor(x);
  const filteredBarScalar = (distance, halfWidth, footprint) => {
    const w = Math.max(footprint, 0.0001);
    return Math.min(Math.min(1, (halfWidth * 2) / w), Math.max(0, (halfWidth + w * 0.5 - Math.abs(distance)) / w));
  };
  const pulseScalar = (x, a, b, w) => {
    const hw = Math.max(w, 0.0001) * 0.5;
    const integral = (t) => Math.floor(t) * (b - a) + Math.min(b, Math.max(a, fractS(t))) - a;
    return (integral(x + hw) - integral(x - hw)) / (hw * 2);
  };
  const repeatingBarScalar = (coord, halfWidth, footprint) =>
    pulseScalar(fractS(coord + 0.5), 0.5 - halfWidth, 0.5 + halfWidth, footprint);
  const unionS = (a, b) => a + b - a * b;

  const scale = sizeX / STOREY;
  const fullHeight = sizeY - 1 + scale * 3.2;
  const across00 = pos00[0] + 1.7;
  const acrossDx = (pos10[0] - pos00[0]);
  const acrossDy = (pos01[0] - pos00[0]);
  const fwAcross = Math.abs(acrossDx) + Math.abs(acrossDy);

  const height00 = pos00[1] * fullHeight - scale * 2.2;
  const heightDx = (pos10[1] - pos00[1]) * fullHeight;
  const heightDy = (pos01[1] - pos00[1]) * fullHeight;
  const py = Math.abs(heightDx) + Math.abs(heightDy);

  const zDx = pos10[2] - pos00[2];
  const zDy = pos01[2] - pos00[2];
  const fwZ = Math.abs(zDx) + Math.abs(zDy);

  const level = height00 / sizeX;
  const levelWidth = py / sizeX;

  if (part === 1) {
    const front = Math.abs(normalZ);
    const along = (pos00[2] + 0.55) * (1 - front) + across00 * front;
    const scaleBay = (6 / 1.1) * (1 - front) + (20 / 3.4) * front;
    const bay = along * scaleBay;
    const fwBay = (fwZ * (1 - front) + fwAcross * front) * scaleBay;
    const pickets = repeatingBarScalar(bay, 0.08, fwBay);
    const guardHeight = pulseScalar(fractS(level), 0, 1 / STOREY, levelWidth);
    const rails = repeatingBarScalar(level - 0.97 / STOREY, 0.03 / STOREY, levelWidth)
      + repeatingBarScalar(level - 0.48 / STOREY, 0.018 / STOREY, levelWidth);
    const guards = unionS(pickets * guardHeight, rails);
    const deck = repeatingBarScalar(level - 0.04 / sizeX, 0.05 / sizeX, levelWidth);
    return unionS(deck, guards) * (height00 < 0 ? 0 : 1);
  }
  if (part === 3) {
    const flight = (index) => {
      const parity = index - 2 * Math.floor(index / 2);
      const x = (across00 * (1 - parity) + (3.4 - across00) * parity) - 0.5;
      const y = height00 - index * sizeX;
      const railY = (y - x * (sizeX / 2.4)) / scale;
      const slope = (1 - 2 * parity) * (sizeX / 2.4);
      const footprint = (Math.abs(heightDx - acrossDx * slope) + Math.abs(heightDy - acrossDy * slope)) / scale;
      const bay = x * (14 / 2.4);
      const pickets = repeatingBarScalar(bay, 0.08, fwAcross * (14 / 2.4)) * filteredBarScalar(railY - 0.5, 0.5, footprint);
      const rails = filteredBarScalar(railY + 0.025, 0.055, footprint)
        + filteredBarScalar(railY - 0.97, 0.03, footprint)
        + filteredBarScalar(railY - 0.48, 0.018, footprint);
      const visible = (index < 0 ? 0 : 1) * (index + 1 > Math.floor(sizeY / sizeX) ? 0 : 1);
      return unionS(pickets, rails) * visible;
    };
    const f0 = Math.floor(level);
    return unionS(flight(f0), flight(f0 - 1));
  }
  if (part === 4) {
    const ladderX = (across00 - 0.08) / 0.34;
    const ladderY = (height00 / scale + 2.2) / 2.15;
    const fwLadderY = (py / scale) / 2.15;
    const ladderRails = filteredBarScalar(Math.min(ladderX, 1 - ladderX), 0.065, fwAcross / 0.34);
    const rungs = repeatingBarScalar(ladderY * 8, 0.07, fwLadderY * 8);
    return unionS(ladderRails, rungs) * filteredBarScalar(ladderY - 0.5, 0.5, fwLadderY);
  }
  if (part === 5) {
    const dx = pos00[0], dy = pos00[2];
    const grating = unionS(
      repeatingBarScalar(dx * 10, 0.08, fwAcross * 10),
      repeatingBarScalar(dy * 10, 0.08, fwZ * 10)
    );
    const edge = Math.min(
      Math.abs(Math.abs(dx) - 1.7),
      Math.abs(Math.abs(dx) - 1.2),
      Math.abs(Math.abs(dy) - 0.55),
      Math.abs(dy + 0.18)
    );
    const frame = filteredBarScalar(edge, 0.025, Math.max(fwAcross, fwZ));
    const opening = (Math.abs(dx) > 1.2 ? 0 : 1) * (dy < -0.18 ? 0 : 1);
    return unionS(grating, frame) * (1 - opening * (edge < 0.025 ? 0 : 1));
  }
  throw new Error(`Unexpected reference part: ${part}`);
}

test('escapeGeometry preserves flat horizontal stair treads and per-triangle part invariants', () => {
  const geo = escapeGeometry();
  const idx = geo.index.array;
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const parts = geo.attributes.escapePart.array;
  const levels = geo.attributes.escapeLevel.array;

  assert.equal(idx.length / 3, 218, 'expected 218 triangles per fire escape with 96 flat horizontal treads');
  assert.equal(pos.count, 436, 'expected 436 vertices per fire escape');

  // Every triangle must have constant escapePart & escapeLevel so vEscapeMeta.x never interpolates across parts,
  // and every stair tread (part 6) must be strictly horizontal (constant y across all 3 vertices).
  const partTriCounts = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    assert.equal(parts[i0], parts[i1]);
    assert.equal(parts[i0], parts[i2]);
    assert.equal(levels[i0], levels[i1]);
    assert.equal(levels[i0], levels[i2]);
    if (parts[i0] === 6 || parts[i0] === 5) {
      const y0 = pos.array[i0 * 3 + 1], y1 = pos.array[i1 * 3 + 1], y2 = pos.array[i2 * 3 + 1];
      assert.equal(y0, y1, 'tread/landing triangle must be strictly flat (horizontal)');
      assert.equal(y0, y2, 'tread/landing triangle must be strictly flat (horizontal)');
    }
    partTriCounts.set(parts[i0], (partTriCounts.get(parts[i0]) || 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(partTriCounts), {
    1: 6,   // front + 2 side balcony guards
    3: 4,   // inner + outer diagonal flight guards
    4: 2,   // drop ladder
    5: 14,  // 7 landing decks
    6: 192  // 6 flights x 16 flat horizontal stair treads
  });

  // Every vertex normal must be unit length, and both landing decks (5) and stair treads (6) must point straight up (+Y)
  for (let v = 0; v < norm.count; v++) {
    const nx = norm.array[v * 3], ny = norm.array[v * 3 + 1], nz = norm.array[v * 3 + 2];
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, 'unit normal');
    if (parts[v] === 5 || parts[v] === 6) {
      assert.ok(Math.abs(ny - 1) < 1e-6, 'landing decks and flat stair treads face straight up (+Y)');
    }
  }
});

test('positionNode keeps horizontal stair treads flat and collapses unused upper storeys', () => {
  const material = createFireEscapeMaterial();
  const storey = 3.85;
  const landings = 4;
  const h = (landings - 1) * storey + 1; // 4 landings (levels 0..3), 3 stair flights (levels 0..2)
  const scale = storey / 3.5;

  for (let level = 0; level < 7; level++) {
    const deckPos = evalSample(material.positionNode, {
      positionGeometry: [-1.7, level * 3.5, 0],
      normalGeometry: [0, 1, 0],
      attrs: { escapePart: [5], escapeLevel: [level], escapeSize: [storey, h] }
    });
    if (level < landings) {
      const expectedY = (level * 3.5 + 2.2) * scale;
      assert.ok(Math.abs(deckPos[1] - expectedY) < 1e-6);
    } else {
      assert.equal(Math.hypot(...deckPos), 0, 'unused landing collapses to origin');
    }

    if (level < 6) {
      const stepY = level * 3.5 + (3.5 * 8) / 16;
      const leftEdge = evalSample(material.positionNode, {
        positionGeometry: [-0.15, stepY, -0.15],
        normalGeometry: [0, 1, 0],
        attrs: { escapePart: [6], escapeLevel: [level], escapeSize: [storey, h] }
      });
      const rightEdge = evalSample(material.positionNode, {
        positionGeometry: [0.0, stepY, 0.5],
        normalGeometry: [0, 1, 0],
        attrs: { escapePart: [6], escapeLevel: [level], escapeSize: [storey, h] }
      });
      if (level < landings - 1) {
        const expectedStepY = (stepY + 2.2) * scale;
        assert.ok(Math.abs(leftEdge[1] - expectedStepY) < 1e-6);
        assert.ok(Math.abs(rightEdge[1] - expectedStepY) < 1e-6, 'both sides of a tread stay at identical horizontal y');
      } else {
        assert.equal(Math.hypot(...leftEdge), 0, 'unused stair tread collapses to origin');
        assert.equal(Math.hypot(...rightEdge), 0);
      }
    }
  }
});

test('opacityNode obeys WGSL derivative uniformity, gates per-part ALU, and matches HEAD on parts 1, 3, 4, 5', () => {
  const material = createFireEscapeMaterial();
  const samples = [
    // Front balcony guard (part 1, normalZ = 1)
    { part: 1, normal: [0, 0, 1], pos: [-0.42, 0.37, 0.55], dx: [0.006, 0, 0], dy: [0, 0.0025, 0], size: [3.6, 15.4] },
    { part: 1, normal: [0, 0, 1], pos: [0.85, 0.64, 0.55], dx: [0.018, 0, 0], dy: [0, 0.005, 0], size: [3.3, 10.9] },
    // Side balcony guard (part 1, normalZ = 0)
    { part: 1, normal: [1, 0, 0], pos: [1.7, 0.48, -0.12], dx: [0, 0, 0.007], dy: [0, 0.003, 0], size: [3.5, 18.5] },
    // Diagonal flight guards (part 3, even & odd storeys)
    { part: 3, normal: [0, 0, 1], pos: [-0.25, 0.28, 0.52], dx: [0.008, 0.001, 0], dy: [0.001, 0.004, 0], size: [3.5, 18.5] },
    { part: 3, normal: [0, 0, 1], pos: [0.55, 0.54, -0.17], dx: [0.011, -0.001, 0], dy: [0, 0.0035, 0], size: [3.75, 19.75] },
    // Raised drop ladder (part 4)
    { part: 4, normal: [0, 0, 1], pos: [-1.45, 0.05, 0.56], dx: [0.004, 0, 0], dy: [0, 0.002, 0], size: [3.5, 15.0] },
    { part: 4, normal: [0, 0, 1], pos: [-1.61, 0.03, 0.56], dx: [0.005, 0, 0], dy: [0, 0.002, 0], size: [3.4, 11.2] },
    // Landing deck grating, frame & flight opening (part 5)
    { part: 5, normal: [0, 1, 0], pos: [-1.45, 3.5, 0.12], dx: [0.009, 0, 0], dy: [0, 0, 0.009], size: [3.5, 15.0] },
    { part: 5, normal: [0, 1, 0], pos: [0.35, 7.0, 0.15], dx: [0.008, 0, 0], dy: [0, 0, 0.008], size: [3.5, 15.0] },
    { part: 5, normal: [0, 1, 0], pos: [0.0, 3.5, -0.35], dx: [0.012, 0, 0], dy: [0, 0, 0.012], size: [3.6, 15.4] }
  ];

  for (const s of samples) {
    const p10 = s.pos.map((v, i) => v + s.dx[i]);
    const p01 = s.pos.map((v, i) => v + s.dy[i]);
    const actual = evalSample(
      material.opacityNode,
      { positionGeometry: s.pos, normalGeometry: s.normal, attrs: { escapePart: [s.part], escapeLevel: [0], escapeSize: s.size } },
      { positionGeometry: p10 },
      { positionGeometry: p01 }
    )[0];

    assert.equal(shaderState.derivativesInBranch, 0, `part ${s.part} must not call dFdx/dFdy/fwidth inside If/ElseIf`);
    const maxExpectedCalls = s.part === 3 ? 10 : 5;
    assert.ok(
      shaderState.pulseAndBarCalls <= maxExpectedCalls,
      `part ${s.part} should evaluate <= ${maxExpectedCalls} bar/pulse helpers (got ${shaderState.pulseAndBarCalls})`
    );

    const expected = headReferenceOpacity(s.pos, p10, p01, s.normal[2], s.part, s.size[0], s.size[1]);
    assert.ok(Math.abs(actual - expected) < 1e-11, `part ${s.part}: actual ${actual} !== expected ${expected}`);
  }

  // Part 6 (flat horizontal stair treads): solid iron (opacity = 1) with zero procedural bar/pulse calls
  const treadAlpha = evalSample(
    material.opacityNode,
    { positionGeometry: [0.05, 1.75, 0.175], normalGeometry: [0, 1, 0], attrs: { escapePart: [6], escapeLevel: [0], escapeSize: [3.5, 15.0] } },
    { positionGeometry: [0.054, 1.75, 0.175] },
    { positionGeometry: [0.05, 1.75, 0.179] }
  )[0];

  assert.equal(shaderState.derivativesInBranch, 0, 'part 6 must not call derivatives inside branch');
  assert.equal(shaderState.pulseAndBarCalls, 0, 'part 6 bypasses all procedural bar/pulse helpers');
  assert.equal(treadAlpha, 1, 'flat horizontal stair treads remain solid');
});

test('createFireEscapes partitions near shadow casters vs 4x4 far cells and computes tight bounding spheres', () => {
  const group = new Object3D();
  const sys = createFireEscapes(group);
  assert.equal(group.children.length, 17, '1 near shadow bucket + 16 (4x4) far frustum-culled cells');

  const [nearMesh, ...farMeshes] = group.children;
  assert.equal(nearMesh.castShadow, true);
  assert.equal(nearMesh.frustumCulled, true);
  for (const m of farMeshes) {
    assert.equal(m.castShadow, false, 'distant fire escapes do not rasterize into shadow cascades');
    assert.equal(m.frustumCulled, true);
    assert.equal(m.userData.sharesPipelineWith, nearMesh);
  }

  // three.js re-uploads a DynamicDrawUsage attribute in every render pass; flagRange() uploads changed instances once
  for (const m of group.children) {
    assert.notEqual(m.instanceMatrix.usage, threeStub.DynamicDrawUsage, 'instance matrices keep static usage');
  }

  // Case 1: Empty stream region -> nearMesh keeps 1 underground stand-in for pipeline precompilation, far cells hidden
  sys.begin(120, -340);
  sys.end();
  assert.equal(nearMesh.count, 1);
  assert.equal(nearMesh.visible, true);
  assert.equal(nearMesh.boundingSphere.center.y, -10000);
  for (const m of farMeshes) {
    assert.equal(m.count, 0);
    assert.equal(m.visible, false);
  }

  // Case 2: Populated stream region around (focusX = 50, focusZ = -80)
  sys.begin(50, -80);
  const placements = [
    { x: 60, y: 4.5, z: -70, h: 15, storey: 3.5, ry: 0, facing: 0 },       // d = 14.1 m -> near
    { x: 140, y: 5.0, z: -20, h: 18.5, storey: 3.6, ry: 0.4, facing: 1.57 }, // d = 108.2 m -> near (<= 115 m)
    { x: -350, y: 4.2, z: -420, h: 14, storey: 3.5, ry: 0, facing: 0 },    // NW far cell
    { x: -320, y: 4.8, z: -390, h: 17.5, storey: 3.5, ry: 0, facing: 3.14 }, // same NW far cell
    { x: 430, y: 4.5, z: 310, h: 21, storey: 3.5, ry: 0, facing: 0 }       // SE far cell
  ];
  for (const p of placements) sys.add(p);
  sys.end();

  assert.equal(nearMesh.count, 2, 'escapes within 115 m route to FireEscapesNear');
  assert.ok(nearMesh.instanceMatrix.needsUpdateCount >= 2, 'instance matrices receive flagRange updates');

  const visibleFar = farMeshes.filter((m) => m.visible);
  assert.equal(visibleFar.length, 2, 'only the 2 occupied 280 m cells are visible; 14 empty cells are skipped');
  assert.equal(visibleFar.reduce((s, m) => s + m.count, 0), 3);

  // Every visible bucket's boundingSphere must enclose its instances and stay compact enough for frustum culling
  for (const m of visibleFar) {
    assert.ok(m.boundingSphere.radius > 0 && m.boundingSphere.radius < 220);
  }
  // Check nearMesh bounding sphere encloses both near placements
  for (const p of placements.slice(0, 2)) {
    const dx = p.x - nearMesh.boundingSphere.center.x;
    const dy = (p.y + p.h) - nearMesh.boundingSphere.center.y;
    const dz = p.z - nearMesh.boundingSphere.center.z;
    assert.ok(Math.hypot(dx, dy, dz) <= nearMesh.boundingSphere.radius);
  }
});
