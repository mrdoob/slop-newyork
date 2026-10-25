const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../js/render/scene-culling.js'), 'utf8');
const topLevel = (name) => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?\\n\\}`, 'm'));
  assert.ok(match, `${name} is present`);
  return match[0];
};

// Just enough of three.js for splitMesh: world-space triangle centres, attributes, meshes in a parent
class Vector3 {
  constructor() { this.x = this.y = this.z = 0; }
  fromBufferAttribute(a, i) { [this.x, this.y, this.z] = a.array.slice(i * 3, i * 3 + 3); return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  applyMatrix4(m) { this.x += m.tx; this.z += m.tz; return this; } // (translations only here)
  copy(v) { return Object.assign(this, { x: v.x, y: v.y, z: v.z }); }
}
class BufferAttribute {
  constructor(array, itemSize, normalized = false) { Object.assign(this, { array, itemSize, normalized, count: array.length / itemSize }); }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this.disposed = false; }
  setAttribute(name, a) { this.attributes[name] = a; }
  computeBoundingBox() {}
  computeBoundingSphere() {}
  dispose() { this.disposed = true; }
}
class Object3D {
  constructor() {
    this.children = [];
    this.parent = null;
    this.layers = { mask: 1 };
    this.userData = {};
    this.position = new Vector3();
    this.quaternion = new Vector3();
    this.scale = new Vector3();
    this.matrix = { copy() {} };
  }
  add(o) { o.parent = this; this.children.push(o); }
  remove(o) { this.children = this.children.filter((c) => c !== o); }
  updateMatrixWorld() {}
}
class Mesh extends Object3D {
  constructor(geometry, material) { super(); Object.assign(this, { geometry, material }); }
}
const THREE = { BufferAttribute, BufferGeometry, Mesh };
const context = { THREE, Math, Map, Object, _a: new Vector3(), _b: new Vector3(), _c: new Vector3() };
const splitMesh = vm.runInNewContext(`${topLevel('copyObjectState')}\n(${topLevel('splitMesh')})`, context);

test('a large merged mesh is split into squares by where its triangles are, every triangle kept once', () => {
  const parent = new Object3D();
  // nine triangles spread over three 1 km squares, the mesh placed 200 m east
  const pos = [], uv = [];
  for (const [x, z] of [[100, 100], [300, 400], [900, 50], [1200, 100], [1500, 800], [1900, 900], [100, 1200], [400, 1700], [800, 1900]]) {
    pos.push(x, 0, z, x + 5, 0, z, x, 0, z + 5);
    uv.push(x, z, x, z, x, z);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  const material = {};
  const mesh = new Mesh(geo, material);
  mesh.matrixWorld = { tx: 200, tz: 0 };
  mesh.name = 'Curbs';
  mesh.receiveShadow = true;
  parent.add(mesh);
  splitMesh(mesh, 1000);
  assert.ok(!parent.children.includes(mesh) && geo.disposed);
  // (the centres in the world, 200 m further east: squares (0, 0), (1, 0), (2, 0), (0, 1) and (1, 1))
  assert.equal(parent.children.length, 5);
  let tris = 0;
  const seen = new Set();
  for (const piece of parent.children) {
    assert.equal(piece.material, material);
    assert.equal(piece.name, 'Curbs');
    assert.equal(piece.receiveShadow, true);
    const p = piece.geometry.attributes.position.array, u = piece.geometry.attributes.uv.array;
    tris += p.length / 9;
    for (let t = 0; t < p.length; t += 9) {
      seen.add(`${p[t]},${p[t + 2]}`);
      assert.equal(u[(t / 9) * 6], p[t], 'attributes travel with their triangle');
    }
  }
  assert.equal(tris, 9);
  assert.equal(seen.size, 9);
});
