const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const source = readFileSync(join(__dirname, '../js/pedestrian-routes.js'), 'utf8');
const createPedestrianRoutes = new Function(source.replace(/export \{ createPedestrianRoutes \};/, '') + '\nreturn createPedestrianRoutes;')();

function fixture(obstacles = [], angle = 0) {
  const cs = Math.cos(angle), sn = Math.sin(angle);
  const world = (x, z) => ({ x: x * cs - z * sn, z: x * sn + z * cs });
  const local = (x, z) => ({ x: x * cs + z * sn, z: -x * sn + z * cs });
  const block = { poly: [world(0, 5), world(200, 5), world(200, 40), world(0, 40)] };
  const blockAt = (x, z) => { const p = local(x, z); return p.x >= 0 && p.x <= 200 && p.z >= 5 && p.z <= 40 ? block : null; };
  const walkable = (minX, maxX, minZ, maxZ) => {
    const p = local((minX + maxX) / 2, (minZ + maxZ) / 2);
    const hx = (maxX - minX) / 2, hz = (maxZ - minZ) / 2;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    return ![...obstacles, [0, 200, 9.4, 40]].some(([x0, x1, z0, z1]) =>
      p.x + ex > x0 && p.x - ex < x1 && p.z + ez > z0 && p.z - ez < z1);
  };
  const nodes = Array.from({ length: 3 }, () => ({ in: [], out: [], road: [] }));
  const edges = [0, 1].map((i) => {
    const start = world(5 + i * 90, 0);
    const edge = { from: nodes[i], to: nodes[i + 1], sx: start.x, sz: start.z, dx: cs, dz: sn,
      rx: -sn, rz: cs, half: 5, len: 90 };
    nodes[i].out.push(edge); nodes[i + 1].in.push(edge);
    return edge;
  });
  const routes = createPedestrianRoutes({ walkable, onSidewalk: (x, z) => !!blockAt(x, z) }, blockAt);
  return { routes, edges, block, blockAt, walkable, world };
}

const endpoint = (track, end) => ({ x: track.ax + track.ux * track.len * end, z: track.az + track.uz * track.len * end });
function touching(a, b) { assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 1e-8); }

test('unobstructed sidewalk lines stay straight', () => {
  const f = fixture(), tracks = f.routes.along(f.edges[0]);
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every((t) => t.len === 90 && !t.before && !t.after));
});

for (const angle of [0, Math.PI / 6]) {
  test(`pedestrians bypass an obstruction within the curb island (${angle})`, () => {
    const f = fixture([[35, 42, 6.5, 8.1]], angle), tracks = f.routes.along(f.edges[0]);
    const starts = tracks.filter((t) => !t.before), goal = f.world(500, 7);
    assert.equal(starts.length, 2);
    assert.ok(starts.every((t) => t.after));
    for (const start of starts) {
      touching(endpoint(start, 0), f.world(5, start === starts[0] ? 6.7 : 7.8));
      let tail = start;
      for (let t = start; t; t = t.after) {
        tail = t;
        for (let s = 0; s <= t.len; s += 0.1) {
          const x = t.ax + t.ux * s, z = t.az + t.uz * s;
          assert.equal(f.blockAt(x, z), f.block);
          assert.ok(f.walkable(x - 0.4, x + 0.4, z - 0.4, z + 0.4));
        }
        for (const [dir, neighbor] of [[1, t.after], [-1, t.before]]) {
          if (!neighbor) continue;
          const plan = f.routes.next(t, dir, goal.x, goal.z);
          assert.equal(plan.length, 1);
          assert.equal(plan[0].track, neighbor);
          assert.equal(plan[0].dir, dir);
          touching(endpoint(t, dir > 0 ? 1 : 0), endpoint(neighbor, dir > 0 ? 0 : 1));
        }
      }
      touching(endpoint(tail, 1), f.world(95, start === starts[0] ? 6.7 : 7.8));
      const exit = f.routes.next(tail, 1, goal.x, goal.z);
      assert.equal(exit.at(-1).track.edge, f.edges[1]);
    }
  });
}

test('a blocked sidewalk does not send pedestrians into the road or through a lot', () => {
  const f = fixture([[35, 42, 5, 9.4]]);
  assert.deepEqual(f.routes.along(f.edges[0]), []);
});

test('a cached route can weave between obstacles on opposite sides of the sidewalk', () => {
  const f = fixture([[30, 36, 5, 7.35], [56, 62, 7.15, 9.4]]);
  const tracks = f.routes.along(f.edges[0]);
  assert.equal(tracks.filter((t) => !t.before).length, 2);
  assert.ok(tracks.length >= 6);
  for (const t of tracks) {
    for (let s = 0; s <= t.len; s += 0.1) {
      const x = t.ax + t.ux * s, z = t.az + t.uz * s;
      assert.equal(f.blockAt(x, z), f.block);
      assert.ok(f.walkable(x - 0.4, x + 0.4, z - 0.4, z + 0.4));
    }
  }
});

test('both directions of a two-way road share one set of sidewalks, which still lead on at its junctions', () => {
  const f = fixture();
  // the opposite direction of the first road, along the same centreline
  const [a, b] = [f.edges[0].from, f.edges[0].to];
  const end = f.world(95, 0);
  const back = { from: b, to: a, sx: end.x, sz: end.z, dx: -f.edges[0].dx, dz: -f.edges[0].dz,
    rx: -f.edges[0].rx, rz: -f.edges[0].rz, half: 5, len: 90 };
  b.out.push(back); a.in.push(back);
  const tracks = f.routes.along(back); // laid out along the opposite direction first
  assert.equal(tracks.length, 2);
  assert.equal(f.routes.along(f.edges[0]), tracks);
  assert.equal(f.routes.share(back), 0.5);
  assert.equal(f.routes.share(f.edges[0]), 0.5);
  assert.equal(f.routes.share(f.edges[1]), 1);
  // walking on towards the second road from the end of either line
  const goal = f.world(500, 7);
  for (const t of tracks) {
    const dir = t.ux * f.edges[0].dx + t.uz * f.edges[0].dz > 0 ? 1 : -1;
    const plan = f.routes.next(t, dir, goal.x, goal.z);
    assert.ok(plan, 'a way on from the shared sidewalk');
    assert.equal(plan.at(-1).track.edge, f.edges[1]);
  }
});
