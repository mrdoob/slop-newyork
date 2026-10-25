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

test('in the flat city (?slopes=0) the ground is the hills over it, as before', () => {
  // (the town is on its slopes by default)
  assert.equal(SLOPES, true);
  assert.notEqual(groundHeight, hillGround);
  assert.ok(townHeight(0, 0) > 50);
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

test('triangles cut along the lattice keep their area & winding, each piece on one ground triangle', async () => {
  const { clipToLattice } = await import('../js/world/ground.js');
  const lattice = { x0: -5, z0: 3, cell: 10 };
  // two big triangles (one indexed quad, counter-clockwise from above) with an attribute linear in x & z
  const pos = new Float32Array([-31, 0.2, -18, 44, 0.2, -9, 40, 0.2, 57, -26, 0.2, 51]);
  const att = new Float32Array([...[0, 1, 2, 3].map((i) => pos[i * 3] + 2 * pos[i * 3 + 2])]);
  const index = [0, 3, 2, 0, 2, 1];
  const [p, a] = clipToLattice([pos, att], [3, 1], index, lattice);
  assert.equal(p.length / 3, a.length);
  assert.ok(p.length / 9 > 60, `${p.length / 9} pieces`);
  const area = (ax, az, bx, bz, cx, cz) => ((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  const whole = area(-31, -18, -26, 51, 40, 57) + area(-31, -18, 40, 57, 44, -9);
  assert.ok(area(-31, -18, -26, 51, 40, 57) * area(-31, -18, 40, 57, 44, -9) > 0);
  let sum = 0;
  for (let t = 0; t < p.length; t += 9) {
    const s = area(p[t], p[t + 2], p[t + 3], p[t + 5], p[t + 6], p[t + 8]);
    assert.ok(s * Math.sign(whole) >= -1e-6, 'winding kept');
    sum += s;
    // one lattice triangle: every vertex within the same unit band of each family
    for (const f of [(x, z) => (x + 5) / 10, (x, z) => (z - 3) / 10, (x, z) => (x + 5 + z - 3) / 10]) {
      const cx = (p[t] + p[t + 3] + p[t + 6]) / 3, cz = (p[t + 2] + p[t + 5] + p[t + 8]) / 3;
      const band = Math.floor(f(cx, cz));
      for (let v = 0; v < 3; v++) {
        const sv = f(p[t + v * 3], p[t + v * 3 + 2]);
        assert.ok(sv >= band - 1e-4 && sv <= band + 1 + 1e-4);
      }
    }
    for (let v = 0; v < 3; v++) {
      assert.ok(Math.abs(a[t / 3 + v] - (p[t + v * 3] + 2 * p[t + v * 3 + 2])) < 1e-3, 'attributes interpolated');
      assert.ok(Math.abs(p[t + v * 3 + 1] - 0.2) < 1e-6);
    }
  }
  assert.ok(Math.abs(sum - whole) < 1e-2, `${sum} of ${whole} m²`);
  // a triangle inside one lattice triangle comes back whole
  const [q] = clipToLattice([new Float32Array([-4, 0, 4, 0, 0, 4, -4, 0, 8])], [3], null, lattice);
  assert.equal(q.length, 9);
});

test("the town's grid lies on the hills' lattice and meets the far floor at its edge", () => {
  const G = GEO.ground, T = GEO.terrain;
  // its cells halve the hills', on the same lines: every hill triangle is a whole number of town triangles
  assert.equal(T.cell % G.cell, 0);
  assert.equal((G.x0 - T.x0) % T.cell, 0);
  assert.equal((G.z0 - T.z0) % T.cell, 0);
  assert.equal(((G.w - 1) * G.cell) % T.cell, 0);
  assert.equal(((G.h - 1) * G.cell) % T.cell, 0);
  const g = createGround(GEO, { slopes: true });
  const x1 = G.x0 + (G.w - 1) * G.cell, z1 = G.z0 + (G.h - 1) * G.cell;
  // on the grid's border, and just beyond it, the floor the hills stand on
  for (const [x, z] of [[G.x0, G.z0 + 3000], [x1 - 0.01, G.z0 + 5000], [G.x0 + 4000, z1 - 0.01], [G.x0 - 50, 0], [0, z1 + 50]]) {
    assert.ok(Math.abs(g.townHeight(x, z) - G.floor) < 0.05, `${g.townHeight(x, z)} at (${x}, ${z})`);
  }
});

test("a bridge's deck holds what is on it and lets what passes under it through; a raised junction is a disc", async () => {
  const { createDecks } = await import('../js/world/ground.js');
  // a 200 m road east along z = 0 ramping to 6 m at x = 100 and back, and a road crossing it at grade (nodes 2-3);
  // a third link meeting the first at its raised middle (node 4) makes that a junction
  const geo = {
    roadGraph: {
      nodes: [0, 0, 200, 0, 100, -50, 100, 50, 100, 0, 100, -100],
      links: [
        [0, 4, 0, 8, 2, 0, [], [0, 60], 1],
        [4, 1, 0, 8, 2, 0, [], [60, 0], 1],
        [2, 3, 0, 8, 2, 0, [], 0, 0],
        [4, 5, 0, 8, 2, 0, [], [60, 60], 1]
      ]
    }
  };
  const { deckLift, junctions } = createDecks(geo);
  assert.equal(junctions.length, 1);
  assert.deepEqual([junctions[0].x, junctions[0].z, junctions[0].lift], [100, 0, 6]);
  // up the ramp: from the ground at its foot, step by step to the top
  let over = 0;
  for (let x = 0; x <= 90; x += 2) { // (up to the junction's disc)
    const lift = deckLift(x, 1, over);
    assert.ok(Math.abs(lift - (6 * x) / 100) < 1e-9, `on the ramp at ${x}`);
    over = lift;
  }
  // under the span (on the ground) nothing holds a body up; on it the deck does
  assert.equal(deckLift(100, 30, 0), 0);
  assert.equal(deckLift(100, 1, 0), 0);
  assert.equal(deckLift(100, 1, 6), 6);
  // the junction's disc reaches the corners between its links, where no link's strip does
  assert.equal(deckLift(104, -5, 6), 6);
  assert.equal(deckLift(100, 30), 0);
});

test("a ramp's deck rises smoothly through its vertices, and its run past an end still fills a bend's outside", async () => {
  const { createDecks } = await import('../js/world/ground.js');
  // a 7 % ramp east along z = 0 in three pieces (vertices at x = 40 and 80), then turning north at x = 120
  const geo = {
    roadGraph: {
      nodes: [0, 0, 120, -60],
      links: [[0, 1, 0, 8, 2, 0, [40, 0, 80, 0, 120, 0], [0, 28, 56, 84, 84], 1]]
    }
  };
  const { deckLift } = createDecks(geo);
  // up it 0.25 m at a time: the lift is the ramp's own, no step where the pieces meet (it used to hold the next
  // vertex's lift from half the deck's width before it, a 30 cm step a car took as a launch)
  let over = 0;
  for (let x = 0; x <= 118; x += 0.25) {
    const lift = deckLift(x, 2, over);
    assert.ok(Math.abs(lift - Math.min(8.4, 0.07 * x)) < 1e-9, `on the ramp at ${x}: ${lift}`);
    over = lift;
  }
  // the outside of the bend at x = 120 is past the end of both pieces meeting there: the deck holds it
  assert.equal(deckLift(123, 3, 8.4), 8.4);
});
