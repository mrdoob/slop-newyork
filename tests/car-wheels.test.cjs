const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

// Numeric TSL node evaluator so we can run both createCarWheelMaterial and createLoftedCarMaterial
// on sample wheel fragments and compare near (<90 m) vs far (>=90 m) outputs directly.
const env = { attrs: {}, fwidthVal: [0.004, 0.004, 0.004] };
const arr = (v) => (v instanceof TNode ? v.eval() : typeof v === 'number' ? [v] : v);
const broadcast = (a, b, fn) => {
  const va = arr(a), vb = arr(b);
  const n = Math.max(va.length, vb.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(va[i % va.length], vb[i % vb.length]);
  return out;
};
const smoothstepScalar = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

class TNode {
  constructor(fn) {
    this._fn = typeof fn === 'function' ? fn : () => fn;
  }
  eval() { return this._fn(); }
  get x() { return new TNode(() => [this.eval()[0]]); }
  get y() { return new TNode(() => [this.eval()[1]]); }
  get z() { return new TNode(() => [this.eval()[2]]); }
  get w() { return new TNode(() => [this.eval()[3]]); }
  get r() { return this.x; }
  get g() { return this.y; }
  get b() { return this.z; }
  get rgb() { return new TNode(() => this.eval().slice(0, 3)); }
  add(b) { return new TNode(() => broadcast(this, b, (x, y) => x + y)); }
  sub(b) { return new TNode(() => broadcast(this, b, (x, y) => x - y)); }
  mul(b) { return new TNode(() => broadcast(this, b, (x, y) => x * y)); }
  div(b) { return new TNode(() => broadcast(this, b, (x, y) => x / y)); }
  negate() { return new TNode(() => this.eval().map((x) => -x)); }
  greaterThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x > y ? 1 : 0))); }
  lessThan(b) { return new TNode(() => broadcast(this, b, (x, y) => (x < y ? 1 : 0))); }
  and(b) { return new TNode(() => broadcast(this, b, (x, y) => (x && y ? 1 : 0))); }
  toVar() {
    let slot = null;
    const variable = new TNode(() => (slot ?? this.eval()));
    variable.assign = (rhs) => { slot = arr(rhs).slice(); };
    return variable;
  }
}

const wrap = (v) => (v instanceof TNode ? v : new TNode(Array.isArray(v) ? v : [v]));
const unary = (fn) => (a) => new TNode(() => arr(a).map(fn));

function IfImpl(cond, body) {
  let matched = arr(cond)[0] > 0;
  if (matched) body();
  const api = {
    ElseIf(c, b) {
      if (!matched && arr(c)[0] > 0) {
        matched = true;
        b();
      }
      return api;
    },
    Else(b) {
      if (!matched) {
        matched = true;
        b();
      }
      return api;
    }
  };
  return api;
}

function FnImpl(builder) {
  return () => new TNode(() => arr(builder()));
}

let plateTextureCreated = 0;
const tslStub = {
  Fn: FnImpl,
  If: IfImpl,
  float: (v) => wrap(v),
  vec2: (...args) => new TNode(() => args.flatMap((a) => arr(a)).slice(0, 2)),
  vec3: (...args) => new TNode(() => {
    const flat = args.flatMap((a) => arr(a));
    return flat.length === 1 ? [flat[0], flat[0], flat[0]] : flat.slice(0, 3);
  }),
  vec4: (...args) => new TNode(() => args.flatMap((a) => arr(a)).slice(0, 4)),
  color: (hex) => wrap([((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]),
  attribute: (name) => new TNode(() => env.attrs[name]),
  varying: (node) => node,
  vertexStage: (node) => node,
  sin: unary(Math.sin),
  cos: unary(Math.cos),
  atan: (y, x) => new TNode(() => [Math.atan2(arr(y)[0], arr(x)[0])]),
  pow: (a, b) => new TNode(() => broadcast(a, b, Math.pow)),
  dot: (a, b) => new TNode(() => {
    const va = arr(a), vb = arr(b);
    let s = 0;
    for (let i = 0; i < va.length; i++) s += va[i] * vb[i];
    return [s];
  }),
  abs: unary(Math.abs),
  fract: unary((x) => x - Math.floor(x)),
  floor: unary(Math.floor),
  min: (a, b) => new TNode(() => broadcast(a, b, Math.min)),
  max: (a, b) => new TNode(() => broadcast(a, b, Math.max)),
  clamp: (v, lo, hi) => new TNode(() => broadcast(broadcast(v, lo, Math.max), hi, Math.min)),
  mix: (a, b, t) => new TNode(() => {
    const va = arr(a), vb = arr(b), vt = arr(t);
    const n = Math.max(va.length, vb.length);
    return Array.from({ length: n }, (_, i) => va[i % va.length] * (1 - vt[i % vt.length]) + vb[i % vb.length] * vt[i % vt.length]);
  }),
  step: (edge, x) => new TNode(() => broadcast(edge, x, (e, v) => (v < e ? 0 : 1))),
  smoothstep: (e0, e1, x) => new TNode(() => broadcast(broadcast(e0, e1, (a, b) => [a, b]), x, () => 0)).mul(0) // replaced below
  ,
  length: (v) => new TNode(() => [Math.hypot(...arr(v))]),
  sqrt: unary(Math.sqrt),
  fwidth: () => new TNode(() => env.fwidthVal),
  dFdx: (v) => new TNode(() => arr(v).map(() => 0)),
  dFdy: (v) => new TNode(() => arr(v).map(() => 0)),
  cross: (a, b) => new TNode(() => {
    const u = arr(a), v = arr(b);
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  }),
  normalize: (v) => new TNode(() => {
    const u = arr(v);
    const len = Math.hypot(...u) || 1;
    return u.map((x) => x / len);
  }),
  select: (c, a, b) => new TNode(() => (arr(c)[0] > 0 ? arr(a) : arr(b))),
  positionView: wrap([0, 0, -5]),
  normalView: wrap([0, 0, 1]),
  positionViewDirection: wrap([0, 0, 1]),
  uniform: (val) => wrap(val.isVector4 ? [val.x, val.y, val.z, val.w] : [val]),
  texture: () => {
    plateTextureCreated++;
    return wrap([0.9, 0.7, 0.1, 1]);
  },
  time: wrap([0]),
  instanceIndex: wrap([0])
};
tslStub.smoothstep = (e0, e1, x) => new TNode(() => {
  const v0 = arr(e0), v1 = arr(e1), vx = arr(x);
  const n = Math.max(v0.length, v1.length, vx.length);
  return Array.from({ length: n }, (_, i) => smoothstepScalar(v0[i % v0.length], v1[i % v1.length], vx[i % vx.length]));
});

class MeshStandardNodeMaterial {
  constructor() {
    this.userData = {};
    this.colorNode = null;
    this.roughnessNode = null;
    this.metalnessNode = null;
    this.emissiveNode = null;
    this.envMapIntensity = 1;
  }
}
class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 0) {
    Object.assign(this, { x, y, z, w, isVector4: true });
  }
}

const cars = loadModule(readFileSync(join(__dirname, '../js/cars.js'), 'utf8'), {
  imports: {
    'three/webgpu': { MeshStandardNodeMaterial, Vector4, CanvasTexture: class {}, SRGBColorSpace: 'srgb' },
    'three/tsl': tslStub,
    'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries: () => ({}) },
    'three/addons/geometries/LoftGeometry.js': { LoftGeometry: class {} },
    './tsl-materials.js': { cityUniforms: { uInteriorGlow: wrap([0.48]), uSkyHorizonColor: wrap([0.8, 0.75, 0.7]) } },
    './vehicles.js': { part: (g) => g, mirrorSection: (s) => s, roundedRectShape: () => ({}), roundedBox: () => ({}) }
  },
  globals: {
    document: {
      createElement: () => ({
        getContext: () => ({ fillRect() {}, fillText() {} })
      })
    }
  }
});

const { BODY_SPECS, CAR_PARTS, carStyleCode, createCarWheelMaterial, createLoftedCarMaterial } = cars;

test('createCarWheelMaterial is lightweight, cached, and never binds license plate textures or emissive nodes', () => {
  plateTextureCreated = 0;
  const instA = createCarWheelMaterial({ instanced: true });
  const instB = createCarWheelMaterial({ instanced: true });
  const fixedA = createCarWheelMaterial({ style: 0 });
  const fixedB = createCarWheelMaterial({ style: 0 });
  assert.equal(instA, instB);
  assert.equal(fixedA, fixedB);
  assert.notEqual(instA, fixedA);
  assert.equal(instA.emissiveNode, null);
  assert.equal(fixedA.emissiveNode, null);
  assert.equal(instA.envMapIntensity, 1.35);
  env.attrs = { position: [0.1, 0.14, 0.08], partId: [CAR_PARTS.ALLOY], wheelStyle: [0] };
  instA.colorNode.eval();
  fixedA.colorNode.eval();
  assert.equal(plateTextureCreated, 0, 'wheel shader must not sample carPlateTexture');
});

test('near instanced wheels match far proxy wheel shading across NYPD, blackout, and all spoke styles', () => {
  const wheelMat = createCarWheelMaterial({ instanced: true });
  const proxyMat = createLoftedCarMaterial(BODY_SPECS.sedan);
  assert.equal(wheelMat.envMapIntensity, proxyMat.envMapIntensity);

  const styles = [
    carStyleCode({ livery: 0, trim: 0, wheel: 0 }),
    carStyleCode({ livery: 0, trim: 0, wheel: 1 }),
    carStyleCode({ livery: 0, trim: 0, wheel: 2 }),
    carStyleCode({ livery: 0, trim: 0, wheel: 3 }),
    carStyleCode({ livery: 0, trim: 2, wheel: 0 }), // blackout trim
    carStyleCode({ livery: 1, trim: 2, wheel: 3 })  // NYPD cruiser steelies + center hubcap
  ];
  const samples = [
    { part: CAR_PARTS.ALLOY, y: 0.14, z: 0.06 }, // spoke & brake rotor zone
    { part: CAR_PARTS.ALLOY, y: 0.03, z: 0.01 }, // center hubcap
    { part: CAR_PARTS.ALLOY, y: 0.22, z: 0.0 },  // outer rim flange
    { part: CAR_PARTS.TYRE, y: 0.28, z: 0.04 },  // tyre sidewall rib
    { part: CAR_PARTS.TRIM, y: 0.10, z: 0.0 }    // inboard back disc
  ];

  const spokeColors = [];
  for (const style of styles) {
    for (const s of samples) {
      // Near centered 3D wheel at (z, y) vs far axle-positioned wheel at (wheelZ + z, wheelRadius + y)
      env.attrs = {
        position: [0.8, s.y, s.z],
        normal: [1, 0, 0],
        partId: [s.part],
        wheelStyle: [style],
        paintColor: [0.8, 0.8, 0.8],
        carState: [0, 0, 0, style]
      };
      const nearCol = wheelMat.colorNode.eval();
      const nearRough = wheelMat.roughnessNode.eval()[0];
      const nearMetal = wheelMat.metalnessNode.eval()[0];

      env.attrs = {
        position: [0.8, BODY_SPECS.sedan.wheelRadius + s.y, BODY_SPECS.sedan.wheelZ + s.z],
        normal: [1, 0, 0],
        partId: [s.part],
        paintColor: [0.8, 0.8, 0.8],
        carState: [0, 0, 0, style]
      };
      const farCol = proxyMat.colorNode.eval();
      const farRough = proxyMat.roughnessNode.eval()[0];
      const farMetal = proxyMat.metalnessNode.eval()[0];

      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(nearCol[c] - farCol[c]) < 1e-6, `style ${style} part ${s.part} channel ${c}: ${nearCol[c]} vs ${farCol[c]}`);
      }
      assert.ok(Math.abs(nearRough - farRough) < 1e-6, `style ${style} roughness: ${nearRough} vs ${farRough}`);
      assert.ok(Math.abs(nearMetal - farMetal) < 1e-6, `style ${style} metalness: ${nearMetal} vs ${farMetal}`);
    }

    // Also verify standalone fixed-style wheel material matches instanced wheel material for the same style
    const fixedMat = createCarWheelMaterial({ style });
    env.attrs = { position: [0.8, 0.22, 0.0], partId: [CAR_PARTS.ALLOY], wheelStyle: [style] };
    const instRim = wheelMat.colorNode.eval();
    const fixedRim = fixedMat.colorNode.eval();
    spokeColors.push(instRim);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(instRim[c] - fixedRim[c]) < 1e-6);
  }

  // Standard silver alloy (style 0), blackout dark alloy (style 4), and NYPD black steel wheel (style 5) must look distinct!
  assert.ok(spokeColors[0][0] > spokeColors[4][0] + 0.3, 'silver alloy brighter than blackout alloy');
  assert.ok(spokeColors[4][0] > spokeColors[5][0] + 0.1, 'blackout alloy brighter than NYPD black steel wheel');

  // Spoke patterns (wheel 0 vs 1 vs 2) produce distinct geometry inside the spoke band (at wAngle = 0, wheel 1 hits a turbine spoke while wheel 0 sits in its split groove)
  const patternSamples = [0, 1, 2].map((w) => {
    env.attrs = { position: [0.8, 0.0, 0.15], partId: [CAR_PARTS.ALLOY], wheelStyle: [carStyleCode({ wheel: w })] };
    return wheelMat.colorNode.eval()[0];
  });
  assert.ok(Math.abs(patternSamples[0] - patternSamples[1]) > 0.2,
    `spoke styles 0 and 1 produce distinct spoke patterns: ${patternSamples}`);
});

test('renderCar writes per-car wheel styles to both front and rear wheel slots with dirty tracking', () => {
  const trafficSrc = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
  const match = trafficSrc.match(/  function renderCar\(c\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'renderCar function present');
  const carWheelStyles = { array: new Float32Array(8) };
  const placed = [];
  const makeInst = () => ({
    count: 0,
    setMatrixAt() {},
    geometry: {
      attributes: {
        paintColor: { array: new Float32Array(12) },
        carState: { array: new Float32Array(16) }
      }
    }
  });
  const ctx = {
    BODY_SPECS: { sedan: { wheelRadius: 0.35, wheelX: 0.8, wheelZ: 1.4 } },
    CAR_PROXY_DISTANCE: 90,
    hasView: false,
    visible: () => true,
    focusX: 0,
    focusZ: 0,
    camX: 0,
    camY: 10,
    camZ: 0,
    camFwdX: 0,
    camFwdZ: 1,
    MAX_LIGHT_DIST_SQ: 0,
    MAX_LIGHT_DIST: 0,
    clock: 0,
    bodies: { sedan: { near: makeInst(), far: makeInst(), shadow: [2, 4.5, 0] } },
    policeLightbars: {},
    policeDrawn: { sedan: 0 },
    dirtyPaint: new Set(),
    dirtyState: new Set(),
    dirtyWheelStyles: false,
    carWheelStyles,
    carWheelLeftInst: {},
    carWheelRightInst: {},
    carShadowInst: { setMatrixAt() {} },
    litVehicles: [],
    litVehicleCount: 0,
    visibleCars: 0,
    wheelCars: 0,
    dummy: {
      position: { set() {} },
      rotation: { set() {} },
      scale: { set() {} },
      updateMatrix() {},
      matrix: {}
    },
    placeWheels(c, idx) { placed.push(idx); }
  };
  const renderCar = vm.runInNewContext(`(${match[0].trim()})`, ctx);
  const policeStyle = carStyleCode({ livery: 1, trim: 2, wheel: 3 });
  const sportStyle = carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 });
  const c0 = { x: 10, z: 10, prevX: 10, prevZ: 10, yaw: 0, yawOffset: 0, pitch: 0, roll: 0, wheelSpin: 0,
    bodyType: 'sedan', isPolice: false, paint: [1, 1, 1], style: policeStyle, blink: 0, blinkPhase: 0, acc: 0, speed: 5 };
  const c1 = { ...c0, x: 20, style: sportStyle };
  const c2 = { ...c0, x: 120, style: 99 }; // > 90 m -> far proxy, no separate wheels

  renderCar(c0);
  renderCar(c1);
  renderCar(c2);
  assert.equal(ctx.wheelCars, 2);
  assert.deepEqual(placed, [0, 1]);
  assert.equal(ctx.dirtyWheelStyles, true);
  assert.deepEqual([...carWheelStyles.array.slice(0, 4)], [policeStyle, policeStyle, sportStyle, sportStyle]);

  // Second frame with identical near cars & styles must leave dirtyWheelStyles false (no GPU upload)
  ctx.dirtyWheelStyles = false;
  ctx.wheelCars = 0;
  ctx.bodies.sedan.near.count = 0;
  ctx.bodies.sedan.far.count = 0;
  renderCar(c0);
  renderCar(c1);
  assert.equal(ctx.dirtyWheelStyles, false);
});
