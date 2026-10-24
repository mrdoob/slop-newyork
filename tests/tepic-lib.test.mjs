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

test('an island ringing a road loop is cut open so its outline never covers the loop', async () => {
  const { extractBlocks, pointInRing } = await import('../tools/tepic-lib.mjs');
  const W = 80, H = 80;
  const land = new Uint8Array(W * H).fill(1);
  const road = (i, j) => { land[j * W + i] = 0; };
  for (let k = 0; k < W; k++) { road(k, 0); road(k, H - 1); road(0, k); road(W - 1, k); } // the streets around
  for (let k = 25; k <= 55; k++) for (let t = 0; t < 4; t++) { road(k, 25 + t); road(k, 52 + t); road(25 + t, k); road(52 + t, k); } // a loop inside
  const { blocks } = extractBlocks({ land, w: W, h: H, x0: 0, z0: 0, res: 1, sidewalk: 1, minArea: 10, lotArea: 1e9 });
  assert.ok(blocks.length >= 2, 'the ring and the island inside the loop');
  for (const b of blocks) {
    for (const [x, z] of [[26.5, 40.5], [53.5, 40.5], [40.5, 26.5], [40.5, 53.5]]) {
      assert.equal(pointInRing(x, z, b.poly), false, 'no outline covers the loop road');
    }
  }
});

test('large islands are labelled without a flood-fill stack', async () => {
  const { extractBlocks } = await import('../tools/tepic-lib.mjs');
  const W = 1200, H = 1200;
  const land = new Uint8Array(W * H).fill(1);
  for (let k = 0; k < W; k++) { land[k] = 0; land[(H - 1) * W + k] = 0; land[k * W] = 0; land[k * W + W - 1] = 0; }
  const { blocks } = extractBlocks({ land, w: W, h: H, x0: 0, z0: 0, res: 1, sidewalk: 2, minArea: 10, lotArea: 1e9 });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].cells, (W - 2) * (H - 2));
});
