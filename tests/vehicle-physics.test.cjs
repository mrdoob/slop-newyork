const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadModule } = require('./helpers/module.cjs');

const physics = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'));
const { vehicleContact, resolveVehicleContact, sweptVehicleContact } = physics;

function body(options = {}) {
  const result = { x: 0, z: 0, sin: 0, cos: 1, halfW: 0.86, halfL: 2.18,
    mass: 1600, vx: 0, vz: 0, angularVel: 0, ...options };
  result.prevX ??= result.x;
  result.prevZ ??= result.z;
  return result;
}

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
}

function inertia(b) {
  return b.mass * (b.halfW ** 2 + b.halfL ** 2) / 3;
}

function energy(b) {
  return (b.mass * (b.vx ** 2 + b.vz ** 2) + inertia(b) * b.angularVel ** 2) / 2;
}

function momentum(a, b) {
  return [a.mass * a.vx + b.mass * b.vx, a.mass * a.vz + b.mass * b.vz,
    a.mass * (a.z * a.vx - a.x * a.vz) + b.mass * (b.z * b.vx - b.x * b.vz)
    + inertia(a) * a.angularVel + inertia(b) * b.angularVel];
}

function collide(a, b) {
  const hit = {};
  assert.ok(vehicleContact(a, b, hit));
  resolveVehicleContact(a, b, hit);
  return hit;
}

test('centered rear-end impacts exchange momentum without artificial spin', () => {
  const a = body({ vz: 10 }), b = body({ z: 4.2 });
  const hit = collide(a, b);
  close(hit.x, 0);
  close(hit.nz, -1);
  close(a.vz, 4.6);
  close(b.vz, 5.4);
  close(a.angularVel, 0);
  close(b.angularVel, 0);
  close(a.mass * a.vz + b.mass * b.vz, 16000);
});

test('offset bumper contacts lie in the overlapping faces and spin both cars', () => {
  const a = body({ x: 0.6, vz: 12 }), b = body({ z: 4.2 });
  const before = momentum(a, b), initialEnergy = energy(a) + energy(b);
  const hit = collide(a, b);
  close(hit.x, 0.3);
  assert.ok(Math.abs(a.angularVel) > 0.1);
  assert.ok(Math.abs(b.angularVel) > 0.1);
  momentum(a, b).forEach((value, i) => close(value, before[i]));
  assert.ok(energy(a) + energy(b) < initialEnergy);
});

test('bus contacts conserve momentum and move the heavy vehicle much less', () => {
  const car = body({ vz: 15 }), bus = body({ z: 7.8, mass: 12000, halfW: 1.3, halfL: 5.72 });
  const before = momentum(car, bus);
  collide(car, bus);
  assert.ok(bus.vz > 0 && bus.vz < 2);
  assert.ok(car.vz > 0 && car.vz < 2);
  momentum(car, bus).forEach((value, i) => close(value, before[i]));
});

test('separating or resting overlaps produce no impulse or spin', () => {
  for (const velocity of [0, -10]) {
    const a = body({ vz: velocity }), b = body({ z: 4.2 });
    const hit = collide(a, b);
    close(hit.impulse, 0);
    close(a.vz, velocity);
    close(b.vz, 0);
    close(a.angularVel, 0);
  }
});

test('angled and spinning impacts conserve momentum without gaining energy', () => {
  for (let i = 0; i < 80; i++) {
    const heading = i * 0.079;
    const a = body({ x: 0.3, z: -1, vx: 8 * Math.sin(i), vz: 9,
      sin: Math.sin(heading), cos: Math.cos(heading), angularVel: Math.cos(i) });
    const b = body({ z: 1, vx: -5 * Math.cos(i), vz: -3, mass: 2100, angularVel: Math.sin(i) });
    const hit = {};
    if (!vehicleContact(a, b, hit)) continue;
    const before = momentum(a, b), initialEnergy = energy(a) + energy(b);
    resolveVehicleContact(a, b, hit);
    momentum(a, b).forEach((value, j) => close(value, before[j], 1e-7));
    assert.ok(energy(a) + energy(b) <= initialEnergy + 1e-7);
    assert.ok(Number.isFinite(hit.x) && Number.isFinite(hit.z));
  }
});

test('sideswipes retain forward motion instead of imposing a fixed speed penalty', () => {
  const a = body({ x: 1.7, vx: -0.5, vz: 12 }), b = body({ vz: 12 });
  collide(a, b);
  close(a.vz, 12);
  close(b.vz, 12);
});

test('all four SAT axes reject a diagonal near miss', () => {
  const angle = Math.PI / 4;
  const a = body({ x: 2.4, z: -2.4, sin: Math.sin(angle), cos: Math.cos(angle) });
  const b = body();
  assert.equal(vehicleContact(a, b, {}), false);
});

test('swept contacts catch a complete side crossing and rewind to first contact', () => {
  const a = body({ x: 4, prevX: -4, vx: 40 }), b = body();
  const hit = {};
  assert.equal(vehicleContact(a, b, hit), false);
  assert.ok(sweptVehicleContact(a, b, hit));
  assert.ok(a.x < -1.7 && a.x > -1.73);
  close(hit.nx, -1);
  resolveVehicleContact(a, b, hit);
  assert.ok(a.vx < 20 && b.vx > 20);
});

test('sweeps handle relative movement and reject departing overlaps and near misses', () => {
  const a = body({ x: 4, prevX: -3, vx: 35 });
  const b = body({ x: -3, prevX: 3, vx: -30 });
  assert.ok(sweptVehicleContact(a, b, {}));
  assert.ok(a.x < b.x);
  assert.equal(sweptVehicleContact(body({ x: 4, prevX: 0 }), body(), {}), false);
  assert.equal(sweptVehicleContact(body({ x: 4, prevX: -4, z: 5 }), body(), {}), false);
});

test('first contact wins when a fast side impact crosses the center but still overlaps', () => {
  const a = body({ x: 0.1, prevX: -1.8, vx: 40 }), b = body();
  const hit = {};
  assert.ok(vehicleContact(a, b, hit));
  close(hit.nx, 1, 1e-8);
  assert.ok(sweptVehicleContact(a, b, hit));
  close(hit.nx, -1, 1e-8);
  assert.ok(resolveVehicleContact(a, b, hit) > 39);
  assert.ok(b.vx > 20);
});

test('swept side scrapes preserve each vehicle’s tangential travel', () => {
  for (const distance of [0.2, 0.3]) {
    const a = body({ x: -1.71, prevX: -1.72, z: distance, prevZ: 0, vx: 0.6, vz: distance * 60 });
    const b = body({ z: 0.2, prevZ: 0, vz: 12 });
    const hit = {};
    assert.ok(sweptVehicleContact(a, b, hit));
    close(hit.az, distance);
    close(hit.bz, 0.2);
    resolveVehicleContact(a, b, hit);
    assert.ok(a.vz > 11.9 && b.vz > 11.9);
  }
});

test('swept touching bumpers preserve mass-weighted common forward travel', () => {
  const a = body({ z: 0.21, prevZ: 0, vz: 12.6, mass: 1700 });
  const b = body({ z: 4.56, prevZ: 4.36, vz: 12, mass: 1600 });
  const hit = {};
  assert.ok(sweptVehicleContact(a, b, hit));
  assert.ok(hit.az > 0.2 && hit.bz > 4.56);
  close(1700 * hit.az + 1600 * hit.bz, 1700 * 0.21 + 1600 * 4.56);
  close(hit.bz - hit.az + hit.depth, 4.36);
  resolveVehicleContact(a, b, hit);
  assert.ok(a.vz >= 12 && b.vz >= 12);
});

test('touching vehicles at equal velocity are never rewound', () => {
  const a = body({ z: 0.2, prevZ: 0, vz: 12 });
  const b = body({ z: 4.56, prevZ: 4.36, vz: 12 });
  assert.equal(sweptVehicleContact(a, b, {}), false);
  close(a.z, 0.2);
  close(b.z, 4.56);
});

const trafficSource = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
function trafficHarness(vehicles) {
  const context = { ...physics, vehicles, contactA: {}, contactB: {}, vehicleHit: {}, impacted: [], collisionStep: 0,
    clamp: (value, lo, hi) => Math.max(lo, Math.min(hi, value)),
    shove(v, dx, dz) { v.x += dx; v.z += dz; },
    reportCollision() {}, spawnCollisionSparks() {}, changeLanes() {},
    accelerate(v) { v.acc = -3; }, steer() {}, enter() {}, leave() {} };
  for (const name of ['readTrafficBody', 'writeTrafficVelocity', 'impactSuspension', 'collideWithPlayer', 'collideTraffic', 'drive']) {
    const source = trafficSource.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`))?.[0];
    assert.ok(source, name);
    context[name] = vm.runInNewContext(`(${source})`, context);
  }
  return context;
}

function trafficCar(z, speed = 0, impactTime = 0) {
  return { x: 0, z, prevX: 0, prevZ: z, yaw: 0, yawOffset: 0, yawRate: 0, yawVel: 0,
    half: 2.25, halfWidth: 0.86, tx: 0, tz: 1, speed, vx: 0, vz: 0, impactTime, pitchVel: 0, rollVel: 0,
    edge: { len: 100 }, s: z, conn: null, axle: 1.38, dl: 0, dlv: 0, nose: 0,
    laneTimer: 10, gap: Infinity, leaderSpeed: 0, wait: 0 };
}

test('player collision impulses persist in both driving speeds and preserve momentum', () => {
  const traffic = trafficCar(4.2);
  const h = trafficHarness([traffic]);
  const car = { type: 'car', position: { x: 0, z: 0 }, heading: 0, speed: 10,
    prevX: 0, prevZ: 0, vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0, heaveVel: 0 };
  h.player = { entity: car, halfW: 0.86, halfL: 2.18 };
  h.collideWithPlayer(traffic);
  assert.ok(car.speed > 4 && car.speed < 5);
  assert.ok(traffic.speed > 5 && traffic.speed < 6);
  close(1700 * car.speed + 1600 * traffic.speed, 17000);
  close(car.vz, 0);
  close(traffic.vz, 0);
  close(car.angularVel, 0);
});

test('a route-constrained vehicle leaves the player fully outside its body', () => {
  const traffic = trafficCar(4.2);
  const h = trafficHarness([traffic]);
  h.shove = () => {};
  const car = { type: 'car', position: { x: 0, z: 0 }, heading: 0, speed: 0,
    prevX: 0, prevZ: 0, vx: 0, vz: 0, angularVel: 0 };
  h.player = { entity: car, halfW: 0.86, halfL: 2.18 };
  h.collideWithPlayer(traffic);
  close(traffic.z - car.position.z, 4.36);
});

test('a traffic impact propagates through a queue once per pair in the same update', () => {
  const cars = [trafficCar(0, 12, 0.8), trafficCar(4.2), trafficCar(8.4)];
  const h = trafficHarness(cars);
  let contacts = 0;
  h.reportCollision = () => contacts++;
  h.collideTraffic();
  assert.equal(contacts, 2);
  assert.ok(cars[2].speed > 3);
  close(cars.reduce((sum, v) => sum + v.speed + v.vz, 0), 12);
  assert.ok(cars.every((v) => v.angularVel === undefined && v.yawVel === 0));
});

test('knocked traffic closes a gap before transferring longitudinal momentum', () => {
  for (const gap of [0.5, 2]) {
    for (const hz of [30, 60, 120]) {
      const cars = [trafficCar(0, 9, 0.8), trafficCar(4.36 + gap)];
      const h = trafficHarness(cars);
      cars[0].gap = gap;
      for (let frame = 0; frame < hz * 0.5 && cars[1].speed === 0; frame++) {
        const car = cars[0];
        car.prevZ = car.z;
        h.drive(car, 1 / hz);
        car.z = car.s;
        h.collideTraffic();
      }
      assert.ok(cars[1].speed > 3, `${gap} m gap at ${hz} Hz transferred momentum`);
    }
  }
});
