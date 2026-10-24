const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../js/sim/traffic.js'), 'utf8');
function productionFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}

for (const [hasView, inView, draw] of [[true, false, false], [true, true, true], [false, false, true]]) {
  test(`pedestrian gait always advances; pose generation follows drawing (${hasView}, ${inView})`, () => {
    let args, drawn = 0;
    const ped = { x: 10, z: 20, ux: 0, uz: 1, dir: 1, rig: { update(...values) { args = values; } } };
    const renderPed = productionFunction('renderPed', {
      hasView, visible: () => inView, pedGround: () => 0, focusX: 0, focusZ: 0,
      pedCrowd: { add(rig) { assert.equal(rig, ped.rig); drawn++; } }
    });
    renderPed(ped, 1 / 60);
    assert.equal(args[0], 1 / 60);
    assert.equal(args[1], ped.x);
    assert.equal(args[2], ped.z);
    assert.equal(args[5], ped);
    assert.equal(args[7], draw);
    assert.equal(drawn, draw ? 1 : 0);
  });
}

function sparkHarness(updates = 3) {
  const sparks = Array.from({ length: 120 }, () => ({ life: 0 }));
  const writes = [];
  const zero = { zero: true };
  const dummy = { matrix: {} };
  for (const key of ['position', 'rotation', 'scale']) dummy[key] = { set(...values) { dummy.matrix[key] = values; } };
  dummy.updateMatrix = () => {};
  let uploads = 0, range = 0;
  const attr = {
    itemSize: 16,
    clearUpdateRanges() { range = 0; },
    addUpdateRange(offset, count) { assert.equal(offset, 0); range = count; },
    set needsUpdate(value) { if (value) uploads++; }
  };
  const sparkInst = {
    instanceMatrix: attr,
    setMatrixAt(index, matrix) { writes.push({ index, matrix: JSON.parse(JSON.stringify(matrix)) }); }
  };
  const context = { MAX_SPARKS: 120, sparks, sparkInst, dummy, zero, updates };
  const flag = productionFunction('flagRange', {});
  context.flagRange = flag;
  return {
    sparks, writes, sparkInst,
    update: productionFunction('updateSparks', context),
    uploads: () => uploads,
    range: () => range
  };
}

test('idle collision sparks write and upload nothing after warm-up', () => {
  const h = sparkHarness();
  for (let frame = 0; frame < 60; frame++) h.update(1 / 60);
  assert.equal(h.writes.length, 0);
  assert.equal(h.uploads(), 0);
  assert.equal(h.sparkInst.count, 0);
  assert.equal(h.sparkInst.visible, false);
});

for (const frame of [1, 2]) {
  test(`spark shader warm-up keeps one degenerate visible instance on frame ${frame}`, () => {
    const h = sparkHarness(frame);
    h.update(1 / 60);
    assert.deepEqual(h.writes, [{ index: 0, matrix: { zero: true } }]);
    assert.equal(h.sparkInst.count, 1);
    assert.equal(h.sparkInst.visible, true);
    assert.equal(h.range(), 16);
  });
}

test('live sparks preserve motion, bounce and fade while packing only live matrices', () => {
  const h = sparkHarness();
  h.sparks[13] = { x: 2, y: 0.04, z: 3, vx: 1, vy: -2, vz: 4, life: 0.1, maxLife: 0.4 };
  h.sparks[80] = { x: 0, y: 2, z: 0, vx: 0, vy: 3, vz: 0, life: 0.2, maxLife: 0.4 };
  h.update(0.05);
  const bounced = h.sparks[13];
  assert.equal(bounced.x, 2.05);
  assert.equal(bounced.y, 0.03);
  assert.equal(bounced.z, 3.2);
  assert.equal(bounced.vx, 0.78);
  assert.equal(bounced.vz, 3.12);
  assert.ok(Math.abs(bounced.vy - 1.395) < 1e-12);
  assert.ok(Math.abs(h.sparks[80].y - 2.095) < 1e-12);
  assert.deepEqual(h.writes.map((write) => write.index), [0, 1]);
  assert.deepEqual(h.writes[0].matrix.position, [2.05, 0.03, 3.2]);
  assert.equal(h.writes[0].matrix.scale[0], 0.125);
  assert.equal(h.writes[0].matrix.scale[1], 0.125);
  assert.equal(h.sparkInst.count, 2);
  assert.equal(h.range(), 32);
  assert.equal(h.uploads(), 1);
  // An expiring particle retains the original zero-life fade on its last simulated frame, then disappears.
  h.update(0.2);
  assert.equal(h.sparkInst.count, 2);
  assert.equal(h.writes.at(-1).matrix.scale[0], 0);
  const uploads = h.uploads();
  h.update(1 / 60);
  assert.equal(h.sparkInst.count, 0);
  assert.equal(h.sparkInst.visible, false);
  assert.equal(h.uploads(), uploads);
});
