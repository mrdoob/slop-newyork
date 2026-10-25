import assert from 'node:assert/strict';
import test from 'node:test';
import { indexHouses, openness, lotTrees, grassDryness, edgeDistance } from '../js/world/lot-greenery.js';

// A 60 x 40 m curb island with one 10 x 10 m house in its north-west corner (houses: x, z, w, d in dm, θ in mrad...)
const square = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const block = { poly: square(0, 0, 60, 40), minX: 0, maxX: 60, minZ: 0, maxZ: 40, area: 2400, park: 0, rural: false, median: false };
const houses = [100, 100, 100, 100, 0, 1, 0, 0];
const blockAt = (x, z) => (x >= 0 && x <= 60 && z >= 0 && z <= 40 ? block : null);

test('walls are measured from the house outline, zero inside', () => {
  const index = indexHouses(houses, 8);
  assert.equal(index.wallDistance(10, 10, 5), 0);
  assert.ok(Math.abs(index.wallDistance(18, 10, 20) - 3) < 1e-9);
  assert.equal(index.wallDistance(50, 30, 6), 6, 'nothing within reach');
});

test('openness is the share of the block inside the sidewalk band no house covers', () => {
  const open = openness([block], houses, blockAt, { stride: 8, sidewalk: 2 }).get(block);
  // 100 m2 built of 2400 - 200 x 2 = 2000 m2
  assert.ok(Math.abs(open - 0.95) < 1e-9);
  assert.equal(openness([block], [], blockAt).get(block), 1);
});

test('lot trees stay off the sidewalk band and clear of the walls', () => {
  const big = { ...block, poly: square(0, 0, 300, 200), maxX: 300, maxZ: 200, area: 60000 };
  const sites = lotTrees([big], houses, { stride: 8, sidewalk: 2.2 });
  assert.ok(sites.length > 20, 'a big lot gets trees');
  const index = indexHouses(houses, 8);
  for (const t of sites) {
    assert.ok(edgeDistance(t.x, t.z, big.poly) >= 5.2);
    assert.ok(index.wallDistance(t.x, t.z, 10) >= 2.4);
    assert.ok(t.species >= 0 && t.species <= 4);
  }
  // the edges of a lot are planted more thickly than the middle of the field
  const edge = sites.filter((t) => edgeDistance(t.x, t.z, big.poly) < 11).length;
  const middle = sites.length - edge;
  assert.ok(edge / 0.13 > middle / 0.87, `edge ${edge} vs middle ${middle}`);
  assert.deepEqual(lotTrees([{ ...big, park: 1 }], houses), [], 'parks are planted elsewhere');
});

test('the grass is driest before the rains and greenest in them', () => {
  assert.ok(grassDryness(4) > 0.9);
  assert.equal(grassDryness(8), 0);
  assert.equal(grassDryness(-4), grassDryness(8));
});
