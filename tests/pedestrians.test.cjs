const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

const pedestriansSource = readFileSync(join(__dirname, '../js/pedestrians.js'), 'utf8');
const controllersSource = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
const pedestrianSystemSource = ['traffic.js', 'pedestrian-system.js']
  .map((file) => readFileSync(join(__dirname, '../js', file), 'utf8')).join('\n');
const polygonCollision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));

// THREE stand-ins for PersonCrowd and PersonRig without a GPU. The shaders are only built here, never run: any node
// takes any method, swizzle or call and gives a node back.
const node = new Proxy(function () {}, { get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : node), apply: () => node });
const tslStub = new Proxy({
  attributeArray: (count) => {
    const value = { array: new Float32Array(count * 4), clearUpdateRanges() {}, addUpdateRange() {}, needsUpdate: false };
    const storage = { value, toReadOnly: () => storage, element: () => node };
    return storage;
  }
}, { get: (stub, key) => stub[key] ?? node });

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  applyAxisAngle(axis, angle) {
    const q = new Quaternion().setFromAxisAngle(axis, angle);
    return this.applyQuaternion(q);
  }
  applyQuaternion(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  }
  applyMatrix4(m) {
    const e = m.elements;
    const x = this.x, y = this.y, z = this.z;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14];
    return this;
  }
}

class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  identity() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; return this; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
  invert() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  slerp(q, t) { // normalized lerp along the shorter arc (enough for the tests)
    const d = this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w, k = d < 0 ? -1 : 1;
    this.x += (q.x * k - this.x) * t; this.y += (q.y * k - this.y) * t; this.z += (q.z * k - this.z) * t; this.w += (q.w * k - this.w) * t;
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  setFromAxisAngle(axis, angle) {
    const half = angle * 0.5, s = Math.sin(half);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
    return this;
  }
  setFromUnitVectors(vFrom, vTo) {
    let r = vFrom.dot(vTo) + 1;
    if (r < 1e-7) {
      if (Math.abs(vFrom.x) > Math.abs(vFrom.z)) { this.x = -vFrom.y; this.y = vFrom.x; this.z = 0; this.w = 0; }
      else { this.x = 0; this.y = -vFrom.z; this.z = vFrom.y; this.w = 0; }
    } else {
      this.x = vFrom.y * vTo.z - vFrom.z * vTo.y;
      this.y = vFrom.z * vTo.x - vFrom.x * vTo.z;
      this.z = vFrom.x * vTo.y - vFrom.y * vTo.x;
      this.w = r;
    }
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l;
    return this;
  }
  multiply(q) { return this.multiplyQuaternions(this, q); }
  premultiply(q) { return this.multiplyQuaternions(q, this); }
  multiplyQuaternions(a, b) {
    const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w;
    const qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
    this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
    this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
    this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
    this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
    return this;
  }
  setFromRotationMatrix(m) {
    const te = m.elements;
    const m11 = te[0], m12 = te[4], m13 = te[8];
    const m21 = te[1], m22 = te[5], m23 = te[9];
    const m31 = te[2], m32 = te[6], m33 = te[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s; this.x = (m32 - m23) * s; this.y = (m13 - m31) * s; this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s; this.x = 0.25 * s; this.y = (m12 + m21) / s; this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s; this.x = (m12 + m21) / s; this.y = 0.25 * s; this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s; this.x = (m13 + m31) / s; this.y = (m23 + m32) / s; this.z = 0.25 * s;
    }
    return this;
  }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  makeBasis(xAxis, yAxis, zAxis) {
    this.elements = [
      xAxis.x, xAxis.y, xAxis.z, 0,
      yAxis.x, yAxis.y, yAxis.z, 0,
      zAxis.x, zAxis.y, zAxis.z, 0,
      0, 0, 0, 1
    ];
    return this;
  }
}

class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.count = array.length / itemSize; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setXYZ(i, x, y, z) {
    const o = i * this.itemSize;
    this.array[o] = x; this.array[o + 1] = y; this.array[o + 2] = z;
    return this;
  }
}
class Float32BufferAttribute extends BufferAttribute {
  constructor(array, itemSize) { super(array instanceof Float32Array ? array : new Float32Array(array), itemSize); }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  getAttribute(name) { return this.attributes[name]; }
  setIndex(indices) {
    this.index = indices instanceof BufferAttribute ? indices : new BufferAttribute(new Uint32Array(indices), 1);
    return this;
  }
  getIndex() { return this.index; }
  computeVertexNormals() {
    const pos = this.attributes.position;
    if (pos && !this.attributes.normal) this.attributes.normal = new Float32BufferAttribute(new Float32Array(pos.array.length), 3);
  }
  computeBoundingSphere() {
    this.boundingSphere = { center: new Vector3(), radius: 1 };
  }
}
class MeshStandardNodeMaterial {
  constructor(opts = {}) { Object.assign(this, opts); }
}
class Mesh {
  constructor(geometry, material) {
    this.geometry = geometry;
    this.material = material;
    this.visible = true;
    this.count = 1;
    this.frustumCulled = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.matrixAutoUpdate = true;
  }
}

function mergeGeometries(geos) {
  let totalVerts = 0;
  let totalIndices = 0;
  const attrNames = Object.keys(geos[0].attributes);
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }
  const merged = new BufferGeometry();
  for (const name of attrNames) {
    const itemSize = geos[0].attributes[name].itemSize;
    const out = new Float32Array(totalVerts * itemSize);
    let offset = 0;
    for (const g of geos) {
      out.set(g.attributes[name].array, offset);
      offset += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new Float32BufferAttribute(out, itemSize));
  }
  const idx = new Uint32Array(totalIndices);
  let iOff = 0, vOff = 0;
  for (const g of geos) {
    const count = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[iOff++] = src[i] + vOff;
    } else {
      for (let i = 0; i < count; i++) idx[iOff++] = i + vOff;
    }
    vOff += count;
  }
  merged.setIndex(new BufferAttribute(idx, 1));
  return merged;
}

const ragdollModule = loadModule(readFileSync(join(__dirname, '../js/ragdoll.js'), 'utf8'));
const pedestriansModule = loadModule(pedestriansSource, {
  imports: {
    './ragdoll.js': ragdollModule,
    'three/webgpu': { Vector3, Quaternion, Matrix4, BufferAttribute, BufferGeometry, Float32BufferAttribute, MeshStandardNodeMaterial, Mesh },
    'three/tsl': tslStub,
    'three/addons/utils/BufferGeometryUtils.js': { mergeGeometries }
  }
});
const { PERSON_BONES, PersonCrowd, PersonRig, buildPersonGeometry } = pedestriansModule;
const STRIDE = 34; // 15 bones x 2 vec4s, 3 appearance vec4s, the info vec4

test('PersonCrowd keeps 1 warm-up instance for 2 updates, then hides empty LODs', () => {
  const crowd = new PersonCrowd(8, { farDistance: 34 });
  const rig = new PersonRig({ seed: 2.5 });
  rig.reset(0, 0, 0, () => 0, null);

  for (const frame of [1, 2]) {
    crowd.begin();
    crowd.end();
    assert.equal(crowd.meshes[0].visible, true, `warm-up frame ${frame} near visible`);
    assert.equal(crowd.meshes[0].count, 1);
    assert.equal(crowd.meshes[1].visible, true, `warm-up frame ${frame} far visible`);
    assert.equal(crowd.meshes[1].count, 1);
  }

  crowd.begin();
  crowd.end();
  assert.equal(crowd.meshes[0].visible, false);
  assert.equal(crowd.meshes[0].count, 0);
  assert.equal(crowd.meshes[1].visible, false);
  assert.equal(crowd.meshes[1].count, 0);

  crowd.begin();
  crowd.add(rig, 12);
  crowd.end();
  assert.equal(crowd.meshes[0].visible, true);
  assert.equal(crowd.meshes[0].count, 1);
  assert.equal(crowd.meshes[1].visible, false);
  assert.equal(crowd.meshes[1].count, 0);
});

test('buildPersonGeometry assigns constant partId across every triangle so flat/interpolated part varyings never bleed', () => {
  for (const detail of [1, 0]) {
    const geo = buildPersonGeometry(detail);
    const skin = geo.getAttribute('skin').array;
    const idx = geo.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      const p0 = skin[idx[i] * 4 + 3];
      const p1 = skin[idx[i + 1] * 4 + 3];
      const p2 = skin[idx[i + 2] * 4 + 3];
      assert.equal(p0, p1);
      assert.equal(p1, p2);
    }
  }
});

test('renderPed skips hidden rig updates beyond 50m while preserving <=50m footstep audio gait', () => {
  const match = pedestrianSystemSource.match(/  function renderPed\([^]*?\n  \}/);
  assert.ok(match, 'renderPed is present');

  const runRenderPed = ({ inView, x, z }) => {
    let calls = 0;
    let drawn = 0;
    const ped = {
      x, z, ux: 0, uz: 1, dir: 1,
      rig: { placed: true, update() { calls++; } }
    };
    const renderPed = vm.runInNewContext(`(${match[0].trim()})`, {
      hasView: true,
      visible: () => inView,
      pedGround: () => 0,
      focusX: 0,
      focusZ: 0,
      Math,
      pedCrowd: { add() { drawn++; } }
    });
    renderPed(ped, 1 / 60);
    return { calls, drawn, placed: ped.rig.placed };
  };

  // Hidden within 50 m (covers 45 m footstep audio radius): gait still updates
  const nearHidden = runRenderPed({ inView: false, x: 30, z: 30 });
  assert.equal(nearHidden.calls, 1);
  assert.equal(nearHidden.drawn, 0);
  assert.equal(nearHidden.placed, true);

  // Hidden beyond 50 m: rig.update is skipped and rig is marked unplaced for clean re-entry
  const farHidden = runRenderPed({ inView: false, x: 45, z: 45 });
  assert.equal(farHidden.calls, 0);
  assert.equal(farHidden.drawn, 0);
  assert.equal(farHidden.placed, false);

  // Visible beyond 50 m: poses and draws normally
  const farVisible = runRenderPed({ inView: true, x: 80, z: 80 });
  assert.equal(farVisible.calls, 1);
  assert.equal(farVisible.drawn, 1);
});

test('poseCharacters skips stationary inactive cyclist IK/uploads and culls parked characters beyond 320m', () => {
  const noopTarget = { addEventListener() {} };
  const { ThirdPersonControllerManager } = loadModule(controllersSource, {
    globals: { window: noopTarget, document: { ...noopTarget, hidden: false } },
    imports: {
      'three/webgpu': {},
      './city-config.js': { streetZ: () => 0, isTypingInField: () => false },
      './tsl-materials.js': {},
      './cars.js': {},
      './helicopter.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './landmarks.js': {},
      './building-collision.js': polygonCollision
    }
  });

  const makeMockCrowd = () => ({
    updates: 0,
    adds: 0,
    ends: 0,
    begin() {},
    add() { this.adds++; },
    end() { this.updates++; this.ends++; }
  });

  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.activeMode = 'car';
  controller.getGroundHeight = () => 0.22;

  let personUpdates = 0;
  let bikeRides = 0;
  const person = {
    type: 'person',
    position: { x: -11.6, y: 0.22, z: 0 },
    heading: 0,
    mesh: { visible: true },
    rig: { placed: true, update() { personUpdates++; this.placed = true; } },
    crowd: makeMockCrowd()
  };
  const cyclist = {
    type: 'cyclist',
    position: { x: 8.15, y: 0, z: 0 },
    heading: 0,
    leanAngle: 0,
    pedalPhase: 0,
    mesh: { visible: true },
    leanPivot: {},
    bikeFrame: {},
    helmet: {
      visible: true,
      quaternion: { copy() {} },
      position: { set() { return this; }, applyQuaternion() { return this; }, add() { return this; } }
    },
    riderRig: { headQuaternion: {}, headPosition: {}, ride() { bikeRides++; } },
    riderCrowd: makeMockCrowd()
  };
  const car = { type: 'car', position: { x: 3.6, y: 0, z: 0 }, carState: { value: { x: 0, w: 0 } } };
  controller.entities = { person, cyclist, car };

  // Within 320m: person updates every frame, stationary inactive cyclist poses once then skips IK & uploads
  for (let i = 0; i < 5; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 0 });
  assert.equal(personUpdates, 5);
  assert.equal(bikeRides, 1, 'stationary parked cyclist solves ride IK only once');
  assert.equal(cyclist.riderCrowd.adds, 1);

  // Move focus > 320m away (e.g. One WTC at z = 4000): warm-up finishes, then both stop updating & hide crowds
  for (let i = 0; i < 6; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.mesh.visible, false);
  assert.equal(person.rig.placed, false);
  assert.equal(cyclist.helmet.visible, false);
  assert.equal(cyclist.mesh.visible, true, 'cyclist root stays visible so its child SpotLight stays in scene lights');

  const endsBeforeIdle = person.crowd.ends + cyclist.riderCrowd.ends;
  for (let i = 0; i < 10; i++) controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(person.crowd.ends + cyclist.riderCrowd.ends, endsBeforeIdle, 'zero crowd calls while parked >320m away');
  assert.equal(personUpdates, 5);
  assert.equal(bikeRides, 1);

  // Switching mode to cyclist immediately restores visibility & poses even when camera has not caught up yet
  controller.setMode('cyclist');
  controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 4000 });
  assert.equal(cyclist.helmet.visible, true);
  assert.equal(bikeRides, 2);

  // Returning within 320m restores the sidewalk pedestrian immediately
  controller.setMode('car');
  controller.poseCharacters(1 / 60, { x: 0, y: 2, z: 10 });
  assert.equal(person.mesh.visible, true);
  assert.equal(personUpdates, 6);
});

function boneWorldPos(rig, bone, localPos = rig.bind[bone]) {
  const o = bone * 8;
  const q = new Quaternion(rig.pose[o], rig.pose[o + 1], rig.pose[o + 2], rig.pose[o + 3]);
  const s = rig.pose[o + 7];
  const p = localPos.clone().applyQuaternion(q).multiplyScalar(s);
  p.x += rig.pose[o + 4];
  p.y += rig.pose[o + 5];
  p.z += rig.pose[o + 6];
  return p;
}

function legKneeBendDeg(rig, legIndex) {
  const thigh = legIndex === 0 ? PERSON_BONES.THIGH_L : PERSON_BONES.THIGH_R;
  const shin = legIndex === 0 ? PERSON_BONES.SHIN_L : PERSON_BONES.SHIN_R;
  const foot = legIndex === 0 ? PERSON_BONES.FOOT_L : PERSON_BONES.FOOT_R;
  const hip = boneWorldPos(rig, thigh);
  const knee = boneWorldPos(rig, shin);
  const ankle = boneWorldPos(rig, foot);
  const u1 = hip.sub(knee).normalize();
  const u2 = ankle.sub(knee).normalize();
  return 180 - Math.acos(Math.max(-1, Math.min(1, u1.dot(u2)))) * 180 / Math.PI;
}

test('PersonRig walk and full-speed run keep smooth kneecushion, bounded swing stride, and springy flight', () => {
  const dt = 1 / 60;
  for (const speed of [1.45, 3.5, 8.2]) {
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });
    let z = 0;
    rig.reset(0, 0, 0, () => 0);
    let minPelvisY = Infinity, maxPelvisY = -Infinity;
    let minKneeDeg = 180, maxKneeDeg = 0;
    let minRelZ = Infinity, maxRelZ = -Infinity;
    let minSoleY = Infinity;

    for (let f = 0; f < 180; f++) {
      z += speed * dt;
      rig.update(dt, 0, z, 0, () => 0);
      if (f < 60) continue;
      minPelvisY = Math.min(minPelvisY, rig.pelvisY);
      maxPelvisY = Math.max(maxPelvisY, rig.pelvisY);
      for (let i = 0; i < 2; i++) {
        const foot = rig.feet[i];
        const bend = legKneeBendDeg(rig, i);
        minKneeDeg = Math.min(minKneeDeg, bend);
        maxKneeDeg = Math.max(maxKneeDeg, bend);
        minRelZ = Math.min(minRelZ, foot.az - z);
        maxRelZ = Math.max(maxRelZ, foot.az - z);
        const heel = boneWorldPos(rig, i === 0 ? PERSON_BONES.FOOT_L : PERSON_BONES.FOOT_R, new Vector3(foot.side * 0.09, 0, -0.078));
        const toe = boneWorldPos(rig, i === 0 ? PERSON_BONES.TOE_L : PERSON_BONES.TOE_R, new Vector3(foot.side * 0.09, 0.005, 0.208));
        minSoleY = Math.min(minSoleY, heel.y, toe.y);
      }
    }
    assert.ok(minKneeDeg > 6.5, `speed ${speed}: soft IK extension avoids locked-knee snap (got ${minKneeDeg.toFixed(1)}°)`);
    const maxVerticalAmp = speed >= 8 ? 0.032 : 0.055;
    assert.ok(minPelvisY > 0.85 && maxPelvisY - minPelvisY < maxVerticalAmp,
      `speed ${speed}: pelvis vertical arc stays smooth and shake-free [${minPelvisY.toFixed(3)}, ${maxPelvisY.toFixed(3)}]`);
    assert.ok(minRelZ > -0.58 && maxRelZ < 0.48, `speed ${speed}: body-carried swing prevents world-space overshoot [${minRelZ.toFixed(2)}, ${maxRelZ.toFixed(2)}]`);
    assert.ok(minSoleY > -0.005, `speed ${speed}: shoe soles stay above pavement (${(minSoleY * 100).toFixed(2)} cm)`);
  }
});

// Measured from the posed bones: the way a bone points, how far the torso (pelvis to neck) leans towards (ax, az),
// and the heights of a foot's heel and toe tip
function boneForward(rig, bone) {
  const o = bone * 8;
  return new Vector3(0, 0, 1).applyQuaternion(new Quaternion(rig.pose[o], rig.pose[o + 1], rig.pose[o + 2], rig.pose[o + 3]));
}
const yawOf = (v) => Math.atan2(v.x, v.z);
const wrapAngle = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
function torsoLean(rig, ax, az) {
  const neck = boneWorldPos(rig, PERSON_BONES.HEAD), pelvis = boneWorldPos(rig, PERSON_BONES.PELVIS);
  return Math.atan2((neck.x - pelvis.x) * ax + (neck.z - pelvis.z) * az, neck.y - pelvis.y);
}
function heelAndToe(rig, i) {
  const side = i ? -1 : 1;
  return [
    boneWorldPos(rig, i ? PERSON_BONES.FOOT_R : PERSON_BONES.FOOT_L, new Vector3(side * 0.09, 0, -0.078)).y,
    boneWorldPos(rig, i ? PERSON_BONES.TOE_R : PERSON_BONES.TOE_L, new Vector3(side * 0.09, 0.005, 0.208)).y
  ];
}

test('PersonRig walking backward keeps the torso upright, reaches back toes first and keeps the foot ahead flat', () => {
  const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
  const dt = 1 / 60;
  let z = 0, maxLean = -Infinity, maxAheadPitch = -Infinity, toeFirst = 0, heelFirst = 0;
  const lifted = [false, false];
  rig.reset(0, 0, 0, () => 0);

  for (let f = 0; f < 240; f++) {
    z -= 2.8 * dt;
    rig.update(dt, 0, z, 0, () => 0);
    if (f < 60) continue;
    maxLean = Math.max(maxLean, torsoLean(rig, 0, 1));
    for (let i = 0; i < 2; i++) {
      const [heel, toe] = heelAndToe(rig, i);
      // each step: which end of the foot comes back down to the ground first
      if (Math.min(heel, toe) > 0.05) lifted[i] = true;
      else if (lifted[i] && Math.min(heel, toe) < 0.02) {
        if (toe < heel) toeFirst++;
        else heelFirst++;
        lifted[i] = false;
      }
      // a foot on the ground ahead of the hips
      const ahead = boneWorldPos(rig, i ? PERSON_BONES.FOOT_R : PERSON_BONES.FOOT_L).z - z;
      if (Math.min(heel, toe) < 0.01 && ahead > 0.2) {
        const forward = boneForward(rig, i ? PERSON_BONES.FOOT_R : PERSON_BONES.FOOT_L);
        maxAheadPitch = Math.max(maxAheadPitch, Math.atan2(-forward.y, Math.hypot(forward.x, forward.z)));
      }
    }
  }
  assert.ok(maxLean < 0.04, `the torso stays upright backing up instead of leaning forward (${maxLean.toFixed(3)} rad)`);
  assert.ok(toeFirst >= 6 && heelFirst === 0, `stepping back, the toes reach the ground first (${toeFirst} toes, ${heelFirst} heels)`);
  assert.ok(maxAheadPitch <= 0.02, `the planted foot ahead never rises onto its toes (${maxAheadPitch.toFixed(3)} rad)`);
});

test('PersonRig turning in place leads with the head and steps the feet round; running turns lean into the curve', () => {
  const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
  const dt = 1 / 60;
  let heading = 0;
  rig.reset(0, 0, 0, () => 0);
  const feet = [PERSON_BONES.FOOT_L, PERSON_BONES.FOOT_R];
  const feetYaw = feet.map((b) => yawOf(boneForward(rig, b)));

  // Continuous 2.6 rad/s turn in place (matches Walk mode A/D turnRate)
  for (let f = 0; f < 60; f++) {
    heading += 2.6 * dt;
    rig.update(dt, 0, 0, heading, () => 0);
  }
  const bodyYaw = yawOf(boneForward(rig, PERSON_BONES.PELVIS));
  assert.ok(Math.abs(wrapAngle(bodyYaw - heading)) < 0.3, `the body keeps up with the turn (${wrapAngle(bodyYaw - heading).toFixed(2)} rad behind)`);
  const headLead = wrapAngle(yawOf(boneForward(rig, PERSON_BONES.HEAD)) - bodyYaw);
  assert.ok(headLead > 0.25, `the head leads into the turn (${headLead.toFixed(2)} rad)`);
  for (let i = 0; i < 2; i++) {
    const turned = wrapAngle(yawOf(boneForward(rig, feet[i])) - feetYaw[i]);
    assert.ok(turned > 1.2, `the feet step round with the body (foot ${i} turned ${turned.toFixed(2)} rad)`);
  }

  // Running turn leans into the curve (to the left of the way it faces)
  let x = 0, z = 0, minLean = Infinity;
  for (let f = 0; f < 90; f++) {
    heading += 2.6 * dt;
    x += Math.sin(heading) * 6.0 * dt;
    z += Math.cos(heading) * 6.0 * dt;
    rig.update(dt, x, z, heading, () => 0);
    if (f > 30) minLean = Math.min(minLean, torsoLean(rig, Math.cos(heading), -Math.sin(heading)));
  }
  assert.ok(minLean > 0.06, `the body leans into a running left turn (${minLean.toFixed(3)} rad)`);
});

test('PersonRig jump prepares with countermovement, evolves continuously across the arc without sprint foot lag, and absorbs landings', () => {
  const dt = 1 / 60;

  // 1. Standing jump: countermovement crouch + arm backswing -> launch punch -> heel-back tuck -> downward landing reach -> deep squat
  const standRig = new PersonRig({ seed: 4.2, scale: 1.0 });
  standRig.reset(0, 0, 0, () => 0);
  const standPelvis0 = standRig.pelvisY;
  const handOffset = new Vector3(0.24, 0.92, 0);
  let minPrepPelvisY = Infinity;
  let minPrepHandRelZ = Infinity;
  for (let p = 1; p <= 5; p++) {
    standRig.update(dt, 0, 0, 0, () => 0, null, -p / 5);
    minPrepPelvisY = Math.min(minPrepPelvisY, standRig.pelvisY);
    const shL = boneWorldPos(standRig, PERSON_BONES.UPPER_ARM_L);
    const handL = boneWorldPos(standRig, PERSON_BONES.FOREARM_L, handOffset);
    minPrepHandRelZ = Math.min(minPrepHandRelZ, handL.z - shL.z);
  }
  assert.ok(standPelvis0 - minPrepPelvisY > 0.05, `standing jump prep crouches pelvis (${((standPelvis0 - minPrepPelvisY) * 100).toFixed(1)} cm)`);
  assert.ok(minPrepHandRelZ < -0.05, `standing jump prep swings arms back before launch (${minPrepHandRelZ.toFixed(2)} m)`);

  let sy = 0, svy = 5.2;
  let apexAnkleClearance = 0;
  let preLandAnkleClearance = Infinity;
  let maxStandLandDrop = 0;
  let minStandSoleY = Infinity;
  for (let f = 0; f < 65; f++) {
    if (svy !== 0 || sy > 0) {
      svy -= 14.5 * dt;
      sy += svy * dt;
      if (sy <= 0) { sy = 0; svy = 0; }
    }
    standRig.update(dt, 0, 0, 0, () => 0, null, sy > 0 ? Math.max(0.006, sy) : 0);
    if (Math.abs(svy) < 0.35 && sy > 0.8) {
      apexAnkleClearance = Math.max(apexAnkleClearance, standRig.feet[0].ay - sy);
    }
    if (svy < -4.2 && sy > 0.05 && sy < 0.25) {
      preLandAnkleClearance = Math.min(preLandAnkleClearance, standRig.feet[0].ay - sy);
    }
    if (f > 15 && sy === 0) {
      maxStandLandDrop = Math.max(maxStandLandDrop, standRig.landDrop);
    }
    for (let i = 0; i < 2; i++) {
      const foot = standRig.feet[i];
      const heel = boneWorldPos(standRig, i === 0 ? PERSON_BONES.FOOT_L : PERSON_BONES.FOOT_R, new Vector3(foot.side * 0.09, 0, -0.078));
      const toe = boneWorldPos(standRig, i === 0 ? PERSON_BONES.TOE_L : PERSON_BONES.TOE_R, new Vector3(foot.side * 0.09, 0.005, 0.208));
      minStandSoleY = Math.min(minStandSoleY, heel.y, toe.y);
    }
  }
  assert.ok(apexAnkleClearance - preLandAnkleClearance > 0.1,
    `standing jump extends legs downward before touchdown instead of freezing at apex (${apexAnkleClearance.toFixed(3)} -> ${preLandAnkleClearance.toFixed(3)} m)`);
  assert.ok(maxStandLandDrop > 0.07, `standing landing compresses into weighty absorption squat (${(maxStandLandDrop * 100).toFixed(1)} cm)`);
  assert.ok(minStandSoleY > -0.005, `standing jump & landing never clip shoe soles below pavement (${(minStandSoleY * 100).toFixed(2)} cm)`);

  // 2. Full-speed sprint jump (8.2 m/s): body-relative split-leap with zero world-space backward foot drag
  const rig = new PersonRig({ seed: 4.2, scale: 1.0 });
  let z = 0, y = 0, vy = 0;
  rig.reset(0, 0, 0, () => 0);
  for (let f = 0; f < 90; f++) {
    z += 8.2 * dt;
    rig.update(dt, 0, z, 0, () => 0, null, 0);
  }

  vy = 5.2;
  let apexKneeBend = 0;
  let maxLeadFootRelZ = -Infinity;
  let minTrailFootRelZ = Infinity;
  let landed = false;
  let maxLandDrop = 0;
  for (let f = 0; f < 60; f++) {
    z += 8.2 * dt;
    if (vy !== 0 || y > 0) {
      vy -= 14.5 * dt;
      y = Math.max(0, y + vy * dt);
      if (y === 0) vy = 0;
    }
    rig.update(dt, 0, z, 0, () => 0, null, y > 0 ? Math.max(0.006, y) : 0);
    if (y > 0.4) {
      const r0 = rig.feet[0].az - z;
      const r1 = rig.feet[1].az - z;
      maxLeadFootRelZ = Math.max(maxLeadFootRelZ, Math.max(r0, r1));
      minTrailFootRelZ = Math.min(minTrailFootRelZ, Math.min(r0, r1));
    }
    if (y > 0.8) apexKneeBend = Math.max(apexKneeBend, legKneeBendDeg(rig, 0), legKneeBendDeg(rig, 1));
    if (f > 10 && y === 0) {
      landed = true;
      maxLandDrop = Math.max(maxLandDrop, rig.landDrop);
    }
  }
  assert.ok(apexKneeBend > 45, `sprint jump apex folds knees into split-leap (${apexKneeBend.toFixed(1)}°)`);
  assert.ok(maxLeadFootRelZ > 0.18, `sprint jump keeps lead foot ahead of hip instead of lagging behind (${maxLeadFootRelZ.toFixed(2)} m)`);
  assert.ok(minTrailFootRelZ > -0.52, `sprint jump trail foot sweeps cleanly without world-space drag (${minTrailFootRelZ.toFixed(2)} m)`);
  assert.ok(landed && maxLandDrop > 0.025, `sprint landing cushions smoothly into next stride (${(maxLandDrop * 100).toFixed(2)} cm)`);

  // 3. High heel-kick above knee height must keep shin lateral axis aligned with thigh (no 180° flip)
  rig.reset(0, 0, 0, () => 0);
  const hip = new Vector3(0.09, 0.92, 0);
  const highHeel = new Vector3(0.09, 0.62, -0.32); // forces knee forward/down and ankle higher than knee
  rig.solveLeg(0, hip, highHeel, 0);
  const oThigh = PERSON_BONES.THIGH_L * 8;
  const oShin = PERSON_BONES.SHIN_L * 8;
  const qThigh = new Quaternion(rig.pose[oThigh], rig.pose[oThigh + 1], rig.pose[oThigh + 2], rig.pose[oThigh + 3]);
  const qShin = new Quaternion(rig.pose[oShin], rig.pose[oShin + 1], rig.pose[oShin + 2], rig.pose[oShin + 3]);
  const xThigh = new Vector3(1, 0, 0).applyQuaternion(qThigh);
  const xShin = new Vector3(1, 0, 0).applyQuaternion(qShin);
  assert.ok(xThigh.dot(xShin) > 0.98, `shin shares thigh hinge axis without twisting (dot=${xThigh.dot(xShin).toFixed(4)})`);
});

test('PersonRig full-speed sprint stays vertically smooth even under uneven browser frame times', () => {
  const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });
  const dtSeq = [0.0142, 0.0189, 0.0155, 0.0208, 0.0138, 0.0174, 0.0166];
  let z = 0;
  rig.reset(0, 0, 0, () => 0);
  let minPelvisY = Infinity, maxPelvisY = -Infinity;
  let maxFrameStep = 0;
  let prevPelvisY = rig.pelvisY;

  for (let f = 0; f < 220; f++) {
    const dt = dtSeq[f % dtSeq.length];
    z += 8.2 * dt;
    rig.update(dt, 0, z, 0, () => 0);
    if (f >= 90) {
      minPelvisY = Math.min(minPelvisY, rig.pelvisY);
      maxPelvisY = Math.max(maxPelvisY, rig.pelvisY);
      maxFrameStep = Math.max(maxFrameStep, Math.abs(rig.pelvisY - prevPelvisY));
    }
    prevPelvisY = rig.pelvisY;
  }
  assert.ok(maxPelvisY - minPelvisY < 0.03, `uneven dt sprint keeps subtle vertical bob (${((maxPelvisY - minPelvisY) * 100).toFixed(2)} cm)`);
  assert.ok(maxFrameStep < 0.006, `uneven dt sprint avoids frame-to-frame pelvis jumps (${(maxFrameStep * 100).toFixed(2)} cm/frame)`);
});

test('PersonRig running uses spring-mass vertical phase, shin-aligned swing feet, and zero-lag contralateral arm pump', () => {
  const dt = 1 / 60;

  // 1. Walking vs running vertical phase: walking peaks near single-leg passing; running peaks in aerial flight above mid-stance
  const walkRig = new PersonRig({ seed: 1, scale: 1.0 });
  walkRig.reset(0, 0, 0, () => 0);
  let wz = 0;
  let walkContactY = 0, walkContactN = 0, walkPassY = 0, walkPassN = 0;
  for (let f = 0; f < 240; f++) {
    wz += 1.5 * dt;
    walkRig.update(dt, 0, wz, 0, () => 0);
    if (f < 90) continue;
    const p = walkRig.phase % 0.5;
    if (p > 0.08 && p < 0.16) { walkContactY += walkRig.pelvisY; walkContactN++; }
    if (p > 0.28 && p < 0.38) { walkPassY += walkRig.pelvisY; walkPassN++; }
  }
  assert.ok(walkPassY / walkPassN > walkContactY / walkContactN + 0.012,
    'walk vaults higher at single-leg passing than weight-acceptance');

  const runRig = new PersonRig({ seed: 1, scale: 1.0 });
  runRig.reset(0, 0, 0, () => 0);
  let rz = 0;
  let midStanceY = 0, midStanceN = 0, midFlightY = 0, midFlightN = 0;
  let maxDorsiflexRad = -Infinity;
  let maxRightHandRelZAtLeftPushOff = -Infinity;
  let minLeftHandRelZAtLeftPushOff = Infinity;

  for (let f = 0; f < 240; f++) {
    rz += 6.5 * dt;
    runRig.update(dt, 0, rz, 0, () => 0);
    if (f < 90) continue;

    const bothSwing = runRig.feet[0].swing && runRig.feet[1].swing;
    const p = runRig.phase % 0.5;
    if (!bothSwing && p > 0.08 && p < 0.16) { midStanceY += runRig.pelvisY; midStanceN++; }
    if (bothSwing && p > 0.33 && p < 0.43) { midFlightY += runRig.pelvisY; midFlightN++; }

    // 2. Swing foot follows shin angle without "magnetic hoverboot" hyper-dorsiflexion during high heel recovery
    for (let i = 0; i < 2; i++) {
      if (!runRig.feet[i].swing) continue;
      const shinBone = i === 0 ? PERSON_BONES.SHIN_L : PERSON_BONES.SHIN_R;
      const footBone = i === 0 ? PERSON_BONES.FOOT_L : PERSON_BONES.FOOT_R;
      const knee = boneWorldPos(runRig, shinBone);
      const ankle = boneWorldPos(runRig, footBone);
      const shinPitch = Math.atan2(knee.z - ankle.z, knee.y - ankle.y);
      const oFoot = footBone * 8;
      const qFoot = new Quaternion(runRig.pose[oFoot], runRig.pose[oFoot + 1], runRig.pose[oFoot + 2], runRig.pose[oFoot + 3]);
      const footFwd = new Vector3(0, 0, 1).applyQuaternion(qFoot);
      const footPitch = Math.atan2(-footFwd.y, footFwd.z);
      maxDorsiflexRad = Math.max(maxDorsiflexRad, shinPitch - footPitch);
    }

    // 3. At left push-off / right high-knee drive (phase ~0.24..0.30), left hand drives forward while right elbow/hand drives back
    if (runRig.phase > 0.24 && runRig.phase < 0.30) {
      const shL = boneWorldPos(runRig, PERSON_BONES.UPPER_ARM_L);
      const shR = boneWorldPos(runRig, PERSON_BONES.UPPER_ARM_R);
      const handL = boneWorldPos(runRig, PERSON_BONES.FOREARM_L, new Vector3(0.24, 0.92, 0));
      const handR = boneWorldPos(runRig, PERSON_BONES.FOREARM_R, new Vector3(-0.24, 0.92, 0));
      // Left leg is trailing behind hip & right knee is driving forward -> left arm pumps forward (+Z), right arm pumps back (-Z)
      minLeftHandRelZAtLeftPushOff = Math.min(minLeftHandRelZAtLeftPushOff, handL.z - shL.z);
      maxRightHandRelZAtLeftPushOff = Math.max(maxRightHandRelZAtLeftPushOff, handR.z - shR.z);
    }
  }

  assert.ok(midFlightY / midFlightN > midStanceY / midStanceN + 0.01,
    `running spring-mass lifts pelvis higher in aerial flight (${(midFlightY / midFlightN).toFixed(3)}) than mid-stance (${(midStanceY / midStanceN).toFixed(3)})`);
  assert.ok(maxDorsiflexRad < 0.5,
    `swing foot stays aligned with shin without horizontal hoverboot hyper-dorsiflexion (${(maxDorsiflexRad * 180 / Math.PI).toFixed(1)}°)`);
  assert.ok(minLeftHandRelZAtLeftPushOff > 0.12 && maxRightHandRelZAtLeftPushOff < 0.05,
    `contralateral arms oppose thigh scissor at push-off (L=${minLeftHandRelZAtLeftPushOff.toFixed(2)}m, R=${maxRightHandRelZAtLeftPushOff.toFixed(2)}m)`);
});

// Points around each bone (its joint and 6 cm off it each way), in world space as posed
function bonePoints(rig) {
  const out = [];
  for (let b = 0; b < 15; b++) {
    for (const [dx, dy, dz] of [[0, 0, 0], [0.06, 0, 0], [0, 0.06, 0], [0, 0, 0.06]]) {
      out.push(boneWorldPos(rig, b, rig.bind[b].clone().add(new Vector3(dx, dy, dz))));
    }
  }
  return out;
}

test('PersonRig gives a ragdoll its joints and takes the bones back from them', () => {
  const dt = 1 / 60;
  for (const female of [false, true]) {
    const rig = new PersonRig({ seed: 3.1, scale: female ? 0.95 : 1.04, female, girth: 1.05 });
    rig.reset(2, 5, 0.7, () => 0.22);
    let z = 5;
    for (let f = 0; f < 50; f++) {
      z += 1.4 * dt;
      rig.update(dt, 2 + (z - 5) * Math.sin(0.7), 5 + (z - 5) * Math.cos(0.7), 0.7, () => 0.22);
    }
    const before = bonePoints(rig);
    const points = rig.ragdollPoints(new Float64Array(17 * 3));
    rig.fromRagdoll(points);
    const after = bonePoints(rig);
    let worst = 0, worstBone = -1;
    before.forEach((p, i) => {
      const d = p.distanceTo(after[i]);
      if (d > worst) { worst = d; worstBone = Math.floor(i / 4); }
    });
    // limbs may turn a little about their own axes (a point frame can't tell a straight limb's twist)
    assert.ok(worst < 0.035, `${female ? 'female' : 'male'}: bones rebuilt from the ragdoll's points within ${(worst * 100).toFixed(1)} cm (bone ${worstBone})`);
  }
});

test('PersonRig bind-pose ragdoll points rebuild the bind pose exactly', () => {
  const rig = new PersonRig({ seed: 1, scale: 1 });
  const points = rig.ragdollBind(new Float64Array(17 * 3));
  rig.fromRagdoll(points);
  for (let b = 0; b < 15; b++) {
    const o = b * 8;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rig.pose[o + 3])));
    assert.ok(angle < 1e-3, `bone ${b} unrotated (${(angle * 180 / Math.PI).toFixed(2)}°)`);
    assert.ok(Math.hypot(rig.pose[o + 4], rig.pose[o + 5], rig.pose[o + 6]) < 1e-3, `bone ${b} untranslated`);
  }
});

test('a vehicle driving into a walker knocks them down; they lie a while, get up and walk back to their way', () => {
  const { createPedestrianSystem } = loadModule(readFileSync(join(__dirname, '../js/pedestrian-system.js'), 'utf8'), {
    imports: {
      './city-config.js': { blockAt: () => null },
      './pedestrian-routes.js': { createPedestrianRoutes: () => ({ next: () => null, share: () => 1, canDodge: () => true }) },
      './pedestrians.js': pedestriansModule,
      './ragdoll.js': ragdollModule
    }
  });
  // a box of a car body coming down the sidewalk line the other way, braking hard once it hits
  const v = [];
  for (const x of [-0.9, 0.9]) for (const y of [0.3, 1.2]) for (const z of [-2.2, 2.2]) v.push(x, y, z);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const idx = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const shape = ragdollModule.vehicleShape({
    attributes: { position: { count: 8, getX: (i) => v[i * 3], getY: (i) => v[i * 3 + 1], getZ: (i) => v[i * 3 + 2] } },
    index: { count: idx.length, getX: (i) => idx[i] }
  });
  const car = Object.assign(ragdollModule.createMover(), { shape, x: 0, z: 34, heading: Math.PI, vz: -10, mass: 1600 });
  const movers = [car];
  const system = createPedestrianSystem({ nodes: [] }, {
    player: { active: false }, nearEdges: [], nearSignals: [], mayCross: () => true, walkOn: () => true,
    visible: () => true, nearView: () => false, movers
  });
  const p = system.peds[0];
  Object.assign(p, { ax: 0, az: 0, ux: 0, uz: 1, len: 60, node: null, side: 0, line: 0, edge: {} }, {
    placed: true, t: 20, dir: 1, x: 0, z: 20, v: p.speed, pause: 0,
    goalX: 0, goalZ: 1e4, goalTime: Infinity, restTime: Infinity, socialTime: Infinity, avoidCheck: 0
  });
  p.route = p;
  const hits = [];
  system.setHitListener((who, by) => hits.push([who, by]));
  const seen = new Set();
  let clock = 0, hitAt = -1, highest = 0, carStopped = 0;
  for (let k = 0; k < 20 / 0.02 && (hitAt < 0 || p.fall || clock < hitAt + 1); k++) {
    clock += 0.02;
    if (hitAt >= 0) car.vz = Math.min(0, car.vz + 8 * 0.02);
    car.z += car.vz * 0.02;
    if (car.vz === 0 && !carStopped) carStopped = clock;
    // drive away again once it has stopped, so they can get up
    if (carStopped && clock > carStopped + 1) car.x = 50;
    car.jx = car.jy = car.jz = 0;
    system.update(0.02, clock, 0, 20, false, true, 'person');
    if (p.fall) {
      seen.add(p.fall.mode);
      if (hitAt < 0) hitAt = clock;
      assert.ok(system.fallen.includes(p) || clock - 0.02 < hitAt, 'traffic is told who is down');
      if (p.fall.mode === 'tumble') highest = Math.max(highest, p.ragdoll.pelvisY);
    }
  }
  assert.ok(hitAt > 0 && hits.length >= 1 && hits[0][0] === p && hits[0][1] === car, 'knocked down by the car (reported once)');
  assert.deepEqual([...seen], ['tumble', 'rise', 'return'], 'fell, got up and walked back');
  assert.equal(p.fall, null, 'back on its way');
  assert.ok(Math.abs(p.x) < 0.3 && p.t > 0 && p.t < 60, `on its sidewalk line again (x ${p.x.toFixed(2)}, t ${p.t.toFixed(1)})`);
  assert.ok(highest < 2.5, `no launch (pelvis at most ${highest.toFixed(2)} m)`);
});
