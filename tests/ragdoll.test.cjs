const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { Ragdoll, RAGDOLL_POINTS: P, createMover, vehicleShape, moverLocal } = loadModule(readFileSync(join(__dirname, '../js/ragdoll.js'), 'utf8'));

// A person standing at the origin facing +z (the bind pose's joints, see pedestrians.js ragdollBindPoints)
function standing(x = 0, z = 0, y = 0) {
  const pts = new Float64Array(17 * 3);
  const set = (i, px, py, pz) => { pts[i * 3] = px + x; pts[i * 3 + 1] = py + y; pts[i * 3 + 2] = pz + z; };
  const ab = 0.14;
  for (const [side, s] of [['_L', 1], ['_R', -1]]) {
    set(P['HIP' + side], s * 0.09, 0.92, 0);
    set(P['KNEE' + side], s * 0.09, 0.5, 0);
    set(P['ANKLE' + side], s * 0.09, 0.08, 0);
    set(P['TOE' + side], s * 0.09, 0.02, 0.135);
    set(P['SHOULDER' + side], s * 0.185, 1.43, -0.015);
    set(P['ELBOW' + side], s * (0.185 + Math.sin(ab) * 0.3), 1.43 - Math.cos(ab) * 0.3, -0.015);
    set(P['WRIST' + side], s * (0.185 + Math.sin(ab) * 0.555), 1.43 - Math.cos(ab) * 0.555, -0.015);
  }
  set(P.SPINE, 0, 1.12, -0.01);
  set(P.NECK, 0, 1.52, -0.012);
  set(P.HEAD, 0, 1.63, 0);
  return pts;
}

// A box of a car body: 1.8 m wide, 4.4 m long, from 0.3 m up to 1.2 m, with wheels at its corners
function boxGeometry(hx = 0.9, hz = 2.2, bottom = 0.3, top = 1.2) {
  const v = [];
  for (const x of [-hx, hx]) for (const y of [bottom, top]) for (const z of [-hz, hz]) v.push(x, y, z);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const idx = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return {
    attributes: { position: { count: v.length / 3, getX: (i) => v[i * 3], getY: (i) => v[i * 3 + 1], getZ: (i) => v[i * 3 + 2] } },
    index: { count: idx.length, getX: (i) => idx[i] }
  };
}
const carShape = () => vehicleShape(boxGeometry(), { wheels: [[0.8, 1.4, 0.33, 0.12], [0.8, -1.4, 0.33, 0.12]] });

// Flat road with a 0.22 m curb for x < -5
const world = { ground: (x) => (x < -5 ? 0.22 : 0), colliders: null, contact: () => false };

const segment = (r, a, b) => Math.hypot(r.x[a * 3] - r.x[b * 3], r.x[a * 3 + 1] - r.x[b * 3 + 1], r.x[a * 3 + 2] - r.x[b * 3 + 2]);
function lowest(r) {
  let y = Infinity;
  for (let i = 0; i < 17; i++) y = Math.min(y, r.x[i * 3 + 1] - r.r[i]);
  return y;
}

test('vehicleShape reads a body\'s outline, top and bottom from its mesh', () => {
  const shape = carShape();
  assert.ok(Math.abs(shape.zFront - 2.2) < 1e-6 && Math.abs(shape.zRear + 2.2) < 1e-6 && Math.abs(shape.xHalf - 0.9) < 1e-6);
  assert.ok(Math.abs(shape.topAt(0, 0) - 1.2) < 0.01, `top ${shape.topAt(0, 0)}`);
  assert.ok(Math.abs(shape.bottomAt(0) - 0.3) < 0.01, `bottom ${shape.bottomAt(0)}`);
  assert.ok(shape.inside(0, 0.8, 0, 0.05), 'inside the body');
  assert.ok(!shape.inside(0, 1.4, 0, 0.05), 'above the roof');
  assert.ok(!shape.inside(0, 0.1, 0, 0.05), 'under the floor (lying on the road)');
  assert.ok(!shape.inside(1.2, 0.8, 0, 0.05) && !shape.inside(0, 0.8, 2.5, 0.05), 'beside and in front');
  assert.ok(shape.inside(0, 0.8, 2.25, 0.1), 'touching the front within its radius');
  assert.ok(shape.underWheel(0.8, 1.4, 0.05) && shape.underWheel(-0.8, -1.4, 0.05) && !shape.underWheel(0, 0, 0.05));
});

test('a limp body falls, keeps its shape and comes to rest on the ground', () => {
  const r = new Ragdoll();
  r.start(standing(), standing(), 1, 0, 0, 0);
  let t = 0;
  while (!r.asleep && t < 8) { r.step(1 / 60, world, []); t += 1 / 60; }
  assert.ok(r.asleep, `came to rest (${t.toFixed(1)} s)`);
  assert.ok(lowest(r) > -0.01, `nothing sank into the road (${lowest(r).toFixed(3)} m)`);
  assert.ok(r.pelvisY < 0.35, `lying down (pelvis ${r.pelvisY.toFixed(2)} m up)`);
  assert.ok(Math.abs(segment(r, P.KNEE_L, P.ANKLE_L) - 0.42) < 0.01 && Math.abs(segment(r, P.SHOULDER_L, P.ELBOW_L) - 0.3) < 0.01, 'limbs keep their length');
  assert.ok(Math.abs(segment(r, P.HIP_L, P.HIP_R) - 0.18) < 0.01 && Math.abs(segment(r, P.SPINE, P.NECK) - 0.4) < 0.01, 'the pelvis and chest stay rigid');
});

// The angle in degrees between segments a -> b and c -> d
function between(r, a, b, c, d) {
  const u = [0, 1, 2].map((k) => r.x[b * 3 + k] - r.x[a * 3 + k]);
  const w = [0, 1, 2].map((k) => r.x[d * 3 + k] - r.x[c * 3 + k]);
  const dot = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  return Math.acos(Math.max(-1, Math.min(1, dot / Math.hypot(...u) / Math.hypot(...w)))) * 180 / Math.PI;
}
const space = { ground: () => -100, colliders: null, contact: () => false };

test('without gravity a limp body relaxes into the neutral body posture', () => {
  const r = new Ragdoll();
  r.start(standing(0, 0, 3), standing(), 1, 0, 0, 0);
  r.gravity = 0;
  for (let t = 0; t < 4; t += 1 / 60) r.step(1 / 60, space, []);
  const knee = between(r, P.HIP_L, P.KNEE_L, P.KNEE_L, P.ANKLE_L);
  const elbow = between(r, P.SHOULDER_R, P.ELBOW_R, P.ELBOW_R, P.WRIST_R);
  const hip = between(r, P.NECK, P.SPINE, P.HIP_R, P.KNEE_R);
  const arm = between(r, P.NECK, P.SPINE, P.SHOULDER_L, P.ELBOW_L);
  assert.ok(knee > 35 && knee < 60, `knees bent (${knee.toFixed(0)} degrees)`);
  assert.ok(hip > 40 && hip < 75, `hips bent (${hip.toFixed(0)} degrees)`);
  assert.ok(elbow > 60 && elbow < 100, `elbows bent (${elbow.toFixed(0)} degrees)`);
  assert.ok(arm > 30 && arm < 60, `upper arms forward & out (${arm.toFixed(0)} degrees off the trunk)`);
});

test('a knee swung straight slows down before its limit instead of stopping dead at it', () => {
  const pose = standing(0, 0, 3);
  // the left shin bent back level
  const set = (i, y, z) => { pose[i * 3 + 1] = y + 3; pose[i * 3 + 2] = z; };
  set(P.ANKLE_L, 0.5, -0.42);
  set(P.TOE_L, 0.44, -0.44);
  const r = new Ragdoll();
  r.start(pose, standing(), 1, 0, 0, 0);
  r.gravity = 0;
  // swung forward at ~12 rad/s
  r.v[P.ANKLE_L * 3 + 1] = -5;
  r.v[P.TOE_L * 3 + 1] = -5.5;
  let straightest = 180;
  for (let t = 0; t < 0.5; t += 1 / 120) {
    r.step(1 / 120, space, []);
    straightest = Math.min(straightest, between(r, P.HIP_L, P.KNEE_L, P.KNEE_L, P.ANKLE_L));
  }
  assert.ok(straightest > 6, `stopped short of straight (bent ${straightest.toFixed(0)} degrees at most)`);
});

test('a kick flings the arms back and the legs along without moving the body', () => {
  const r = new Ragdoll();
  r.start(standing(), standing(), 1, 0, 0, 0);
  let seed = 1;
  r.kick(0, 12, 12, () => (seed = (seed * 16807) % 2147483647) / 2147483647);
  let pz = 0, py = 0;
  for (let i = 0; i < 17; i++) { pz += r.v[i * 3 + 2] / r.w[i]; py += r.v[i * 3 + 1] / r.w[i]; }
  assert.ok(Math.abs(pz) < 1e-6 && Math.abs(py) < 1e-6, 'its momentum is unchanged');
  const rel = (i) => r.v[i * 3 + 2] - r.v[P.SPINE * 3 + 2];
  assert.ok(rel(P.WRIST_L) < -1 && rel(P.WRIST_R) < -1, 'the arms are thrown back');
  assert.ok(rel(P.ANKLE_L) > 1 && rel(P.ANKLE_R) > 1, 'the legs are swept along');
});

test('a car driving into a standing person throws them ahead, takes the push back and they come to rest', () => {
  const r = new Ragdoll();
  r.start(standing(0, 0), standing(), 1, 0, 0, 0);
  const car = createMover();
  Object.assign(car, { shape: carShape(), mass: 1600, x: 0, z: -2.6, heading: 0, vz: 12, dt: 1 / 60 });
  let pushed = 0, highest = 0, t = 0;
  for (; t < 10 && !(r.asleep && t > 2); t += 1 / 60) {
    // the car brakes from 0.5 s
    if (t > 0.5) car.vz = Math.max(0, car.vz - 8 / 60);
    car.z += car.vz / 60;
    car.jx = car.jy = car.jz = 0;
    r.step(1 / 60, world, [car]);
    pushed += car.jz;
    highest = Math.max(highest, r.pelvisY);
  }
  assert.ok(r.impact > 10, `hit at the car's speed (${r.impact.toFixed(1)} m/s)`);
  assert.ok(pushed < -400, `the car took the body's momentum back (${pushed.toFixed(0)} kg m/s)`);
  assert.ok(r.pelvisZ > car.z + 2.2, `thrown ahead of where the car stopped (${(r.pelvisZ - car.z).toFixed(1)} m)`);
  assert.ok(highest < 2.5, `no launch into the air (pelvis at most ${highest.toFixed(2)} m)`);
  assert.ok(r.asleep && lowest(r) > -0.01, `came to rest on the road (${t.toFixed(1)} s)`);
});

test('a car driving over someone lying in the road rolls over them, bumping on its wheels', () => {
  const r = new Ragdoll();
  r.start(standing(), standing(), 1, 0, 0, 0);
  for (let t = 0; t < 6 && !r.asleep; t += 1 / 60) r.step(1 / 60, world, []);
  const x0 = r.pelvisX, z0 = r.pelvisZ;
  const car = createMover();
  Object.assign(car, { shape: carShape(), mass: 1600, x: x0 + 0.5, z: z0 - 6, heading: 0, vz: 5, dt: 1 / 60 });
  let bumps = 0, highest = 0;
  for (let t = 0; t < 3; t += 1 / 60) {
    car.z += car.vz / 60;
    car.wheelHits = 0;
    r.step(1 / 60, world, [car]);
    if (car.wheelHits) bumps++;
    highest = Math.max(highest, r.pelvisY);
    if (Math.abs(r.pelvisZ - car.z) < 1.5) assert.ok(r.covered([car]), 'the car is over it');
  }
  assert.ok(bumps > 3, `the wheels went over it (${bumps} frames)`);
  assert.ok(highest < 0.4, `it stayed under the car (pelvis at most ${highest.toFixed(2)} m)`);
  assert.ok(Math.hypot(r.pelvisX - x0, r.pelvisZ - z0) < 1.5, 'dragged a little, not bulldozed');
});

test('a body sliding into a curb stops against it instead of sinking into the sidewalk', () => {
  const r = new Ragdoll();
  // lying on its back, feet towards the curb, sliding at it
  const pts = standing();
  const lying = new Float64Array(pts.length);
  for (let i = 0; i < 17; i++) {
    lying[i * 3] = -3.2 - pts[i * 3 + 1];
    lying[i * 3 + 1] = 0.11 + pts[i * 3 + 2];
    lying[i * 3 + 2] = pts[i * 3];
  }
  r.start(lying, standing(), 1, -4, 0, 0);
  for (let t = 0; t < 4; t += 1 / 60) {
    r.step(1 / 60, world, []);
    for (let i = 0; i < 17; i++) {
      const o = i * 3;
      assert.ok(r.x[o + 1] - r.r[i] > world.ground(r.x[o]) - 0.03, `point ${i} stayed out of the ground`);
    }
  }
  assert.ok(r.pelvisX > -5.2, `stopped at the curb (pelvis at x ${r.pelvisX.toFixed(2)})`);
});

test('moverLocal undoes the vehicle\'s heading and where it was earlier in the frame', () => {
  const car = createMover();
  Object.assign(car, { x: 10, z: 5, heading: Math.PI / 2, vx: 6, vz: 0, dt: 0.5 });
  const now = moverLocal(car, 1, 12, 1, 5, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(now.z - 2) < 1e-9 && Math.abs(now.x) < 1e-9 && now.y === 1, 'ahead of it, facing +x');
  const before = moverLocal(car, 0, 12, 1, 5, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(before.z - 5) < 1e-9, 'further ahead of where it was half a second ago');
});
