import assert from 'node:assert/strict';
import test from 'node:test';
import { GEO } from '../js/world/city-geodata.js';
import { SLOPES, createGround, groundHeight, hillGround, townHeight } from '../js/world/ground.js';

// A grid as the builder writes it: heights in dm, Int16 little-endian, base64
function grid(heightsM, w, extra = {}) {
  const dm = Int16Array.from(heightsM, (m) => Math.round(m * 10));
  return { x0: 0, z0: 0, cell: 10, w, h: heightsM.length / w, data: Buffer.from(dm.buffer).toString('base64'), ...extra };
}

// The town rising 1 m per 10 m east and 0.5 m per 10 m south: a plane, which the triangles reproduce exactly
const ramp = [];
for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) ramp.push(i + j * 0.5);
const geo = { terrain: grid(new Array(16).fill(0).map((_, k) => (k === 5 ? 3 : 0)), 4), ground: grid(ramp, 4, { datum: 900, floor: 7 }) };

test('without ?slopes the ground is the hills over the flat city, as before', () => {
  assert.equal(SLOPES, false);
  assert.equal(groundHeight, hillGround);
  assert.equal(townHeight(0, 0), 0);
  const flat = createGround(geo);
  assert.equal(flat.slopes, false);
  assert.equal(flat.groundHeight, flat.hillGround);
  assert.equal(flat.townHeight(15, 15), 0);
  // the hills: the raised node, sunk under the streets, and 0 where they're flat or beyond the grid
  assert.equal(flat.terrainHeight(10, 10), 3);
  assert.equal(flat.hillGround(10, 10), 3 - 0.08);
  assert.equal(flat.hillGround(25, 25), 0);
  assert.equal(flat.hillGround(-5, 10), 0);
});

test('with slopes the town floor is interpolated on the grid and the hills stand on it', () => {
  const g = createGround(geo, { slopes: true });
  assert.equal(g.slopes, true);
  assert.equal(g.datum, 900);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} should equal ${b}`);
  for (const [x, z] of [[0, 0], [10, 0], [12.5, 7.5], [27, 21], [29.9, 29.9]]) close(g.townHeight(x, z), x / 10 + z / 20);
  // beyond the grid: the floor away from town
  assert.equal(g.townHeight(-1, 5), 7);
  assert.equal(g.townHeight(5, 31), 7);
  close(g.groundHeight(10, 10), 1.5 + 3 - 0.08);
  close(g.groundHeight(25, 5), 2.75);
  const out = [0, 0];
  assert.equal(g.groundSlope(15, 22, out), out);
  close(out[0], 0.1);
  close(out[1], 0.05);
});

test("Tepic's ground: the datum is the town's lowest point and its streets climb as the city does", () => {
  const g = createGround(GEO, { slopes: true });
  const G = GEO.ground;
  assert.ok(G.datum > 700 && G.datum < 1000, `datum ${G.datum} m a.s.l.`);
  // no street of the detailed city under the datum
  const { box } = GEO.frame;
  const nodes = GEO.roadGraph.nodes;
  let low = Infinity;
  for (let i = 0; i < nodes.length; i += 2) {
    const x = nodes[i], z = nodes[i + 1];
    if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1) low = Math.min(low, g.townHeight(x, z));
  }
  assert.ok(low > -1 && low < 5, `lowest street ${low} m`);
  // the centro sits ~930 m a.s.l. and Xalisco, 7 km south, some 65 m higher
  const at = (id) => g.townHeight(GEO.teleports[id].x, GEO.teleports[id].z);
  const plaza = at('plaza') + G.datum, xalisco = at('xalisco') + G.datum;
  assert.ok(plaza > 900 && plaza < 960, `plaza ${plaza} m a.s.l.`);
  assert.ok(xalisco - plaza > 30 && xalisco - plaza < 100, `Xalisco ${xalisco - plaza} m over the plaza`);
  // a smooth floor: no step over 2 m between neighbouring 25 m cells along the centro's streets
  for (let x = -1000; x < 1000; x += 25) {
    assert.ok(Math.abs(g.townHeight(x + 25, 0) - g.townHeight(x, 0)) < 2);
  }
});
