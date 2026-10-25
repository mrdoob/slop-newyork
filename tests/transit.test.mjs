import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteMatcher } from '../tools/tepic-lib.mjs';
import { createTransit, decodeTransit } from '../js/sim/transit.js';

// A 100 m block (nodes 0..3 clockwise from the north-west corner, x east, z south) with a street running on east from
// its north-east corner (node 4), every street two-way unless a test says otherwise
const NODES = [[0, 0], [100, 0], [100, 100], [0, 100], [200, 0]];
const LINKS = [[0, 1], [1, 2], [2, 3], [3, 0], [1, 4]];
const graph = (dirs = {}) => LINKS.map(([a, b], i) => ({ a, b, pts: [NODES[a], NODES[b]], dir: dirs[i] || 0 }));
// The same as GEO.roadGraph: flat nodes, links [a, b, name, width, lanes, dir, inner]
const roadGraph = { nodes: NODES.flat(), links: LINKS.map(([a, b]) => [a, b, 0, 8, 2, 0, []]), names: [''] };
const wobble = (pts) => pts.map(([x, z], i) => [x + ((i * 7) % 5) - 2, z + ((i * 3) % 5) - 2]);

test('a line drawn round the block a few metres off its streets drives round it and loops', () => {
  const match = createRouteMatcher(graph());
  const r = match(wobble([[5, 0], [100, 0], [100, 100], [0, 100], [0, 5]]));
  assert.equal(r.pieces.length, 1);
  assert.deepEqual(r.pieces[0].slice(0, 4), [1, 2, 3, 4], 'the four sides, each from its node a to b');
  assert.equal(r.loop, true, 'it ends where it began');
  assert.equal(r.matched, r.samples);
});

test('a two-way street is driven the way the line runs; a one-way street only its own way', () => {
  const back = createRouteMatcher(graph())([[195, 0], [105, 0], [100, 50], [100, 95]]);
  assert.deepEqual(back.pieces, [[-5, 2]], 'west along the spur, then south down the east side');
  // the east side one-way north: drawn south down it, the route goes round the other three sides instead
  const oneWay = createRouteMatcher(graph({ 1: -1 }))([[195, 0], [105, 0], [100, 50], [100, 95]]);
  assert.ok(!oneWay.pieces.flat().includes(2), 'never down the one-way street');
  assert.ok(oneWay.pieces.flat().every((ref) => ref !== 0));
});

test('decoded routes run along their links, and a road on one is found with where it ends on it', () => {
  const transit = { groups: ['Centro'], routes: [['Vuelta', 0, '#00796b', 'bus', 1, [[1, 2, 3, 4]]]] };
  const [path] = decodeTransit(transit, roadGraph);
  assert.equal(path.len, 400);
  assert.equal(path.loop, true);
  assert.equal(path.fleet, 'bus');
  const t = createTransit(transit, roadGraph);
  const along = t.pathsAlong(100, 10, 100, 90);
  assert.equal(along.length, 1);
  assert.ok(Math.abs(along[0].s - 190) < 1e-6, 'the east side ends 190 m round');
  assert.equal(t.pathsAlong(100, 90, 100, 10).length, 0, 'not the other way up it');
  assert.equal(t.pathsAlong(110, 10, 190, 10).length, 0, 'nor a road off it');
});

test('at a corner the move along the route is taken, and the cursor wraps round the loop', () => {
  const transit = { groups: [''], routes: [['Vuelta', 0, '#000', '', 1, [[1, 2, 3, 4]]]] };
  const t = createTransit(transit, roadGraph);
  const [path] = t.paths;
  const road = (sx, sz, ex, ez) => {
    const len = Math.hypot(ex - sx, ez - sz);
    return { sx, sz, dx: (ex - sx) / len, dz: (ez - sz) / len, len };
  };
  // arriving at the north-east corner (100 m round): straight on along the spur, or right down the east side
  const moves = [{ to: road(110, 0, 200, 0) }, { to: road(100, 10, 100, 90) }];
  const pick = t.pickMove(path, 98, moves);
  assert.equal(pick.index, 1);
  assert.ok(Math.abs(pick.s - 190) < 1e-6);
  // a lane that can only go straight: no move runs on along the route
  assert.equal(t.pickMove(path, 98, moves, (m) => m === moves[0]).index, -1);
  // arriving at the north-west corner (400 m, the loop's end): on along the north side, 90 m into the next lap
  const wrap = t.pickMove(path, 398, [{ to: road(0, 90, 0, 10) }, { to: road(10, 0, 90, 0) }]);
  assert.equal(wrap.index, 1);
  assert.ok(Math.abs(wrap.s - 90) < 1e-6);
});

test("the generated routes drive connected streets of the road graph, each the way it may be driven", async () => {
  const { GEO } = await import('../js/world/city-geodata.js');
  const { links } = GEO.roadGraph;
  assert.ok(GEO.transit.routes.length >= 30, 'the Secretaría de Movilidad map has 40 routes');
  for (const [name, group, colour, fleet, loops, pieces] of GEO.transit.routes) {
    assert.ok(group >= 0 && group < GEO.transit.groups.length, name);
    assert.match(colour, /^#[0-9a-f]{6}$/i);
    assert.ok(['', 'bus', 'combi'].includes(fleet));
    for (const piece of pieces) {
      let at = -1;
      for (const ref of piece) {
        const l = links[Math.abs(ref) - 1];
        assert.ok(l, `${name}: link ${ref} exists`);
        const [a, b, , , , dir] = l;
        assert.ok(dir === 0 || Math.sign(ref) === dir, `${name}: link ${ref} driven its way`);
        const [from, to] = ref > 0 ? [a, b] : [b, a];
        if (at >= 0) assert.equal(from, at, `${name}: link ${ref} starts where the last ended`);
        at = to;
      }
      if (loops) {
        const first = links[Math.abs(piece[0]) - 1];
        assert.equal(at, piece[0] > 0 ? first[0] : first[1], `${name} loops back into its start`);
      }
    }
  }
});
