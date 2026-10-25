import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PlayerStats, struckDamage, hardness, crashDamage, walletAmount, nearest,
  MAX_HEALTH, MAX_STAMINA, REGEN_CAP, START_MONEY, HOSPITAL_BILL, WASTED_TIME, WINDED_UNTIL
} from '../js/player/stats.js';

const run = (stats, seconds, sprinting = null, step = 0.05) => {
  let result = null;
  for (let t = 0; t < seconds - 1e-9; t += step) result = stats.update(step, sprinting) || result;
  return result;
};

test('a vehicle driving into the player hurts by its speed and its share of the masses', () => {
  assert.equal(struckDamage(2, 1300), 0, 'a nudge is harmless');
  assert.equal(struckDamage(-5, 1300), 0);
  const car30 = struckDamage(30 / 3.6, 1300);
  assert.ok(car30 > 30 && car30 < 50, `a car at 30 km/h takes ${car30}`);
  assert.ok(struckDamage(50 / 3.6, 1300) < MAX_HEALTH, 'a car at 50 km/h leaves you standing');
  assert.ok(struckDamage(65 / 3.6, 1300) >= MAX_HEALTH, 'a car at 65 km/h kills');
  assert.ok(struckDamage(8, 95) < struckDamage(8, 1300) * 0.6, 'a bicycle hurts much less than a car');
});

test('crashes hurt by mode and by what was hit', () => {
  assert.equal(crashDamage('car', 10, 1), 0, 'a car shrugs off a town-speed bump');
  assert.ok(crashDamage('car', 25, 1, 'building') > 25);
  assert.ok(crashDamage('cyclist', 10, 1) > crashDamage('car', 10, 1));
  assert.ok(crashDamage('helicopter', 10, 1, 'ground') > crashDamage('helicopter', 10, 1, 'building'));
  assert.equal(crashDamage('person', 20, 1), 0);
  assert.equal(hardness('building', null), 1);
  assert.equal(hardness('vehicle', { rig: {} }), 0, 'a car hardly feels a pedestrian');
  assert.ok(hardness('vehicle', { bike: true, bodyType: 'bike' }) < hardness('vehicle', { bodyType: 'sedan' }));
  assert.ok(hardness('vehicle', { bus: true }) > 1);
  assert.equal(crashDamage('car', 30, hardness('vehicle', { rig: {} })), 0);
});

test('health comes back by itself, quickly to half and slowly beyond', () => {
  const s = new PlayerStats();
  assert.equal(s.hurt(80), 80);
  assert.equal(s.health, 20);
  run(s, 4);
  assert.equal(s.health, 20, 'nothing comes back right after a hit');
  run(s, 20);
  assert.ok(s.health >= REGEN_CAP && s.health < REGEN_CAP + 10, `fast up to half: ${s.health}`);
  run(s, 200);
  assert.equal(s.health, MAX_HEALTH);
});

test('one crash reporting several contacts hurts once', () => {
  const s = new PlayerStats();
  s.hurt(10);
  assert.equal(s.hurt(10), 0);
  run(s, 0.5);
  assert.equal(s.hurt(10), 10);
  assert.equal(s.health, 80);
});

test('sprinting runs the stamina down; empty, no sprint until it is back to WINDED_UNTIL', () => {
  const s = new PlayerStats();
  run(s, 5, 'person');
  assert.ok(s.stamina < MAX_STAMINA && s.stamina > 0 && s.canSprint);
  run(s, 4.15, 'person');
  assert.equal(s.stamina, 0);
  assert.equal(s.canSprint, false);
  // out of breath, holding shift no longer sprints (controllers.js), so it doesn't count as sprinting either
  run(s, 0.8 + (WINDED_UNTIL - 5) / 18);
  assert.ok(s.stamina > 0 && s.stamina < WINDED_UNTIL);
  assert.equal(s.canSprint, false);
  run(s, 0.5);
  assert.equal(s.canSprint, true);
  run(s, 10);
  assert.equal(s.stamina, MAX_STAMINA);
  const runner = new PlayerStats();
  const bike = new PlayerStats();
  const car = new PlayerStats();
  run(runner, 5, 'person');
  run(bike, 5, 'cyclist');
  run(car, 5, 'car');
  assert.ok(bike.stamina > runner.stamina, 'a bicycle tires more slowly than running');
  assert.equal(car.stamina, MAX_STAMINA, 'the motors do not tire');
});

test('wasted, then up at the hospital less the bill', () => {
  const s = new PlayerStats({ money: 1500 });
  s.hurt(MAX_HEALTH + 50);
  assert.equal(s.health, 0);
  assert.equal(s.alive, false);
  assert.equal(s.canSprint, false);
  assert.equal(s.hurt(10), 0, 'nothing more happens to the wasted');
  assert.equal(run(s, WASTED_TIME - 0.5), null);
  assert.equal(run(s, 1), 'respawn');
  assert.equal(s.respawn(), HOSPITAL_BILL);
  assert.equal(s.money, 1500 - HOSPITAL_BILL);
  assert.equal(s.health, MAX_HEALTH);
  assert.equal(s.alive, true);
  const broke = new PlayerStats({ money: 120 });
  broke.hurt(MAX_HEALTH);
  assert.equal(broke.respawn(), 120, 'the hospital takes what there is');
  assert.equal(broke.money, 0);
});

test('money: saved amounts, earnings, wallets', () => {
  assert.equal(new PlayerStats().money, START_MONEY);
  assert.equal(new PlayerStats({ money: undefined }).money, START_MONEY);
  assert.equal(new PlayerStats({ money: 'x' }).money, START_MONEY);
  assert.equal(new PlayerStats({ money: -5 }).money, 0);
  const s = new PlayerStats({ money: 0 });
  s.earn(120.4);
  s.earn(-50);
  assert.equal(s.money, 120);
  assert.equal(walletAmount(() => 0), 20);
  assert.equal(walletAmount(() => 0.999999), 500);
  for (let i = 0; i < 200; i++) assert.equal(walletAmount() % 10, 0);
});

test('nearest picks the closest place', () => {
  const places = [{ name: 'a', x: 0, z: 0 }, { name: 'b', x: 100, z: 0 }, { name: 'c', x: 0, z: -60 }];
  assert.equal(nearest(places, 70, 5).name, 'b');
  assert.equal(nearest(places, 5, -40).name, 'c');
  assert.equal(nearest([], 0, 0), null);
});
