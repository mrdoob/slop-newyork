import assert from 'node:assert/strict';
import test from 'node:test';
import { minAreaRect, convexHull } from '../tools/tepic-lib.mjs';

// world = c + R_y(th)·local (x' = cs·x + sn·z, z' = -sn·x + cs·z), as buildings.js places the houses
const place = (cx, cz, th, pts) => pts.map(([x, z]) => [cx + Math.cos(th) * x + Math.sin(th) * z, cz - Math.sin(th) * x + Math.cos(th) * z]);

test('a turned rectangular footprint comes back as the same oriented box', () => {
  for (const th of [0, 0.3, -0.6, 1.2, Math.PI / 4]) {
    const ring = place(12, -7, th, [[-6, -2.5], [6, -2.5], [6, 2.5], [-6, 2.5]]);
    const r = minAreaRect(ring);
    assert.ok(Math.abs(r.area - 60) < 1e-6);
    assert.ok(Math.abs(r.cx - 12) < 1e-6 && Math.abs(r.cz + 7) < 1e-6);
    assert.ok(r.th > -Math.PI / 4 - 1e-9 && r.th <= Math.PI / 4 + 1e-9, 'turn folded into a quarter');
    // the box's corners are the footprint's corners
    const corners = place(r.cx, r.cz, r.th, [[-r.w / 2, -r.d / 2], [r.w / 2, -r.d / 2], [r.w / 2, r.d / 2], [-r.w / 2, r.d / 2]]);
    for (const [x, z] of ring) assert.ok(corners.some(([a, b]) => Math.hypot(a - x, b - z) < 1e-6));
  }
});

test('an L-shaped footprint gets the smallest box around it', () => {
  const r = minAreaRect([[0, 0], [10, 0], [10, 4], [4, 4], [4, 9], [0, 9]]);
  assert.ok(Math.abs(r.area - 90) < 1e-6);
  assert.equal(convexHull([[0, 0], [1, 1], [2, 2]]).length, 2, 'collinear points have no area');
  assert.equal(minAreaRect([[0, 0], [1, 1], [2, 2]]), null);
});
