import assert from 'node:assert/strict';
import test from 'node:test';
import { FloodLevel, rainRate, riverStage, hollows, lowness, floodDepth, riverSpill } from '../js/world/flood-model.js';

test('a storm past the drains raises the water, dry weather takes it away', () => {
  const f = new FloodLevel();
  f.update(1, { rainRate: 0, recentRain: 0 });
  assert.equal(f.level, 0);
  // light rain never floods
  for (let i = 0; i < 3600; i++) f.update(1, { rainRate: 5 });
  assert.equal(f.level, 0);
  // an hour of a 30 mm/h storm: 22 mm past the drains
  for (let i = 0; i < 3600; i++) f.update(1, { rainRate: 30 });
  assert.ok(Math.abs(f.level - 22 / 45) < 1e-6, f.level);
  for (let i = 0; i < 3 * 3600; i++) f.update(1, { rainRate: 0 });
  assert.equal(f.level, 0);
  // a thunderstorm code with no rate measured still rains hard
  assert.equal(rainRate({ code: 95, rainRate: 0 }), 28);
});

test('the past hours of rain may have left water standing, and ?flood= holds it', () => {
  const f = new FloodLevel();
  f.update(1, { rainRate: 0, recentRain: 60 });
  assert.ok(f.level > 0.9 && f.level < 1);
  f.hold(0.7);
  f.update(100, { rainRate: 0 });
  assert.equal(f.level, 0.7);
});

test('the hollows fill to their rim, open ground drains off the edge', () => {
  // a 5 x 5 grid, flat at 10 m, with a 1 m pit in the middle and a 0.4 m one beside it
  const n = 5;
  const h = new Float32Array(n * n).fill(10);
  h[12] = 9;
  h[13] = 9.6;
  const d = hollows(h, n);
  assert.ok(Math.abs(d[12] - 1) < 1e-6 && Math.abs(d[13] - 0.4) < 1e-6);
  assert.equal(d[0], 0);
  // a cell under the mean round it is low ground
  assert.ok(lowness(h, n, 1)[12] > 0.1);
  assert.ok(lowness(h, n, 1)[0] < 0.1);
});

test('the depth grows with the level and the river spills over its banks', () => {
  assert.equal(floodDepth(1, 0, 0), 0);
  assert.ok(floodDepth(1, 0, 0.3) > 0.4 && floodDepth(1, 0, 0.3) < 1);
  assert.equal(floodDepth(1, 0, 0.7), 1);
  assert.ok(Math.abs(floodDepth(0, 3, 1) - 0.5) < 1e-9, 'the valley floor stands in half the level');
  assert.equal(riverSpill(riverStage(0.5), 0, 10), 0, 'still inside its channel');
  assert.ok(riverSpill(riverStage(1.2), 0.5, 20) > 1);
  assert.equal(riverSpill(riverStage(1.2), 0.5, 400), 0);
});
