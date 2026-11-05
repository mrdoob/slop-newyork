const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const lightingSource = readFileSync(join(__dirname, '../js/lighting.js'), 'utf8');

const WebGLCoordinateSystem = 2000;
const WebGPUCoordinateSystem = 2001;

class Color {
  constructor(hex = 0xffffff) { this.setHex(hex); }
  setHex(hex) { this.hex = hex; return this; }
}

class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
}

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  distanceToSquared(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }
  normalize() {
    const l = this.length() || 1;
    this.x /= l; this.y /= l; this.z /= l;
    return this;
  }
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }
  setFromMatrixPosition(m) {
    const e = m.elements;
    this.x = e[12]; this.y = e[13]; this.z = e[14];
    return this;
  }
  setFromMatrixColumn(m, index) {
    const o = index * 4;
    const e = m.elements;
    this.x = e[o]; this.y = e[o + 1]; this.z = e[o + 2];
    return this;
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
  applyMatrix4(m) {
    const x = this.x, y = this.y, z = this.z;
    const e = m.elements;
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  }
}

class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  applyMatrix4(m) {
    const x = this.x, y = this.y, z = this.z, w = this.w;
    const e = m.elements;
    this.x = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
    this.y = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
    this.z = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
    this.w = e[3] * x + e[7] * y + e[11] * z + e[15] * w;
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
  setFromRotationMatrix(m) {
    const te = m.elements;
    const m11 = te[0], m12 = te[4], m13 = te[8];
    const m21 = te[1], m22 = te[5], m23 = te[9];
    const m31 = te[2], m32 = te[6], m33 = te[10];
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }
    return this;
  }
}

class Matrix4 {
  constructor() {
    this.elements = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
  }
  set(n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44) {
    const te = this.elements;
    te[0] = n11; te[4] = n12; te[8] = n13; te[12] = n14;
    te[1] = n21; te[5] = n22; te[9] = n23; te[13] = n24;
    te[2] = n31; te[6] = n32; te[10] = n33; te[14] = n34;
    te[3] = n41; te[7] = n42; te[11] = n43; te[15] = n44;
    return this;
  }
  copy(m) {
    for (let i = 0; i < 16; i++) this.elements[i] = m.elements[i];
    return this;
  }
  transpose() {
    const te = this.elements;
    let tmp;
    tmp = te[1]; te[1] = te[4]; te[4] = tmp;
    tmp = te[2]; te[2] = te[8]; te[8] = tmp;
    tmp = te[6]; te[6] = te[9]; te[9] = tmp;
    tmp = te[3]; te[3] = te[12]; te[12] = tmp;
    tmp = te[7]; te[7] = te[13]; te[13] = tmp;
    tmp = te[11]; te[11] = te[14]; te[14] = tmp;
    return this;
  }
  multiply(m) { return this.multiplyMatrices(this, m); }
  multiplyMatrices(a, b) {
    const ae = a.elements, be = b.elements, te = this.elements;
    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
    return this;
  }
  compose(position, quaternion, scale) {
    const te = this.elements;
    const x = quaternion.x, y = quaternion.y, z = quaternion.z, w = quaternion.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = scale.x, sy = scale.y, sz = scale.z;
    te[0] = (1 - (yy + zz)) * sx;
    te[1] = (xy + wz) * sx;
    te[2] = (xz - wy) * sx;
    te[3] = 0;
    te[4] = (xy - wz) * sy;
    te[5] = (1 - (xx + zz)) * sy;
    te[6] = (yz + wx) * sy;
    te[7] = 0;
    te[8] = (xz + wy) * sz;
    te[9] = (yz - wx) * sz;
    te[10] = (1 - (xx + yy)) * sz;
    te[11] = 0;
    te[12] = position.x;
    te[13] = position.y;
    te[14] = position.z;
    te[15] = 1;
    return this;
  }
  invert() {
    const te = this.elements;
    const n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3];
    const n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7];
    const n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11];
    const n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15];
    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
    if (det === 0) return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const detInv = 1 / det;
    te[0] = t11 * detInv;
    te[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    te[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    te[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;
    te[4] = t12 * detInv;
    te[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    te[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    te[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;
    te[8] = t13 * detInv;
    te[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    te[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    te[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;
    te[12] = t14 * detInv;
    te[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    te[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    te[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;
    return this;
  }
  lookAt(eye, target, up) {
    const _x = new Vector3(), _y = new Vector3(), _z = new Vector3();
    _z.subVectors(eye, target);
    if (_z.lengthSq() === 0) _z.z = 1;
    _z.normalize();
    _x.crossVectors(up, _z);
    if (_x.lengthSq() === 0) {
      if (Math.abs(up.z) === 1) _z.x += 0.0001;
      else _z.z += 0.0001;
      _z.normalize();
      _x.crossVectors(up, _z);
    }
    _x.normalize();
    _y.crossVectors(_z, _x);
    const te = this.elements;
    te[0] = _x.x; te[4] = _y.x; te[8] = _z.x;
    te[1] = _x.y; te[5] = _y.y; te[9] = _z.y;
    te[2] = _x.z; te[6] = _y.z; te[10] = _z.z;
    return this;
  }
  makePerspective(left, right, top, bottom, near, far, coordinateSystem = WebGLCoordinateSystem, reversedDepth = false) {
    const x = 2 * near / (right - left);
    const y = 2 * near / (top - bottom);
    const a = (right + left) / (right - left);
    const b = (top + bottom) / (top - bottom);
    let c, d;
    if (reversedDepth) {
      c = near / (far - near);
      d = (far * near) / (far - near);
    } else if (coordinateSystem === WebGLCoordinateSystem) {
      c = -(far + near) / (far - near);
      d = (-2 * far * near) / (far - near);
    } else {
      c = -far / (far - near);
      d = (-far * near) / (far - near);
    }
    const te = this.elements;
    te[0] = x; te[4] = 0; te[8] = a; te[12] = 0;
    te[1] = 0; te[5] = y; te[9] = b; te[13] = 0;
    te[2] = 0; te[6] = 0; te[10] = c; te[14] = d;
    te[3] = 0; te[7] = 0; te[11] = -1; te[15] = 0;
    return this;
  }
  makeOrthographic(left, right, top, bottom, near, far, coordinateSystem = WebGLCoordinateSystem, reversedDepth = false) {
    const w = 1.0 / (right - left);
    const h = 1.0 / (top - bottom);
    const p = 1.0 / (far - near);
    const x = (right + left) * w;
    const y = (top + bottom) * h;
    let z, zInv;
    if (reversedDepth) {
      z = far * p;
      zInv = 1 * p;
    } else if (coordinateSystem === WebGLCoordinateSystem) {
      z = (far + near) * p;
      zInv = -2 * p;
    } else {
      z = near * p;
      zInv = -1 * p;
    }
    const te = this.elements;
    te[0] = 2 * w; te[4] = 0; te[8] = 0; te[12] = -x;
    te[1] = 0; te[5] = 2 * h; te[9] = 0; te[13] = -y;
    te[2] = 0; te[6] = 0; te[10] = zInv; te[14] = z;
    te[3] = 0; te[7] = 0; te[11] = 0; te[15] = 1;
    return this;
  }
}

class Plane {
  constructor(normal = new Vector3(1, 0, 0), constant = 0) {
    this.normal = normal;
    this.constant = constant;
  }
  setComponents(x, y, z, w) {
    this.normal.set(x, y, z);
    this.constant = w;
    return this;
  }
  normalize() {
    const inv = 1.0 / this.normal.length();
    this.normal.multiplyScalar(inv);
    this.constant *= inv;
    return this;
  }
  distanceToPoint(p) {
    return this.normal.dot(p) + this.constant;
  }
}

class Sphere {
  constructor(center = new Vector3(), radius = 0) {
    this.center = center;
    this.radius = radius;
  }
}

class Frustum {
  constructor() {
    this.planes = Array.from({ length: 6 }, () => new Plane());
  }
  setFromProjectionMatrix(m, coordinateSystem = WebGLCoordinateSystem, reversedDepth = false) {
    const planes = this.planes;
    const me = m.elements;
    const me0 = me[0], me1 = me[1], me2 = me[2], me3 = me[3];
    const me4 = me[4], me5 = me[5], me6 = me[6], me7 = me[7];
    const me8 = me[8], me9 = me[9], me10 = me[10], me11 = me[11];
    const me12 = me[12], me13 = me[13], me14 = me[14], me15 = me[15];

    planes[0].setComponents(me3 - me0, me7 - me4, me11 - me8, me15 - me12).normalize();
    planes[1].setComponents(me3 + me0, me7 + me4, me11 + me8, me15 + me12).normalize();
    planes[2].setComponents(me3 + me1, me7 + me5, me11 + me9, me15 + me13).normalize();
    planes[3].setComponents(me3 - me1, me7 - me5, me11 - me9, me15 - me13).normalize();

    if (reversedDepth) {
      planes[4].setComponents(me2, me6, me10, me14).normalize();
      planes[5].setComponents(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize();
    } else {
      planes[4].setComponents(me3 - me2, me7 - me6, me11 - me10, me15 - me14).normalize();
      if (coordinateSystem === WebGLCoordinateSystem) {
        planes[5].setComponents(me3 + me2, me7 + me6, me11 + me10, me15 + me14).normalize();
      } else {
        planes[5].setComponents(me2, me6, me10, me14).normalize();
      }
    }
    return this;
  }
  intersectsSphere(sphere) {
    const center = sphere.center;
    const negRadius = -sphere.radius;
    for (let i = 0; i < 6; i++) {
      if (this.planes[i].distanceToPoint(center) < negRadius) return false;
    }
    return true;
  }
}

class Object3D {
  constructor() {
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.scale = new Vector3(1, 1, 1);
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.children = [];
  }
  add(child) {
    if (!this.children.includes(child)) this.children.push(child);
    return this;
  }
  translateZ(distance) {
    const axis = new Vector3(0, 0, 1).applyQuaternion(this.quaternion);
    this.position.addScaledVector(axis, distance);
    return this;
  }
  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
  }
  updateMatrixWorld() {
    this.updateMatrix();
    this.matrixWorld.copy(this.matrix);
  }
}

class Camera extends Object3D {
  constructor() {
    super();
    this.matrixWorldInverse = new Matrix4();
    this.projectionMatrix = new Matrix4();
    this.projectionMatrixInverse = new Matrix4();
    this.coordinateSystem = WebGPUCoordinateSystem;
    this._reversedDepth = false;
  }
  get reversedDepth() { return this._reversedDepth; }
  updateMatrixWorld() {
    super.updateMatrixWorld();
    this.matrixWorldInverse.copy(this.matrixWorld).invert();
  }
}

class OrthographicCamera extends Camera {
  constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 2000) {
    super();
    this.isOrthographicCamera = true;
    this.left = left;
    this.right = right;
    this.top = top;
    this.bottom = bottom;
    this.near = near;
    this.far = far;
    this.updateProjectionMatrix();
  }
  updateProjectionMatrix() {
    this.projectionMatrix.makeOrthographic(
      this.left, this.right, this.top, this.bottom,
      this.near, this.far, this.coordinateSystem, this.reversedDepth
    );
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

class PerspectiveCamera extends Camera {
  constructor(fov = 50, aspect = 1, near = 0.35, far = 6000) {
    super();
    this.isPerspectiveCamera = true;
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    this.updateProjectionMatrix();
  }
  updateProjectionMatrix() {
    const top = this.near * Math.tan((Math.PI / 360) * this.fov);
    const height = 2 * top;
    const width = this.aspect * height;
    const left = -0.5 * width;
    this.projectionMatrix.makePerspective(
      left, left + width, top, top - height,
      this.near, this.far, this.coordinateSystem, this.reversedDepth
    );
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

class SunLightShadow {
  constructor() {
    this.camera = new OrthographicCamera(-5, 5, 5, -5, 0.5, 500);
    this.mapSize = new Vector2(1024, 1024);
    this.radius = 1;
    this.bias = 0;
    this.normalBias = 0;
    this._frameExtents = new Vector2(2, 1);
    this._viewportCount = 2;
    this._cameras = [new OrthographicCamera(), new OrthographicCamera()];
    this._matrices = [new Matrix4(), new Matrix4()];
    this._frustums = [new Frustum(), new Frustum()];
    this._viewports = [new Vector4(), new Vector4()];
    this._cascadeSplits = [0, 0, 0];
    this._cascadeData = [new Vector4(), new Vector4()];
  }
  getViewportCount() { return this._viewportCount; }
  getCamera(i = 0) { return this._cameras[i]; }
  getMatrix(i = 0) { return this._matrices[i]; }
  getFrustum(i = 0) { return this._frustums[i]; }
  _updateMatrix(shadowCamera, shadowMatrix, frustum, viewport) {
    const projScreen = new Matrix4().multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen, shadowCamera.coordinateSystem, shadowCamera.reversedDepth);
    const scaleX = viewport ? viewport.z / this._frameExtents.x : 1;
    const scaleY = viewport ? viewport.w / this._frameExtents.y : 1;
    const offsetX = viewport ? viewport.x / this._frameExtents.x : 0;
    const offsetY = viewport ? viewport.y / this._frameExtents.y : 0;
    if (shadowCamera.coordinateSystem === WebGPUCoordinateSystem || shadowCamera.reversedDepth) {
      shadowMatrix.set(
        0.5 * scaleX, 0, 0, 0.5 * scaleX + offsetX,
        0, 0.5 * scaleY, 0, 0.5 * scaleY + offsetY,
        0, 0, 1, 0,
        0, 0, 0, 1
      );
    } else {
      shadowMatrix.set(
        0.5 * scaleX, 0, 0, 0.5 * scaleX + offsetX,
        0, 0.5 * scaleY, 0, 0.5 * scaleY + offsetY,
        0, 0, 0.5, 0.5,
        0, 0, 0, 1
      );
    }
    shadowMatrix.multiply(projScreen);
  }
  updateMatrices(light, viewCamera) {
    if (viewCamera === undefined) return;
    const cascadeCount = 2;
    const cascadeFade = 0.1;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    for (let i = 0; i < cascadeCount; i++) {
      this._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    }
    const resolutionX = this.mapSize.x * (1 - 2 * insetX);
    const resolutionY = this.mapSize.y * (1 - 2 * insetY);
    const resolution = Math.min(resolutionX, resolutionY);
    const camera = this.camera;
    const cameraNear = viewCamera.near;
    const cameraFar = Math.max(cameraNear + 1e-6, Math.min(camera.far, viewCamera.far));
    const splits = this._cascadeSplits;
    splits[0] = cameraNear;
    for (let i = 1; i < cascadeCount; i++) {
      const amount = i / cascadeCount;
      const u = cameraNear + (cameraFar - cameraNear) * amount;
      const l = cameraNear > 0 ? cameraNear * Math.pow(cameraFar / cameraNear, amount) : u;
      splits[i] = (u + l) * 0.5;
    }
    splits[cascadeCount] = cameraFar;

    const lightDir = new Vector3().setFromMatrixPosition(light.matrixWorld).negate().normalize();
    const up = new Vector3(0, 1, 0);
    if (Math.abs(up.dot(lightDir)) > 0.99) up.set(0, 0, 1);
    const lightOrientationMatrix = new Matrix4().lookAt(new Vector3(0, 0, 0), lightDir, up);
    const viewToLightMatrix = new Matrix4().copy(lightOrientationMatrix).transpose().multiply(viewCamera.matrixWorld);

    const zNear = viewCamera.reversedDepth ? 1 : (viewCamera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1);
    const invProj = viewCamera.projectionMatrixInverse;
    const nearCorners = Array.from({ length: 4 }, () => new Vector3());
    const farCorners = Array.from({ length: 4 }, () => new Vector3());
    const cascadeCorners = Array.from({ length: 8 }, () => new Vector3());
    let globalMaxZ = -Infinity;

    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nc = nearCorners[i].set(x, y, zNear).applyMatrix4(invProj);
      const fc = farCorners[i];
      if (viewCamera.isPerspectiveCamera === true) {
        fc.copy(nc).multiplyScalar(cameraFar / cameraNear);
      } else {
        fc.set(nc.x, nc.y, -cameraFar);
      }
      nc.applyMatrix4(viewToLightMatrix);
      fc.applyMatrix4(viewToLightMatrix);
      globalMaxZ = Math.max(globalMaxZ, nc.z, fc.z);
    }
    globalMaxZ += cameraFar;

    const shadowNear = camera.near;
    const center = new Vector3();

    for (let i = 0; i < cascadeCount; i++) {
      const cascadeNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
      const cascadeFar = splits[i + 1];
      const fadeStart = cascadeFar - cascadeFade * (cascadeFar - splits[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);

      const nearAlpha = (cascadeNear - cameraNear) / (cameraFar - cameraNear);
      const farAlpha = (cascadeFar - cameraNear) / (cameraFar - cameraNear);
      center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        cascadeCorners[j * 2].lerpVectors(nearCorners[j], farCorners[j], nearAlpha);
        cascadeCorners[j * 2 + 1].lerpVectors(nearCorners[j], farCorners[j], farAlpha);
        center.add(cascadeCorners[j * 2]).add(cascadeCorners[j * 2 + 1]);
      }
      center.multiplyScalar(1 / 8);

      let radiusSq = 0;
      let minZ = Infinity;
      for (let j = 0; j < 8; j++) {
        radiusSq = Math.max(radiusSq, cascadeCorners[j].distanceToSquared(center));
        minZ = Math.min(minZ, cascadeCorners[j].z);
      }
      let radius = Math.sqrt(radiusSq);
      if (resolution > 1) {
        radius /= 1 - 1 / resolution;
        const texelSizeX = 2 * radius / resolutionX;
        const texelSizeY = 2 * radius / resolutionY;
        center.x = Math.round(center.x / texelSizeX) * texelSizeX;
        center.y = Math.round(center.y / texelSizeY) * texelSizeY;
      }

      center.z = globalMaxZ + shadowNear;
      center.applyMatrix4(lightOrientationMatrix);

      const cascadeCamera = this._cameras[i];
      cascadeCamera.position.copy(center);
      cascadeCamera.quaternion.setFromRotationMatrix(lightOrientationMatrix);
      cascadeCamera.left = -radius;
      cascadeCamera.right = radius;
      cascadeCamera.top = radius;
      cascadeCamera.bottom = -radius;
      cascadeCamera.near = shadowNear;
      cascadeCamera.far = globalMaxZ - minZ + 2 * shadowNear;
      cascadeCamera.coordinateSystem = camera.coordinateSystem;
      cascadeCamera._reversedDepth = camera.reversedDepth;
      cascadeCamera.updateProjectionMatrix();
      cascadeCamera.updateMatrixWorld();

      this._updateMatrix(cascadeCamera, this._matrices[i], this._frustums[i], this._viewports[i]);
    }
  }
}

class SunLight extends Object3D {
  static registerNode() {}
  constructor(color = 0xffffff, intensity = 1) {
    super();
    this.isSunLight = true;
    this.color = new Color(color);
    this.intensity = intensity;
    this.castShadow = false;
    this.shadow = new SunLightShadow();
  }
}

function makeTSLNode() {
  return {
    get rgb() { return makeTSLNode(); },
    get x() { return makeTSLNode(); },
    get y() { return makeTSLNode(); },
    get z() { return makeTSLNode(); },
    add: () => makeTSLNode(),
    sub: () => makeTSLNode(),
    mul: () => makeTSLNode(),
    div: () => makeTSLNode(),
    negate: () => makeTSLNode(),
    greaterThan: () => makeTSLNode(),
    assign: () => makeTSLNode(),
    toVar: () => makeTSLNode()
  };
}

function loadLighting() {
  class FogExp2 {
    constructor(color, density) {
      this.color = new Color(color);
      this.density = density;
    }
  }
  class Scene extends Object3D {}
  class HemisphereLight extends Object3D {
    constructor(sky, ground, intensity) {
      super();
      this.color = new Color(sky);
      this.groundColor = new Color(ground);
      this.intensity = intensity;
    }
  }
  class PMREMGenerator {
    fromScene() { return { texture: { isTexture: true } }; }
  }
  class SkyMesh extends Object3D {
    constructor() {
      super();
      const u = (v = 0) => ({ value: v });
      this.turbidity = u();
      this.rayleigh = u();
      this.mieCoefficient = u();
      this.mieDirectionalG = u();
      this.cloudScale = u();
      this.cloudSpeed = u();
      this.cloudCoverage = u();
      this.cloudDensity = u();
      this.cloudElevation = u();
      this.showSunDisc = u(1);
      this.sunPosition = u(new Vector3());
      this.material = { colorNode: makeTSLNode(), vertexNode: makeTSLNode() };
    }
  }

  const THREE = {
    Vector3,
    Color,
    FogExp2,
    Scene,
    HemisphereLight,
    PMREMGenerator,
    WebGLCoordinateSystem,
    WebGPUCoordinateSystem
  };

  const tsl = {
    Fn: (fn) => () => fn(),
    float: () => makeTSLNode(),
    vec3: () => makeTSLNode(),
    vec4: () => makeTSLNode(),
    uniform: (value) => ({ value, ...makeTSLNode() }),
    mix: () => makeTSLNode(),
    fog: () => makeTSLNode(),
    pmremTexture: () => makeTSLNode(),
    positionWorld: makeTSLNode(),
    cameraPosition: makeTSLNode(),
    length: () => makeTSLNode(),
    normalize: () => makeTSLNode(),
    max: () => makeTSLNode(),
    exp: () => makeTSLNode(),
    abs: () => makeTSLNode(),
    select: () => makeTSLNode()
  };

  const cityUniforms = {
    uSunColor: { value: new Color() },
    uSkyTopColor: { value: new Color() },
    uSkyHorizonColor: { value: new Color() },
    uSkySunDir: { value: new Vector3() },
    uInteriorGlow: { value: 0 },
    uRoadWetness: { value: 0 },
    uCanyonBounce: { value: 0 }
  };

  const mod = loadModule(lightingSource, {
    filename: 'lighting.js',
    imports: {
      'three/webgpu': THREE,
      'three/tsl': tsl,
      'three/addons/objects/SkyMesh.js': { SkyMesh },
      'three/addons/lights/SunLight.js': { SunLight },
      'three/addons/lights/SunLightNode.js': { SunLightNode: class SunLightNode {} },
      './tsl-materials.js': { cityUniforms }
    }
  });

  return { ...mod, THREE };
}

function makeChaseCamera({ x = -1135.4, y = 3.13, z = 1204.1, yawDeg = 20, reversedDepth = true } = {}) {
  const cam = new PerspectiveCamera(50, 840 / 1070, 0.35, 6000);
  cam.coordinateSystem = WebGPUCoordinateSystem;
  cam._reversedDepth = reversedDepth;
  cam.position.set(x, y, z);
  cam.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

test('extended cascade ceiling keeps 30 Hudson Yards and 541 m towers in front of cascade near across all yaws and presets', () => {
  // 30 Hudson Yards (height 386 m) casting onto 9th Ave & W 26th St (~670-753 m downstream at Golden Hour)
  const hudsonYardsCenter = new Vector3((-1542 - 1423.5) * 0.5, 386 * 0.5, (734 + 897.5) * 0.5);
  const hudsonYardsSphere = new Sphere(hudsonYardsCenter, Math.hypot(59.25, 193, 81.75));
  const hudsonYardsRoofNW = new Vector3(-1542, 386, 734);

  // Stock SunLightShadow with far = 220 clips 30 Hudson Yards' roof in the NNW view and culls the whole tower in SSE view.
  {
    const stockLight = new SunLight();
    stockLight.position.set(-0.44, 0.58, -0.68).normalize();
    stockLight.updateMatrixWorld();
    stockLight.shadow.mapSize.set(2048, 2048);
    stockLight.shadow.camera.near = 0.5;
    stockLight.shadow.camera.far = 220;
    stockLight.shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
    stockLight.shadow.camera._reversedDepth = true;

    stockLight.shadow.updateMatrices(stockLight, makeChaseCamera({ yawDeg: 20 }));
    assert.ok(stockLight.shadow.getFrustum(1).planes[5].distanceToPoint(hudsonYardsRoofNW) < 0);

    stockLight.shadow.updateMatrices(stockLight, makeChaseCamera({ yawDeg: 215 }));
    assert.equal(stockLight.shadow.getFrustum(0).intersectsSphere(hudsonYardsSphere), false);
    assert.equal(stockLight.shadow.getFrustum(1).intersectsSphere(hudsonYardsSphere), false);
  }

  // LightingSystem extends each cascade upstream along +Z (sun) so every tower up to 550 m stays inside [near, far].
  const { LightingSystem, THREE } = loadLighting();
  const lighting = new LightingSystem(new THREE.Scene(), { reversedDepthBuffer: true });
  const shadow = lighting.sunLight.shadow;
  shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
  shadow.camera._reversedDepth = true;

  for (const yawDeg of [0, 20, 45, 90, 135, 180, 215, 270, 315]) {
    const cam = makeChaseCamera({ yawDeg });
    shadow.updateMatrices(lighting.sunLight, cam);
    assert.ok(shadow.getFrustum(0).planes[5].distanceToPoint(hudsonYardsRoofNW) > 0);
    assert.ok(shadow.getFrustum(1).planes[5].distanceToPoint(hudsonYardsRoofNW) > 0);
    assert.equal(shadow.getFrustum(0).intersectsSphere(hudsonYardsSphere), true);
    assert.equal(shadow.getFrustum(1).intersectsSphere(hudsonYardsSphere), true);
  }

  // Even a 541 m supertall (One WTC) casting a shadow down to street level stays in front of near in all 4 presets.
  for (const preset of ['golden', 'midday', 'twilight', 'midnight']) {
    lighting.applyPreset(preset, true);
    const sunDir = lighting.sunLight.position.clone().normalize();
    const receiver = new Vector3(0, 0, 0);
    const towerTop = receiver.clone().addScaledVector(sunDir, 541 / sunDir.y);

    const cam = makeChaseCamera({ x: 0, y: 3, z: 8, yawDeg: 180 });
    shadow.updateMatrices(lighting.sunLight, cam);
    assert.ok(
      shadow.getFrustum(0).planes[5].distanceToPoint(towerTop) > 0,
      `541 m supertall stays in front of Cascade 0 near plane in '${preset}' preset`
    );
    assert.ok(
      shadow.getFrustum(1).planes[5].distanceToPoint(towerTop) > 0,
      `541 m supertall stays in front of Cascade 1 near plane in '${preset}' preset`
    );
  }
});

test('extended cascade ceiling preserves texel-snapped X/Y bounds, downstream far plane, and receiver depth in (0, 1)', () => {
  for (const reversedDepth of [true, false]) {
    const stockLight = new SunLight();
    stockLight.position.set(-0.44, 0.58, -0.68).normalize();
    stockLight.updateMatrixWorld();
    stockLight.shadow.mapSize.set(2048, 2048);
    stockLight.shadow.camera.near = 0.5;
    stockLight.shadow.camera.far = 220;
    stockLight.shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
    stockLight.shadow.camera._reversedDepth = reversedDepth;

    const { LightingSystem, THREE } = loadLighting();
    const lighting = new LightingSystem(new THREE.Scene(), { reversedDepthBuffer: reversedDepth });
    const shadow = lighting.sunLight.shadow;
    shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
    shadow.camera._reversedDepth = reversedDepth;

    const viewCam = makeChaseCamera({ yawDeg: 20, reversedDepth });
    stockLight.shadow.updateMatrices(stockLight, viewCam);
    shadow.updateMatrices(lighting.sunLight, viewCam);

    const xAxis = new Vector3().setFromMatrixColumn(shadow.getCamera(0).matrixWorld, 0);
    const yAxis = new Vector3().setFromMatrixColumn(shadow.getCamera(0).matrixWorld, 1);

    for (let i = 0; i < 2; i++) {
      const sc = stockLight.shadow.getCamera(i);
      const ec = shadow.getCamera(i);

      assert.ok(Math.abs(ec.left - sc.left) < 1e-9);
      assert.ok(Math.abs(ec.right - sc.right) < 1e-9);
      assert.ok(Math.abs(xAxis.dot(ec.position) - xAxis.dot(sc.position)) < 1e-9);
      assert.ok(Math.abs(yAxis.dot(ec.position) - yAxis.dot(sc.position)) < 1e-9);
      assert.ok(
        Math.abs(shadow.getFrustum(i).planes[4].constant - stockLight.shadow.getFrustum(i).planes[4].constant) < 1e-9,
        'downstream far plane stays unchanged'
      );

      // Receiver at the taxi position maps strictly inside (0, 1).
      const clip = new Vector4(-1138, 0, 1197, 1).applyMatrix4(shadow.getMatrix(i));
      const coordZ = clip.z / clip.w;
      if (i === 0) {
        assert.ok(coordZ > 0 && coordZ < 1, `taxi shadowCoord.z=${coordZ} must lie in (0, 1)`);
      }
    }
  }
});
