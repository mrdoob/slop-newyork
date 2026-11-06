const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
const polygonCollision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function keyboardHarness(nyc = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    streetZ: () => 0,
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    ...nyc
  };
  const { ThirdPersonControllerManager } = loadModule(source, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': config,
      './tsl-materials.js': {},
      './cars.js': {},
      './helicopter.js': {},
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './landmarks.js': {},
      './building-collision.js': polygonCollision
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down'].map((action) => [action, false]));
  controller.bindKeyboard();
  return {
    controller,
    window,
    document,
    key(type, code, tagName = 'BODY') {
      window.dispatch(type, { code, target: { tagName } });
    }
  };
}

test('releasing a movement key after focusing search stops movement', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false);

  key('keydown', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false, 'typing in search does not move the player');
});

test('releasing one movement binding preserves another held binding', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'ArrowUp');
  key('keyup', 'ArrowUp');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('either jump binding stays active until both are released', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'Space');
  key('keydown', 'KeyE');
  key('keyup', 'Space');
  assert.equal(controller.keys.up, true);
  key('keyup', 'KeyE');
  assert.equal(controller.keys.up, false);
});

test('keyboard and touch input remain active independently', () => {
  const { controller, key } = keyboardHarness();
  controller.setTouchInput('forward', 0.35);
  assert.equal(controller.keys.forward, 0.35);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  controller.setTouchInput('forward', 0.6);
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, 0.6);
  controller.setTouchInput('forward', 0);
  assert.equal(controller.keys.forward, false);
});

test('clearing touch input preserves held keyboard controls', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  controller.setTouchInput('forward', 0.4);
  controller.setTouchInput('left', 0.7);
  controller.setTouchInput('up', true);
  controller.clearTouchInput();
  assert.equal(controller.keys.forward, true);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, false);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('touch strengths are clamped and unknown actions are ignored', () => {
  const { controller } = keyboardHarness();
  controller.setTouchInput('forward', 2);
  controller.setTouchInput('left', -0.5);
  controller.setTouchInput('up', true);
  controller.setTouchInput('unknown', 1);
  assert.equal(controller.keys.forward, 1);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, true);
  assert.equal(Object.hasOwn(controller.keys, 'unknown'), false);
});

for (const interruption of ['blur', 'hidden', 'reset']) {
  test(`${interruption} clears held controls and their physical key state`, () => {
    const { controller, window, document, key } = keyboardHarness();
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    key('keydown', 'Space');
    key('keydown', 'KeyE');
    controller.setTouchInput('forward', 0.4);
    controller.setTouchInput('backward', 0.8);
    controller.setTouchInput('down', true);
    if (interruption === 'blur') {
      window.dispatch('blur');
    } else if (interruption === 'hidden') {
      document.hidden = true;
      document.dispatch('visibilitychange');
    } else {
      controller.resetInput();
    }
    assert.equal(Object.values(controller.keys).some(Boolean), false);

    // A fresh use of the alias must not revive the old key whose keyup was lost.
    key('keydown', 'ArrowUp');
    key('keyup', 'ArrowUp');
    assert.equal(controller.keys.forward, false);
  });
}

function advanceWithTouch(mode, strength, reverse) {
  const { controller } = keyboardHarness();
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  if (mode === 'Person') Object.assign(entity, { verticalVel: 0 });
  if (mode === 'Car') Object.assign(entity, {
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
  });
  if (mode === 'Cyclist') Object.assign(entity, {
    leanAngle: 0, leanPivot: { rotation: { z: 0 } },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    pedalPhase: 0, crankPivot: { rotation: { x: 0 } }, pedals: []
  });
  if (mode === 'Helicopter') Object.assign(entity, {
    verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }
  });
  controller.entities = { [mode.toLowerCase()]: entity };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.setTouchInput(reverse ? 'backward' : 'forward', strength);
  controller.setTouchInput(reverse ? 'right' : 'left', strength);
  if (mode === 'Helicopter') controller.setTouchInput(reverse ? 'down' : 'up', strength);
  controller[`update${mode}`](0.1, 0);
  return entity;
}

for (const mode of ['Person', 'Car', 'Cyclist', 'Helicopter']) {
  test(`analog ${mode.toLowerCase()} input proportionally scales movement and turning`, () => {
    for (const reverse of [false, true]) {
      const full = advanceWithTouch(mode, 1, reverse);
      const partial = advanceWithTouch(mode, 0.4, reverse);
      if (mode === 'Car') {
        assert.equal(Math.sign(partial.speed), Math.sign(full.speed));
        assert.ok(Math.abs(partial.speed) > 0 && Math.abs(partial.speed) < Math.abs(full.speed), 'partial throttle moves more slowly');
        assert.equal(Math.sign(partial.steerAngle), Math.sign(full.steerAngle));
        assert.ok(Math.abs(partial.steerAngle) > 0 && Math.abs(partial.steerAngle) < Math.abs(full.steerAngle), 'partial steering turns less');
        continue;
      }
      assert.ok(Math.abs(partial.speed - full.speed * 0.4) < 1e-10, 'movement should scale with joystick strength');
      assert.ok(Math.abs(partial.heading - full.heading * 0.4) < 1e-10, 'turning should scale with joystick strength');
      if (mode === 'Helicopter') {
        assert.ok(Math.abs(partial.verticalSpeed - full.verticalSpeed * 0.4) < 1e-10);
      }
    }
  });
}

function carDynamicsHarness(motion = {}) {
  const { controller } = keyboardHarness();
  const car = {
    type: 'car', position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0,
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: [],
    carState: { value: { x: 0, w: 0 } },
    ...motion
  };
  controller.entities = { car };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  return {
    controller, car,
    advance(seconds, hz = 60) {
      for (let i = 0; i < Math.round(seconds * hz); i++) controller.updateCar(1 / hz);
    }
  };
}

function carVelocity(car) {
  return [Math.sin(car.heading) * car.speed + car.vx, Math.cos(car.heading) * car.speed + car.vz];
}

test('car accelerates gradually to full speed and preserves coasting and braking', () => {
  const acceleration = carDynamicsHarness();
  acceleration.controller.keys.forward = true;
  acceleration.advance(4);
  assert.ok(Math.abs(acceleration.car.speed * 3.6 - 60) < 1, 'reach city speeds gradually');
  acceleration.advance(5);
  assert.ok(acceleration.car.speed > 26 && acceleration.car.speed < 28, 'acceleration tapers at higher speeds');
  acceleration.advance(25);
  assert.equal(acceleration.car.speed, 36, 'holding the accelerator reaches the full top speed');

  const coasting = carDynamicsHarness({ speed: 50 / 3.6 });
  coasting.advance(5);
  assert.ok(Math.abs(coasting.car.speed * 3.6 - 33.07) < 0.2, 'keep the existing accelerator-release resistance');

  const braking = carDynamicsHarness({ speed: 50 / 3.6 });
  braking.controller.keys.backward = true;
  braking.advance(1.5);
  assert.ok(braking.car.speed >= 0 && braking.car.speed < 0.2, 'braking reaches a stop without reversing early');
  assert.ok(braking.car.position.z > 9.8 && braking.car.position.z < 10.6, 'preserve the roughly ten-metre stopping distance');
});

test('car steering follows speed and reverses direction when backing up', () => {
  const slow = carDynamicsHarness({ speed: 5 });
  const fast = carDynamicsHarness({ speed: 25 });
  const reverse = carDynamicsHarness({ speed: -5 });
  const stopped = carDynamicsHarness();
  for (const sim of [slow, fast, reverse, stopped]) {
    sim.controller.keys.left = true;
    sim.advance(1);
  }
  assert.ok(slow.car.heading > fast.car.heading && fast.car.heading > 0, 'fast steering follows a wider arc');
  assert.ok(fast.car.steerAngle < slow.car.steerAngle / 3, 'reduce steering lock at speed');
  assert.ok(Math.abs(fast.car.angularVel * fast.car.speed) < 9.5, 'high-speed turning stays within road-tire grip');
  assert.ok(reverse.car.heading < 0, 'the same steering input turns the opposite way in reverse');
  assert.ok(Math.abs(reverse.car.heading + slow.car.heading) < 0.05, 'forward and reverse steering remain symmetric');
  assert.equal(stopped.car.heading, 0, 'steering alone cannot rotate a stationary car');
  assert.equal(stopped.car.speed, 0);
});

test('car changes direction after braking with residual turning and sideways motion', () => {
  for (const direction of [-1, 1]) {
    for (const hz of [30, 60, 120]) {
      const sim = carDynamicsHarness({ speed: -direction * 10, angularVel: direction });
      sim.controller.keys[direction > 0 ? 'forward' : 'backward'] = true;
      sim.controller.keys.left = true;
      sim.advance(3, hz);
      assert.ok(sim.car.speed * direction > 5, 'holding the new direction must release the brakes and drive away');
    }
  }
});

test('player brake and reverse lamps follow braking and backward travel', () => {
  for (const [speed, input, brake, reverse] of [
    [0, null, 0, 0], [5, null, 0, 0], [5, 'forward', 0, 0], [5, 'backward', 1, 0],
    [-5, null, 0, 1], [-5, 'backward', 0, 1], [-5, 'forward', 1, 1]
  ]) {
    const sim = carDynamicsHarness({ speed });
    if (input) sim.controller.keys[input] = true;
    sim.advance(1 / 60);
    assert.equal(sim.car.carState.value.x, brake, `brake at speed ${speed}, input ${input}`);
    assert.equal(sim.car.carState.value.w, reverse, `reverse at speed ${speed}, input ${input}`);
    sim.controller.entities.person = {};
    sim.controller.setMode('person');
    assert.equal(sim.car.carState.value.x, 0, 'leaving the car releases its brake lights');
    assert.equal(sim.car.carState.value.w, 0, 'the parked car no longer shows reverse lights');
  }
});

test('releasing car steering settles smoothly and suspension leans outward', () => {
  const sim = carDynamicsHarness({ speed: 15 });
  sim.controller.keys.left = true;
  sim.advance(2);
  const turning = sim.car.angularVel;
  assert.ok(sim.car.chassisPivot.rotation.z > 0, 'the body rolls away from the turn');
  sim.controller.keys.left = false;
  sim.advance(1 / 60);
  assert.ok(sim.car.angularVel > 0, 'steering release does not snap away the existing yaw');
  sim.advance(1.5);
  assert.ok(Math.abs(sim.car.angularVel) < Math.abs(turning) * 0.1, 'yaw settles after the wheel recenters');
  assert.ok(Math.abs(sim.car.steerAngle) < 0.001);
});

test('braking while turning initiates a slide that recovers on release', () => {
  for (const speed of [15, 25]) {
    for (const turn of ['left', 'right']) {
      const braking = carDynamicsHarness({ speed });
      const coasting = carDynamicsHarness({ speed });
      braking.controller.keys.backward = true;
      for (const sim of [braking, coasting]) {
        sim.controller.keys[turn] = true;
        sim.advance(0.75);
      }
      const slip = (car) => Math.atan2(Math.hypot(car.vx, car.vz), Math.abs(car.speed));
      assert.ok(slip(braking.car) > slip(coasting.car) * 1.5, 'the handbrake lets the rear slide out');
      assert.ok(Math.hypot(...carVelocity(braking.car)) < speed, 'the slide cannot add momentum');
      braking.controller.keys.backward = false;
      braking.controller.keys[turn] = false;
      braking.advance(2);
      assert.ok(Math.hypot(braking.car.vx, braking.car.vz) < 0.1, 'grip returns smoothly after releasing the brake');
    }
  }
});

test('sustained car turns produce bounded slip that recovers with countersteering', () => {
  for (const speed of [5, 15, 25]) {
    const sim = carDynamicsHarness({ speed });
    sim.controller.keys.forward = true;
    sim.controller.keys.left = true;
    let peakSlip = 0;
    for (let i = 0; i < 900; i++) {
      sim.controller.updateCar(1 / 60);
      const slip = Math.atan2(Math.hypot(sim.car.vx, sim.car.vz), Math.abs(sim.car.speed));
      peakSlip = Math.max(peakSlip, slip);
      assert.ok(sim.car.speed > 4, 'holding a turn does not spin the car to a stop');
    }
    assert.ok(peakSlip > 0.08 && peakSlip < 0.27, 'hard turns allow a modest slide without a growing spin');

    sim.controller.keys.left = false;
    sim.controller.keys.right = true;
    sim.advance(0.5);
    assert.ok(sim.car.angularVel < 0, 'countersteering brings yaw back under control');
    sim.controller.keys.right = false;
    sim.controller.keys.forward = false;
    sim.advance(2);
    assert.ok(Math.hypot(sim.car.vx, sim.car.vz) < 0.05, 'the slide settles after steering is released');
  }
});

test('car collision momentum is retained and sideways motion settles through grip', () => {
  const forward = carDynamicsHarness({ vz: 8 });
  forward.advance(0.1);
  assert.ok(carVelocity(forward.car)[1] > 7.7, 'a forward impact becomes rolling motion instead of disappearing');
  assert.ok(forward.car.speed > 7.7, 'longitudinal momentum reaches the signed speed used by other systems');

  const sideways = carDynamicsHarness({ vx: 8 });
  sideways.advance(0.1);
  assert.ok(carVelocity(sideways.car)[0] > 6.9, 'tire grip cannot remove a sideways impact instantly');
  sideways.advance(2);
  assert.ok(Math.abs(carVelocity(sideways.car)[0]) < 0.1, 'sideways velocity eventually settles');
});

test('unpowered car steering and collision recovery never add translational energy', () => {
  const sim = carDynamicsHarness({ speed: 20, vx: 3, angularVel: 1 });
  sim.controller.keys.left = true;
  let speed = Math.hypot(...carVelocity(sim.car));
  for (let i = 0; i < 240; i++) {
    sim.controller.updateCar(1 / 60);
    const next = Math.hypot(...carVelocity(sim.car));
    assert.ok(Number.isFinite(next) && next <= speed + 1e-9, 'steering and grip may redirect or dissipate momentum, but cannot create it');
    speed = next;
  }
});

test('car turning, handbraking and impact recovery agree across display rates', () => {
  const results = [30, 60, 120, 144].map((hz) => {
    const sim = carDynamicsHarness({ speed: 15, vx: 2, angularVel: 0.5 });
    sim.controller.keys.left = 0.6;
    sim.controller.keys.forward = 0.5;
    sim.advance(2, hz);
    sim.controller.keys.forward = false;
    sim.controller.keys.backward = 0.8;
    sim.advance(0.5, hz);
    sim.controller.keys.backward = false;
    sim.controller.keys.left = false;
    sim.advance(1, hz);
    return sim.car;
  });
  for (const car of results.slice(0, -1)) {
    const reference = results.at(-1);
    assert.ok(Math.hypot(car.position.x - reference.position.x, car.position.z - reference.position.z) < 0.1, 'path differs by less than ten centimetres');
    assert.ok(Math.abs(car.heading - reference.heading) < 0.01);
    assert.ok(Math.abs(car.speed - reference.speed) < 0.05);
    assert.ok(Math.abs(car.chassisPivot.rotation.z - reference.chassisPivot.rotation.z) < 0.01);
  }
});

function teleportHarness(mode, colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 1000, maxX: 1100, minZ: 1000, maxZ: 1100 },
    getIslandBoundsAtZ: shore,
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0.1, y: 0, z: -0.2 } });
  const chase = { person: [4.3, 1.95], car: [6.9, 2.12], cyclist: [4.8, 2.05], helicopter: [11.4, 3.3] };
  const ent = {
    type: mode, chaseDistance: chase[mode][0], chaseHeight: chase[mode][1],
    position: position(400, mode === 'helicopter' ? 120 : 0, 400), heading: 1, speed: 20,
    mesh: pivot(),
    verticalVel: 5, vx: 3, vz: -4, angularVel: 2, steerAngle: 0.4,
    pitchVel: 3, rollVel: 4, heaveY: 0.1, heaveVel: 2, chassisPivot: pivot(),
    lastCollisionSpark: { speed: 5 }, carState: { value: { x: 1, w: 1 } }, wheelSpin: 1,
    wheels: [{ isFront: true, steerPivot: { rotation: { y: 0.4 } }, tire: { rotation: { x: 0 } } }],
    leanAngle: 0.3, leanPivot: pivot(), pedalPhase: 0.7,
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } }, pedals: [],
    verticalSpeed: -8, pitchAngle: 0.2, rollAngle: -0.2, tiltPivot: pivot(),
    rig: { reset(...args) { this.resetArgs = args; } },
    crowd: { begin() {}, add() {}, end() {} }
  };
  controller.activeMode = mode;
  controller.entities = { [mode]: ent };
  controller.colliders = colliders;
  controller._colliderCells = null;
  controller.getGroundHeight = (x, z, mode) => mode === 'person' ? (x < 0 ? 1.24 : 0.22) : 0;
  return { ...harness, ent };
}

for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
  test(`${mode} teleport stops carried motion and updates its arrival pose immediately`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    controller.setTouchInput('left', 0.8);
    const result = controller.teleportActiveTo(30, 20, 0.7);
    assert.deepEqual({ ...result }, { x: 30, z: 20 }, 'an open destination is kept exactly');
    assert.equal(ent.heading, 0.7);
    assert.equal(ent.speed, 0);
    assert.equal(Object.values(controller.keys).some(Boolean), false);
    assert.equal(controller._pressedCodes.size, 0);
    assert.deepEqual([ent.mesh.position.x, ent.mesh.position.y, ent.mesh.position.z], [ent.position.x, ent.position.y, ent.position.z]);
    assert.equal(ent.mesh.rotation.y, 0.7);
    if (mode === 'person') {
      assert.equal(ent.verticalVel, 0);
      assert.equal(ent.position.y, 0.22);
      assert.deepEqual(ent.rig.resetArgs.slice(0, 3), [30, 20, 0.7]);
      assert.equal(ent.rig.resetArgs[3](ent.rig.resetArgs[4], 30, 20), 0.22);
    } else if (mode === 'car') {
      for (const field of ['vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) assert.equal(ent[field], 0, field);
      assert.equal(ent.chassisPivot.rotation.x, 0);
      assert.equal(ent.chassisPivot.rotation.z, 0);
      assert.equal(ent.chassisPivot.position.y, 0);
      assert.equal(ent.wheels[0].steerPivot.rotation.y, 0);
      assert.equal(ent.lastCollisionSpark, null);
      assert.equal(ent.carState.value.x, 0);
      assert.equal(ent.carState.value.w, 0);
    } else if (mode === 'cyclist') {
      assert.equal(ent.leanAngle, 0);
      assert.equal(ent.leanPivot.rotation.z, 0);
    } else {
      for (const field of ['verticalSpeed', 'pitchAngle', 'rollAngle']) assert.equal(ent[field], 0, field);
      assert.equal(ent.tiltPivot.rotation.x, 0);
      assert.equal(ent.tiltPivot.rotation.z, 0);
      assert.equal(ent.tiltPivot.position.y, 0);
      assert.equal(ent.position.y, 120, 'keep the helicopter altitude when already above the minimum');
    }
    const before = [ent.position.x, ent.position.y, ent.position.z, ent.heading];
    controller[`update${mode[0].toUpperCase()}${mode.slice(1)}`](0.1, 0);
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], before, 'the first neutral frame stays at the arrival');
  });
}

test('teleport checks all overlapping buildings instead of leaving a sequential push trap', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 200 },
    { minX: 9, maxX: 20, minZ: 0, maxZ: 10, maxY: 200 }
  ];
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    // Reverse order as well: a valid arrival must not rely on collider traversal order.
    for (const list of [colliders, colliders.slice().reverse()]) {
      const { controller, ent } = teleportHarness(mode, list.map(c => ({ ...c })));
      const result = controller.teleportActiveTo(11, 5, 0);
      assert.notDeepEqual({ ...result }, { x: 11, z: 5 });
      const before = [ent.position.x, ent.position.z];
      const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
      controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
      assert.deepEqual([ent.position.x, ent.position.z], before, `${mode} must already be collision-free`);
      assert.equal(ent.position.y, mode === 'helicopter' ? 120 : controller.getGroundHeight(result.x, result.z, mode));
    }
  }
});

test('teleports use oriented building footprints without rejecting clear corners of their bounds', () => {
  const cs = Math.SQRT1_2;
  const box = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, maxY: 200, obb: { cx: 0, cz: 0, hx: 8, hz: 2, cs, sn: cs } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...box }]);
    assert.deepEqual({ ...controller.teleportActiveTo(7, 7, 0.6) }, { x: 7, z: 7 });
    const actual = controller.teleportActiveTo(0, 0, 0.6);
    const before = [actual.x, actual.z];
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65,
      mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], before);
  }
});

test('movement and teleports preserve polygon courtyards and avoid their actual walls', () => {
  const points = (values) => values.map(([x, z]) => ({ x, z }));
  const collider = { minX: 0, maxX: 30, minZ: 0, maxZ: 30, maxY: 200, polygon: {
    outer: points([[0, 0], [30, 0], [30, 30], [0, 30]]),
    holes: [points([[5, 5], [25, 5], [25, 25], [5, 25]])]
  } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...collider }]);
    assert.deepEqual({ ...controller.teleportActiveTo(15, 15, 0) }, { x: 15, z: 15 });
    const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
    controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [15, 15]);
    ent.position.x = 5.1;
    controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
    const resolved = [ent.position.x, ent.position.z];
    assert.ok(ent.position.x > 5.1, 'wall contact moves back into the courtyard');
    controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], resolved, 'one resolution clears the wall');
  }
});

test('pedestrians pass clear building corners and resolve real corner hits radially', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.position.x = ent.position.z = -0.4;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [-0.4, -0.4], 'distance to the corner exceeds the body radius');

  ent.position.x = ent.position.z = -0.2;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(Math.hypot(ent.position.x, ent.position.z) - 0.48) < 1e-6);
  assert.ok(Math.abs(ent.position.x - ent.position.z) < 1e-6, 'a diagonal contact pushes along the corner normal');
});

test('corner collision normals follow an oriented building footprint', () => {
  const cs = Math.SQRT1_2;
  const { controller, ent } = teleportHarness('person', [{
    minX: -10 * cs, maxX: 10 * cs, minZ: -10 * cs, maxZ: 10 * cs, maxY: 30,
    obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs }
  }]);
  // Local (-5.2, -5.2) lies just outside the rotated square's leftmost corner.
  ent.position.x = -10.4 * cs;
  ent.position.z = 0;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(ent.position.x - (-10 * cs - 0.48)) < 1e-6);
  assert.ok(Math.abs(ent.position.z) < 1e-6, 'the correction must not slide sideways along the corner');
});

test('rotated cars use their own separating axes at building corners', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.heading = -Math.PI / 4;
  ent.speed = 0;
  ent.vx = ent.vz = 0;
  ent.position.x = ent.position.z = -1.8;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.z], [-1.8, -1.8], 'the projected bounds overlap, but the actual car does not');

  ent.position.x = ent.position.z = -0.3;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.86 * Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(ent.position.z + 0.86 * Math.SQRT1_2) < 1e-6, 'the shortest correction is perpendicular to the car side');
});

test('teleports preserve clear rounded corners and separated rotated cars', () => {
  for (const [mode, coordinate, heading] of [['person', -0.45, 0], ['car', -1.8, -Math.PI / 4]]) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
    const arrival = controller.teleportActiveTo(coordinate, coordinate, heading);
    assert.deepEqual({ ...arrival }, { x: coordinate, z: coordinate }, `${mode} has room including the arrival margin`);
    controller.resolveHorizontalCollision(ent.position, mode === 'person' ? 0.48 : 1.35, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [coordinate, coordinate], 'teleport clearance agrees with movement');

    const blocked = controller.teleportActiveTo(-0.2, -0.2, heading);
    assert.notDeepEqual({ ...blocked }, { x: -0.2, z: -0.2 }, 'a real corner overlap still needs a different arrival');
  }
});

test('movement and teleports pass underneath elevated building sections', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 4, maxY: 30 }]);
    controller.getGroundHeight = () => 0;
    const y = mode === 'helicopter' ? 0.25 : 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} fits below the overhang`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('building clearance uses the full player height beneath an overhang', () => {
  for (const [mode, height] of [['person', 1.9], ['car', 1.8], ['cyclist', 1.9], ['helicopter', 3.2]]) {
    const y = mode === 'helicopter' ? 0.25 : 0;
    const { controller, ent } = teleportHarness(mode, [{
      minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: y + height - 0.1, maxY: 30
    }]);
    controller.getGroundHeight = () => 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} intersects the underside`);
    assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('players above a roof are clear once their body bottoms clear it', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
    controller.getGroundHeight = () => 10.1;
    const y = mode === 'helicopter' ? 10.35 : 10.1;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} clears the visible roof`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('helicopter skids cannot pass through a roof below the body origin', () => {
  const { controller, ent } = teleportHarness('helicopter', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
  Object.assign(ent.position, { x: 5, y: 10.2, z: 5 });
  controller.resolveHorizontalCollision(ent.position, 4.5);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5]);
  assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, 10.2) }, { x: 5, z: 5 });
});

test('ground arrivals share movement shoreline limits while helicopters may remain above lower buildings', () => {
  const shore = z => ({ westX: -40 + z * 0.05, eastX: 40 + z * 0.05 });
  const { controller, ent } = teleportHarness('person', [], shore);
  const result = controller.teleportActiveTo(1000, -1000);
  assert.deepEqual({ ...result }, { x: 8.5, z: -470 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [result.x, result.z]);

  const heli = teleportHarness('helicopter', [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, maxY: 50 }]);
  heli.ent.position.y = 10;
  assert.deepEqual({ ...heli.controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(heli.ent.position.y, 92);
});

test('a displaced pedestrian samples ground and resets its feet at the resolved destination', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: -4, maxX: 0, minZ: -10, maxZ: 10, maxY: 30 }]);
  assert.deepEqual({ ...controller.teleportActiveTo(-1, 0) }, { x: 3, z: 0 });
  assert.equal(ent.position.y, 0.22, 'the requested point was on the higher ground, but the clear arrival is lower');
  assert.deepEqual(ent.rig.resetArgs.slice(0, 2), [3, 0]);
});

test('failed or invalid teleports keep the current position and stop the player with bounded search', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 500 }]);
  let checks = 0;
  const near = controller.nearColliders;
  controller.nearColliders = function (...args) { checks++; return near.apply(this, args); };
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 400, z: 400 });
  assert.ok(checks <= 2049, 'the search must be bounded even inside an enormous obstacle');
  assert.equal(ent.speed, 0);
  assert.equal(ent.vx, 0);
  assert.equal(ent.angularVel, 0);
  assert.deepEqual({ ...controller.teleportActiveTo(NaN, Infinity) }, { x: 400, z: 400 });
});

test('successive mode teleports keep parked players out of the arrival and default chase view', () => {
  const { controller, ent: car } = teleportHarness('car');
  const person = teleportHarness('person').ent;
  const cyclist = teleportHarness('cyclist').ent;
  controller.entities = { car, person, cyclist };
  person.position.x = 300;
  cyclist.position.x = 200;
  const heading = Math.PI / 2; // The first radial candidate is +X: its rear camera would sit on the parked car.
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0, heading) }, { x: 0, z: 0 });
  const arrivals = [car];
  const radii = { car: 2.4, person: 0.48, cyclist: 1.0 };
  for (const mode of ['person', 'cyclist']) {
    controller.activeMode = mode;
    const ent = controller.entities[mode];
    const actual = controller.teleportActiveTo(0, 0, heading);
    assert.notDeepEqual({ ...actual }, { x: 0, z: 0 });
    for (const parked of arrivals) {
      const dx = parked.position.x - actual.x, dz = parked.position.z - actual.z;
      const cameraBack = Math.cos(0.09) * ent.chaseDistance;
      const along = Math.max(0, Math.min(cameraBack, -dx));
      assert.ok(Math.hypot(dx, dz) > radii[parked.type] + radii[mode], 'player bodies must not overlap');
      assert.ok(Math.hypot(dx + along, dz) > radii[parked.type] + 0.5, 'the complete default chase corridor must be clear');
    }
    assert.deepEqual([car.position.x, car.position.z], [0, 0], 'switching modes leaves the parked car in place');
    arrivals.push(ent);
  }
});

test('player clearance respects altitude and permits a ground arrival under an airborne helicopter', () => {
  const { controller, ent } = teleportHarness('person');
  const helicopter = teleportHarness('helicopter').ent;
  helicopter.position.x = helicopter.position.z = 0;
  helicopter.position.y = 120;
  controller.entities.helicopter = helicopter;
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(ent.position.y, 0.22);
  helicopter.position.y = 1;
  assert.notDeepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 }, 'a helicopter parked at street level must be avoided');
});

test('walk mode keeps curb step-offs grounded while real jumps arc and pin the contact shadow to the pavement', () => {
  const { controller } = keyboardHarness({
    ISLAND_BOUNDS: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 9999, maxX: 9999, minZ: 9999, maxZ: 9999 },
    blockAt: (_x, z) => (z < 0 ? {} : null)
  });
  let maxRigAir = 0;
  const shadow = {
    position: { y: 0.02 },
    scale: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  };
  const person = {
    type: 'person',
    position: { x: 0, y: 0.22, z: -0.4 },
    prevX: 0,
    prevZ: -0.4,
    heading: 0,
    speed: 2.0,
    verticalVel: 0,
    jumping: false,
    shadow,
    mesh: { visible: true },
    rig: { placed: true, update(_dt, _x, _z, _h, _g, _o, air) { maxRigAir = Math.max(maxRigAir, air); } },
    crowd: { updates: 0, begin() {}, add() {}, end() {} }
  };
  controller.activeMode = 'person';
  controller.colliders = [];
  controller.entities = { person };
  controller.keys.forward = true;

  // Walk across the 0.22 m curb at z = 0: must stay grounded without triggering jump state
  for (let i = 0; i < 30; i++) {
    controller.updatePerson(1 / 60);
    controller.poseCharacters(1 / 60, person.position);
    assert.equal(person.jumping, false, 'stepping off a 0.22 m curb must not trigger jumping');
  }
  assert.equal(person.position.y, 0);
  assert.equal(maxRigAir, 0, 'curb step-off passes air=0 so PersonRig steps down smoothly');

  // Press jump: person rises into the air, rig receives jump air, and contact shadow stays at y = 0.02 in world space
  controller.keys.up = true;
  controller.updatePerson(1 / 60);
  controller.keys.up = false;
  for (let i = 0; i < 15; i++) {
    controller.updatePerson(1 / 60);
    controller.poseCharacters(1 / 60, person.position);
  }
  assert.equal(person.jumping, true);
  assert.ok(person.position.y > 0.5 && maxRigAir > 0.5, 'real jump lifts person and informs PersonRig');
  assert.ok(Math.abs((person.position.y + shadow.position.y) - 0.02) < 1e-6, 'contact shadow stays on the ground beneath the jump');
  assert.ok(shadow.scale.x < 0.85, 'contact shadow shrinks with jump height');
});

test('walk mode clamps phantom speed when blocked head-on by a building wall', () => {
  const { controller } = keyboardHarness({
    ISLAND_BOUNDS: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, sidewalkHeight: 0.22 },
    CENTRAL_PARK_BOUNDS: { minX: 9999, maxX: 9999, minZ: 9999, maxZ: 9999 },
    blockAt: () => null
  });
  const person = {
    type: 'person',
    position: { x: 0, y: 0, z: -0.5 },
    prevX: 0,
    prevZ: -0.5,
    heading: 0,
    speed: 0,
    verticalVel: 0,
    jumping: false
  };
  controller.activeMode = 'person';
  controller.colliders = [{ minX: -10, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }];
  controller.entities = { person };
  controller.keys.forward = true;

  for (let i = 0; i < 120; i++) controller.updatePerson(1 / 60);
  assert.ok(person.speed < 0.05, `wall-blocked pedestrian does not accumulate phantom sprint speed (got ${person.speed})`);

  // Reversing away from the wall responds immediately on the next frame
  controller.keys.forward = false;
  controller.keys.backward = true;
  controller.updatePerson(1 / 60);
  assert.ok(person.speed < 0 && person.position.z < -0.48, 'pedestrian backs away from wall without waiting to bleed phantom speed');
});

test('cyclist braking stops briskly, pauses at zero before reversing, and supports Space handbrake', () => {
  function bikeHarness(speed = 0, colliders = []) {
    const { controller } = keyboardHarness({
      ISLAND_BOUNDS: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, sidewalkHeight: 0.22 },
      CENTRAL_PARK_BOUNDS: { minX: 9999, maxX: 9999, minZ: 9999, maxZ: 9999 },
      blockAt: () => null
    });
    const cyclist = {
      type: 'cyclist',
      position: { x: 0, y: 0, z: 0 },
      heading: 0,
      speed,
      leanAngle: 0,
      pedalPhase: 0,
      leanPivot: { rotation: { z: 0 } },
      frontWheel: { rotation: { x: 0 } },
      rearWheel: { rotation: { x: 0 } },
      crankPivot: { rotation: { x: 0 } },
      pedals: []
    };
    controller.activeMode = 'cyclist';
    controller.colliders = colliders;
    controller.entities = { cyclist };
    controller.getGroundHeight = () => 0;
    return { controller, cyclist };
  }

  // Holding S from cruising speed (12 m/s) stops in ~6.5 m and pauses cleanly at 0 before backing up
  const sBrake = bikeHarness(12);
  sBrake.controller.keys.backward = true;
  for (let i = 0; i < 72; i++) sBrake.controller.updateCyclist(1 / 60); // 1.2 s
  assert.equal(sBrake.cyclist.speed, 0, 'S brake brings the bicycle to a clean stop without immediately reversing');
  assert.ok(sBrake.cyclist.position.z > 5.5 && sBrake.cyclist.position.z < 7.5,
    `bicycle stops within ~6.5 m from 12 m/s (got ${sBrake.cyclist.position.z.toFixed(2)} m)`);

  // Continuing to hold S past the brief stop hold engages gentle reverse
  for (let i = 0; i < 30; i++) sBrake.controller.updateCyclist(1 / 60);
  assert.ok(sBrake.cyclist.speed < -0.5, 'continuing to hold S after stopping backs the bike up');

  // Holding Space (keys.up) brakes to a complete stop and never reverses
  const handbrake = bikeHarness(15);
  handbrake.controller.keys.up = true;
  for (let i = 0; i < 150; i++) handbrake.controller.updateCyclist(1 / 60);
  assert.equal(handbrake.cyclist.speed, 0, 'Space handbrake stops at zero and never reverses');
  assert.ok(handbrake.cyclist.position.z < 11.5, 'Space handbrake stops crisply from high speed');

  // Wall-blocked cyclist clamps phantom speed so braking/reversing away works immediately
  const blocked = bikeHarness(0, [{ minX: -10, maxX: 10, minZ: 0.5, maxZ: 10, maxY: 30 }]);
  blocked.controller.keys.forward = true;
  for (let i = 0; i < 120; i++) blocked.controller.updateCyclist(1 / 60);
  assert.ok(blocked.cyclist.speed < 0.05, `wall-blocked cyclist clamps phantom speed (got ${blocked.cyclist.speed})`);
});
