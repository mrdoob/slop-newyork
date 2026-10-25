import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSpec, gearRatios, torqueAt, wheelRpm, gearTopSpeed, createDriveState, stepDrive, gearLabel
} from '../js/player/drivetrain.js';
import { CAR_MODELS, CAR_MODEL_BY_ID } from '../js/models/cars/index.js';

const DT = 1 / 60;
const spec = (id) => buildSpec(CAR_MODEL_BY_ID[id]);

// Full throttle from a standstill for `seconds`; the speed and drive state at the end, and when it passed 100 km/h
function launch(s, seconds, input = {}) {
  const d = createDriveState(s);
  let v = 0, t = 0, to100 = null;
  const gears = [];
  while (t < seconds) {
    v = stepDrive(d, s, { throttle: 1, power: 1, ...input }, v, DT);
    t += DT;
    if (to100 === null && v >= 100 / 3.6) to100 = t;
    if (gears[gears.length - 1] !== d.gear) gears.push(d.gear);
  }
  return { d, v, to100, gears };
}

test('every car model tops out at its maker\'s top speed and pulls away plausibly', () => {
  for (const m of CAR_MODELS) {
    const { d, v, to100 } = launch(buildSpec(m), 90);
    const top = v * 3.6;
    assert.ok(Math.abs(top - m.top) <= m.top * 0.03, `${m.id} tops out at ${top.toFixed(0)} km/h, not ${m.top}`);
    assert.ok(to100 > 2.5 && to100 < 16, `${m.id} 0-100 km/h in ${to100}s`);
    assert.ok(d.rpm <= m.redline);
  }
});

test('the fast ones are fast and the slow ones slow', () => {
  const time = (id) => launch(spec(id), 20).to100;
  assert.ok(time('lamborghini-huracan') < time('ford-mustang-gt'));
  assert.ok(time('tesla-model-3') < time('ford-mustang-gt'));
  assert.ok(time('ford-mustang-gt') < time('nissan-versa'));
  assert.ok(time('nissan-versa') < time('toyota-hiace'));
});

test('a combustion car shifts up through its gears; an electric one stays in D', () => {
  const versa = launch(spec('nissan-versa'), 40);
  assert.deepEqual(versa.gears, [1, 2, 3, 4, 5]);
  const tesla = launch(spec('tesla-model-3'), 40);
  assert.deepEqual(tesla.gears, [1]);
  assert.equal(gearLabel(tesla.d, spec('tesla-model-3')), 'D');
  assert.equal(gearLabel(versa.d, spec('nissan-versa')), '5');
});

test('a limited car stops pulling at its limiter', () => {
  const s = spec('ford-mustang-gt');
  assert.equal(s.vmax * 3.6, 250);
  const { v } = launch(s, 90);
  assert.ok(v * 3.6 <= 250.5);
});

test('nitro adds power while it lasts, then refills', () => {
  const s = spec('nissan-sentra');
  // (from 60 km/h: below that a front-drive car can't put more power down anyway)
  const run = (nitro) => {
    const d = createDriveState(s);
    d.gear = 3;
    let v = 60 / 3.6;
    for (let t = 0; t < 6; t += DT) v = stepDrive(d, s, { throttle: 1, nitro, power: 1 }, v, DT);
    return { v, d };
  };
  const plain = run(false);
  const nitro = run(true);
  assert.ok(nitro.v > plain.v + 2, 'faster with nitro');
  assert.ok(nitro.d.nitro < 0.01, 'the tank empties in ~4 s');
  const d = nitro.d;
  stepDrive(d, s, { throttle: 1, nitro: false, power: 1 }, 30, 1);
  assert.ok(d.nitro > 0 && d.nitro < 0.1, 'and refills slowly off it');
});

test('S brakes a moving car, then reverses it from a standstill; W brings it back into first', () => {
  const s = spec('nissan-tsuru');
  const d = createDriveState(s);
  d.gear = 3;
  let v = 100 / 3.6, distance = 0;
  while (v > 0) {
    v = stepDrive(d, s, { brake: 1, power: 1 }, v, DT);
    distance += v * DT;
    if (v > 0.6) assert.notEqual(d.gear, -1, 'no reverse while still rolling forward');
  }
  assert.ok(distance > 35 && distance < 55, `100-0 km/h in ${distance} m`);
  for (let i = 0; i < 60; i++) v = stepDrive(d, s, { brake: 1, power: 1 }, v, DT);
  assert.equal(d.gear, -1);
  assert.equal(gearLabel(d), 'R');
  assert.ok(v < -2, 'backing up');
  for (let i = 0; i < 120; i++) v = stepDrive(d, s, { throttle: 1, power: 1 }, v, DT);
  assert.equal(d.gear, 1);
  assert.ok(v > 0);
});

test('an electric car slows itself off the throttle (regenerative braking)', () => {
  const tesla = spec('tesla-model-3'), versa = spec('nissan-versa');
  const coast = (s) => {
    const d = createDriveState(s);
    let v = 20;
    for (let i = 0; i < 120; i++) v = stepDrive(d, s, { power: 1 }, v, DT);
    return v;
  };
  assert.ok(coast(tesla) < coast(versa) - 1);
});

test('the rev limiter cuts the drive at the redline in a held gear', () => {
  const s = spec('nissan-tsuru');
  const d = createDriveState(s);
  d.manual = true;
  let v = 0;
  for (let i = 0; i < 600; i++) v = stepDrive(d, s, { throttle: 1, power: 1 }, v, DT);
  assert.equal(d.gear, 1, 'a manual gearbox stays in its gear');
  assert.ok(d.limiter);
  assert.ok(Math.abs(v - gearTopSpeed(s, 1)) < 0.6, 'first gear tops out at its redline');
});

test('manual shifts go one gear at a time and refuse a downshift that would over-rev the engine', () => {
  const s = spec('nissan-sentra');
  const d = createDriveState(s);
  d.gear = 4;
  const v = gearTopSpeed(s, 3) * 0.75;
  stepDrive(d, s, { throttle: 1, shift: -1, power: 1 }, v, DT);
  assert.equal(d.manual, true, 'shifting by hand selects the manual gearbox');
  assert.equal(d.gear, 3);
  d.shift = d.lock = 0;
  stepDrive(d, s, { throttle: 1, shift: -1, power: 1 }, v, DT);
  assert.equal(d.gear, 3, 'second would be far past the redline');
  assert.ok(wheelRpm(s, 2, v) > s.redline);
  stepDrive(d, s, { throttle: 1, shift: 1, power: 1 }, v, DT);
  assert.equal(d.gear, 4);
});

test('a dead engine drives nothing; a parked car holds on a hill', () => {
  const s = spec('nissan-x-trail');
  assert.equal(stepDrive(createDriveState(s), s, { throttle: 1, power: 0 }, 0, 0.5), 0);
  assert.equal(stepDrive(createDriveState(s), s, { slope: -1.5, power: 1 }, 0, 0.5), 0);
  assert.ok(stepDrive(createDriveState(s), s, { slope: -1.5, power: 1 }, 5, 0.5) < 5, 'but rolls back once moving uphill');
});

test('gearboxes and torque curves come out of the data sheet', () => {
  for (const n of [5, 6, 8, 10]) {
    const r = gearRatios(n);
    assert.equal(r.length, n);
    for (let i = 1; i < n; i++) assert.ok(r[i] < r[i - 1]);
  }
  const versa = spec('nissan-versa');
  assert.equal(torqueAt(versa, 4000), 154, 'peak torque at its rpm');
  const ev = spec('tesla-model-3');
  assert.equal(torqueAt(ev, 0), 660, 'an electric motor: full torque from standstill');
  assert.ok(torqueAt(ev, 15000) < 300);
});

test('the registry: unique ids, sensible figures', () => {
  assert.ok(CAR_MODELS.length >= 50);
  assert.equal(new Set(CAR_MODELS.map((m) => m.id)).size, CAR_MODELS.length);
  for (const m of CAR_MODELS) {
    assert.equal(m.size.length, 3);
    assert.ok(m.mass > 800 && m.mass < 3500 && m.top >= 120 && m.top <= 350, m.id);
    assert.ok(['fwd', 'rwd', 'awd'].includes(m.drive), m.id);
  }
});

test('the Italika motos top out at their own speeds', async () => {
  const { MOTO_MODELS, PLAYER_MOTO } = await import('../js/models/motos/index.js');
  assert.equal(PLAYER_MOTO.id, 'italika-ft150');
  for (const m of MOTO_MODELS) {
    const top = launch(buildSpec(m), 60).v * 3.6;
    assert.ok(Math.abs(top - m.top) <= m.top * 0.03, `${m.id} tops out at ${top.toFixed(0)} km/h, not ${m.top}`);
  }
});

test('on a wet road a car stops in a longer distance and puts down less power', () => {
  const s = spec('nissan-versa');
  const stopping = (grip) => {
    const d = createDriveState(s);
    let v = 20, x = 0;
    while (v > 0.05) {
      v = stepDrive(d, s, { brake: 1, power: 1, grip }, v, DT);
      x += v * DT;
    }
    return x;
  };
  const dry = stopping(1), wet = stopping(0.7);
  assert.ok(wet > dry * 1.25 && wet < dry * 1.6, `from 72 km/h: ${dry.toFixed(1)} m dry, ${wet.toFixed(1)} m wet`);
  const fast = spec(CAR_MODELS.reduce((a, m) => (m.power[0] > a.power[0] ? m : a)).id);
  const d = createDriveState(fast);
  stepDrive(d, fast, { throttle: 1, power: 1, grip: 0.7 }, 1, DT);
  assert.equal(d.wheelspin, true, 'the most powerful car spins its tyres pulling away in the wet');
});
