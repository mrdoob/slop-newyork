import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Stamina, struckDamage, hardness, crashDamage, walletAmount, nearest, MAX_STAMINA, WINDED_UNTIL
} from '../js/player/stats.js';

const run = (stamina, seconds, sprinting = null, step = 0.05) => {
  for (let t = 0; t < seconds - 1e-9; t += step) stamina.update(step, sprinting);
};

test('a vehicle driving into the player hurts by its speed and its share of the masses', () => {
  assert.equal(struckDamage(2, 1300), 0, 'a nudge is harmless');
  assert.equal(struckDamage(-5, 1300), 0);
  const car30 = struckDamage(30 / 3.6, 1300);
  assert.ok(car30 > 30 && car30 < 50, `a car at 30 km/h takes ${car30}`);
  assert.ok(struckDamage(50 / 3.6, 1300) < 100, 'a car at 50 km/h leaves you standing');
  assert.ok(struckDamage(65 / 3.6, 1300) >= 100, 'a car at 65 km/h kills');
  assert.ok(struckDamage(8, 95) < struckDamage(8, 1300) * 0.6, 'a bicycle hurts much less than a car');
});

test('crashes hurt by mode and by what was hit', () => {
  assert.equal(crashDamage('car', 10, 1), 0, 'a car shrugs off a town-speed bump');
  assert.ok(crashDamage('car', 25, 1, 'building') > 50);
  assert.ok(crashDamage('cyclist', 10, 1) > crashDamage('car', 10, 1));
  assert.ok(crashDamage('moto', 15, 1) > 0 && crashDamage('moto', 6, 1) === 0);
  assert.ok(crashDamage('helicopter', 10, 1, 'ground') > crashDamage('helicopter', 10, 1, 'building'));
  assert.equal(crashDamage('person', 20, 1), 0);
  assert.equal(hardness('building', null), 1);
  assert.equal(hardness('vehicle', { rig: {} }), 0, 'a car hardly feels a pedestrian');
  assert.ok(hardness('vehicle', { bike: true, bodyType: 'bike' }) < hardness('vehicle', { bodyType: 'sedan' }));
  assert.ok(hardness('vehicle', { bus: true }) > 1);
  assert.equal(crashDamage('car', 30, hardness('vehicle', { rig: {} })), 0);
});

test('sprinting runs the stamina down; empty, no sprint until it is back to WINDED_UNTIL', () => {
  const s = new Stamina();
  run(s, 5, 'person');
  assert.ok(s.value < MAX_STAMINA && s.value > 0 && s.canSprint);
  run(s, 4.15, 'person');
  assert.equal(s.value, 0);
  assert.equal(s.canSprint, false);
  // out of breath, holding shift no longer sprints (controllers.js), so it doesn't count as sprinting either
  run(s, 0.8 + (WINDED_UNTIL - 5) / 18);
  assert.ok(s.value > 0 && s.value < WINDED_UNTIL);
  assert.equal(s.canSprint, false);
  run(s, 0.5);
  assert.equal(s.canSprint, true);
  run(s, 10);
  assert.equal(s.value, MAX_STAMINA);
  const runner = new Stamina();
  const bike = new Stamina();
  const moto = new Stamina();
  run(runner, 5, 'person');
  run(bike, 5, 'cyclist');
  run(moto, 5, 'moto');
  assert.ok(bike.value > runner.value, 'a bicycle tires more slowly than running');
  assert.equal(moto.value, MAX_STAMINA, 'the motors do not tire');
  runner.reset();
  assert.equal(runner.value, MAX_STAMINA);
});

test('wallets and the nearest hospital', () => {
  assert.equal(walletAmount(() => 0), 5);
  assert.equal(walletAmount(() => 0.999999), 120);
  for (let i = 0; i < 200; i++) assert.equal(walletAmount() % 5, 0);
  const places = [{ name: 'a', x: 0, z: 0 }, { name: 'b', x: 100, z: 0 }, { name: 'c', x: 0, z: -60 }];
  assert.equal(nearest(places, 70, 5).name, 'b');
  assert.equal(nearest(places, 5, -40).name, 'c');
  assert.equal(nearest([], 0, 0), null);
});
