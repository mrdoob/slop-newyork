import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { clipToLattice } from '../js/world/ground.js';

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');
const source = readFileSync(new URL('../js/world/drape.js', import.meta.url), 'utf8');

// Just enough of three.js for drapeGeometry
class BufferAttribute {
  constructor(array, itemSize, normalized = false) {
    Object.assign(this, { array, itemSize, normalized, count: array.length / itemSize });
  }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(name, a) { this.attributes[name] = a; }
  computeBoundingBox() {}
  computeBoundingSphere() {}
}
const THREE = { BufferAttribute, BufferGeometry, Matrix4: class {} };

// The town floor rising 0.1 m per metre east, on a 10 m lattice
const floor = (x) => 100 + 0.1 * x;
function drape(slopes = true) {
  return loadModule(source, {
    imports: {
      'three/webgpu': THREE,
      './ground.js': { SLOPES: slopes, LATTICE: { x0: 0, z0: 0, cell: 10 }, clipToLattice, townHeight: floor }
    }
  }).drapeGeometry;
}

// A 20 m square at y = 0.2 facing up (two triangles wound counter-clockwise from above) and one triangle under it
function slab() {
  const geo = new BufferGeometry();
  const tri = [[0, 0, 0, 20, 20, 0], [20, 0, 0, 20, 20, 20], [0, 0, 20, 0, 0, 20]];
  const position = [], normal = [];
  tri.forEach((t, k) => {
    for (let v = 0; v < 3; v++) {
      position.push(t[v * 2], 0.2, t[v * 2 + 1]);
      normal.push(0, k < 2 ? 1 : -1, 0);
    }
  });
  geo.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  return geo;
}

test('a draped layer is cut on the lattice, raised by the floor under each vertex, its tops tilted with it', () => {
  const geo = drape()(slab(), { undersides: false });
  const p = geo.attributes.position.array, n = geo.attributes.normal.array;
  assert.ok(p.length / 9 >= 8, 'the square is cut along the lattice (the 8 of its 2 x 2 cells)');
  let area = 0;
  for (let t = 0; t < p.length; t += 9) {
    area += Math.abs((p[t + 3] - p[t]) * (p[t + 8] - p[t + 2]) - (p[t + 6] - p[t]) * (p[t + 5] - p[t + 2])) / 2;
    for (let v = 0; v < 9; v += 3) {
      assert.ok(Math.abs(p[t + v + 1] - (0.2 + floor(p[t + v]))) < 1e-4, 'on the floor');
      // square off the slope: (-0.1, 1, 0) normalised, never the underside's (0, -1, 0)
      assert.ok(Math.abs(n[t + v] + 0.1 / Math.hypot(1, 0.1)) < 1e-5 && Math.abs(n[t + v + 1] - 1 / Math.hypot(1, 0.1)) < 1e-5);
    }
  }
  assert.ok(Math.abs(area - 400) < 1e-3, `${area} m² of top, no underside`);
  // undersides kept when asked
  const all = drape()(slab());
  const below = [...all.attributes.normal.array].filter((v, i) => i % 3 === 1 && v < -0.5).length;
  assert.ok(below >= 3);
});

test('in the flat city (?slopes=0) a layer is left as built', () => {
  const geo = slab();
  assert.equal(drape(false)(geo), geo);
});
