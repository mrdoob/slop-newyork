import assert from 'node:assert/strict';
import test from 'node:test';
import { cyclewayRuns, medianTrees, nearestOn } from '../js/world/medians.js';

// Two one-way carriageways 7 m wide, 31 m apart centre to centre, running opposite ways along x for 400 m
const roads = [
  ['Periférico Libramiento', 7, 'FT', 2, 1, [0, 0, 400, 0]],
  ['Periférico Libramiento de Tepic', 7, 'FT', 2, 1, [400, 31, 0, 31]],
  ['Calle Laurel', 7, 'TW', 1, 0, [200, -50, 200, 80]]
];

test('the nearest point on a polyline', () => {
  const q = nearestOn([0, 0, 10, 0, 10, 10], 12, 5);
  assert.equal(q.d, 2);
  assert.deepEqual([q.x, q.z, q.tx, q.tz], [10, 5, 0, 1]);
});

test('the cycleway runs down the middle of the median, once, broken where a street crosses it', () => {
  const crossing = (x) => Math.abs(x - 200) < 6;
  const runs = cyclewayRuns(roads, { inMedian: (x) => !crossing(x) });
  assert.equal(runs.length, 2, 'either side of the cross street');
  for (const run of runs) {
    for (const p of run) {
      assert.ok(Math.abs(p.z - 15.5) < 1e-9, 'halfway between the carriageways');
      assert.ok(Math.abs(Math.abs(p.tx) - 1) < 1e-9);
      assert.ok(Math.abs(p.half - 12) < 1e-9, '31 / 2 less half of 7 m');
      assert.ok(!crossing(p.x));
    }
  }
  assert.deepEqual(cyclewayRuns(roads, { match: /Insurgentes/ }), []);
});

test('trees line the path in rows that keep clear of the curbs', () => {
  const runs = cyclewayRuns(roads);
  const trees = medianTrees(runs);
  assert.ok(trees.length > 120);
  for (const t of trees) {
    const off = Math.abs(t.z - 15.5);
    assert.ok(off > 4 && off < 10, `a tree ${off} m off the path's centre`);
  }
});
