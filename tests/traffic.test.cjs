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

// Drivers dodging the player: noticing late, as people do, getting out of the way the player leaves, and re-judging as
// the player moves. Closed loop: the production react() deciding, steer() turning the car down a straight road (and
// back onto it), the car braking or speeding up as it decided, and the player keeping on or swerving
const avoidConsts = ['CAR_DRIVER', 'AVOID_NOTICE', 'AVOID_MARGIN', 'AVOID_HOLD', 'AVOID_STEP', 'AVOID_REACH', 'AVOID_SWITCH',
  'AVOID_TURN', 'AVOID_BRAKE', 'SPIN_FRICTION'].map((name) => source.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0])
  .concat(['bendA', 'bendB', 'at', 'danger', 'course'].map((name) => source.match(new RegExp(`^  const ${name} = .*$`, 'm'))?.[0]));
assert.ok(avoidConsts.every(Boolean), 'dodging constants are present');

function dodgeHarness({ road = (x) => Math.abs(x) <= 6.65, others = [] } = {}) {
  const context = { clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)), clock: 0, connector() {}, curvePoint() {},
    network: { isRoadClear: (x, z) => road(x, z) } };
  vm.runInNewContext(avoidConsts.join('\n').replace(/^\s*const /gm, 'var '), context);
  for (const name of ['react', 'calm', 'predictPlayer', 'assess', 'spread', 'dodge', 'clearTo', 'steer', 'previewPoint', 'lanePoint',
    'pathPoint', 'locate']) context[name] = trafficFunction(name, context);
  context.player = { active: true, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1, heading: 0, yawRate: 0, halfW: 0.86, halfL: 2.18 };
  // a car heading +z (its right is -x) down the middle of the road at 12 m/s
  const edge = { sx: 0, sz: 0, dx: 0, dz: 1, rx: -1, rz: 0, len: 5000, lanes: [0] };
  const car = { half: 2.25, halfL: 2.18, halfWidth: 0.86, axle: 1.38, driver: context.CAR_DRIVER, edge, lane: 0, s: 0,
    conn: null, trail: null, speed: 12, dl: 0, dlv: 0, delta: 0, yaw: 0, nose: 0, yawRate: 0, yawVel: 0, yawOffset: 0,
    tx: 0, tz: 1, x: 0, z: 0, vx: 0, vz: 0, move: { out: [0], to: null }, impactTime: 0, shaken: 0, reaction: 0.8 };
  context.calm(car);
  car.lastDanger = -Infinity;
  context.vehicles = [car, ...others];
  context.locate(car);
  // the player from (x, z) heading `heading` at `speed`, turning at `turn` rad/s from `turnAt` s, for `seconds` at 60 Hz:
  // the closest the two boxes come (< 0: they hit), and where the player ended up
  const run = ({ x, z, heading, speed = 14, turn = 0, turnAt = 0, seconds = 3.5, onFrame }) => {
    let closest = Infinity;
    for (let k = 0; k < seconds * 60; k++) {
      const yawRate = context.clock >= turnAt ? turn : 0;
      Object.assign(context.player, { x, z, heading, fx: Math.sin(heading), fz: Math.cos(heading),
        vx: Math.sin(heading) * speed, vz: Math.cos(heading) * speed, yawRate });
      context.react(car, 1 / 60);
      if (car.panic) car.speed = Math.max(0, car.speed + car.panicAcc / 60);
      car.s += car.speed * Math.cos(car.nose) / 60;
      context.steer(car, 1 / 60);
      context.locate(car);
      for (const o of others) o.z += o.speed / 60;
      if (onFrame) onFrame(car, context);
      context.clock += 1 / 60;
      heading += yawRate / 60;
      x += Math.sin(heading) * speed / 60;
      z += Math.cos(heading) * speed / 60;
      closest = Math.min(closest, boxGap(car, { x, z, heading }));
    }
    return { closest, x, z };
  };
  return { context, car, run };
}

// Gap between the car's box and the player's (the SAT separation; < 0 overlapping)
function boxGap(car, p) {
  const a = { x: car.x, z: car.z, s: Math.sin(car.yaw), c: Math.cos(car.yaw) };
  const b = { x: p.x, z: p.z, s: Math.sin(p.heading), c: Math.cos(p.heading) };
  const half = (o, ax, az) => 0.86 * Math.abs(ax * o.c - az * o.s) + 2.18 * Math.abs(ax * o.s + az * o.c);
  let gap = -Infinity;
  for (const o of [a, b]) {
    for (const [ax, az] of [[o.c, -o.s], [o.s, o.c]]) {
      gap = Math.max(gap, Math.abs((a.x - b.x) * ax + (a.z - b.z) * az) - half(a, ax, az) - half(b, ax, az));
    }
  }
  return gap;
}

test('drivers notice a player about to hit them only shortly before, and react later still', () => {
  const { context, car, run } = dodgeHarness();
  // head-on at 12 + 14 m/s from 72 m: about 2.6 s to impact, noticed 2.2 s before, acted on 0.8 s after that
  let noticed = null, reacted = null;
  run({ x: 0, z: 72, heading: Math.PI, seconds: 2, onFrame: (v, c) => {
    if (noticed === null && v.alarm > 0) noticed = c.clock;
    if (reacted === null && v.panic) reacted = c.clock;
  } });
  assert.ok(noticed > 0.25 && noticed < 0.6, `noticed at ${noticed} s`); // (contact due at 2.6 s, seen 2.2 s before)
  assert.ok(Math.abs(reacted - noticed - car.reaction) < 0.05, `reacted at ${reacted} s`);
  assert.ok(car.warning, 'sounding its horn');
  assert.ok(context.assess(car).time < 1.3, 'about a second before impact');
});

test('head-on, a driver brakes and swerves right and misses; hit from behind, it floors it and pulls aside', () => {
  const head = dodgeHarness();
  const h = head.run({ x: 0, z: 55, heading: Math.PI, seconds: 1.4 });
  assert.ok(head.car.evade > 1.5, `to the right (${head.car.evade.toFixed(2)} m)`);
  assert.equal(head.car.panicAcc, -head.context.AVOID_BRAKE, 'braking, but not so hard it can\'t swerve');
  assert.ok(head.run({ x: h.x, z: h.z, heading: Math.PI, seconds: 2 }).closest > 0, 'missed');
  const rear = dodgeHarness();
  const r = rear.run({ x: 0.4, z: -25, heading: 0, speed: 24 });
  assert.ok(rear.car.speed > 12, 'sped up');
  assert.ok(r.closest > 0, 'missed');
});

test('drivers swerve away from the side the player is on, and around a car beside them', () => {
  // the player 0.6 m to its right (-x): left
  const right = dodgeHarness();
  assert.ok(right.run({ x: -0.6, z: 55, heading: Math.PI }).closest > 0);
  assert.ok(right.car.dl < -0.5 || right.car.evade < 0);
  // head-on with a car keeping pace in the lane on its right: left, not into that car
  const beside = { x: -3.4, z: 0, yaw: 0, yawOffset: 0, speed: 12, vx: 0, vz: 0, half: 2.25, halfWidth: 0.86, edge: {} };
  const h = dodgeHarness({ others: [beside] });
  let leftmost = 0;
  const { closest } = h.run({ x: 0, z: 55, heading: Math.PI, onFrame: (v) => { leftmost = Math.max(leftmost, -v.dl); } });
  assert.ok(leftmost > 1, `swerved left (${leftmost.toFixed(2)} m)`);
  assert.ok(closest > 0 && boxGap(h.car, { x: beside.x, z: beside.z, heading: 0 }) > 0, 'missed both');
});

test('a player swerving late the way the driver went is not driven into', () => {
  // head-on, the curb close on the car's right: it goes left; the player swerves late (just after the driver has
  // made up its mind) to its own right (the car's left), then the other way. Either way the driver keeps re-judging,
  // and they miss
  for (const turn of [-0.9, 0.9]) {
    const { car, run } = dodgeHarness({ road: (x) => x >= -2.55 && x <= 8 });
    let first = 0;
    const { closest } = run({ x: 0, z: 55, heading: Math.PI, turn, turnAt: 1.1, onFrame: (v) => {
      if (!first && v.evadeSide) first = v.evadeSide;
    } });
    assert.equal(first, -1, 'went left first (no room on the right)');
    assert.ok(closest > 0, `missed the player swerving ${turn < 0 ? 'its own right' : 'its own left'} (${closest.toFixed(2)} m)`);
    assert.ok(Math.abs(car.dl) < 3.6 + 0.6, 'stayed on the road');
  }
});

test('a player crossing its way: the driver stands on the brakes and stops short', () => {
  const { car, run } = dodgeHarness();
  const { closest } = run({ x: 28, z: 26, heading: -Math.PI / 2, speed: 12 });
  assert.ok(closest > 0, `missed (${closest.toFixed(2)} m)`);
  assert.ok(car.speed < 4, `nearly stopped (${car.speed.toFixed(1)} m/s)`);
});

test('with no way out a driver holds its line and stands on the brakes', () => {
  const { car, run } = dodgeHarness({ road: (x) => Math.abs(x) <= 1.6 });
  run({ x: 0, z: 55, heading: Math.PI, seconds: 1.3 });
  assert.ok(car.panic);
  assert.equal(car.panicAcc, -car.driver.bMax);
  assert.ok(Math.abs(car.evade - car.dl) < 1e-9 && Math.abs(car.dl) < 0.2, 'kept to its line');
});

test('a player passing in the next lane or going away is no threat', () => {
  const { context, car } = dodgeHarness();
  Object.assign(context.player, { x: -3.6, z: -10, vx: 0, vz: 20, fx: 0, fz: 1, heading: 0 });
  assert.equal(context.assess(car).time, Infinity);
  Object.assign(context.player, { x: 0, z: 10, vx: 0, vz: 20 });
  assert.equal(context.assess(car).time, Infinity);
});

test('a turning player is expected on its arc', () => {
  const { context } = dodgeHarness();
  // at 10 m/s turning 0.5 rad/s (a 20 m radius) from heading +z: a quarter turn takes pi s
  Object.assign(context.player, { x: 0, z: 0, vx: 0, vz: 10, fx: 0, fz: 1, heading: 0, yawRate: 0.5 });
  const p = context.predictPlayer(Math.PI, {});
  assert.ok(Math.abs(p.x - 20) < 1e-6 && Math.abs(p.z - 20) < 1e-6, `at (${p.x}, ${p.z})`);
  assert.ok(Math.abs(p.fx - 1) < 1e-6 && Math.abs(p.fz) < 1e-6, 'heading +x');
});

// Steering: cars turn only as fast as their front wheels turn them, the wheels as fast as a person turns them
function steeringHarness() {
  const consts = ['CAR_DRIVER', 'BUS_DRIVER', 'SPIN_FRICTION'].map((name) => source.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0])
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
  assert.ok(wheelRate <= 3.5 * context.CAR_DRIVER.steerRate + 1e-9);
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
