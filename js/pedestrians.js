import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  int,
  vec2,
  vec3,
  vec4,
  color,
  attribute,
  instanceIndex,
  attributeArray,
  normalLocal,
  varying,
  vertexStage,
  cross,
  normalize,
  sin,
  abs,
  fract,
  max,
  clamp,
  mix,
  step,
  smoothstep
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Skinned characters for pedestrian-system.js and the player controllers.
// Each crowd level uses one instanced draw, with 15-bone poses in a storage buffer and seeded appearance.
// PersonRig plants footsteps in world space and uses two-bone IK to place the legs; it also handles
// turns, curb steps, running, jumping, evasive dives, cycling and weight shifts while standing.

// ============================================================================
// 1. SKELETON
// ============================================================================
const BONE = {
  PELVIS: 0,
  CHEST: 1,
  HEAD: 2,
  UPPER_ARM_L: 3,
  FOREARM_L: 4,
  UPPER_ARM_R: 5,
  FOREARM_R: 6,
  THIGH_L: 7,
  SHIN_L: 8,
  FOOT_L: 9,
  TOE_L: 10,
  THIGH_R: 11,
  SHIN_R: 12,
  FOOT_R: 13,
  TOE_R: 14
};
const BONE_COUNT = 15;
// vec4s per person in the pose buffer: (quaternion) and (translation, scale) per bone, then (seed, female, girth, hair)
const STRIDE = BONE_COUNT * 2 + 1;

// Bind pose (metres, a 1.75 m person standing at the origin facing +Z, +X on their left): legs straight down, arms
// hanging 8 degrees out from the body
const THIGH = 0.42;
const SHIN = 0.42;
const ANKLE_H = 0.08;
const HIP_X = 0.09;
const UPPER_ARM = 0.3;
const FOREARM = 0.255;
const ARM_BIND_ABDUCTION = 0.14;
const PELVIS_Y = 0.96;
const HIP_Y = ANKLE_H + SHIN + THIGH;
const SIDES = [1, -1]; // left (+X), right (-X)
const LIMB = {
  upperArm: [BONE.UPPER_ARM_L, BONE.UPPER_ARM_R],
  forearm: [BONE.FOREARM_L, BONE.FOREARM_R],
  thigh: [BONE.THIGH_L, BONE.THIGH_R],
  shin: [BONE.SHIN_L, BONE.SHIN_R],
  foot: [BONE.FOOT_L, BONE.FOOT_R],
  toe: [BONE.TOE_L, BONE.TOE_R]
};

function shoulderJoint(female) {
  return female ? [0.165, 1.415, -0.015] : [0.185, 1.43, -0.015];
}

function bindJoints(female) {
  const sh = shoulderJoint(female);
  const ax = Math.sin(ARM_BIND_ABDUCTION) * UPPER_ARM;
  const ay = -Math.cos(ARM_BIND_ABDUCTION) * UPPER_ARM;
  const j = [];
  j[BONE.PELVIS] = new THREE.Vector3(0, PELVIS_Y, 0);
  j[BONE.CHEST] = new THREE.Vector3(0, 1.12, -0.01);
  j[BONE.HEAD] = new THREE.Vector3(0, 1.52, -0.012);
  SIDES.forEach((side, k) => {
    j[LIMB.upperArm[k]] = new THREE.Vector3(side * sh[0], sh[1], sh[2]);
    j[LIMB.forearm[k]] = new THREE.Vector3(side * (sh[0] + ax), sh[1] + ay, sh[2]);
    j[LIMB.thigh[k]] = new THREE.Vector3(side * HIP_X, HIP_Y, 0);
    j[LIMB.shin[k]] = new THREE.Vector3(side * HIP_X, ANKLE_H + SHIN, 0);
    j[LIMB.foot[k]] = new THREE.Vector3(side * HIP_X, ANKLE_H, 0);
    j[LIMB.toe[k]] = new THREE.Vector3(side * HIP_X, 0.02, 0.135);
  });
  return j;
}
const BIND = [bindJoints(false), bindJoints(true)];

// ============================================================================
// 2. SKINNED LOFTED BODY GEOMETRY
// ============================================================================
const PART = { BODY: 0, LEG: 1, SHOE: 2, ARM: 3, HAND: 4, HEAD: 5, HAIR: 6, LONG_HAIR: 7 };

// Superellipse ring around a vertical axis (x across, z to the front `rzF` or back `rzB`); `bump(a)` pushes points out
function ringY(y, rx, rzF, rzB, cz, n, ex = 2, bump = null, cx = 0) {
  const e = 2 / ex;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x = Math.sign(c) * Math.abs(c) ** e * rx;
    let z = Math.sign(s) * Math.abs(s) ** e * (s >= 0 ? rzF : rzB);
    const b = bump ? bump(a) : 0;
    if (b) {
      const r = Math.hypot(x, z) || 1;
      x += (x / r) * b;
      z += (z / r) * b;
    }
    out.push(new THREE.Vector3(cx + x, y, cz + z));
  }
  return out;
}

const _down = new THREE.Vector3(0, -1, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
// Ring around a limb axis `dir` (rows run along it): x stays roughly across the body, z to the front; `twist` turns
// the ring about the axis
function limbRing(center, dir, rx, rz, n, ex = 2, twist = 0) {
  const q = new THREE.Quaternion().setFromUnitVectors(_down, dir);
  return ringY(0, rx, rz, rz, 0, n, ex).map((p) => p.applyAxisAngle(_yAxis, twist).applyQuaternion(q).add(center));
}

// Gaussian bump around angle a0 (wrapping)
function lobe(a, a0, width) {
  let d = a - a0;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return Math.exp(-(d * d) / (width * width));
}

// Closed loft through rings of equal size (rows of the surface), with optional flat caps (centroid fans). Returns
// positions, uvs (u along the rows, v around), indices and the row each vertex belongs to; rings with the same layout
// give vertex-for-vertex matching positions, which the morph targets rely on.
function loftRings(sections, capStart, capEnd) {
  const rows = sections.length;
  const columns = sections[0].length;
  const per = columns + 1;
  const positions = [];
  const uvs = [];
  const indices = [];
  const rowOf = [];
  const rowU = [0];
  for (let i = 1; i < rows; i++) {
    let d = 0;
    for (let j = 0; j < columns; j++) d += sections[i][j].distanceTo(sections[i - 1][j]);
    rowU.push(rowU[i - 1] + d / columns);
  }
  const totalU = rowU[rows - 1] || 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < per; j++) {
      const p = sections[i][j % columns];
      positions.push(p.x, p.y, p.z);
      uvs.push(rowU[i] / totalU, j / columns);
      rowOf.push(i);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * per + j;
      const b = a + 1;
      const c = a + per + 1;
      const d = a + per;
      indices.push(a, b, d, b, c, d);
    }
  }
  const cap = (row, flip) => {
    const start = positions.length / 3;
    const centre = new THREE.Vector3();
    for (let j = 0; j < columns; j++) {
      const p = sections[row][j];
      centre.add(p);
      positions.push(p.x, p.y, p.z);
      uvs.push(row === 0 ? 0 : 1, j / columns);
      rowOf.push(row);
    }
    centre.divideScalar(columns);
    positions.push(centre.x, centre.y, centre.z);
    uvs.push(row === 0 ? 0 : 1, 0.5);
    rowOf.push(row);
    const c = start + columns;
    for (let j = 0; j < columns; j++) {
      const a = start + j;
      const b = start + ((j + 1) % columns);
      if (flip) indices.push(c, b, a);
      else indices.push(c, a, b);
    }
  };
  // rings run counter-clockwise looking back along the rows: the first cap faces back, the last one forward
  if (capStart) cap(0, true);
  if (capEnd) cap(rows - 1, false);
  return { positions, uvs, indices, rowOf, rows, per };
}

class BodyBuilder {
  constructor() {
    this.geometries = [];
  }

  // rows: { pts, ptsF (female), ptsH (more hair volume), ptsL (long hair), skin: [boneA, boneB, weightB], axis }
  // flattenBelow: normals of vertices lower than this face less downwards (the crotch of the trousers reads as cloth,
  // not as a dark gap between the legs)
  loft(rows, part, { capStart = false, capEnd = false, flattenBelow = -1 } = {}) {
    const lo = loftRings(rows.map((r) => r.pts), capStart, capEnd);
    const variant = (key) => (rows.some((r) => r[key]) ? loftRings(rows.map((r) => r[key] || r.pts), capStart, capEnd).positions : null);
    const fem = variant('ptsF');
    const vol = variant('ptsH');
    const long = variant('ptsL');

    const geo = new THREE.BufferGeometry();
    geo.setIndex(lo.indices);
    // normals of the shape as seen: the long hair's hanging down, not its bind pose folded away inside the head
    geo.setAttribute('position', new THREE.Float32BufferAttribute(long || lo.positions, 3));
    geo.computeVertexNormals();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(lo.positions, 3));
    // weld the normals along the seam of every ring
    const normals = geo.attributes.normal;
    for (let i = 0; i < lo.rows; i++) {
      const a = i * lo.per;
      const b = a + lo.per - 1;
      _seam.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b), normals.getZ(a) + normals.getZ(b)).normalize();
      normals.setXYZ(a, _seam.x, _seam.y, _seam.z);
      normals.setXYZ(b, _seam.x, _seam.y, _seam.z);
    }
    for (let v = 0; v < normals.count; v++) {
      if (lo.positions[v * 3 + 1] >= flattenBelow || normals.getY(v) >= 0) continue;
      _seam.set(normals.getX(v), normals.getY(v) * 0.3, normals.getZ(v)).normalize();
      normals.setXYZ(v, _seam.x, _seam.y, _seam.z);
    }

    // Packed (WebGPU allows 8 vertex buffers): skin = (bone A, bone B, weight of B, part), extra = (girth direction
    // x & z, u along the loft), femaleDelta, hairDelta (hair volume on the shell, hair length on the long hair)
    const pos = lo.positions;
    const count = pos.length / 3;
    const skin = new Float32Array(count * 4);
    const extra = new Float32Array(count * 3);
    const femaleDelta = new Float32Array(count * 3);
    const hairDelta = new Float32Array(count * 3);
    const hair = vol || long;
    for (let v = 0; v < count; v++) {
      const row = rows[lo.rowOf[v]];
      skin[v * 4] = row.skin[0];
      skin[v * 4 + 1] = row.skin[1];
      skin[v * 4 + 2] = row.skin[2];
      skin[v * 4 + 3] = part;
      if (row.axis) {
        extra[v * 3] = pos[v * 3] - row.axis.x;
        extra[v * 3 + 1] = pos[v * 3 + 2] - row.axis.z;
      }
      extra[v * 3 + 2] = lo.uvs[v * 2];
      for (let k = 0; k < 3; k++) {
        if (fem) femaleDelta[v * 3 + k] = fem[v * 3 + k] - pos[v * 3 + k];
        if (hair) hairDelta[v * 3 + k] = hair[v * 3 + k] - pos[v * 3 + k];
      }
    }
    geo.setAttribute('skin', new THREE.BufferAttribute(skin, 4));
    geo.setAttribute('extra', new THREE.BufferAttribute(extra, 3));
    geo.setAttribute('femaleDelta', new THREE.BufferAttribute(femaleDelta, 3));
    geo.setAttribute('hairDelta', new THREE.BufferAttribute(hairDelta, 3));
    this.geometries.push(geo);
  }

  build() {
    const geo = mergeGeometries(this.geometries);
    geo.computeBoundingSphere();
    return geo;
  }
}
const _seam = new THREE.Vector3();

// Profiles: [y, rx, rzFront, rzBack, centreZ, keepInFarLod] for the male base and the female morph target
const TORSO = {
  m: [
    [1.615, 0.046, 0.044, 0.048, -0.004, 1],
    [1.575, 0.051, 0.049, 0.053, -0.008, 0],
    [1.53, 0.058, 0.053, 0.057, -0.013, 1],
    [1.5, 0.1, 0.064, 0.07, -0.018, 0],
    [1.47, 0.163, 0.08, 0.082, -0.02, 1],
    [1.44, 0.188, 0.095, 0.089, -0.018, 1],
    [1.4, 0.186, 0.108, 0.093, -0.014, 0],
    [1.34, 0.177, 0.118, 0.096, -0.01, 1],
    [1.27, 0.167, 0.117, 0.093, -0.006, 0],
    [1.2, 0.157, 0.11, 0.089, -0.002, 1],
    [1.13, 0.15, 0.104, 0.086, 0, 0],
    [1.06, 0.154, 0.101, 0.089, 0, 1],
    [0.99, 0.163, 0.099, 0.099, 0, 0],
    [0.935, 0.166, 0.095, 0.106, 0, 1],
    [0.885, 0.152, 0.078, 0.1, 0, 0],
    [0.845, 0.1, 0.055, 0.075, 0, 1]
  ],
  f: [
    [1.615, 0.042, 0.04, 0.044, -0.004],
    [1.575, 0.045, 0.043, 0.047, -0.008],
    [1.53, 0.051, 0.047, 0.051, -0.012],
    [1.5, 0.086, 0.056, 0.062, -0.016],
    [1.47, 0.142, 0.072, 0.074, -0.018],
    [1.44, 0.164, 0.085, 0.081, -0.016],
    [1.4, 0.163, 0.1, 0.084, -0.012],
    [1.34, 0.157, 0.122, 0.087, -0.006],
    [1.27, 0.148, 0.118, 0.084, -0.002],
    [1.2, 0.136, 0.097, 0.08, 0],
    [1.13, 0.127, 0.09, 0.078, 0],
    [1.06, 0.144, 0.094, 0.086, 0],
    [0.99, 0.165, 0.098, 0.103, 0],
    [0.935, 0.174, 0.096, 0.112, 0],
    [0.885, 0.16, 0.08, 0.106, 0],
    [0.845, 0.104, 0.056, 0.078, 0]
  ]
};

function torsoSkin(y) {
  if (y > 1.6) return [BONE.CHEST, BONE.HEAD, 1];
  if (y > 1.56) return [BONE.CHEST, BONE.HEAD, 0.65];
  if (y > 1.52) return [BONE.CHEST, BONE.HEAD, 0.2];
  if (y > 1.15) return [BONE.CHEST, BONE.CHEST, 0];
  if (y > 1.1) return [BONE.PELVIS, BONE.CHEST, 0.5];
  if (y > 1.03) return [BONE.PELVIS, BONE.CHEST, 0.15];
  return [BONE.PELVIS, BONE.PELVIS, 0];
}

// [y, rx, rzFront, rzBack, centreZ, keepInFarLod] around each leg's axis (x = +-HIP_X)
const LEG = {
  m: [
    [0.975, 0.054, 0.054, 0.054, 0, 1],
    [0.925, 0.062, 0.072, 0.075, 0, 0],
    [0.865, 0.083, 0.088, 0.091, 0.003, 1],
    [0.77, 0.078, 0.083, 0.083, 0.006, 0],
    [0.67, 0.071, 0.075, 0.073, 0.008, 1],
    [0.59, 0.064, 0.067, 0.064, 0.008, 0],
    [0.535, 0.058, 0.062, 0.058, 0.008, 1],
    [0.5, 0.056, 0.061, 0.056, 0.008, 1],
    [0.465, 0.054, 0.058, 0.056, 0.004, 1],
    [0.415, 0.054, 0.056, 0.06, 0, 0],
    [0.335, 0.053, 0.054, 0.061, -0.004, 1],
    [0.245, 0.051, 0.052, 0.054, -0.003, 0],
    [0.17, 0.051, 0.053, 0.053, 0, 1],
    [0.13, 0.052, 0.055, 0.053, 0.004, 0],
    [0.1, 0.044, 0.046, 0.044, 0.004, 1]
  ],
  f: [
    [0.975, 0.056, 0.056, 0.056, 0],
    [0.925, 0.066, 0.074, 0.08, 0],
    [0.865, 0.087, 0.087, 0.094, 0.003],
    [0.77, 0.078, 0.079, 0.08, 0.006],
    [0.67, 0.067, 0.069, 0.067, 0.008],
    [0.59, 0.057, 0.059, 0.057, 0.008],
    [0.535, 0.051, 0.055, 0.051, 0.008],
    [0.5, 0.049, 0.053, 0.049, 0.008],
    [0.465, 0.047, 0.051, 0.049, 0.004],
    [0.415, 0.047, 0.049, 0.054, 0],
    [0.335, 0.046, 0.047, 0.056, -0.004],
    [0.245, 0.04, 0.042, 0.045, -0.003],
    [0.17, 0.035, 0.037, 0.037, 0],
    [0.13, 0.034, 0.036, 0.035, 0.003],
    [0.1, 0.031, 0.033, 0.032, 0.003]
  ]
};

function legSkin(y, k) {
  const thigh = LIMB.thigh[k];
  const shin = LIMB.shin[k];
  const foot = LIMB.foot[k];
  // the hip bends over 0.75-0.95 m, below the jacket's hem, so the thigh tops stay inside the pelvis
  if (y > 0.95) return [BONE.PELVIS, thigh, 0.05];
  if (y > 0.9) return [BONE.PELVIS, thigh, 0.3];
  if (y > 0.84) return [BONE.PELVIS, thigh, 0.72];
  if (y > 0.74) return [BONE.PELVIS, thigh, 0.93];
  if (y > 0.55) return [thigh, thigh, 0];
  if (y > 0.52) return [thigh, shin, 0.12];
  if (y > 0.48) return [thigh, shin, 0.5];
  if (y > 0.44) return [thigh, shin, 0.88];
  if (y > 0.15) return [shin, shin, 0];
  if (y > 0.115) return [shin, foot, 0.25];
  return [shin, foot, 0.5];
}

// [distance along the arm from the shoulder, rx, rz, offset towards the body's side, offset forward, keepInFarLod]
const ARM = [
  [-0.022, 0.026, 0.032, -0.024, 0, 1],
  [-0.008, 0.042, 0.05, -0.014, 0, 0],
  [0.012, 0.052, 0.057, -0.006, 0, 1],
  [0.05, 0.055, 0.057, 0.001, 0, 0],
  [0.1, 0.052, 0.052, 0.003, 0, 1],
  [0.16, 0.048, 0.049, 0.001, 0.003, 0],
  [0.23, 0.044, 0.046, 0, 0, 1],
  [0.272, 0.042, 0.043, 0, -0.003, 0],
  [0.3, 0.041, 0.042, 0, -0.005, 1],
  [0.328, 0.042, 0.043, 0, -0.003, 0],
  [0.39, 0.043, 0.042, 0, 0, 1],
  [0.465, 0.038, 0.035, 0, 0, 0],
  [0.525, 0.034, 0.031, 0, 0, 1],
  [0.542, 0.036, 0.033, 0, 0, 1],
  [0.55, 0.028, 0.026, 0, 0, 1]
];
// [distance along the arm, thickness (across), width (front-back), offset forward, keepInFarLod]
const HAND = [
  [0.525, 0.023, 0.026, 0, 1],
  [0.555, 0.021, 0.03, 0.002, 0],
  [0.595, 0.023, 0.04, 0.004, 1],
  [0.64, 0.021, 0.042, 0.004, 0],
  [0.68, 0.017, 0.037, 0.002, 1],
  [0.712, 0.013, 0.028, 0, 0],
  [0.728, 0.008, 0.015, 0, 1]
];
const HAND_TWIST = 0.45; // relaxed hands: palms turned from facing the thighs towards the back

function armSkin(d, k) {
  const ua = LIMB.upperArm[k];
  const fa = LIMB.forearm[k];
  if (d < -0.03) return [BONE.CHEST, ua, 0.32];
  if (d < 0) return [BONE.CHEST, ua, 0.6];
  if (d < 0.06) return [BONE.CHEST, ua, 0.88];
  if (d < 0.26) return [ua, ua, 0];
  if (d < 0.29) return [ua, fa, 0.15];
  if (d < 0.315) return [ua, fa, 0.5];
  if (d < 0.36) return [ua, fa, 0.85];
  return [fa, fa, 0];
}

// [y, rx, rzFront, rzBack, centreZ, keepInFarLod]
const HEAD = {
  m: [
    [1.752, 0.018, 0.018, 0.02, -0.012, 1],
    [1.738, 0.056, 0.058, 0.064, -0.013, 0],
    [1.712, 0.078, 0.082, 0.092, -0.013, 1],
    [1.682, 0.087, 0.09, 0.102, -0.011, 0],
    [1.652, 0.088, 0.093, 0.103, -0.009, 1],
    [1.622, 0.084, 0.094, 0.098, -0.007, 0],
    [1.592, 0.078, 0.095, 0.09, -0.005, 1],
    [1.562, 0.071, 0.091, 0.078, -0.002, 0],
    [1.537, 0.063, 0.085, 0.066, 0.002, 1],
    [1.514, 0.052, 0.074, 0.054, 0.008, 0],
    [1.497, 0.03, 0.048, 0.032, 0.016, 1]
  ],
  f: [
    [1.748, 0.017, 0.017, 0.019, -0.012],
    [1.734, 0.053, 0.055, 0.061, -0.013],
    [1.709, 0.074, 0.078, 0.088, -0.013],
    [1.68, 0.083, 0.086, 0.097, -0.011],
    [1.651, 0.083, 0.089, 0.098, -0.009],
    [1.622, 0.079, 0.09, 0.093, -0.007],
    [1.594, 0.073, 0.09, 0.085, -0.005],
    [1.566, 0.066, 0.086, 0.073, -0.002],
    [1.543, 0.058, 0.08, 0.061, 0.002],
    [1.522, 0.046, 0.068, 0.049, 0.008],
    [1.507, 0.026, 0.042, 0.028, 0.014]
  ]
};

// Nose, brow, cheekbones, chin & ears pushed out of the head's rings
function headBump(y) {
  const front = Math.PI / 2;
  return (a) => {
    let b = 0;
    if (Math.abs(y - 1.592) < 0.02) b += 0.017 * lobe(a, front, 0.16); // nose tip
    if (Math.abs(y - 1.622) < 0.02) b += 0.007 * lobe(a, front, 0.14); // bridge
    if (Math.abs(y - 1.652) < 0.02) b += 0.004 * lobe(a, front, 0.6); // brow ridge
    if (Math.abs(y - 1.562) < 0.02) b += 0.004 * lobe(a, front, 0.2) + 0.004 * (lobe(a, front - 0.75, 0.3) + lobe(a, front + 0.75, 0.3));
    if (Math.abs(y - 1.514) < 0.012) b += 0.006 * lobe(a, front, 0.35); // chin
    if (y < 1.64 && y > 1.575) b += 0.011 * (lobe(a, -0.12, 0.22) + lobe(a, Math.PI + 0.12, 0.22)); // ears
    return b;
  };
}

// Head profile at any height (for the hair shell)
function headAt(table, y) {
  if (y >= table[0][0]) return table[0];
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i];
    const b = table[i + 1];
    if (y <= a[0] && y >= b[0]) {
      const t = (a[0] - y) / (a[0] - b[0]);
      return a.map((v, k) => v + (b[k] - v) * t);
    }
  }
  return table[table.length - 1];
}

const hairlineY = (a) => 1.62 + 0.055 * Math.sin(a) - 0.005 * Math.cos(2 * a);

// Hair shell over the scalp, from the crown to the hairline, `t` thick (thinning to a soft edge at the hairline)
function hairShellRing(table, f, t, n) {
  const crown = table[0][0];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const y = crown + (hairlineY(a) - crown) * f;
    const [, rx, rzF, rzB, cz] = headAt(table, y);
    const p = new THREE.Vector3(Math.cos(a) * rx, y, cz + Math.sin(a) * (Math.sin(a) >= 0 ? rzF : rzB));
    const k = t * (1 - 0.75 * f * f);
    const c = new THREE.Vector3(0, 1.635, -0.012);
    out.push(p.sub(c).multiplyScalar(1 + k / Math.max(0.05, p.length())).add(c));
  }
  return out;
}

// Long hair falling behind the shoulders: [y, rx, rzFront, rzBack, centreZ]
const LONG_HAIR = [
  [1.635, 0.094, 0.045, 0.108, -0.01],
  [1.59, 0.098, 0.034, 0.107, -0.015],
  [1.55, 0.097, 0.03, 0.101, -0.022],
  [1.5, 0.093, 0.028, 0.09, -0.036],
  [1.45, 0.096, 0.028, 0.08, -0.05],
  [1.4, 0.091, 0.026, 0.07, -0.06],
  [1.36, 0.066, 0.02, 0.052, -0.068]
];

// [z from the ankle, half width, top, sole, keepInFarLod] (relative to the ankle joint)
const SHOE = [
  [-0.088, 0.02, -0.02, -0.066, 1],
  [-0.078, 0.034, 0.016, -0.08, 0],
  [-0.05, 0.042, 0.036, -0.08, 1],
  [-0.01, 0.045, 0.032, -0.08, 0],
  [0.04, 0.048, 0.006, -0.08, 1],
  [0.09, 0.05, -0.022, -0.08, 0],
  [0.13, 0.051, -0.035, -0.08, 1],
  [0.165, 0.048, -0.044, -0.08, 0],
  [0.192, 0.039, -0.05, -0.079, 1],
  [0.208, 0.022, -0.056, -0.075, 1]
];

function shoeRing(cx, z, hw, top, sole, n) {
  const out = [];
  const mid = sole + (top - sole) * 0.38;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = Math.sign(c) * Math.abs(c) ** 0.6 * hw;
    const y = s >= 0 ? mid + (top - mid) * s ** 0.85 : mid - (mid - sole) * Math.abs(s) ** 0.35;
    out.push(new THREE.Vector3(cx + x, ANKLE_H + y, z));
  }
  return out;
}

function shoeSkin(z, k) {
  const foot = LIMB.foot[k];
  const toe = LIMB.toe[k];
  if (z < 0.07) return [foot, foot, 0];
  if (z < 0.11) return [foot, toe, 0.12];
  if (z < 0.15) return [foot, toe, 0.55];
  return [toe, toe, 0];
}

const _geometryCache = new Map();

/**
 * The skinned person: detail 1 near (~2000 vertices), 0 far (~600 vertices). Attributes: position & normal (male bind
 * pose), skin (two bones & the weight of the second, part id), extra (girth direction, u along the loft) and the
 * femaleDelta & hairDelta morph targets.
 */
function buildPersonGeometry(detail = 1) {
  if (_geometryCache.has(detail)) return _geometryCache.get(detail);
  const hi = detail > 0;
  const keep = (row, flagIndex) => hi || row[flagIndex] === 1;
  const B = new BodyBuilder();
  const nTorso = hi ? 16 : 8;
  const nLeg = hi ? 12 : 6;
  const nArm = hi ? 10 : 6;
  const nHand = hi ? 8 : 4;
  const nHead = hi ? 20 : 8;
  const nShoe = hi ? 12 : 6;

  // Torso & neck: a soft-cornered chest (superellipse), with a hint of bust on the female target
  const bust = (a) => 0.011 * (lobe(a, Math.PI / 2 - 0.5, 0.38) + lobe(a, Math.PI / 2 + 0.5, 0.38));
  const torsoRows = [];
  TORSO.m.forEach((m, i) => {
    if (!keep(m, 5)) return;
    const f = TORSO.f[i];
    const ex = m[0] > 1.5 ? 2 : m[0] > 1.0 ? 2.35 : 2.15;
    const fBump = m[0] < 1.37 && m[0] > 1.25 ? bust : null;
    torsoRows.push({
      pts: ringY(m[0], m[1], m[2], m[3], m[4], nTorso, ex),
      ptsF: ringY(f[0], f[1], f[2], f[3], f[4], nTorso, ex, fBump),
      skin: torsoSkin(m[0]),
      axis: new THREE.Vector3(0, m[0], m[4])
    });
  });
  B.loft(torsoRows, PART.BODY, { capEnd: true, flattenBelow: 0.95 });

  // Trouser legs
  SIDES.forEach((side, k) => {
    const rows = [];
    LEG.m.forEach((m, i) => {
      if (!keep(m, 5)) return;
      const f = LEG.f[i];
      const cx = side * HIP_X;
      rows.push({
        pts: ringY(m[0], m[1], m[2], m[3], m[4], nLeg, 2, null, cx),
        ptsF: ringY(f[0], f[1], f[2], f[3], f[4], nLeg, 2, null, cx),
        skin: legSkin(m[0], k),
        axis: new THREE.Vector3(cx, m[0], m[4])
      });
    });
    B.loft(rows, PART.LEG, { capStart: true, capEnd: true });
  });

  // Sleeves & hands, along each arm's bind direction (female arms: slimmer & from narrower shoulders)
  SIDES.forEach((side, k) => {
    const dir = new THREE.Vector3(side * Math.sin(ARM_BIND_ABDUCTION), -Math.cos(ARM_BIND_ABDUCTION), 0);
    const shM = new THREE.Vector3(...shoulderJoint(false));
    const shF = new THREE.Vector3(...shoulderJoint(true));
    shM.x *= side;
    shF.x *= side;
    const at = (sh, d, ox, oz) => sh.clone().addScaledVector(dir, d).add(new THREE.Vector3(side * ox, 0, oz));
    const sleeve = [];
    for (const r of ARM) {
      if (!keep(r, 5)) continue;
      const [d, rx, rz, ox, oz] = r;
      const c = at(shM, d, ox, oz);
      sleeve.push({
        pts: limbRing(c, dir, rx, rz, nArm),
        ptsF: limbRing(at(shF, d, ox * 0.9, oz), dir, rx * 0.84, rz * 0.84, nArm),
        skin: armSkin(d, k),
        axis: c
      });
    }
    B.loft(sleeve, PART.ARM, { capStart: true, capEnd: true });

    const hand = [];
    const twist = -side * HAND_TWIST;
    for (const r of HAND) {
      if (!keep(r, 4)) continue;
      const [d, rx, rz, oz] = r;
      hand.push({
        pts: limbRing(at(shM, d, 0, oz), dir, rx, rz, nHand, 2, twist),
        ptsF: limbRing(at(shF, d * 0.985, 0, oz), dir, rx * 0.88, rz * 0.88, nHand, 2, twist),
        skin: [LIMB.forearm[k], LIMB.forearm[k], 0],
        axis: null
      });
    }
    B.loft(hand, PART.HAND, { capStart: true, capEnd: true });

    if (hi) {
      // Thumb, along the front edge of the (turned) palm
      const thumb = [
        [0.565, 0.026, 0.011],
        [0.605, 0.038, 0.0105],
        [0.64, 0.044, 0.008]
      ].map(([d, oz, r]) => {
        const off = new THREE.Vector3(side * -0.006, 0, oz).applyAxisAngle(_yAxis, twist);
        return {
          pts: limbRing(shM.clone().addScaledVector(dir, d).add(off), dir, r, r, 6),
          ptsF: limbRing(shF.clone().addScaledVector(dir, d * 0.985).addScaledVector(off, 0.9), dir, r * 0.88, r * 0.88, 6),
          skin: [LIMB.forearm[k], LIMB.forearm[k], 0],
          axis: null
        };
      });
      B.loft(thumb, PART.HAND, { capStart: true, capEnd: true });
    }
  });

  // Head (nose, brow, cheekbones, chin & ears sculpted into the rings)
  const headRows = [];
  HEAD.m.forEach((m, i) => {
    if (!keep(m, 5)) return;
    const f = HEAD.f[i];
    headRows.push({
      pts: ringY(m[0], m[1], m[2], m[3], m[4], nHead, 2, hi ? headBump(m[0]) : null),
      ptsF: ringY(f[0], f[1], f[2], f[3], f[4], nHead, 2, hi ? headBump(m[0]) : null),
      skin: [BONE.HEAD, BONE.HEAD, 0],
      axis: null
    });
  });
  B.loft(headRows, PART.HEAD, { capStart: true, capEnd: true });

  // Hair shell (volume morph) & long hair (length morph, folded away inside the head when short)
  const shell = (hi ? [0.04, 0.22, 0.45, 0.68, 0.86, 1] : [0.04, 0.45, 1]).map((f) => ({
    pts: hairShellRing(HEAD.m, f, 0.006, nHead),
    ptsF: hairShellRing(HEAD.f, f, 0.006, nHead),
    ptsH: hairShellRing(HEAD.m, f, 0.022, nHead),
    skin: [BONE.HEAD, BONE.HEAD, 0],
    axis: null
  }));
  B.loft(shell, PART.HAIR, { capStart: true });
  const nLong = hi ? 14 : 6;
  const longRows = (hi ? LONG_HAIR : LONG_HAIR.filter((r, i) => i % 2 === 0)).map(([y, rx, rzF, rzB, cz]) => ({
    pts: ringY(1.64, 0.02, 0.02, 0.02, -0.03, nLong),
    ptsL: ringY(y, rx, rzF, rzB, cz, nLong, 2.2),
    skin: y > 1.56 ? [BONE.HEAD, BONE.HEAD, 0] : y > 1.47 ? [BONE.HEAD, BONE.CHEST, 0.4] : [BONE.HEAD, BONE.CHEST, 0.8],
    axis: null
  }));
  B.loft(longRows, PART.LONG_HAIR, { capEnd: true });

  // Shoes, heel to toe (the toes bend at the ball of the foot)
  SIDES.forEach((side, k) => {
    const rows = SHOE.filter((r) => keep(r, 4)).map(([z, hw, top, sole]) => ({
      pts: shoeRing(side * HIP_X, z, hw, top, sole, nShoe),
      ptsF: shoeRing(side * HIP_X, z * 0.93, hw * 0.88, top * 0.92, sole, nShoe),
      skin: shoeSkin(z, k),
      axis: null
    }));
    B.loft(rows, PART.SHOE, { capStart: true, capEnd: true });
  });

  const geo = B.build();
  _geometryCache.set(detail, geo);
  return geo;
}

// ============================================================================
// 3. TSL MATERIAL: GPU SKINNING + PROCEDURAL CLOTHES
// ============================================================================
const COAT_COLORS = [0x2b3a52, 0x33332f, 0x8a6a44, 0x5a2f2f, 0x4f5238, 0x6a6a66, 0x222024, 0x7d3f22];
const COAT_COLORS_F = [0x7a2630, 0xb89a72, 0x2e3e5c, 0x1f1d22, 0xc9c1b2, 0x5b6b4a, 0x8c5a7a, 0x3c3c40];
const SHIRT_COLORS = [0xe8e6e0, 0xb8c4d8, 0xcfc8b8, 0x9aa7b8];
const LEG_COLORS = [0x22242c, 0x35485b, 0x51473d, 0x7c7160, 0x252526];
const LEG_COLORS_F = [0x1c1c22, 0x2f4a6e, 0x46413b, 0xcfc8bb, 0x5a2a2e];
const SKIN_COLORS = [0xc68863, 0xa96f4c, 0x8a5535, 0x6b3d24, 0xd9a077];
const HAIR_COLORS = [0x1a1512, 0x3a2a1a, 0x584022, 0x6e6862, 0x2a2624, 0x8f6d43, 0x5e3020];

// Branchless TSL palette selector from an array of hex colors and a [0..1) hash value
function pickColorFromPalette(hexArray, tNode) {
  const n = hexArray.length;
  const scaled = tNode.mul(n);
  let acc = color(hexArray[0]);
  for (let i = 1; i < n; i++) {
    acc = mix(acc, color(hexArray[i]), step(float(i), scaled));
  }
  return acc;
}

// v rotated by unit quaternion q
const qrot = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2.0));

/**
 * Material for one crowd mesh. `pose` is its storage buffer (STRIDE vec4s per instance). The vertex stage morphs the
 * bind pose (girth, female, hair), skins it with two bones and resolves per-instance palette colours & style flags;
 * the near LOD (`detail = 1`) adds fine procedural facial/jacket/shoe detail per body part in the fragment stage,
 * while the far LOD (`detail = 0`) shades its part colours directly in the vertex stage.
 */
function createPersonMaterial(pose, detail = 1) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const base = int(instanceIndex).mul(STRIDE);
  const info = pose.element(base.add(STRIDE - 1)); // seed, female, girth, hair

  mat.positionNode = Fn(() => {
    const skin = attribute('skin', 'vec4');
    const extra = attribute('extra', 'vec3');
    // hair volume on the shell (part 6), hair length on the long hair (part 7)
    const hairAmount = mix(clamp(info.w.mul(2.0), 0.0, 1.0), clamp(info.w.mul(2.0).sub(1.0), 0.0, 1.0), step(PART.LONG_HAIR - 0.5, skin.w));
    const p = attribute('position', 'vec3')
      .add(vec3(extra.x, 0.0, extra.y).mul(info.z.sub(1.0)))
      .add(attribute('femaleDelta', 'vec3').mul(info.y))
      .add(attribute('hairDelta', 'vec3').mul(hairAmount));
    const n = attribute('normal', 'vec3');
    const w = skin.z;
    const ia = base.add(int(skin.x).mul(2));
    const ib = base.add(int(skin.y).mul(2));
    const qa = pose.element(ia);
    const ta = pose.element(ia.add(1));
    const qb = pose.element(ib);
    const tb = pose.element(ib.add(1));
    normalLocal.assign(normalize(mix(qrot(qa, n), qrot(qb, n), w)));
    return mix(qrot(qa, p).mul(ta.w).add(ta.xyz), qrot(qb, p).mul(tb.w).add(tb.xyz), w);
  })();

  const skinAttr = attribute('skin', 'vec4');
  const posAttr = attribute('position', 'vec3');
  const extraAttr = attribute('extra', 'vec3');
  const partId = skinAttr.w;
  const isPart = (id) => step(abs(partId.sub(id)), 0.25);
  const isLeg = isPart(PART.LEG);
  const isShoe = isPart(PART.SHOE);
  const isArm = isPart(PART.ARM);
  const isHand = isPart(PART.HAND);
  const isHead = isPart(PART.HEAD);
  const isHairPart = step(PART.HAIR - 0.5, partId);

  const female = info.y;
  const lane = (salt) => fract(sin(info.x.add(salt).mul(12.9898)).mul(43758.5453));
  const skinCol = vertexStage(pickColorFromPalette(SKIN_COLORS, lane(17.0))).toVar();
  const hairCol = vertexStage(pickColorFromPalette(HAIR_COLORS, lane(3.0))).toVar();
  const coatCol = vertexStage(
    mix(pickColorFromPalette(COAT_COLORS, lane(29.0)), pickColorFromPalette(COAT_COLORS_F, lane(29.0)), female)
  ).toVar();
  const shirtCol = vertexStage(pickColorFromPalette(SHIRT_COLORS, lane(71.0))).toVar();
  const legsCol = vertexStage(
    mix(pickColorFromPalette(LEG_COLORS, lane(47.0)), pickColorFromPalette(LEG_COLORS_F, lane(47.0)), female)
  ).toVar();
  const bald = vertexStage(step(lane(41.0), 0.08).mul(float(1.0).sub(female))).toVar();
  const tailored = vertexStage(step(0.42, lane(89.0))).toVar();
  const hemY = vertexStage(mix(mix(0.955, 0.88, female), 1.0, lane(61.0))).toVar();
  const sneaker = vertexStage(step(0.4, lane(5.0))).toVar();
  const upperCol = vertexStage(
    mix(
      mix(color(0x201e1c), color(0x4a3524), lane(23.0)),
      mix(color(0x252b32), color(0xc8c3b8), step(0.55, lane(31.0))),
      sneaker
    )
  ).toVar();
  const soleCol = vertexStage(mix(color(0x191816), color(0xd5d1c8), sneaker)).toVar();
  const cuffCol = vertexStage(mix(coatCol.mul(0.72), shirtCol, tailored)).toVar();
  const roughnessVal = vertexStage(
    mix(
      mix(mix(float(0.86), float(0.55), max(isHand, isHead)), float(0.74), isHairPart),
      float(0.38),
      isShoe.mul(float(1.0).sub(sneaker))
    )
  );

  if (!detail) {
    const vFarSurface = varying(
      vertexStage(
        Fn(() => {
          const q = posAttr;
          const hd = normalize(vec2(q.x, q.z.add(0.01)));
          const hairline = hd.y.mul(0.055).add(1.62).sub(hd.x.mul(hd.x).sub(hd.y.mul(hd.y)).mul(0.005)).add(bald.mul(0.3));
          const headCol = mix(skinCol, hairCol, smoothstep(hairline.sub(0.015), hairline.add(0.015), q.y));
          const hairPartCol = mix(hairCol.mul(0.97), skinCol, bald.mul(step(q.y, 1.755)));
          const opening = q.y.sub(1.33).mul(0.42);
          const shirtV = smoothstep(1.33, 1.36, q.y)
            .mul(step(abs(q.x), opening.add(0.01)))
            .mul(smoothstep(0.035, 0.075, q.z))
            .mul(tailored);
          const neckLine = mix(1.5, 1.49, tailored);
          const torsoCol = mix(mix(legsCol, mix(coatCol, shirtCol, shirtV), step(hemY, q.y)), skinCol, step(neckLine, q.y));
          const sleeveCol = mix(coatCol, cuffCol, smoothstep(0.92, 0.96, extraAttr.z));
          const shoeCol = mix(upperCol, soleCol, step(q.y, 0.022));
          const farCol = mix(
            mix(
              mix(mix(mix(mix(torsoCol, legsCol, isLeg), shoeCol, isShoe), sleeveCol, isArm), skinCol, isHand),
              headCol,
              isHead
            ),
            hairPartCol,
            isHairPart
          );
          return vec4(farCol, roughnessVal);
        })()
      ),
      'vPersonFarSurface'
    );
    mat.colorNode = vFarSurface.xyz;
    mat.roughnessNode = vFarSurface.w;
    return mat;
  }

  // Every lofted sub-mesh has a constant `partId` across its triangles, so each triangle only needs the colours &
  // style flags of its own body part.
  const vPartA = varying(
    vertexStage(
      vec4(
        mix(mix(mix(mix(coatCol, legsCol, isLeg), upperCol, isShoe), skinCol, max(isHand, isHead)), hairCol, isHairPart),
        mix(mix(tailored, sneaker, isShoe), bald, max(isHead, isHairPart))
      )
    ),
    'vPersonPartA'
  );
  const vPartB = varying(
    vertexStage(
      vec4(mix(mix(mix(mix(shirtCol, soleCol, isShoe), cuffCol, isArm), hairCol, isHead), skinCol, isHairPart), hemY)
    ),
    'vPersonPartB'
  );
  const vPartC = varying(vertexStage(vec4(mix(legsCol, skinCol, step(1.18, posAttr.y)), partId)), 'vPersonPartC');
  const vLocal = varying(
    vertexStage(vec4(mix(posAttr.x, extraAttr.z, isArm), posAttr.y, posAttr.z, roughnessVal)),
    'vPersonLocal'
  );

  mat.colorNode = Fn(() => {
    const pId = vPartC.w;
    const colA = vPartA.xyz;
    const colB = vPartB.xyz;
    const param0 = vPartA.w;
    const q = vLocal.xyz;
    const outCol = vec3(colA).toVar();

    If(pId.lessThan(0.5), () => {
      // Torso: collar & neck, tailored jacket (lapels, shirt V) or casual coat (zip, collar band), hem, trousers below
      const isTailored = param0;
      const coatHemY = vPartB.w;
      const chestFront = smoothstep(0.035, 0.075, q.z);
      const opening = q.y.sub(1.33).mul(0.42);
      const shirtV = smoothstep(1.33, 1.35, q.y)
        .mul(smoothstep(0.004, 0.0, abs(q.x).sub(opening)))
        .mul(chestFront)
        .mul(isTailored);
      const lapel = smoothstep(0.024, 0.009, abs(abs(q.x).sub(opening)))
        .mul(smoothstep(1.32, 1.37, q.y))
        .mul(chestFront)
        .mul(isTailored)
        .mul(float(1.0).sub(shirtV));
      const zip = smoothstep(0.006, 0.0025, abs(q.x)).mul(chestFront).mul(float(1.0).sub(isTailored));
      const collarBand = smoothstep(1.455, 1.48, q.y).mul(float(1.0).sub(isTailored));
      const neckLine = mix(1.5, 1.49, isTailored);
      const neck = smoothstep(neckLine.sub(0.004), neckLine.add(0.004), q.y);
      const hem = smoothstep(coatHemY.sub(0.004), coatHemY.add(0.004), q.y);
      const hemShade = smoothstep(coatHemY.add(0.035), coatHemY, q.y).mul(0.12);
      const jacketCol = mix(
        colA.mul(float(1.0).sub(lapel.mul(0.25)).sub(zip.mul(0.4)).sub(collarBand.mul(0.15)).sub(hemShade)),
        colB,
        shirtV
      );
      outCol.assign(mix(mix(vPartC.xyz, jacketCol, hem), vPartC.xyz, neck));
    })
      .ElseIf(pId.lessThan(1.5), () => {
        // Trousers: subtle front crease
        const crease = smoothstep(0.004, 0.0, abs(abs(q.x).sub(HIP_X))).mul(step(0.0, q.z)).mul(0.08);
        outCol.assign(colA.mul(float(1.0).sub(crease)));
      })
      .ElseIf(pId.lessThan(2.5), () => {
        // Shoes: sneakers or leather, soles, laces over the instep
        const isSneaker = param0;
        const sole = smoothstep(0.024, 0.016, q.y);
        const laces = smoothstep(0.6, 0.75, fract(q.z.mul(80.0)))
          .mul(step(abs(abs(q.x).sub(HIP_X)), 0.016))
          .mul(step(0.0, q.z))
          .mul(step(q.z, 0.09))
          .mul(step(0.075, q.y))
          .mul(isSneaker);
        outCol.assign(mix(mix(colA, colB, sole), color(0xb8b4aa), laces.mul(0.6)));
      })
      .ElseIf(pId.lessThan(3.5), () => {
        // Sleeves: cuffs (shirt cuff under a tailored jacket; q.x carries `along`)
        outCol.assign(mix(colA, colB, smoothstep(0.93, 0.96, q.x)));
      })
      .ElseIf(pId.greaterThan(5.5), () => {
        // Hair & long hair: subtle strand variation or bald scalp
        const hairStrands = colA.mul(sin(q.x.mul(170.0).add(q.z.mul(130.0))).mul(0.06).add(0.97));
        outCol.assign(mix(hairStrands, colB, param0.mul(step(q.y, 1.755))));
      })
      .ElseIf(pId.greaterThan(4.5), () => {
        // Head: skin, hairline (none for the bald), eyes, brows, lips
        const isBald = param0;
        const hd = normalize(vec2(q.x, q.z.add(0.01)));
        const hairline = hd.y.mul(0.055).add(1.62).sub(hd.x.mul(hd.x).sub(hd.y.mul(hd.y)).mul(0.005)).add(isBald.mul(0.3));
        const hairMask = smoothstep(hairline.sub(0.004), hairline.add(0.004), q.y);
        const front = smoothstep(0.06, 0.08, q.z);
        const eyeX = abs(abs(q.x).sub(0.031));
        const eyes = smoothstep(0.011, 0.006, eyeX).mul(smoothstep(0.0055, 0.002, abs(q.y.sub(1.627)))).mul(front);
        const brows = smoothstep(0.016, 0.01, eyeX).mul(smoothstep(0.0035, 0.0012, abs(q.y.sub(1.646)))).mul(front);
        const mouth = smoothstep(0.022, 0.014, abs(q.x)).mul(smoothstep(0.0045, 0.0015, abs(q.y.sub(1.549)))).mul(front);
        const faceCol = mix(
          colA.mul(float(1.0).sub(eyes.mul(0.7)).sub(brows.mul(0.45))),
          colA.mul(color(0xb06a5c)).mul(1.15),
          mouth.mul(0.7)
        );
        outCol.assign(mix(faceCol, colB, hairMask));
      });
    return outCol;
  })();

  mat.roughnessNode = vLocal.w;

  return mat;
}

// ============================================================================
// 4. CROWD: ONE INSTANCED, SKINNED DRAW PER LEVEL OF DETAIL
// ============================================================================
class PersonCrowd {
  /**
   * @param {number} maxCount - most people drawn at once
   * @param {{ farDistance?: number, castShadow?: boolean }} options - beyond farDistance (m) people use the far LOD
   */
  constructor(maxCount, { farDistance = 34, castShadow = true } = {}) {
    this.farDistance = farDistance;
    this.updates = 0;
    const levels = Number.isFinite(farDistance) ? [1, 0] : [1];
    this.lods = levels.map((detail) => {
      const pose = attributeArray(maxCount * STRIDE, 'vec4').toReadOnly();
      const mesh = new THREE.Mesh(buildPersonGeometry(detail), createPersonMaterial(pose, detail));
      mesh.name = detail ? 'PeopleNear' : 'PeopleFar';
      mesh.count = 1; // one (degenerate) person until warm-up finishes, so the pipelines compile up front
      mesh.frustumCulled = false;
      mesh.castShadow = Boolean(castShadow && detail > 0);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      return { pose, mesh, count: 0, max: maxCount, hasZero: true };
    });
    this.meshes = this.lods.map((l) => l.mesh);
  }

  begin() {
    for (const l of this.lods) l.count = 0;
  }

  add(rig, distance = 0) {
    const l = this.lods.length > 1 && distance > this.farDistance ? this.lods[1] : this.lods[0];
    if (l.count >= l.max) return;
    l.pose.value.array.set(rig.pose, l.count * STRIDE * 4);
    l.count++;
  }

  end() {
    const hideEmpty = ++this.updates > 2;
    for (const l of this.lods) {
      if (l.count === 0) {
        if (!hideEmpty) {
          if (!l.hasZero) {
            const attr = l.pose.value;
            attr.array.fill(0, 0, STRIDE * 4);
            attr.clearUpdateRanges();
            attr.addUpdateRange(0, STRIDE * 4);
            attr.needsUpdate = true;
            l.hasZero = true;
          }
          l.mesh.count = 1;
          l.mesh.visible = true;
        } else {
          l.mesh.count = 0;
          l.mesh.visible = false;
        }
        continue;
      }
      l.hasZero = false;
      l.mesh.count = l.count;
      l.mesh.visible = true;
      const attr = l.pose.value;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, l.count * STRIDE * 4);
      attr.needsUpdate = true;
    }
  }
}

// ============================================================================
// 5. PERSON RIG: PLANTED FOOTSTEPS, TWO-BONE IK & A GAIT THAT FOLLOWS THE FEET
// ============================================================================
// Reference walk (% of the gait cycle from heel strike): the knee bends ~15-20 degrees taking the weight, straightens
// by mid-stance, bends ~40 degrees while the heel rises before toe-off at ~60% and peaks near 60 degrees early in the
// swing. The pelvis rides highest over the stance foot and lowest just after each heel strike, ~4 cm apart.
const GAIT = {
  dutyWalk: 0.6, // share of the gait cycle each foot spends on the ground (a walk always has a foot down)
  dutyRun: 0.35, // ...and jogging/running (both feet off the ground in flight)
  minCadence: 1.05, // gait cycles per second stepping on the spot or settling to rest
  startCadence: 0.74,
  turnRate: 3.4, // rad/s standing, turning on the spot...
  walkTurnRate: 7, // ...and walking (the body faces where it goes within a step)
  spread: 0.074, // each foot's distance from the line of travel
  toeOut: 0.08,
  heelStrike: -0.28, // foot pitch at heel strike (toes up) and toe-off (heel up)
  toeOffWalk: 0.72,
  toeOffRun: 0.98,
  heelRoll: 0.14, // share of the stance spent rolling onto the sole, and when the heel comes up
  heelOffWalk: 0.44,
  heelOffRun: 0.34,
  landLeadWalk: 0.36, // feet land this share of the stance's travel ahead of the hips
  landLeadRun: 0.35,
  bob: 0.025, // walking pelvis dip after each heel strike at a 0.72 m step (m, for a 1.75 m person)
  maxDrop: 0.12, // planted feet never pull the pelvis lower than this below standing height (the foot slips instead)
  armLag: 0.06, // s the arm swing trails the legs
  // Turning: quicker, shorter steps the sharper the turn; hurried steps when a planted foot is left out of reach;
  // feet stay on their own side of each other; a lean into the turn
  turnQuicken: 0.4,
  turnShorten: 0.45,
  footGap: 0.1, // closest the ankles pass side by side (m)
  maxBank: 0.1
};
// Standing: weight rests on one leg for a while (hips shifted over it and tilted up on its side, the other knee
// loose), then moves to the other or settles on both
const IDLE = { shift: 0.045, roll: 0.055, drop: 0.008, minHold: 3.5, maxHold: 11 };
const HEEL = new THREE.Vector3(0, -ANKLE_H, -0.07); // heel contact, from the ankle
const TOE_JOINT = new THREE.Vector3(0, 0.02 - ANKLE_H, 0.135);

const PEDESTRIAN_DIVE_DURATION = 2.5;
// Time, pelvis height/pitch, chest/head pitch, hand height/forward/spread, left and right ankle height/forward,
// foot pitch. The hands catch the landing; a short prone pause leads into a push-up, one knee under the body,
// and a staggered rise. Positions are metres in the escape direction, before each person's height scaling.
const DIVE_POSES = [
  [0,    0.957, 0.035, 0.05, 0.05, 0.82, 0.03, 0.23, 0.08, 0,     0.08, 0,     0],
  [0.12, 0.79,  0.38,  0.50, 0.10, 0.76, 0.42, 0.27, 0.08, -0.06, 0.08, 0.10,  0.15],
  [0.30, 1.10,  0.88,  1.05, 0.65, 0.92, 0.76, 0.29, 0.61, -0.55, 0.72, -0.52, 0.9],
  [0.55, 0.50,  1.45,  1.46, 1.05, 0.10, 0.72, 0.32, 0.32, -0.70, 0.41, -0.64, 1.35],
  [0.72, 0.135, 1.49,  1.45, 1.10, 0.08, 0.60, 0.32, 0.16, -0.80, 0.19, -0.76, 1.4],
  [1.15, 0.135, 1.49,  1.45, 1.10, 0.08, 0.60, 0.32, 0.16, -0.80, 0.19, -0.76, 1.4],
  [1.55, 0.40,  1.10,  1.00, 0.25, 0.11, 0.57, 0.30, 0.10, -0.44, 0.12, -0.50, 0.9],
  [1.90, 0.65,  0.55,  0.60, 0.10, 0.62, 0.40, 0.27, 0.08, 0.15,  0.12, -0.35, 0.3],
  [2.20, 0.83,  0.20,  0.30, 0.08, 0.80, 0.20, 0.25, 0.08, 0.03,  0.08, -0.03, 0],
  [PEDESTRIAN_DIVE_DURATION, 0.957, 0.035, 0.05, 0.05, 0.82, 0.03, 0.23, 0.08, 0, 0.08, 0, 0]
];

const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampAbs = (x, m) => (x < -m ? -m : x > m ? m : x);
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (dt, tau) => 1 - Math.exp(-dt / tau); // share of the way a first-order lag covers in dt
let _easeDt = -1;
let _e03 = 0, _e045 = 0, _e07 = 0, _e10 = 0, _e12 = 0, _e15 = 0, _e22 = 0, _e35 = 0;
function syncEase(dt) {
  if (dt === _easeDt) return;
  _easeDt = dt;
  _e03 = ease(dt, 0.03);
  _e045 = ease(dt, 0.045);
  _e07 = ease(dt, GAIT.armLag);
  _e10 = ease(dt, 0.1);
  _e12 = ease(dt, 0.12);
  _e15 = ease(dt, 0.15);
  _e22 = ease(dt, 0.22);
  _e35 = ease(dt, 0.35);
}
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const hash01 = (x) => {
  const v = Math.sin(x * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};
// Highest a hip at (hx, hz) can be with a leg of length `reach` down to the ankle at (ax, ay, az)
const reachTop = (ax, ay, az, hx, hz, reach) => {
  const dx = ax - hx;
  const dz = az - hz;
  return ay + Math.sqrt(Math.max(0, reach * reach - (dx * dx + dz * dz)));
};

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qPelvis = new THREE.Quaternion();
const _qChest = new THREE.Quaternion();
const _qUpper = new THREE.Quaternion();
const _qRoot = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pelvis = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _front = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _ux = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _rootPos = new THREE.Vector3();
const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);
const qX = (out, a) => out.setFromAxisAngle(AX, a);
const qY = (out, a) => out.setFromAxisAngle(AY, a);
const qZ = (out, a) => out.setFromAxisAngle(AZ, a);

function makeFoot(side) {
  return {
    side,
    swing: false,
    // planted: ground point under the ankle (foot flat), heading
    px: 0, py: 0, pz: 0, yaw: 0,
    // current ankle, foot pitch (+ heel up), toe bend (relative), heading while swinging, ground contact 0..1,
    // stance progress (0 at the ends, 1 at mid-stance)
    ax: 0, ay: 0, az: 0, pitch: 0, toe: 0, swingYaw: 0, contact: 1, stance: 0,
    // swing progress, lift-off state (world + body-relative rx/rz), landing target and the ankle at touchdown
    w: 0, w0: 0, lx: 0, ly: 0, lz: 0, rx: 0, rz: 0, lyaw: 0, lpitch: 0, ltoe: 0, lground: 0,
    tx: 0, ty: 0, tz: 0, tyaw: 0, ex: 0, ey: 0, ez: 0
  };
}

// Ankle of a foot standing at ground point (px, py, pz) heading `yaw`, pitched by `pitch` about `pivot` (heel or toe
// joint, from the ankle) for a person of scale s
function ankleAt(px, py, pz, yaw, pitch, pivot, s, out) {
  const pyl = pivot.y * s;
  const pzl = pivot.z * s;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward = pzl - pyl * sp - pzl * cp;
  return out.set(px + Math.sin(yaw) * forward, py + pyl + ANKLE_H * s - pyl * cp + pzl * sp, pz + Math.cos(yaw) * forward);
}

class PersonRig {
  /**
   * @param {object} o - seed (dresses them), scale (height / 1.75 m), female, girth (build, ~0.9-1.15),
   *   hair (0 short .. 0.5 voluminous .. 1 long), armSwing & stride (gait personality, ~1)
   */
  constructor({ seed = 0, scale = 1, female = false, girth = 1, hair = 0.2, armSwing = 1, stride = 1 } = {}) {
    this.seed = seed;
    this.s = scale;
    this.female = female ? 1 : 0;
    this.girth = girth;
    this.armSwing = armSwing;
    this.stride = stride;
    this.bind = BIND[this.female];
    this.placed = false;
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.vx = 0;
    this.vz = 0;
    this.tvx = 0; // velocity as footsteps plan with it: it follows the path round corners at once
    this.tvz = 0;
    this.speed = 0;
    this.gait = 0; // how much of the walking motion shows (0 standing .. 1 walking)
    this.run = 0;
    this.sprint = 0;
    this.phase = 0; // gait cycle: the left heel strikes at 0, the right at 0.5
    this.pelvisY = 0;
    this.standY = 0; // pelvis height standing straight on the ground under the feet (eased)
    this.pelvisYaw = 0;
    this.pelvisRoll = 0;
    this.pelvisTilt = 0.035;
    this.sway = 0; // pelvis shift to the left of the line of travel
    this.spreadF = 0; // how far the left foot is ahead of the right (per metre of height)
    this.thighSplit = 0; // actual solved knee/ankle split driving contralateral arm & pelvis counter-rotation
    this.arm = 0; // smoothed contralateral arm drive
    this.yawRate = 0; // smoothed body turn rate (rad/s)
    this.back = 0; // backward motion blend (0 forward .. 1 backward)
    this.airBlend = 0; // airborne jump blend (0 grounded .. 1 airborne)
    this.prevAir = 0;
    this.landDrop = 0; // spring-damped landing knee compression (m)
    this.landVel = 0;
    this.headTurn = 0; // the head leads into turns
    this.bank = 0; // lean into the turn (rad, + to the right)
    this.lean = 0; // standing weight: +1 on the left leg .. -1 on the right
    this.leanTarget = 0;
    this.leanCount = 0;
    this.time = seed * 7.3;
    this.leanAt = this.time + IDLE.minHold * hash01(seed + 0.5);
    this.diving = false;
    this.diveGround = 0;
    this.feet = [makeFoot(1), makeFoot(-1)];
    this.pose = new Float32Array(STRIDE * 4);
    this.pose.set([seed, this.female, girth, hair], (STRIDE - 1) * 4);
  }

  get legLength() {
    return (THIGH + SHIN) * this.s;
  }

  // Pelvis height standing straight over feet at ground height y
  standingHeight(y) {
    return y + ANKLE_H * this.s + this.legLength * 0.997 + (PELVIS_Y - HIP_Y) * this.s;
  }

  // Standing still at (x, z) facing yaw, feet side by side on the ground
  reset(x, z, yaw, ground, owner = null) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.vx = this.vz = this.tvx = this.tvz = this.speed = 0;
    this.gait = this.run = this.sprint = this.sway = 0;
    this.yawRate = this.back = this.airBlend = this.prevAir = this.landDrop = this.landVel = 0;
    this.pelvisYaw = this.pelvisRoll = this.spreadF = this.thighSplit = this.arm = this.headTurn = this.bank = this.lean = 0;
    this.pelvisTilt = 0.025;
    this.diving = false;
    this.phase = 0;
    for (const foot of this.feet) {
      this.restPoint(foot, x, z, yaw, _v);
      foot.px = _v.x;
      foot.pz = _v.z;
      foot.py = ground(owner, _v.x, _v.z);
      foot.yaw = foot.swingYaw = yaw + foot.side * GAIT.toeOut;
      foot.swing = false;
      foot.w = foot.w0 = foot.pitch = foot.toe = foot.stance = 0;
      foot.contact = 1;
      this.plant(foot, 0, HEEL);
      foot.rx = foot.ax - x;
      foot.rz = foot.az - z;
    }
    this.pelvisY = this.standY = this.standingHeight((this.feet[0].py + this.feet[1].py) * 0.5);
    this.placed = true;
    this.solve();
  }

  restPoint(foot, x, z, yaw, out) {
    const d = foot.side * GAIT.spread * this.s;
    return out.set(x + Math.cos(yaw) * d, 0, z - Math.sin(yaw) * d);
  }

  // Ankle of the planted foot, pitched by `pitch` about `pivot`
  plant(foot, pitch, pivot) {
    ankleAt(foot.px, foot.py, foot.pz, foot.yaw, pitch, pivot, this.s, _v);
    foot.ax = _v.x;
    foot.ay = _v.y;
    foot.az = _v.z;
    foot.pitch = pitch;
  }

  /**
   * Walk the body to ground position (x, z), turning towards `heading`. `ground(owner, x, z)` gives the walking
   * surface's height anywhere around. `air` lifts the body off the ground (jumps). Set `updatePose` false for hidden
   * pedestrians: their gait and planted feet still advance, while bone transforms wait until they are drawn.
   * `diveTime` is elapsed seconds in an evasive dive, or -1 for ordinary locomotion.
   */
  update(dt, x, z, heading, ground, owner = null, air = 0, updatePose = true, diveTime = -1) {
    const dx = x - this.x;
    const dz = z - this.z;
    if (!this.placed || dx * dx + dz * dz > 9) {
      this.reset(x, z, heading, ground, owner);
      if (diveTime < 0) return;
    }
    dt = Math.min(Math.max(dt, 1e-4), 0.1);
    this.time += dt;

    if (diveTime >= 0) {
      if (!this.diving) this.diveGround = ground(owner, this.x, this.z);
      // Crossing a curb in flight changes the landing surface, without stepping the whole airborne body.
      // Travel ends before .55 s; settle exactly onto the surface by the prone pose at .72 s.
      this.diveGround += (ground(owner, x, z) - this.diveGround) * (diveTime >= 0.72 ? 1 : ease(dt, 0.06));
      this.diving = true;
      this.x = x;
      this.z = z;
      this.yaw = wrap(this.yaw + clampAbs(wrap(heading - this.yaw), 10 * dt));
      this.vx = this.vz = this.tvx = this.tvz = this.speed = this.gait = this.run = 0;
      if (updatePose) this.solveDive(diveTime, this.diveGround);
      return;
    }
    if (this.diving) {
      this.reset(x, z, this.yaw, ground, owner);
      return;
    }

    syncEase(dt);
    // Body velocity (smoothed), heading and how much walking & running show; the body leans into turns
    const rvx = (x - this.x) / dt;
    const rvz = (z - this.z) / dt;
    this.vx += (rvx - this.vx) * _e10;
    this.vz += (rvz - this.vz) * _e10;
    this.tvx += (rvx - this.tvx) * _e03;
    this.tvz += (rvz - this.tvz) * _e03;
    this.x = x;
    this.z = z;
    const speed = (this.speed = Math.sqrt(this.vx * this.vx + this.vz * this.vz));
    const yawErr = wrap(heading - this.yaw);
    const yawStep = clampAbs(yawErr, lerp(GAIT.turnRate, GAIT.walkTurnRate, this.gait) * dt);
    this.yaw = wrap(this.yaw + yawStep);
    this.yawRate += ((yawStep / dt) - this.yawRate) * _e10;
    const headLead = 0.6 * wrap(heading - this.yaw) + 0.16 * this.yawRate;
    this.headTurn += (clampAbs(headLead, 0.75) - this.headTurn) * _e15;
    this.bank += (clampAbs(-0.55 * speed * this.yawRate / 9.81, GAIT.maxBank) - this.bank) * _e15;
    const fwdVel = this.vx * Math.sin(this.yaw) + this.vz * Math.cos(this.yaw);
    const backTarget = speed > 0.12 ? smooth(-0.08, -0.45, fwdVel / speed) : 0;
    this.back += (backTarget - this.back) * _e15;
    this.gait += (Math.min(1, speed / 0.9) - this.gait) * _e22;
    this.run += (smooth(2.0, 3.1, speed) - this.run) * _e22;
    this.sprint += (smooth(3.5, 8.2, speed) * this.run - this.sprint) * _e15;
    this.updateLean();

    const airborne = air > 0.03;
    if (!airborne && this.prevAir > 0.05) {
      const impact = Math.min(1, this.prevAir / (0.85 * this.s));
      this.landDrop = Math.max(this.landDrop, (0.02 + 0.03 * impact) * this.s);
      this.landVel = Math.max(this.landVel, (0.45 + 0.75 * impact) * this.s);
      this.pelvisY -= this.prevAir + this.landDrop;
      // Resume grounded gait smoothly from the actual lead/trail landing feet without popping the rear leg mid-swing
      const sinY = Math.sin(this.yaw);
      const cosY = Math.cos(this.yaw);
      const zl = (this.feet[0].ax - x) * sinY + (this.feet[0].az - z) * cosY;
      const zr = (this.feet[1].ax - x) * sinY + (this.feet[1].az - z) * cosY;
      const leadIdx = zl >= zr ? 0 : 1;
      const leadFoot = this.feet[leadIdx];
      const trailFoot = this.feet[1 - leadIdx];
      leadFoot.swing = false;
      leadFoot.w0 = 0;
      leadFoot.px = leadFoot.ax;
      leadFoot.pz = leadFoot.az;
      leadFoot.py = ground(owner, leadFoot.px, leadFoot.pz);
      this.phase = (leadIdx * 0.5 + 0.04) % 1;
      const duty = lerp(GAIT.dutyWalk, lerp(GAIT.dutyRun, 0.225, this.sprint), this.run);
      const trailLp = (this.phase + (1 - leadIdx) * 0.5) % 1;
      if (speed > 0.2 && trailLp >= duty) {
        this.liftOff(trailFoot, x, z, (trailLp - duty) / (1 - duty));
        trailFoot.lground = ground(owner, trailFoot.ax, trailFoot.az);
        trailFoot.ly = trailFoot.lground + ANKLE_H * this.s;
      } else {
        trailFoot.swing = false;
        trailFoot.w0 = 0;
        trailFoot.px = trailFoot.ax;
        trailFoot.pz = trailFoot.az;
        trailFoot.py = ground(owner, trailFoot.px, trailFoot.pz);
      }
    }
    this.prevAir = air;
    this.airBlend += ((airborne ? 1 : 0) - this.airBlend) * (airborne ? _e045 : _e10);
    if (!airborne && (this.landDrop > 1e-4 || Math.abs(this.landVel) > 1e-4)) {
      const springAcc = -240 * this.landDrop - 26 * this.landVel;
      this.landVel += springAcc * dt;
      this.landDrop = Math.max(0, Math.min(0.11 * this.s, this.landDrop + this.landVel * dt));
      if (this.landDrop < 1e-4 && this.landVel <= 0) this.landDrop = this.landVel = 0;
    } else if (airborne) {
      this.landDrop *= 1 - _e10;
      this.landVel = 0;
    }

    if (airborne) this.updateAirborne(dt, x, z, ground, owner, air);
    else this.updateGait(dt, x, z, heading, yawErr, ground, owner);
    if (updatePose) this.solve();
  }

  // Airborne (jumping): smooth transition from current stride into an athletic jump tuck, leveling for landing
  updateAirborne(dt, x, z, ground, owner, air) {
    const s = this.s;
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const groundY = ground(owner, x, z);
    const jumpArc = clamp01(air / (0.85 * s));
    const strideSplit = Math.min(0.24 * s, this.speed * 0.035 * s) * (1 - 0.5 * this.back);
    const follow = ease(dt, 0.075);
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      const leadSign = i === 0 ? 1 : -1;
      const splitZ = strideSplit * leadSign * Math.sign(this.spreadF || 1);
      const lat = foot.side * GAIT.spread * s;
      const targetX = x + cosY * lat + sinY * splitZ;
      const targetZ = z - sinY * lat + cosY * splitZ;
      const footGround = ground(owner, targetX, targetZ);
      const tuck = (0.045 + 0.11 * jumpArc + (splitZ < 0 ? 0.035 : 0.01) * jumpArc) * s;
      const targetAy = footGround + air + ANKLE_H * s + tuck;
      foot.swing = false;
      foot.ax += (targetX - foot.ax) * follow;
      foot.az += (targetZ - foot.az) * follow;
      foot.ay += (targetAy - foot.ay) * ease(dt, 0.055);
      foot.px = foot.ax;
      foot.pz = foot.az;
      foot.py = ground(owner, foot.px, foot.pz);
      foot.yaw = foot.swingYaw = this.yaw + foot.side * GAIT.toeOut;
      foot.pitch += ((0.18 * jumpArc - 0.05) - foot.pitch) * follow;
      foot.toe *= 1 - follow;
      foot.contact = foot.stance = 0;
    }
    this.standY = this.standingHeight(groundY);
    const targetPelvisY = groundY + air + ANKLE_H * s + this.legLength * 0.965 + (PELVIS_Y - HIP_Y) * s;
    this.pelvisY += (targetPelvisY - this.pelvisY) * ease(dt, 0.045);
    this.pelvisTilt += ((0.06 + 0.08 * this.run * (1 - this.back)) - this.pelvisTilt) * _e15;
    this.pelvisRoll *= 1 - _e15;
    this.pelvisYaw *= 1 - _e15;
    this.sway *= 1 - _e12;
  }

  // Standing weight shifts from leg to leg every few seconds (deterministic per person)
  updateLean() {
    if (this.time >= this.leanAt) {
      const n = ++this.leanCount;
      const r = hash01(this.seed * 3.71 + n * 1.13);
      const side = this.leanTarget ? -Math.sign(this.leanTarget) : r < 0.5 ? 1 : -1;
      this.leanTarget = r < 0.18 ? 0 : side * (0.55 + 0.45 * hash01(this.seed * 5.3 + n * 2.71));
      this.leanAt = this.time + lerp(IDLE.minHold, IDLE.maxHold, hash01(this.seed * 1.9 + n * 0.77));
    }
    this.lean += (this.leanTarget * (1 - this.gait) - this.lean) * _e35;
  }

  updateGait(dt, x, z, heading, yawErr, ground, owner) {
    const s = this.s;
    const g = this.gait;
    const run = this.run;
    const sprint = this.sprint;
    const speed = this.speed;
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const duty = lerp(GAIT.dutyWalk, lerp(GAIT.dutyRun, 0.225, sprint), run);
    const turnSignal = Math.max(Math.abs(yawErr), Math.abs(this.yawRate) * 0.35);
    const turning = smooth(0.15, 1.2, turnSignal); // how sharp a turn the body is making
    const settleSq = (0.07 * s) * (0.07 * s);

    // Cadence: the walking gait cycle shortens with speed (step length ~0.68 m at 1.45 m/s); running scales from
    // ~1.45 Hz jogging to ~2.1 Hz sprinting so ground contact sweep stays matched to leg length while flight lengthens.
    let f = 0;
    if (speed > 0.08) {
      const walkF = Math.pow(speed, 0.48) / (1.12 * s * this.stride);
      const runF = (1.42 + 0.12 * Math.max(0, speed - 2.4)) / Math.sqrt(s);
      const turnQ = GAIT.turnQuicken * (1 - 0.65 * run);
      f = Math.max(GAIT.startCadence, lerp(walkF, runF, run)) * (1 + turnQ * turning);
    } else {
      let unsettled = false;
      let anySwing = false;
      const stopSettleSq = (0.12 * s) * (0.12 * s);
      for (const foot of this.feet) {
        this.restPoint(foot, x, z, this.yaw, _v);
        const fdx = foot.px - _v.x;
        const fdz = foot.pz - _v.z;
        const tolSq = this.gait > 0.05 ? stopSettleSq : settleSq;
        if (foot.swing) anySwing = true;
        if (foot.swing
          || fdx * fdx + fdz * fdz > tolSq
          || Math.abs(wrap(foot.yaw - this.yaw - foot.side * GAIT.toeOut)) > 0.25) unsettled = true;
      }
      if (unsettled) f = anySwing ? GAIT.minCadence * 1.25 : GAIT.minCadence;
    }
    // turning on the spot in quick steps of ~45-60 degrees
    if (Math.abs(yawErr) > 0.12 || Math.abs(this.yawRate) > 0.35) {
      f = Math.max(f, GAIT.minCadence * (1 + 0.6 * turning));
    }
    // Only hurry cadence when a planted foot is genuinely stranded sideways or far out of reach round a corner
    const reach = this.legLength * 0.997;
    if (f > 0 && run < 0.5) {
      for (const foot of this.feet) {
        if (foot.swing) continue;
        const hx = x + cosY * foot.side * HIP_X * s;
        const hz = z - sinY * foot.side * HIP_X * s;
        const drop = this.standY - (reachTop(foot.ax, foot.ay, foot.az, hx, hz, reach) + (PELVIS_Y - HIP_Y) * s);
        f *= 1 + 1.5 * (1 - run * 2) * smooth(0.14 * s, 0.22 * s, drop);
      }
    }

    // Advance the cycle: feet lift off when their phase passes the duty factor, land when it wraps
    const prev = this.phase;
    this.phase = (this.phase + f * dt) % 1;
    const tSwing = f > 0 ? (1 - duty) / f : 0.4;
    const tStance = f > 0 ? duty / f : 0.6;
    const turningInPlace = Math.abs(yawErr) > 0.12 || Math.abs(this.yawRate) > 0.35;
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      const other = this.feet[1 - i];
      const lp0 = (prev + i * 0.5) % 1;
      const lp = (this.phase + i * 0.5) % 1;
      if (f > 0 && foot.swing && lp < lp0) {
        this.touchDown(foot);
      } else if (f > 0 && !foot.swing && lp >= duty && lp >= lp0) {
        // When stopping, don't start an extra micro-step if this foot is already settled near rest
        let needLift = speed > 0.14 || turningInPlace || other.swing;
        if (!needLift) {
          this.restPoint(foot, x, z, this.yaw, _v);
          const fdx = foot.px - _v.x;
          const fdz = foot.pz - _v.z;
          const stopSettleSq = (0.15 * s) * (0.15 * s);
          needLift = fdx * fdx + fdz * fdz > stopSettleSq
            || Math.abs(wrap(foot.yaw - this.yaw - foot.side * GAIT.toeOut)) > 0.25;
        }
        if (needLift) this.liftOff(foot, x, z, 0);
      }
      if (foot.swing) this.swingFoot(foot, other, clamp01((lp - duty) / (1 - duty)), tSwing, tStance, x, z, heading, turning, ground, owner);
      else this.stanceFoot(foot, clamp01(lp / duty), x, z);
    }

    // Pelvis: sways over the foot carrying the weight (or the leg the person stands on), turns with the stride and
    // drops on the side of the swinging leg
    const left = this.feet[0];
    const right = this.feet[1];
    const idle = 1 - g;
    const zl = (left.ax - x) * sinY + (left.az - z) * cosY;
    const zr = (right.ax - x) * sinY + (right.az - z) * cosY;
    const spreadF = (zl - zr) / s;
    const latL = (left.ax - x) * cosY - (left.az - z) * sinY;
    const latR = (right.ax - x) * cosY - (right.az - z) * sinY;
    const cSum = left.contact + right.contact;
    const weightLat = cSum > 0.01 ? (left.contact * latL + right.contact * latR) / cSum : 0;
    const swayTarget = weightLat * 0.4 * g * (1 - run * 0.65) - this.bank * 0.45 * s
      + (IDLE.shift * this.lean + 0.004 * Math.sin(this.time * 0.7)) * s * idle;
    this.sway += (swayTarget - this.sway) * _e12;
    const activeSplit = this.thighSplit || spreadF;
    const targetPelvisYaw = clampAbs(-0.13 * activeSplit * g, 0.14);
    this.pelvisYaw += (targetPelvisYaw - this.pelvisYaw) * _e07;
    const targetPelvisRoll = 0.042 * g * (left.contact - right.contact) * (1 - run * 0.55) + IDLE.roll * this.lean * idle;
    this.pelvisRoll += (targetPelvisRoll - this.pelvisRoll) * _e10;
    const fwdLean = 1 - 1.15 * this.back;
    const targetPelvisTilt = 0.025 + (0.02 * g + (0.055 + 0.035 * sprint) * run) * fwdLean;
    this.pelvisTilt += (targetPelvisTilt - this.pelvisTilt) * _e15;
    this.spreadF = spreadF;
    const turnArm = Math.sin(2 * Math.PI * this.phase) * 0.22 * smooth(0.4, 2.2, Math.abs(this.yawRate)) * (1 - g);
    this.arm += (activeSplit + turnArm - this.arm) * _e045;
    this.setPelvisRotation();

    // Height: walking follows Contact -> Down (~13% phase) -> Passing -> Up (~38% phase); running follows spring-mass
    // mechanics (lowest at mid-stance compression, highest in aerial flight).
    const stepWeights = left.contact + right.contact;
    const footGround = stepWeights > 0.01 ? (left.contact * left.py + right.contact * right.py) / stepWeights : (left.py + right.py) * 0.5;
    const groundAvg = lerp(footGround, ground(owner, x, z), 0.35 * g + 0.35 * run);
    this.standY += (this.standingHeight(groundAvg) - this.standY) * ease(dt, 0.085);
    const stepRatio = f > 0 ? Math.min(1.2, speed / (2 * f * 0.72 * s)) : 0;
    const walkWave = 0.5 + 0.5 * Math.cos(4 * Math.PI * (this.phase - 0.13));
    const walkDrop = s * g * GAIT.bob * stepRatio * walkWave;
    const runWave = 0.5 + 0.5 * Math.cos(4 * Math.PI * (this.phase - duty * 0.45));
    const runAmp = lerp(0.036, 0.02, sprint);
    const runBase = lerp(0.014, 0.022, sprint);
    const runDrop = s * (runBase + runAmp * runWave);
    let y = this.standY - lerp(walkDrop, runDrop, run) - this.landDrop - IDLE.drop * s * Math.abs(this.lean) * idle;

    // ...never higher than the legs reach: planted feet hold the hips down during support, releasing smoothly at
    // push-off as the leg enters aerial flight so trailing feet never yank the pelvis downward mid-air.
    const lowest = this.standY - GAIT.maxDrop * s;
    const k = s * (0.004 + 0.03 * Math.max(g, run)); // smooth where the constraints hand over in a stride
    const swingRelease = 1.4 + 4.0 * run;
    const landPrep = lerp(0.55, 4.0, run);
    const runAir = run * s;
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      this.hipOffset(i, _v);
      const hx = x + cosY * this.sway + _v.x;
      const hz = z - sinY * this.sway + _v.z;
      if (foot.swing) {
        const w = foot.w;
        const tRem = (1 - w) * tSwing;
        const flightFree = runAir * (0.18 + 0.25 * smooth(0, 0.1, w)) * (1 - 0.85 * smooth(0.9, 1, w));
        const fromLiftOff = reachTop(foot.ax, foot.ay, foot.az, hx, hz, reach) + flightFree + swingRelease * s * w * w;
        const toLanding = reachTop(foot.ex, foot.ey, foot.ez, hx + this.tvx * tRem, hz + this.tvz * tRem, reach) + flightFree + landPrep * s * (1 - w) * (1 - w);
        const swingFloor = this.standingHeight(Math.min(foot.lground, foot.ty)) - GAIT.maxDrop * s;
        y = smin(y, Math.max(Math.min(lowest, swingFloor), Math.min(fromLiftOff, toLanding) - _v.y), k);
      } else {
        const stanceRelease = (0.018 * g + 0.18 * run) * s * smooth(0.45, 1.0, 1 - foot.contact)
          + 0.03 * run * s * (1 - smooth(0, 0.28, foot.stance));
        const stanceFloor = this.standingHeight(foot.py) - GAIT.maxDrop * s;
        y = smin(y, Math.max(Math.min(lowest, stanceFloor), reachTop(foot.ax, foot.ay, foot.az, hx, hz, reach) + stanceRelease - _v.y), k);
      }
    }
    this.pelvisY += (y - this.pelvisY) * ease(dt, 0.045);
  }

  touchDown(foot) {
    foot.swing = false;
    foot.w0 = 0;
    foot.px = foot.tx;
    foot.py = foot.ty;
    foot.pz = foot.tz;
    foot.yaw = foot.tyaw;
  }

  liftOff(foot, x, z, w0 = 0) {
    foot.swing = true;
    foot.w0 = w0;
    foot.lx = foot.ax;
    foot.ly = foot.ay;
    foot.lz = foot.az;
    foot.rx = foot.ax - x;
    foot.rz = foot.az - z;
    foot.lyaw = foot.yaw;
    foot.lpitch = foot.pitch;
    foot.ltoe = foot.toe;
    foot.lground = foot.py;
  }

  // Stance (u: 0 contact .. 1 push-off): forward walks roll heel-to-toe with early heel rise before opposite contact;
  // runs cushion onto midfoot and drive off the ball of the foot; backward steps roll forefoot-to-heel
  stanceFoot(foot, u, x, z) {
    const g = this.gait;
    const run = this.run;
    const sprint = this.sprint;
    const stepScale = smooth(0.15, 1.35, this.speed);
    const heelOff = lerp(GAIT.heelOffWalk, GAIT.heelOffRun, run);
    const toeOff = lerp(GAIT.toeOffWalk, GAIT.toeOffRun, run);
    const strikePitch = GAIT.heelStrike * g * (1 - run * (0.52 + 0.36 * sprint));
    let fPitch = 0;
    if (u < GAIT.heelRoll) {
      const t = 1 - u / GAIT.heelRoll;
      fPitch = strikePitch * t * t;
    } else if (u > heelOff) {
      const t = (u - heelOff) / (1 - heelOff);
      fPitch = toeOff * g * (0.45 + 0.55 * stepScale) * Math.pow(t, lerp(1.22, 1.35, run));
    }
    // Backward walk/jog: ball-of-foot touchdown (positive pitch) -> flat -> slight heel rock (negative pitch)
    let bPitch = 0;
    if (u < 0.26) {
      const t = 1 - u / 0.26;
      bPitch = 0.24 * g * (0.5 + 0.5 * stepScale) * t * t;
    } else if (u > 0.72) {
      const t = (u - 0.72) / 0.28;
      bPitch = -0.08 * g * (1 - run * 0.5) * t * t;
    }
    const pitch = lerp(fPitch, bPitch, this.back);
    this.plant(foot, pitch, pitch > 0 ? TOE_JOINT : HEEL);
    foot.rx = foot.ax - x;
    foot.rz = foot.az - z;
    foot.toe = pitch > 0 ? -pitch : 0;
    foot.swingYaw = foot.yaw;
    // running, a foot carries the body only until mid-stance; behind the hips the leg drives push-off
    foot.contact = 1 - 0.75 * smooth(lerp(GAIT.heelOffWalk, 0.32, run), lerp(1, 0.65, run), u) * Math.max(g, run);
    foot.stance = Math.sin(Math.PI * u);
  }

  // Swing (w: 0 toe-off .. 1 touchdown) carried smoothly in body-relative space towards the future foothold on the
  // path, folding the heel high in running recovery, driving the front knee forward, and retracting into contact
  swingFoot(foot, other, rawW, tSwing, tStance, x, z, heading, turning, ground, owner) {
    const s = this.s;
    const g = this.gait;
    const run = this.run;
    const sprint = this.sprint;
    const w = foot.w0 !== 0 ? clamp01((rawW - foot.w0) / Math.max(0.05, 1 - foot.w0)) : rawW;
    foot.w = w;
    foot.stance = 0;
    const tRem = (1 - rawW) * tSwing;
    const yawPred = this.yaw + clampAbs(wrap(heading - this.yaw) + this.yawRate * tRem * 0.35, lerp(GAIT.turnRate, GAIT.walkTurnRate, g) * tRem);
    const sn = Math.sin(yawPred);
    const cs = Math.cos(yawPred);
    const lat = foot.side * GAIT.spread * s;
    const baseLead = lerp(GAIT.landLeadWalk, lerp(GAIT.landLeadRun, 0.37, sprint), run);
    const leadShare = lerp(baseLead, 0.56, this.back) * (1 - GAIT.turnShorten * turning);
    const leadTime = tStance * leadShare;
    foot.tx = x + this.tvx * (tRem + leadTime) + cs * lat;
    foot.tz = z + this.tvz * (tRem + leadTime) - sn * lat;
    // left of the other foot for the left foot, right for the right (in the body's predicted frame)
    const gap = GAIT.footGap * s;
    const across = ((foot.tx - other.ax) * cs - (foot.tz - other.az) * sn) * foot.side;
    if (!other.swing && across < gap) {
      foot.tx += cs * foot.side * (gap - across);
      foot.tz -= sn * foot.side * (gap - across);
    }
    foot.ty = ground(owner, foot.tx, foot.tz);
    foot.tyaw = yawPred + foot.side * GAIT.toeOut;

    const stepScale = smooth(0.15, 1.35, this.speed);
    const fStrike = GAIT.heelStrike * g * (1 - run * (0.52 + 0.36 * sprint));
    const bStrike = 0.22 * g * (0.5 + 0.5 * stepScale);
    const strike = lerp(fStrike, bStrike, this.back);
    ankleAt(foot.tx, foot.ty, foot.tz, foot.tyaw, strike, strike > 0 ? TOE_JOINT : HEEL, s, _v);
    foot.ex = _v.x;
    foot.ey = _v.y;
    foot.ez = _v.z;

    // Body-relative horizontal Hermite swing: brief toe-off follow-through, energetic mid-swing knee drive, and active
    // terminal retraction (pawback) into touchdown without backward mid-air skating or forward goose-stepping
    const futX = x + this.tvx * tRem;
    const futZ = z + this.tvz * tRem;
    const r1x = foot.ex - futX;
    const r1z = foot.ez - futZ;
    const drx = r1x - foot.rx;
    const drz = r1z - foot.rz;
    const v0Scale = lerp(0.26, 0.08, run) * (1 - 0.65 * this.back);
    const m0x = clampAbs(-this.vx * tSwing * v0Scale, Math.abs(drx) * 0.45 + 0.04 * s);
    const m0z = clampAbs(-this.vz * tSwing * v0Scale, Math.abs(drz) * 0.45 + 0.04 * s);
    const m1Scale = lerp(0.32, 0.58, run) * (1 - 0.55 * this.back);
    const m1x = clampAbs(-this.vx * tSwing * m1Scale, Math.abs(drx) * 1.05 + 0.04 * s);
    const m1z = clampAbs(-this.vz * tSwing * m1Scale, Math.abs(drz) * 1.05 + 0.04 * s);
    const w2 = w * w;
    const w3 = w2 * w;
    const h00 = 2 * w3 - 3 * w2 + 1;
    const h10 = w3 - 2 * w2 + w;
    const h01 = -2 * w3 + 3 * w2;
    const h11 = w3 - w2;
    foot.ax = x + h00 * foot.rx + h10 * m0x + h01 * r1x + h11 * m1x;
    foot.az = z + h00 * foot.rz + h10 * m0z + h01 * r1z + h11 * m1z;

    // Vertical swing: walking lifts early via knee flexion and arcs smoothly onto the heel at w=1; running folds the
    // heel up in recovery while ramping down through late swing so the foot opens naturally towards the ground
    const stepDown = foot.ty < foot.lground - 0.02;
    const walkEY = stepDown ? smooth(0.36, 1, w) : smooth(0, 0.96, w);
    const eY = lerp(walkEY, w2 * (3 - 2 * w), run);
    const stepLen = Math.hypot(drx, drz);
    const liveRun = smooth(1.8, 3.2, this.speed) * run;
    const runClear = lerp(0.18, 0.28, sprint) * (1 - 0.45 * this.back) * s;
    const stepChange = Math.max(0, foot.ty - foot.lground) * 1.15 + Math.max(0, foot.lground - foot.ty) * 0.25;
    const walkClear = (0.022 + 0.036 * Math.min(1, stepLen / (0.8 * s))) * s;
    const walkBump = 0.72 * Math.sin(Math.PI * Math.pow(w, 0.72)) + 0.28 * Math.sin(Math.PI * w);
    const runBump = Math.sin(Math.PI * Math.pow(w, 0.68)) * (1 - 0.22 * w2);
    foot.ay = lerp(foot.ly, foot.ey, eY) + lerp(walkClear * walkBump, runClear * runBump, liveRun) + stepChange * Math.sin(Math.PI * w);

    // swing round the planted foot rather than through it
    const pass = ((foot.ax - other.ax) * cs - (foot.az - other.az) * sn) * foot.side;
    const along = Math.abs((foot.ax - other.ax) * sn + (foot.az - other.az) * cs);
    if (!other.swing && pass < gap) {
      const out = (gap - pass) * Math.sin(Math.PI * w) * (1 - smooth(0.12 * s, 0.3 * s, along));
      foot.ax += cs * foot.side * out;
      foot.az -= sn * foot.side * out;
    }

    // Base swing foot pitch from push-off to touchdown (refined against actual shin angle in solve())
    const midLift = lerp(-0.12 * (1 - run), 0.06, this.back) * g * Math.sin(Math.PI * w);
    foot.pitch = foot.lpitch * (1 - smooth(0, 0.5, w)) + strike * smooth(0.55, 1, w) + midLift;
    foot.toe = lerp(foot.ltoe, 0, smooth(0, 0.3, w));
    const eYaw = w2 * (3 - 2 * w);
    foot.swingYaw = foot.lyaw + wrap(foot.tyaw - foot.lyaw) * eYaw;
    const solePitch = Math.sin(foot.pitch);
    const minAnkleY = ground(owner, foot.ax, foot.az) + ANKLE_H * s + Math.max(solePitch * 0.14 * s, -solePitch * 0.08 * s);
    if (foot.ay < minAnkleY) foot.ay = minAnkleY;
    foot.contact = Math.max(0.25 * (1 - smooth(0, 0.2, w)), smooth(0.82, 1, w));
  }

  setPelvisRotation() {
    qY(_qPelvis, this.yaw + this.pelvisYaw);
    _qPelvis.multiply(qZ(_q, this.pelvisRoll + this.bank)).multiply(qX(_q, this.pelvisTilt));
  }

  // Hip joint relative to the pelvis joint (out.y < 0: the hips are below it)
  hipOffset(i, out) {
    const j = this.bind;
    return out.copy(j[LIMB.thigh[i]]).sub(j[BONE.PELVIS]).multiplyScalar(this.s).applyQuaternion(_qPelvis);
  }

  // Joint `child` of a bone rotated by q whose joint `parent` is at parentPos
  jointFrom(parent, child, q, parentPos, out) {
    const j = this.bind;
    return out.copy(j[child]).sub(j[parent]).multiplyScalar(this.s).applyQuaternion(q).add(parentPos);
  }

  writeBone(b, q, p) {
    const s = this.s;
    _v2.copy(this.bind[b]).applyQuaternion(q).multiplyScalar(s);
    const o = b * 8;
    const a = this.pose;
    a[o] = q.x;
    a[o + 1] = q.y;
    a[o + 2] = q.z;
    a[o + 3] = q.w;
    a[o + 4] = p.x - _v2.x;
    a[o + 5] = p.y - _v2.y;
    a[o + 6] = p.z - _v2.z;
    a[o + 7] = s;
  }

  // Foot at `ankle` rotated by qFoot, toes bent by `toeBend` (+ down) at the ball of the foot
  writeFoot(i, ankle, qFoot, toeBend) {
    this.writeBone(LIMB.foot[i], qFoot, ankle);
    this.jointFrom(LIMB.foot[i], LIMB.toe[i], qFoot, ankle, _v);
    _q2.copy(qFoot).multiply(qX(_q, toeBend));
    this.writeBone(LIMB.toe[i], _q2, _v);
  }

  // Bone rotation whose +Y points `up` (from the child joint to this one) and +Z towards `front`
  basis(up, front, out) {
    _by.copy(up).normalize();
    _bz.copy(front).addScaledVector(_by, -front.dot(_by));
    if (_bz.lengthSq() < 1e-8) {
      if (Math.abs(_by.z) < 0.9) _bz.set(0, 0, 1).addScaledVector(_by, -_by.z);
      else _bz.set(0, 1, 0).addScaledVector(_by, -_by.y);
    }
    _bz.normalize();
    _bx.crossVectors(_by, _bz);
    _m.makeBasis(_bx, _by, _bz);
    return out.setFromRotationMatrix(_m);
  }

  /**
   * Two-bone IK from `root` towards `target`, the middle joint bending towards `pole`. Writes both bones (+Z towards
   * `front`, keeping the lower segment on the upper segment's hinge axis, then turned back by the limb's bind-pose tilt
   * about Z) and returns the end joint reached (in _ankle).
   */
  limb(upper, lower, root, target, l1, l2, pole, front, tilt = 0, soft = 0) {
    _dir.subVectors(target, root);
    const length = _dir.length();
    _dir.divideScalar(length || 1);
    const maxLen = l1 + l2;
    let dist;
    if (soft > 0) {
      const margin = maxLen * soft;
      const free = maxLen * (1 - soft * 1.15);
      dist = length <= free
        ? length
        : free + margin * (1 - Math.exp(-(length - free) / margin));
    } else {
      dist = Math.min(maxLen * 0.9999, length);
    }
    dist = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(maxLen * 0.9999, dist));
    _bend.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
    if (_bend.lengthSq() < 1e-8) _bend.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _bend.normalize();
    const cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist);
    _knee.copy(root).addScaledVector(_dir, l1 * cosA).addScaledVector(_bend, l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA)));
    _ankle.copy(root).addScaledVector(_dir, dist);
    this.basis(_v2.subVectors(root, _knee), front, _qUpper);
    _ux.copy(_bx);
    if (tilt) _qUpper.multiply(qZ(_q, -tilt));
    this.writeBone(upper, _qUpper, root);

    // Lower segment shares the upper segment's lateral hinge axis (_ux), preventing 180° twist flips on high kicks
    _by.subVectors(_knee, _ankle).normalize();
    _bz.crossVectors(_ux, _by);
    if (_bz.lengthSq() < 1e-8) {
      this.basis(_v2.subVectors(_knee, _ankle), front, _q2);
    } else {
      _bz.normalize();
      _bx.crossVectors(_by, _bz);
      _m.makeBasis(_bx, _by, _bz);
      _q2.setFromRotationMatrix(_m);
    }
    if (tilt) _q2.multiply(qZ(_q, -tilt));
    this.writeBone(lower, _q2, _knee);
    return _ankle;
  }

  // Leg from the hip to the ankle target, knee towards the foot's heading, with soft full-extension cushion
  solveLeg(i, hip, ankleTarget, footYaw) {
    const s = this.s;
    _pole.set(Math.sin(footYaw) + Math.sin(this.yaw), 0, Math.cos(footYaw) + Math.cos(this.yaw));
    _front.set(Math.sin(footYaw), 0, Math.cos(footYaw)).addScaledVector(_pole, 0.5);
    return this.limb(LIMB.thigh[i], LIMB.shin[i], hip, ankleTarget, THIGH * s, SHIN * s, _pole, _front, 0, 0.012);
  }

  // Grounded escape animation, independent of the walking gait and evaluated only for visible people.
  solveDive(time, groundY) {
    const s = this.s;
    let frame = 0;
    while (frame < DIVE_POSES.length - 2 && time > DIVE_POSES[frame + 1][0]) frame++;
    const a = DIVE_POSES[frame];
    const b = DIVE_POSES[frame + 1];
    const t = smooth(a[0], b[0], time);
    const key = (k) => lerp(a[k], b[k], t);
    const pitch = key(2);
    const footPitch = key(12);
    const footClearance = ANKLE_H * Math.cos(footPitch) + 0.208 * Math.sin(footPitch);
    // a point given in the escape frame (metres before scaling), on the ground under the person
    const local = (out, lx, ly, lz) => {
      out.set(lx, ly, lz).multiplyScalar(s).applyQuaternion(_qRoot);
      out.x += this.x;
      out.y += groundY;
      out.z += this.z;
      return out;
    };
    qY(_qRoot, this.yaw);
    _qPelvis.copy(_qRoot).multiply(qX(_q, pitch));
    _pelvis.set(this.x, groundY + key(1) * s, this.z);
    this.pelvisY = _pelvis.y;
    this.writeBone(BONE.PELVIS, _qPelvis, _pelvis);
    _qChest.copy(_qRoot).multiply(qX(_q, key(3)));
    this.writeBone(BONE.CHEST, _qChest, this.jointFrom(BONE.PELVIS, BONE.CHEST, _qPelvis, _pelvis, _chest));
    _qa.copy(_qRoot).multiply(qX(_q, key(4)));
    this.writeBone(BONE.HEAD, _qa, this.jointFrom(BONE.CHEST, BONE.HEAD, _qChest, _chest, _v));
    _front.set(0, 0, 1).applyQuaternion(_qChest);

    for (let i = 0; i < 2; i++) {
      const side = SIDES[i];
      this.jointFrom(BONE.CHEST, LIMB.upperArm[i], _qChest, _chest, _shoulder);
      local(_target, side * key(7), key(5), key(6));
      _pole.set(side * 0.9, 0.25, -0.5).applyQuaternion(_qRoot);
      this.limb(LIMB.upperArm[i], LIMB.forearm[i], _shoulder, _target, UPPER_ARM * s, (FOREARM + 0.07) * s, _pole, _front, side * ARM_BIND_ABDUCTION);

      this.jointFrom(BONE.PELVIS, LIMB.thigh[i], _qPelvis, _pelvis, _hip);
      local(_target, side * GAIT.spread, Math.max(footClearance, key(8 + i * 2)), key(9 + i * 2));
      // Knees fold towards the chest, then tuck beneath the hips for the rise. A little outward bend keeps
      // the knees clear of the pavement when the body is lying flat.
      _pole.set(side * 0.45 * Math.sin(pitch), -0.2 * Math.sin(pitch), Math.cos(pitch)).applyQuaternion(_qRoot);
      const ankle = this.limb(LIMB.thigh[i], LIMB.shin[i], _hip, _target, THIGH * s, SHIN * s, _pole, _front);
      this.writeFoot(i, ankle, _qa.copy(_qRoot).multiply(qX(_q, footPitch)), 0);
    }
  }

  // Bones of the whole body from the feet, pelvis and gait state (world space)
  solve() {
    const s = this.s;
    const g = this.gait;
    const run = this.run;
    const sprint = this.sprint;
    const airB = this.airBlend;
    const yaw = this.yaw;
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const idle = (1 - g) * (1 - airB);
    const fwdLean = 1 - 1.15 * this.back;
    this.setPelvisRotation();
    _pelvis.set(this.x + cosY * this.sway, this.pelvisY, this.z - sinY * this.sway);
    this.writeBone(BONE.PELVIS, _qPelvis, _pelvis);

    // Solve legs first so actual world knee & ankle separation drives zero-lag contralateral arm & chest motion
    let kneeSplit = 0;
    let ankleSplit = 0;
    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i];
      const footYaw = foot.swing ? foot.swingYaw : foot.yaw;
      this.jointFrom(BONE.PELVIS, LIMB.thigh[i], _qPelvis, _pelvis, _hip);
      const ankle = this.solveLeg(i, _hip, _target.set(foot.ax, foot.ay, foot.az), footYaw);
      const sign = i === 0 ? 1 : -1;
      kneeSplit += sign * ((_knee.x - this.x) * sinY + (_knee.z - this.z) * cosY);
      ankleSplit += sign * ((ankle.x - this.x) * sinY + (ankle.z - this.z) * cosY);
      let pitch = foot.pitch;
      const toe = foot.toe;
      if (foot.swing || airB > 0.05) {
        const shinFwd = (_knee.x - ankle.x) * Math.sin(footYaw) + (_knee.z - ankle.z) * Math.cos(footYaw);
        const shinPitch = Math.atan2(shinFwd, _knee.y - ankle.y);
        if (foot.swing) {
          const w = foot.w;
          const followW = Math.sin(Math.PI * w) * (0.5 + 0.5 * run) * (1 - 0.55 * this.back);
          const naturalPitch = shinPitch * 0.9 + 0.12 * run * (1 - this.back);
          pitch = lerp(pitch, naturalPitch, followW);
          pitch = Math.max(shinPitch - 0.42, Math.min(shinPitch + 0.6, pitch));
        } else {
          pitch = lerp(pitch, clampAbs(shinPitch * 0.75 + 0.12, 0.85), airB);
        }
      }
      this.writeFoot(i, ankle, qY(_qa, footYaw).multiply(qX(_q, pitch)), toe);
    }
    this.thighSplit = clampAbs(0.62 * (kneeSplit / (THIGH * s)) + 0.38 * (ankleSplit / (0.62 * s)), 1.35);

    // Chest counter-rotates against the pelvis and leans athletically into the walk/run; the head stays level, looking
    // ahead (and into turns), or subtly scanning around while standing
    const breathe = Math.sin(this.time * 1.7) * 0.008 * idle;
    const chestLean = 0.012 + (0.018 * g + (0.065 + 0.035 * sprint) * run) * fwdLean - 0.04 * airB + 0.09 * this.landDrop;
    _qChest.copy(_qPelvis)
      .multiply(qY(_q, -1.75 * this.pelvisYaw))
      .multiply(qX(_q, chestLean + breathe))
      .multiply(qZ(_q, -0.8 * this.pelvisRoll));
    this.writeBone(BONE.CHEST, _qChest, this.jointFrom(BONE.PELVIS, BONE.CHEST, _qPelvis, _pelvis, _chest));
    const look = Math.sin(this.time * 0.37 + this.seed) * 0.22 * idle * idle;
    const headPitch = 0.015 * idle - 0.02 * run * (1 - this.back) - 0.04 * airB;
    qY(_qa, yaw + this.headTurn + look).multiply(qX(_q, headPitch));
    this.writeBone(BONE.HEAD, _qa, this.jointFrom(BONE.CHEST, BONE.HEAD, _qChest, _chest, _v));

    // Arms: relaxed symmetric pendulum in walk (opening straight on backswing); energetic "cheek-to-hip-pocket" pump in
    // running (elbows driving far behind the back on backswing, hands pumping up towards chest midline on frontswing)
    const armSignal = lerp(this.arm, this.thighSplit, 0.65 * g);
    const armScale = this.armSwing * Math.max(g, 0.35 * smooth(0.4, 2.2, Math.abs(this.yawRate))) * (1 - 0.55 * airB);
    const fwdRun = run * (1 - 0.6 * this.back);
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i];
      const drive = -side * armSignal * armScale;
      const posD = 0.5 * (drive + Math.sqrt(drive * drive + 0.015));
      const negD = posD - drive;
      const walkFlex = drive * 0.46;
      const runFlex = -0.03 + posD * (0.58 + 0.1 * sprint) - negD * (0.64 + 0.12 * sprint);
      const flex = lerp(walkFlex, runFlex, fwdRun) + idle * 0.01 + airB * 0.28;
      const abduction = 0.095 + (this.girth - 1) * 0.35 + run * (0.06 + 0.03 * sprint) + this.back * run * 0.05 + airB * 0.16 + this.landDrop * 0.6;
      const crossIn = -side * (0.05 * g + (0.16 + 0.08 * sprint) * fwdRun) * Math.min(1.1, posD);
      this.jointFrom(BONE.CHEST, LIMB.upperArm[i], _qChest, _chest, _shoulder);
      _qUpper.copy(_qChest)
        .multiply(qZ(_q, side * (abduction - ARM_BIND_ABDUCTION)))
        .multiply(qY(_q, crossIn))
        .multiply(qX(_q, -flex));
      this.writeBone(LIMB.upperArm[i], _qUpper, _shoulder);
      const walkElbow = 0.14 * idle + 0.075 * g + 0.42 * posD;
      const runElbow = (1.14 + 0.08 * sprint) + posD * (0.38 + 0.1 * sprint) - negD * 0.1;
      const elbow = lerp(walkElbow, runElbow, fwdRun) + airB * 0.35;
      this.jointFrom(LIMB.upperArm[i], LIMB.forearm[i], _qUpper, _shoulder, _v);
      this.writeBone(LIMB.forearm[i], _q2.copy(_qUpper).multiply(qX(_q, -elbow)), _v);
    }
  }

  /**
   * Riding a bicycle: `root` (Object3D) is the bike frame (pose in its parent's space, e.g. the scene), `crank` the
   * pedal crank angle. Seat, bars and bottom bracket in the frame's space (metres, +Z forward).
   */
  ride(root, crank, { seat, bars, gripHalf = 0.22, bracket, crankLength = 0.17 }) {
    const s = this.s;
    this.gait = 0;
    this.run = 0;
    root.updateWorldMatrix(true, false);
    root.matrixWorld.decompose(_rootPos, _qRoot, _v);
    const toWorld = (local) => local.applyQuaternion(_qRoot).add(_rootPos);

    // Pelvis on the saddle, leaning forward; chest further forward, head up looking ahead
    qX(_qPelvis, 0.42).premultiply(_qRoot);
    toWorld(_pelvis.set(0, seat.y + 0.055 * s, seat.z + 0.03));
    this.writeBone(BONE.PELVIS, _qPelvis, _pelvis);
    _qChest.copy(_qPelvis).multiply(qX(_q, 0.2));
    this.writeBone(BONE.CHEST, _qChest, this.jointFrom(BONE.PELVIS, BONE.CHEST, _qPelvis, _pelvis, _chest));
    _qa.copy(_qRoot).multiply(qX(_q, -0.12));
    this.jointFrom(BONE.CHEST, BONE.HEAD, _qChest, _chest, _v);
    this.writeBone(BONE.HEAD, _qa, _v);
    this.headPosition = (this.headPosition || new THREE.Vector3()).copy(_v);
    this.headQuaternion = (this.headQuaternion || new THREE.Quaternion()).copy(_qa);

    // Hands on the grips (elbows out & down, the arms' front kept towards the bike's front), feet on the pedals
    // (knees over the feet)
    _fwd.set(0, 0, 1).applyQuaternion(_qRoot);
    this.yaw = Math.atan2(_fwd.x, _fwd.z);
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i];
      this.jointFrom(BONE.CHEST, LIMB.upperArm[i], _qChest, _chest, _shoulder);
      toWorld(_target.set(side * gripHalf, bars.y + 0.02, bars.z - 0.07));
      _pole.set(side * 0.6, -1, -0.4).applyQuaternion(_qRoot);
      this.limb(LIMB.upperArm[i], LIMB.forearm[i], _shoulder, _target, UPPER_ARM * s, (FOREARM + 0.07) * s, _pole, _fwd, side * ARM_BIND_ABDUCTION);

      // pedals go round bottom, back, top, front as `crank` grows (pedalling forwards)
      const a = crank + (i === 0 ? 0 : Math.PI);
      const footPitch = 0.16 + 0.16 * Math.cos(a) - 0.1 * Math.sin(a);
      qX(_q2, footPitch);
      // ball of the foot on the pedal: ankle = pedal - R * (ball offset from the ankle)
      _v2.set(0, TOE_JOINT.y * s - 0.012, TOE_JOINT.z * s * 0.85).applyQuaternion(_q2);
      _target.set(side * 0.1, bracket.y - Math.cos(a) * crankLength, bracket.z - Math.sin(a) * crankLength).sub(_v2);
      toWorld(_target);
      this.jointFrom(BONE.PELVIS, LIMB.thigh[i], _qPelvis, _pelvis, _hip);
      const ankle = this.solveLeg(i, _hip, _target, this.yaw);
      this.writeFoot(i, ankle, _qa.copy(_qRoot).multiply(qX(_q, footPitch)), 0);
    }
  }
}


export { BONE as PERSON_BONES, buildPersonGeometry, createPersonMaterial, PersonCrowd, PersonRig, PEDESTRIAN_DIVE_DURATION };
