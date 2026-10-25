const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

class Matrix4 {}
const { BONES, boxHit, riderKnocked, startTumble, stepTumble, slide, tumblePose, startTopple, stepTopple, hideInstance } = loadModule(
  readFileSync(join(__dirname, '../js/sim/mayhem.js'), 'utf8'),
  { imports: { 'three/webgpu': { Matrix4 } }, filename: 'mayhem.js' }
);

const run = (f, ground, seconds, dt = 1 / 60) => {
  let rest = 0;
  for (let t = 0; t < seconds; t += dt) rest = stepTumble(f, dt, ground);
  return rest;
};

test('the player box hits bodies along its length and width only', () => {
  // facing +x (heading π/2), 4.5 m long, 1.8 m wide
  assert.ok(boxHit(0, 0, Math.PI / 2, 0.9, 2.25, 2.3, 0, 0.3));
  assert.ok(boxHit(0, 0, Math.PI / 2, 0.9, 2.25, -2.3, 0.5, 0.3));
  assert.equal(boxHit(0, 0, Math.PI / 2, 0.9, 2.25, 2.7, 0, 0.3), null);
  assert.equal(boxHit(0, 0, Math.PI / 2, 0.9, 2.25, 0, 1.3, 0.3), null);
  const hit = boxHit(0, 0, 0, 0.9, 2.25, 0, 2, 0.3);
  assert.ok(Math.abs(hit.nz - 1) < 1e-9, 'the contact points away from the player');
});

test('a car or bicycle knocks a rider off when driven into them, whoever was moving', () => {
  // the rider is ahead of the player along +z: (nx, nz) = (0, 1)
  assert.ok(riderKnocked('car', 0, 9, 0, 1, 2.2), 'the player drives into a cyclist');
  assert.ok(riderKnocked('car', 0, 5, 0, 1, 2.2), 'a cyclist rides into the standing car (the same, seen from the car)');
  assert.ok(riderKnocked('cyclist', 0, 3, 0, 1, 2.2));
  assert.equal(riderKnocked('car', 0, 1.5, 0, 1, 2.2), false, 'a slow touch only eases them apart');
  assert.equal(riderKnocked('car', 0, -6, 0, 1, 2.2), false, 'nor do two pulling apart');
  // brushing past alongside: the rider is off to the side (1, 0), the speed between them along the road
  assert.equal(riderKnocked('car', 0, 3, 1, 0, 2.2), false, 'a car slipping past a cyclist');
  assert.ok(riderKnocked('car', 0.4, 9, 1, 0, 2.2), 'a car swiping past far faster than them');
  assert.equal(riderKnocked('person', 0, 9, 0, 1, 2.2), false, 'nobody on foot knocks a rider off');
  assert.equal(riderKnocked('helicopter', 0, 9, 0, 1, 2.2), false);
});

test('a knocked-over body is thrown the way the player went and ends lying still on the ground', () => {
  const f = startTumble(10, 0.22, 20, 0, 12, 0, 1, () => 0.5);
  assert.ok(f.vz > 10 && Math.abs(f.vx) < 1e-9 && f.vy > 0);
  const rest = run(f, 0.22, 12);
  assert.ok(rest > 5, 'it lies still');
  assert.ok(f.pz > 25, 'thrown forwards');
  assert.ok(Math.abs(Math.cos(f.angle)) < 0.02, 'flat on its back or front');
  assert.ok(Math.abs(f.py - (0.22 + 0.16)) < 0.02, 'resting on the ground');
  assert.ok([f.px, f.py, f.pz, f.angle, f.spin].every(Number.isFinite));
});

test('a slow knock still lands without sinking into the ground', () => {
  const f = startTumble(0, 0, 0, 2.3, 0, 1, 0, () => 0);
  let lowest = Infinity;
  for (let t = 0; t < 10; t += 1 / 60) {
    stepTumble(f, 1 / 60, 0);
    lowest = Math.min(lowest, f.py - 0.16 - 0.79 * Math.abs(Math.cos(f.angle)));
  }
  assert.ok(lowest > -1e-6);
});

test('the tumble pose turns the solved bones as one rigid body about the pivot', () => {
  const base = new Float32Array(BONES * 8);
  for (let b = 0; b < BONES; b++) {
    base.set([0, 0, 0, 1, 0, 0.1 * b, 0, 1], b * 8); // identity bones stacked up the body
  }
  const f = { x0: 0, y0: 0.95, z0: 0, px: 0, py: 0.95, pz: 0, ax: 1, az: 0, angle: 0, spin: 0 };
  const dst = new Float32Array(BONES * 8);
  tumblePose(dst, base, f);
  for (let i = 0; i < dst.length; i++) assert.ok(Math.abs(dst[i] - base[i]) < 1e-6, 'upright and in place: unchanged');

  // a quarter turn about +x: what stood above the pivot now lies towards +z (thrown along +z), moved to the new pivot
  Object.assign(f, { angle: Math.PI / 2, px: 3, py: 0.2, pz: 5 });
  tumblePose(dst, base, f);
  const top = (BONES - 1) * 8;
  const above = base[top + 5] - 0.95;
  assert.ok(Math.abs(dst[top + 4] - 3) < 1e-5);
  assert.ok(Math.abs(dst[top + 5] - 0.2) < 1e-5);
  assert.ok(Math.abs(dst[top + 6] - (5 + above)) < 1e-5);
  const q = dst.subarray(top, top + 4);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-5, 'unit quaternions');
  assert.equal(dst[top + 7], 1, 'scale kept');
});

test('a knocked pole falls over and comes to rest lying down', () => {
  const f = startTopple(10, () => 0.5);
  let rest = 0;
  for (let t = 0; t < 6; t += 1 / 60) rest = stepTopple(f, 1 / 60, Math.PI / 2 - 0.04, 8.4);
  assert.ok(rest > 1);
  assert.ok(Math.abs(f.angle - (Math.PI / 2 - 0.04)) < 1e-9);
});

test('hiding a prop clears its instance where culling moved it', () => {
  const instance = () => ({ instanceMatrix: { array: new Float32Array(48).fill(1), ranges: [], addUpdateRange(o, n) { this.ranges.push([o, n]); }, needsUpdate: false } });
  const chunkA = instance();
  const chunkB = instance();
  const where = new Int32Array([0, 2, 1, 0]); // instance 0 -> chunk A slot 2, instance 1 -> chunk B slot 0
  const source = { userData: { chunked: { chunks: [chunkA, chunkB], where } } };
  hideInstance(source, 1);
  assert.deepEqual(Array.from(chunkB.instanceMatrix.array.subarray(0, 16)), new Array(16).fill(0));
  assert.equal(chunkB.instanceMatrix.array[16], 1, 'the neighbouring instance stays');
  assert.equal(chunkB.instanceMatrix.needsUpdate, true);
  assert.deepEqual(chunkB.instanceMatrix.ranges, [[0, 16]]);
  assert.equal(chunkA.instanceMatrix.needsUpdate, false);
  const plain = { userData: {}, ...instance() };
  hideInstance(plain, 2);
  assert.deepEqual(Array.from(plain.instanceMatrix.array.subarray(32, 48)), new Array(16).fill(0));
});

test('a body thrown at a wall bounces off it instead of flying into the building', () => {
  const wall = (x) => x > 5; // a facade along x = 5
  const f = startTumble(0, 0, 0, 20, 0, 1, 0, () => 0.5);
  let furthest = 0;
  for (let t = 0; t < 10; t += 1 / 60) {
    stepTumble(f, 1 / 60, 0, wall);
    furthest = Math.max(furthest, f.px);
  }
  assert.ok(furthest <= 5, 'never inside');
  assert.ok(f.px < 5 && f.px > -10, 'lies in front of the wall, bounced back a few metres');
  const o = { px: 4.9, pz: 0, vx: 3, vz: 0 };
  assert.equal(slide(o, 0.3, 0, wall), false);
  assert.equal(o.px, 4.9);
  assert.ok(o.vx < 0, 'bounced back');
  assert.equal(slide(o, -0.3, 0, wall), true);
  assert.ok(Math.abs(o.px - 4.6) < 1e-9);
});

test('a body thrown fast tumbles on along the ground, head over heels, before it settles', () => {
  // knocked along +z at 30 m/s (108 km/h)
  const f = startTumble(0, 0, 0, 0, 30, 0, 1, () => 0.5);
  let turnsOnGround = 0, landedAt = null, lastAngle = 0;
  for (let t = 0; t < 15; t += 1 / 60) {
    stepTumble(f, 1 / 60, 0);
    if (f.landed && landedAt === null) { landedAt = f.pz; lastAngle = f.angle; }
    if (landedAt !== null) {
      turnsOnGround += Math.abs(f.angle - lastAngle) / (2 * Math.PI);
      lastAngle = f.angle;
    }
  }
  assert.ok(turnsOnGround > 4, `${turnsOnGround.toFixed(1)} turns rolling`);
  assert.ok(f.pz - landedAt > 15, `rolled ${(f.pz - landedAt).toFixed(1)} m after landing`);
  assert.ok(f.rest > 1 && Math.abs(Math.cos(f.angle)) < 0.02, 'then lies still on its back or front');
  assert.ok(Math.abs(f.py - 0.16) < 0.02);
});
