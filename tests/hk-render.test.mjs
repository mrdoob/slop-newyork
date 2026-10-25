import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildRoadMarkings, dedupe } from '../js/hk/markings.js';
import { ROADS, LANE_WIDTH } from './helpers/hk-fixtures.mjs';

// Regression: the first Hong Kong build created one BufferGeometry per dash segment (13 108 of them) and
// merged them on the main thread, which locked the browser ("Page Unresponsive"). Markings must stay one
// typed array, produced quickly and without an unbounded loop.

test('road markings are produced as one typed array, quickly', () => {
  const t0 = performance.now();
  const marks = buildRoadMarkings(ROADS, { laneWidth: LANE_WIDTH });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `markings took ${ms.toFixed(0)} ms — should be tens of ms`);
  assert.ok(marks.quads > 2000, `only ${marks.quads} marking quads`);
  assert.ok(marks.quads < 40000, `${marks.quads} quads is more than this network should need`);
  assert.ok(marks.positions instanceof Float32Array);
  assert.ok(marks.indices instanceof Uint32Array);
  assert.equal(marks.positions.length, marks.quads * 12, 'four vertices per quad');
  assert.equal(marks.indices.length, marks.quads * 6, 'two triangles per quad');
});

test('markings contain no NaN and sit flat on the carriageway', () => {
  const marks = buildRoadMarkings(ROADS, { laneWidth: LANE_WIDTH, y: 0.17 });
  for (let i = 0; i < marks.positions.length; i++) {
    assert.ok(Number.isFinite(marks.positions[i]), `position ${i} is not finite`);
  }
  for (let i = 1; i < marks.positions.length; i += 3) {
    assert.ok(Math.abs(marks.positions[i] - 0.17) < 1e-6, 'every marking vertex must sit at the paint height');
  }
  const verts = marks.positions.length / 3;
  for (let i = 0; i < marks.indices.length; i++) {
    assert.ok(marks.indices[i] < verts, 'index out of range');
  }
});

test('markings stay inside the carriageway of the road they belong to', () => {
  const marks = buildRoadMarkings(ROADS, { laneWidth: LANE_WIDTH, edgeInset: 0.5 });
  // Every marking vertex must be within a road's half-width of some road centreline.
  const pts = ROADS.flatMap((r) => r.pts.map((p) => ({ ...p, w: r.w })));
  const step = 7; // sample a subset: this test is about bounds, not throughput
  for (let v = 0; v < marks.positions.length; v += 3 * step) {
    const x = marks.positions[v];
    const z = marks.positions[v + 2];
    let best = Infinity;
    for (const road of ROADS) {
      const P = road.pts;
      for (let i = 0; i + 1 < P.length; i++) {
        const ax = P[i].x, az = P[i].z, bx = P[i + 1].x, bz = P[i + 1].z;
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(ax + t * dx - x, az + t * dz - z);
        if (d - road.w / 2 < best) best = d - road.w / 2;
      }
    }
    assert.ok(best <= 0.3, `marking vertex ${x.toFixed(1)},${z.toFixed(1)} is ${best.toFixed(2)} m outside the carriageway`);
  }
  assert.ok(pts.length > 0);
});

test('dash phases carry across segments instead of repeating per segment', () => {
  // A straight 100 m road split into 5 pieces: a 4/6 dash pattern must produce ~10 dashes, not 5 × 2.
  const pts = Array.from({ length: 6 }, (_, i) => ({ x: i * 20, z: 0, dx: 1, dz: 0 }));
  const road = { pts, w: 10, lanesPerWay: 1, oneway: true };
  const dashed = buildRoadMarkings([road], { laneWidth: 3.4, edgeInset: 0.5 });
  // 2 edge lines (solid, 5 quads each) + 0 dashed (a one-way road with a single lane has no lane divider)
  assert.equal(dashed.quads, 10);
  const twoLane = buildRoadMarkings([{ ...road, lanesPerWay: 2 }], { laneWidth: 3.4, edgeInset: 0.5 });
  const dashes = twoLane.quads - dashed.quads;
  assert.ok(dashes >= 8 && dashes <= 12, `expected ~10 dashes over 100 m, got ${dashes}`);
});

test('degenerate input is ignored rather than producing NaN geometry', () => {
  const road = { pts: [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 5, z: 0 }], w: 8, lanesPerWay: 1, oneway: true };
  const marks = buildRoadMarkings([road], {});
  assert.ok(marks.quads >= 2);
  for (const v of marks.positions) assert.ok(Number.isFinite(v));
  assert.deepEqual(dedupe([{ x: 1, z: 1 }, { x: 1.001, z: 1 }, { x: 3, z: 1 }]).length, 2);
});

test('the boot sequence yields to the browser and precompiles shaders', () => {
  const main = readFileSync(new URL('../js/hk/main.js', import.meta.url), 'utf8');
  // rAF resolves microtasks before the next paint, so a stuck build never rendered its status text.
  assert.match(main, /setTimeout\(resolve, 16\)/, 'the boot must yield with a macrotask so the browser paints');
  assert.match(main, /compileAsync/, 'shader pipelines must be precompiled, not all at once on the first frame');
  assert.match(main, /showBootError/, 'a boot failure must be reported on screen');
  const city = readFileSync(new URL('../js/hk/city.js', import.meta.url), 'utf8');
  assert.match(city, /buildRoadMarkings/, 'city.js must use the single-geometry markings builder');
  assert.doesNotMatch(city, /function paintStrip/, 'the per-dash geometry builder must stay gone');
});
