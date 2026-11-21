const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = ['traffic.js', 'pedestrian-system.js']
  .map((file) => readFileSync(join(__dirname, '../js', file), 'utf8')).join('\n');
// Exercise the production lane query and player snapshot without creating the WebGPU scene.
const laneQuery = source.match(/  function playerInLane\(lane, pl\) \{[\s\S]*?\n  \}/)?.[0];
const boxRun = source.match(/const HWY_BOX_RUN = \d+;/)?.[0];
const playerSnapshot = source.match(/    const pl = entity[\s\S]*?\n    \} : null;/)?.[0];
assert.ok(laneQuery, 'traffic lane query is present');
assert.ok(boxRun, 'traffic lane bounds run length is present');
assert.ok(playerSnapshot, 'traffic player snapshot is present');
const { playerInLane, snapshot, HWY_BOX_RUN } = vm.runInNewContext(`
  ${boxRun}
  ${laneQuery}
  function snapshot(entity, mode) {
    ${playerSnapshot}
    return pl;
  }
  ({ playerInLane, snapshot, HWY_BOX_RUN });
`);

function lane(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  // Bounds per run of HWY_BOX_RUN segments, as createHighwayTraffic lays them out
  const box = [];
  for (let s = 0; s + 1 < points.length; s += HWY_BOX_RUN) {
    const run = points.slice(s, Math.min(points.length, s + HWY_BOX_RUN + 1));
    box.push(Math.min(...run.map((p) => p.x)), Math.max(...run.map((p) => p.x)),
      Math.min(...run.map((p) => p.z)), Math.max(...run.map((p) => p.z)));
  }
  return { pts: points, cum, box };
}

function player(x, y, z, mode = 'car') {
  return snapshot({ position: { x, y, z }, heading: Math.PI / 2, speed: 10 }, mode);
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`);
}

test('viaduct traffic ignores players below it and recognizes players at deck height', () => {
  const road = lane([{ x: 0, y: 7.6, z: 0 }, { x: 100, y: 7.6, z: 0 }]);
  assert.equal(playerInLane(road, player(50, 0, 0)), null);
  const result = playerInLane(road, player(50, 7.6, 0));
  close(result.u, 50);
  close(result.v, 10);
});

test('sloped lanes use horizontal projection and compare interpolated road height', () => {
  const road = lane([{ x: 0, y: 0, z: 0 }, { x: 100, y: 7.6, z: 0 }]);
  for (const t of [0, 0.5, 1]) {
    const result = playerInLane(road, player(100 * t, 7.6 * t, 0));
    close(result.u, road.cum[1] * t);
    close(result.v, road.cum[1] / 10);
  }
  assert.equal(playerInLane(road, player(50, 0, 0)), null);
  assert.equal(playerInLane(road, player(100.1, 7.6, 0)), null);
  assert.equal(playerInLane(road, player(50, 3.8, 2.001)), null);
});

test('long lanes find the player in any run of segments and ignore players inside their overall bounds', () => {
  // A U-shaped lane (up one shore, back down the other) with many segments: its overall bounds cover the middle
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push({ x: 0, y: 0, z: i * 10 });
  for (let i = 0; i <= 40; i++) pts.push({ x: 200, y: 0, z: 400 - i * 10 });
  const road = lane(pts);
  assert.ok(road.box.length > 4, 'the lane is bounded in several runs');
  const late = playerInLane(road, player(200, 0, 55));
  close(late.u, road.cum[75] + 5);
  close(playerInLane(road, player(0, 0, 333)).u, 333);
  assert.equal(playerInLane(road, player(100, 0, 200)), null);
});

function trafficFunction(name, context) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`));
  assert.ok(match, `${name} is present`);
  return vm.runInNewContext(`(${match[0].trim()})`, context);
}

function intersectionHarness() {
  const n = { signal: true, in: [] };
  const exit = { lanes: [0], outSide: 1 };
  const edge = { to: n, axisIndex: 0, occ: [[]], opposite: null, inSide: 0, len: 100 };
  const car = { edge, move: { to: exit, out: [0], turn: 'S' }, lane: 0, s: 80, speed: 4,
    driver: { b: 3 }, half: 2.25, wait: 0, commit: null, isPolice: false };
  const state = { phase: 'red', occupied: false, pedestrians: false, space: true, conflict: false };
  const context = {
    LOOKAHEAD: 70,
    phaseOf: () => state.phase,
    canStopBefore: () => true,
    stopAt: () => -3,
    boxBusy: () => state.occupied,
    ahead: () => null,
    connector: () => ({ len: 20 }),
    yieldToCrossTraffic: () => state.conflict,
    pedestrianOn: () => state.pedestrians,
    laneCoord: () => 0,
    timeTo: () => 1,
    room: () => state.space,
    alongside: () => false,
    mergingAhead: () => null
  };
  return { car, state, mayEnter: trafficFunction('mayEnter', context), signalAhead: trafficFunction('signalAhead', context) };
}

test('police pass red and amber signals while ordinary cars stop', () => {
  const { car, state, mayEnter, signalAhead } = intersectionHarness();
  for (const phase of ['red', 'amber']) {
    state.phase = phase;
    car.isPolice = false;
    assert.equal(mayEnter(car, 18), false);
    assert.equal(signalAhead(car, car.edge, 18), -3);
    car.isPolice = true;
    assert.equal(mayEnter(car, 18), true);
    assert.equal(signalAhead(car, car.edge, 18), 0);
  }
});

test('police running a red yield to fast cross traffic regardless of how long they waited', () => {
  const car = { edge: { axisIndex: 0 }, wait: 20 };
  const lead = { s: 85, v: { speed: 10 } };
  const side = { axisIndex: 1, occ: [[lead]], len: 100 };
  const node = { signal: true, in: [{ axisIndex: 0, occ: [[lead]] }, side] };
  const context = {
    leadOf: (list) => list.at(-1),
    canStopBefore: () => true
  };
  lead.v.half = 2.25;
  context.canStop = trafficFunction('canStop', context);
  const yieldToCrossTraffic = trafficFunction('yieldToCrossTraffic', context);
  assert.equal(yieldToCrossTraffic(car, node), true);
  lead.v.speed = 0;
  assert.equal(yieldToCrossTraffic(car, node), false);
  lead.v.speed = 10;
  lead.s = 10;
  assert.equal(yieldToCrossTraffic(car, node), false);
});

function populationContext() {
  const context = {
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
    hasView: true, camX: 0, camY: 10, camZ: 0, visible: () => true,
    focusX: 0, focusZ: 0, player: { active: false },
    clock: 0,
    VEHICLE_SPAWN_DISTANCE: 250, PED_SPAWN_DISTANCE: 150, NEAR_RADIUS: 350, PED_AVOID_INTERVAL: 0.12,
    nearEdges: [], nearSignals: [], track: {}, KERB: 1.6, QUEUE_GAP: 0.62,
    atCurb: () => {}, laneClear: () => true,
    place: (v, e, lane, s) => Object.assign(v, { edge: e, lane, s })
  };
  context.nearView = trafficFunction('nearView', context);
  // spawnPed's neighbours: the busyness-weighted sidewalk pick & spot, the crowd check and the neighbour grid
  Object.assign(context, { spawnEdge: () => context.nearEdges[0], densityAccepts: () => true, crowdDensity: () => 1,
    crowdAt: () => 0, gridAdd: () => {} });
  return context;
}

function straightEdge(z, len = 20) {
  return { sx: 0, sz: z, dx: 0, dz: 1, rx: -1, rz: 0, len, lanes: [0], occ: [[]] };
}

test('cars replenish the road ahead while nearby visible spawning stays blocked', () => {
  const context = populationContext();
  const edge = straightEdge(140);
  context.nearEdges.push(edge);
  const spawnVehicle = trafficFunction('spawnVehicle', context);
  const car = { half: 2.25 };
  assert.equal(spawnVehicle(car, 100, 350, true), false);
  edge.sz = 290;
  assert.equal(spawnVehicle(car, 100, 350, true), true);
  assert.equal(edge.sz + car.s, 300);
  edge.sz = 140;
  context.visible = () => false;
  assert.equal(spawnVehicle(car, 100, 350, true), true);
});

test('pedestrians replenish visible sidewalks ahead without appearing nearby', () => {
  const context = populationContext();
  context.nearEdges.push(straightEdge(0));
  let z = 100;
  context.sidewalkTrack = () => {
    Object.assign(context.track, { ax: 0, az: z - 10, ux: 0, uz: 1, len: 20, node: null });
    return true;
  };
  const spawnPed = trafficFunction('spawnPed', context);
  const ped = { crossesStreets: false, speed: 1.4, rig: {} };
  assert.equal(spawnPed(ped, 60, 280, true), false);
  z = 220;
  assert.equal(spawnPed(ped, 60, 280, true), true);
  assert.equal(ped.z, 220);
  assert.equal(ped.v, ped.speed);
});

test('long roads are available near their ends and spawn only in the local section', () => {
  const context = populationContext();
  const edge = straightEdge(100, 2000);
  Object.assign(context, { edges: [edge, straightEdge(2000)], nodes: [], nearX: Infinity, nearZ: Infinity });
  trafficFunction('refreshNear', context)();
  assert.deepEqual(context.nearEdges, [edge]);
  const car = { half: 2.25 };
  assert.equal(trafficFunction('spawnVehicle', context)(car, 0, 350, false), true);
  assert.ok(edge.sz + car.s <= 350);
  assert.ok(car.s >= car.half + 5);
});

// Drivers dodging the player: late, as people do, and committed to whatever they do
function dodgeHarness({ isRoadClear = (x) => Math.abs(x) <= 6.65 } = {}) {
  const context = {
    AVOID_NOTICE: 1.8, AVOID_HOLD: 1.2, clock: 0,
    threat: { ahead: 0, aside: 0, across: 0 },
    player: { active: true, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1, halfW: 0.86, halfL: 2.18 },
    network: { isRoadClear }
  };
  for (const name of ['threatTime', 'swerveRoom', 'react']) context[name] = trafficFunction(name, context);
  // a car heading +z (its right is -x) in the middle of the road
  const car = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, speed: 12, half: 2.25, halfL: 2.18, halfWidth: 0.86, dl: 0,
    impactTime: 0,
    evade: 0, alarm: 0, panicUntil: 0, panicAcc: 0, reaction: 0.8 };
  // the player at (x, z) heading `heading` at `speed`, the car on at its speed, for `seconds` at 60 Hz
  const step = (x, z, heading, speed, seconds) => {
    for (let k = 0; k < seconds * 60; k++) {
      Object.assign(context.player, { x, z, fx: Math.sin(heading), fz: Math.cos(heading),
        vx: Math.sin(heading) * speed, vz: Math.cos(heading) * speed });
      context.react(car, 1 / 60);
      context.clock += 1 / 60;
      car.z += car.speed / 60;
      x += Math.sin(heading) * speed / 60;
      z += Math.cos(heading) * speed / 60;
    }
    return { x, z };
  };
  return { context, car, step };
}

test('drivers notice a player about to hit them only shortly before, and react later still', () => {
  const { context, car, step } = dodgeHarness();
  // head-on at 12 + 14 m/s from 60 m: 2.1 s to impact, noticed 1.8 s before (after 0.3 s), acted on 0.8 s later
  let p = step(0, 60, Math.PI, 14, 0.3);
  assert.equal(car.alarm, 0, 'not noticed yet');
  p = step(p.x, p.z, Math.PI, 14, 0.7);
  assert.ok(car.alarm > 0 && car.panicUntil === 0, 'noticed, not reacting yet');
  step(p.x, p.z, Math.PI, 14, 0.2);
  assert.ok(car.panicUntil > 0, 'reacting, about a second before impact');
  assert.ok(Math.abs(context.threatTime(car) - 0.95) < 0.15);
});

test('a driver about to be hit head-on brakes and swerves; hit from behind, it floors it instead of braking', () => {
  const head = dodgeHarness();
  head.step(0, 40, Math.PI, 14, 1.2);
  assert.equal(head.car.panicAcc, -1);
  assert.equal(head.car.evade, 2.2, 'to the right, the player coming straight at it');
  const rear = dodgeHarness();
  rear.step(0.5, -25, 0, 26, 1.2);
  assert.equal(rear.car.panicAcc, 1);
  assert.equal(rear.car.evade, 2.2, 'right, away from the player coming up on its left (+x)');
});

test('drivers swerve behind a player crossing their way, and to the side with room', () => {
  // crossing from the car's left (+x) to its right: swerving left, behind the player
  const cross = dodgeHarness();
  cross.step(25, 25, -Math.PI / 2, 12, 1.2);
  assert.ok(cross.car.evade < 0);
  // head-on with the curb close on its right (-x): left it is
  const curb = dodgeHarness({ isRoadClear: (x) => x >= -2.55 && x <= 8 });
  curb.step(0, 40, Math.PI, 14, 1.2);
  assert.equal(curb.car.evade, -2.2);
});

test('drivers commit to their manoeuvre whatever the player does then', () => {
  const { car, step } = dodgeHarness();
  let p = step(0, 40, Math.PI, 14, 1.2);
  const { evade, panicAcc } = car;
  assert.ok(evade !== 0);
  // the player swerves the same way: the driver keeps on
  p = step(p.x - 3, p.z, Math.PI, 14, 0.3);
  assert.equal(car.evade, evade);
  assert.equal(car.panicAcc, panicAcc);
});

test('a player passing in the next lane or going away is no threat', () => {
  const { context, car } = dodgeHarness();
  Object.assign(context.player, { x: -3.6, z: -10, vx: 0, vz: 20, fx: 0, fz: 1 });
  assert.equal(context.threatTime(car), Infinity);
  Object.assign(context.player, { x: 0, z: 10, vx: 0, vz: 20 });
  assert.equal(context.threatTime(car), Infinity);
});

// Steering: cars turn only as fast as their front wheels turn them, the wheels as fast as a person turns them
function steeringHarness() {
  const consts = ['CAR_DRIVER', 'BUS_DRIVER'].map((name) => source.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0])
    .concat(['bendA', 'bendB', 'at'].map((name) => source.match(new RegExp(`^  const ${name} = .*$`, 'm'))?.[0]));
  assert.ok(consts.every(Boolean), 'steering constants are present');
  const context = { clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)), connector() {}, curvePoint() {} };
  vm.runInNewContext(consts.join('\n').replace(/^\s*const /gm, 'var '), context);
  for (const name of ['steer', 'previewPoint', 'lanePoint', 'pathPoint', 'locate']) {
    context[name] = trafficFunction(name, context);
  }
  const edge = { sx: 0, sz: 0, dx: 0, dz: 1, rx: -1, rz: 0, len: 5000, lanes: [-1.8, 1.8] };
  const car = (speed, extra = {}) => {
    const v = { half: 2.25, axle: 1.38, driver: context.CAR_DRIVER, edge, lane: 0, s: 10, conn: null, trail: null,
      speed, dl: 0, dlv: 0, delta: 0, evade: 0, yaw: 0, nose: 0, yawRate: 0, yawVel: 0, tx: 0, tz: 1, x: 0, z: 0,
      move: { out: [0, 1], to: null }, ...extra };
    context.locate(v);
    return v;
  };
  // drive v on for `seconds` at 60 Hz, as drive() moves it along its path; the fastest it turns and turns the wheel
  const run = (v, seconds) => {
    let yawRate = 0, wheelRate = 0;
    for (let k = 0; k < seconds * 60; k++) {
      const { yaw, delta } = v;
      v.s += v.speed * Math.cos(v.nose) / 60;
      context.steer(v, 1 / 60);
      context.locate(v);
      yawRate = Math.max(yawRate, Math.abs(v.yaw - yaw) * 60);
      wheelRate = Math.max(wheelRate, Math.abs(v.delta - delta) * 60);
    }
    return { yawRate, wheelRate };
  };
  return { context, car, run };
}

test('a lane change is steered: the car turns only as fast as its wheels let it, and settles in its lane', () => {
  const { context, car, run } = steeringHarness();
  const v = car(12, { dl: 3.6 }); // (just changed lanes: 3.6 m right of its new lane's centre)
  const { yawRate, wheelRate } = run(v, 6);
  assert.ok(wheelRate <= context.CAR_DRIVER.steerRate + 1e-9, `wheel turned at ${wheelRate}`);
  assert.ok(yawRate * 12 <= 1.3 * context.CAR_DRIVER.aLat + 0.05, `turned at ${yawRate} rad/s`);
  assert.ok(Math.abs(v.dl) < 0.1 && Math.abs(v.yaw) < 0.02, 'in its lane, heading down it');
});

test('a panicking driver yanks the wheel, but the car still turns only as fast as the tyres grip', () => {
  const { context, car, run } = steeringHarness();
  const v = car(12, { evade: -2.2 });
  const { yawRate, wheelRate } = run(v, 1.5);
  assert.ok(wheelRate <= 2.5 * context.CAR_DRIVER.steerRate + 1e-9);
  assert.ok(yawRate * 12 <= context.CAR_DRIVER.grip + 0.05, `turned at ${yawRate} rad/s`);
  assert.ok(v.dl < -1.5, 'well out of the way after 1.5 s');
});

test('a standing car does not turn, however far it is off its line', () => {
  const { car, run } = steeringHarness();
  const v = car(0, { dl: 2 });
  run(v, 2);
  assert.equal(v.yaw, 0);
  assert.equal(v.dl, 2);
});

test('drivers stop short of someone lying in their way, not of someone off to the side', () => {
  const fallen = [];
  const fallenGap = trafficFunction('fallenGap', { pedestrianSystem: { fallen }, LOOKAHEAD: 70, Math });
  const car = { x: 0, z: 0, yaw: 0, half: 2.25, halfWidth: 0.9 };
  assert.equal(fallenGap(car), Infinity, 'nobody down');
  fallen.push({ x: 0.5, z: 20 });
  const gap = fallenGap(car);
  assert.ok(Math.abs(gap - (20 - 2.25 - 1.1)) < 1e-9, `stops a body's length short (${gap})`);
  fallen[0].x = 4; // lying on the sidewalk beside the lane
  assert.equal(fallenGap(car), Infinity);
  fallen[0].x = 0; fallen[0].z = -10; // behind it
  assert.equal(fallenGap(car), Infinity);
});
