import assert from 'node:assert/strict';
import test from 'node:test';
import { Wanted, STAR_HEAT, POLICE, GANGS, gangTurf, evadeTime, starsFor } from '../js/sim/crime-rules.js';

test('running people over brings the police: a star at once, two by the third', () => {
  const w = new Wanted();
  assert.equal(w.report('runOver'), 1);
  assert.equal(w.stars, 1);
  w.report('runOver');
  assert.equal(w.stars, 1);
  w.report('runOver');
  assert.equal(w.stars, 2);
  assert.ok(POLICE.cruisers[w.stars] > 0, 'patrol cars come at two stars');
});

test('unwitnessed crimes and unknown ones add nothing', () => {
  const w = new Wanted();
  assert.equal(w.report('gunfire', false), 0);
  assert.equal(w.report('jaywalking'), 0);
  assert.equal(w.heat, 0);
});

test('killing a cop is two stars, and the stars top out at five', () => {
  const w = new Wanted();
  w.report('killCop');
  assert.equal(w.stars, 3);
  for (let i = 0; i < 20; i++) w.report('killCop');
  assert.equal(w.stars, 5);
  assert.equal(starsFor(1e9), 5);
});

test('stars stay while the police see the player and drop one at a time out of sight', () => {
  const w = new Wanted();
  w.report('killCop'); // 3 stars
  for (let t = 0; t < 120; t += 0.1) w.update(0.1, true);
  assert.equal(w.stars, 3, 'seen: no star is lost');
  for (let t = 0; t < evadeTime(3) - 0.5; t += 0.1) w.update(0.1, false);
  assert.equal(w.stars, 3);
  assert.ok(w.evading > 0.9);
  w.update(1, false);
  assert.equal(w.stars, 2);
  assert.equal(w.heat, STAR_HEAT[2]);
  for (let t = 0; t < 60; t += 0.1) w.update(0.1, false);
  assert.equal(w.stars, 0);
});

test('the gangs hold turf away from the town centre, deterministically', () => {
  assert.equal(gangTurf(0, 0), -1, 'the plaza is nobody\'s');
  let rojos = 0, verdes = 0;
  for (let x = -23 * 260; x < 6000; x += 260) {
    for (let z = -23 * 260; z < 6000; z += 260) {
      const g = gangTurf(x + 1, z + 1);
      if (Math.hypot(x, z) < 700) continue; // (the centre's edge cuts squares)
      assert.equal(g, gangTurf(x + 100, z + 100), 'the same square, the same gang');
      if (g === 0) rojos++;
      if (g === 1) verdes++;
    }
  }
  assert.ok(rojos > 150 && verdes > 150, `${rojos} / ${verdes} squares`);
  assert.equal(GANGS.length, 2);
  assert.ok(GANGS[0].hostile && !GANGS[1].hostile);
});
