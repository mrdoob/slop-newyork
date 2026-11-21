const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Evaluate the production TSL expressions numerically, without a browser or Three dependency.
const f = Math.fround;
const values = (v) => v instanceof Node ? v.values : Array.isArray(v) ? v : [v];
function binary(a, b, op) {
  a = values(a); b = values(b);
  return new Node(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => op(a[i % a.length], b[i % b.length])));
}
class Node {
  constructor(v) { this.values = values(v).map(f); }
  get x() { return new Node(this.values[0]); }
  get y() { return new Node(this.values[1]); }
  get z() { return new Node(this.values[2]); }
  add(v) { return binary(this, v, (a, b) => a + b); }
  sub(v) { return binary(this, v, (a, b) => a - b); }
  mul(v) { return binary(this, v, (a, b) => a * b); }
  negate() { return this.mul(-1); }
  normalize() { const length = Math.hypot(...this.values); return new Node(this.values.map(v => v / length)); }
  toVar() { return this; }
  setInterpolation(sampling, mode) { this.interpolation = { sampling, mode }; return this; }
}
const unary = (op) => (v) => new Node(values(v).map(op));
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // Row-major normal matrices in this harness.
function matrix(elements) {
  return { mul(v) {
    const a = values(v);
    return new Node([0, 3, 6].map(i => f(f(f(elements[i] * a[0]) + f(elements[i + 1] * a[1])) + f(elements[i + 2] * a[2]))));
  } };
}
const source = readFileSync(join(__dirname, '../js/tsl-materials.js'), 'utf8');
const frame = source.match(/const facadeNormalVertex =[\s\S]*?const facadeAlongZ =[\s\S]*?\.setInterpolation\([\s\S]*?\);/);
assert.ok(frame, 'the shared camera-independent facade frame must exist');
const projectionStart = source.indexOf('function facadeCell(');
const projection = source.slice(source.indexOf('{', projectionStart) + 1, source.indexOf('let bayWidth', projectionStart));
const interiorStart = source.indexOf('const rayWorld =', source.indexOf('const evaluateApartmentInterior'));
const interior = source.slice(interiorStart, source.indexOf('// Slab intersection', interiorStart));
const buildFrame = vm.runInNewContext(`(function (normalLocal, modelNormalMatrix, normalWorldGeometry, cameraViewMatrix) {
  ${frame[0]}
  return {
    normal: facadeWorldNormal, axis: facadeAlongZ,
    project(boxLocal, normalGeometry, positionWorld) { ${projection} return { alongZ, uCoord, isRoof }; },
    interior(positionWorld, cameraPosition) { ${interior} return { dirX, dirY, dirZ }; }
  };
})`, {
  THREE: { InterpolationSamplingType: { FLAT: 'flat' }, InterpolationSamplingMode: { EITHER: 'either' } },
  normalize: v => v.normalize(),
  varying: v => new Node(v),
  abs: unary(Math.abs), sign: unary(Math.sign),
  step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1),
  max: (a, b) => binary(a, b, Math.max),
  mix: (a, b, t) => binary(binary(a, t, (v, t) => v * (1 - t)), binary(b, t, (v, t) => v * t), (a, b) => a + b),
  vec3: (...v) => new Node(v.flatMap(values)),
  dot: (a, b) => new Node(values(a).reduce((sum, v, i) => sum + v * values(b)[i], 0))
});
const scalar = v => v.values[0];
const position = new Node([-204.25, 220, 5267.625]);
const eye = new Node([-130, 250, 5180]);

// Float32 rotation into and out of view space reproduces the old normalWorldGeometry round-trip.
function cameraMatrix(yaw) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(-0.38), sx = Math.sin(-0.38);
  const cz = Math.cos(0.03), sz = Math.sin(0.03);
  return [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx].map(f);
}
function roundTrip(normal, camera) {
  const transpose = [camera[0], camera[3], camera[6], camera[1], camera[4], camera[7], camera[2], camera[5], camera[8]];
  return matrix(transpose).mul(matrix(camera).mul(normal).normalize()).normalize();
}

for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  test(`45-degree facade (${sx}, ${sz}) keeps its windows and room frame across camera rotations`, () => {
    // Exact normal of One WTC's fitted diagonal glass shaft, including its slight outward slope.
    const normal = new Node([sx * 0.7068521976470947, -0.02683299221098423, sz * 0.7068521976470947]);
    const reference = buildFrame(normal, matrix(identity), normal, matrix(identity));
    const room = reference.interior(position, eye);
    const oldAxes = new Set();
    for (let i = 0; i < 720; i++) {
      const camera = cameraMatrix(i * Math.PI / 360);
      const unstable = roundTrip(normal, camera);
      oldAxes.add(Math.abs(unstable.values[0]) >= Math.abs(unstable.values[2]) ? 1 : 0);
      const actual = buildFrame(normal, matrix(identity), unstable, matrix(camera));
      assert.equal(scalar(actual.axis), 1, 'near-equal diagonal components have one deterministic tie-break');
      assert.deepEqual(actual.normal.values, reference.normal.values);
      const projected = actual.project(false, normal, position);
      assert.equal(scalar(projected.uCoord), position.values[2], 'the entire window grid must not switch to world X');
      assert.equal(scalar(projected.isRoof), 0);
      const directions = actual.interior(position, eye);
      for (const key of ['dirX', 'dirY', 'dirZ']) assert.deepEqual(directions[key].values, room[key].values);
    }
    assert.equal(oldAxes.size, 2, 'the fixture must expose the original camera-dependent axis flip');
    assert.equal(reference.axis.interpolation.sampling, 'flat', 'projection choice is constant across each triangle');
    assert.equal(reference.axis.interpolation.mode, 'either');
  });
}

test('surveyed storefronts remain glazed above the sidewalk while cut-off storeys stay solid', () => {
  const masks = source.slice(source.indexOf('let partial =', projectionStart), source.indexOf('const solid =', projectionStart));
  const evaluate = vm.runInNewContext(`(function (vCoord, fromTop, wallH, floorHeight, gridV, footprintLocal) {
    const boxLocal = true, wall = float(1);
    ${masks}
    return partial;
  })`, {
    float: v => new Node(v), floor: unary(Math.floor),
    step: (edge, v) => binary(edge, v, (a, b) => b < a ? 0 : 1)
  });
  const partial = (y, bottom, height, footprintLocal) => scalar(evaluate(
    new Node(y), new Node(bottom + height - y), new Node(height), new Node(3.5), new Node(y / 3.5), footprintLocal));

  assert.equal(partial(2, 0.22, 10, true), 0, 'the sidewalk offset must not blank the ground floor');
  assert.equal(partial(5, 0.22, 10, true), 0, 'complete upper storeys retain their windows');
  assert.equal(partial(8, 0.22, 10, true), 1, 'the roof still masks an incomplete top storey');
  assert.equal(partial(6, 5.4, 10, false), 1, 'a raised authored box masks its incomplete bottom storey');
  assert.equal(partial(8, 5.4, 10, false), 0, 'complete storeys in raised boxes remain glazed');
});
