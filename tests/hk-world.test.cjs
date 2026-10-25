const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

// js/hk/config.js only depends on the generated data pack, so the world maths can be tested in plain Node.
const load = () => import(pathToFileURL(join(__dirname, '../js/hk/config.js')).href);
const loadWorld = () => import(pathToFileURL(join(__dirname, '../js/world.js')).href);

test('lane lateral: Hong Kong keeps left, so a northbound car sits west of the centreline', async () => {
  const HK = await load();
  const north = HK.laneLateral(0, -1); // heading north (north = −z)
  assert.equal(north.x, -1);
  assert.equal(north.z, 0);
  const east = HK.laneLateral(1, 0); // heading east
  assert.equal(east.x, 0);
  assert.equal(east.z, -1); // …its left is north (−z)
  for (let i = 0; i < 4; i++) {
    assert.ok(HK.laneCentreOffset(i, HK.LANE_WIDTH) > HK.laneCentreOffset(i - 1, HK.LANE_WIDTH));
  }
  assert.equal(HK.LANE_WIDTH, 3.4);
});

test('offset corridors put every lane vertex on the left of travel', async () => {
  const HK = await load();
  for (const road of HK.ROADS) {
    const pts = road.pts.map((p) => ({ x: p.x, z: p.z }));
    for (const dir of [1, -1]) {
      const base = dir === 1 ? pts : [...pts].reverse();
      for (let lane = 0; lane < road.lanesPerWay; lane++) {
        const offset = HK.laneCentreOffset(lane, HK.LANE_WIDTH);
        const shifted = HK.offsetPolyline(base, offset);
        shifted.forEach((p, i) => {
          // The lateral offset from the centreline must have a positive component along the left normal.
          const left = HK.laneLateral(p.dx, p.dz);
          const vx = p.x - base[i].x;
          const vz = p.z - base[i].z;
          const along = vx * left.x + vz * left.z;
          assert.ok(along > 0.1, `${road.en} lane ${lane} vertex ${i} is not on the left (${along.toFixed(2)} m)`);
          // …and none along the direction of travel.
          const forward = vx * p.dx + vz * p.dz;
          assert.ok(Math.abs(forward) < 0.5, `${road.en} lane ${lane} vertex ${i} drifts forward (${forward.toFixed(2)} m)`);
          // Exactly the lane's centre offset out to within the miter of a bend.
          const dist = Math.hypot(vx, vz);
          assert.ok(Math.abs(dist - offset) < 1.0, `${road.en} lane ${lane}: ${dist.toFixed(2)} m ≠ ${offset.toFixed(2)} m`);
        });
      }
    }
  }
});

test('a negative offset mirrors the carriageway to the right (the New York rule)', async () => {
  const HK = await load();
  const road = HK.ROADS[0];
  const pts = road.pts.map((p) => ({ x: p.x, z: p.z }));
  const right = HK.offsetPolyline(pts, -HK.laneCentreOffset(0, HK.LANE_WIDTH));
  right.forEach((p, i) => {
    const left = HK.laneLateral(p.dx, p.dz);
    const along = (p.x - pts[i].x) * left.x + (p.z - pts[i].z) * left.z;
    assert.ok(along < -0.1, 'a negative offset must land on the right-hand side');
  });
});

test('lane sets: one-way corridors get one direction, two-way corridors get both', async () => {
  const HK = await load();
  const lanes = HK.buildLanes();
  assert.ok(lanes.length > 30);
  for (const road of HK.ROADS) {
    const mine = lanes.filter((l) => l.road === road);
    assert.equal(mine.length, road.lanesPerWay * (road.oneway ? 1 : 2), `${road.en} lane count`);
    if (!road.oneway) {
      assert.deepEqual([...new Set(mine.map((l) => l.dir))].sort(), [-1, 1]);
    }
    for (const lane of mine) {
      assert.ok(lane.len > 20, `${road.en} lane length`);
      assert.equal(lane.isKerbLane, lane.lane === road.lanesPerWay - 1);
    }
  }
});

test('poseAt walks the lane monotonically and keeps the lane bearing', async () => {
  const HK = await load();
  const lane = HK.buildLanes()[0];
  const a = HK.poseAt(lane, 0);
  const b = HK.poseAt(lane, lane.len * 0.5);
  const c = HK.poseAt(lane, lane.len);
  assert.ok(Math.hypot(b.x - a.x, b.z - a.z) > 1);
  assert.ok(Math.hypot(c.x - b.x, c.z - b.z) > 1);
  assert.ok(Math.abs(Math.hypot(a.dx, a.dz) - 1) < 1e-9);
  assert.ok(Math.abs(a.heading - Math.atan2(a.dx, a.dz)) < 1e-9);
  // Clamped outside the lane instead of extrapolating off the map.
  assert.deepEqual(HK.poseAt(lane, -50).x, HK.poseAt(lane, 0).x);
  assert.deepEqual(HK.poseAt(lane, lane.len + 50).x, HK.poseAt(lane, lane.len).x);
});

test('traffic signals: green → amber → all-red, and pedestrians never start on amber', async () => {
  const HK = await load();
  const phases = new Set();
  for (let t = 0; t < HK.SIGNAL.cycle; t += 0.5) {
    phases.add(HK.signalPhase(t, true));
    if (HK.walkPhase(t, true)) {
      // A pedestrian may only start while the parallel traffic still has green.
      assert.equal(HK.signalPhase(t, true), 'green', `walk at t=${t} without green`);
    }
  }
  assert.deepEqual([...phases].sort(), ['amber', 'green', 'red']);
  // The two directions are offset by half the cycle.
  assert.notEqual(HK.signalPhase(1, true), HK.signalPhase(1, false));
});

test('districts and bilingual location labels', async () => {
  const HK = await load();
  for (const d of HK.DISTRICTS) {
    assert.match(d.zh, /[\u4e00-\u9fff]/);
    assert.ok(d.x1 > d.x0 && d.z1 > d.z0);
  }
  const central = HK.TELEPORTS.find((t) => t.id === 'central');
  assert.equal(HK.districtAt(central.x, central.z).id, 'central');
  const label = HK.locationLabel(central.x, central.z);
  assert.match(label, /中環/);
  assert.match(label, /Central/);
  assert.ok(label.includes('·'));
  // Kowloon is on the other side of the harbour.
  const tst = HK.TELEPORTS.find((t) => t.id === 'tst');
  const d = HK.districtAt(tst.x, tst.z);
  assert.ok(['tsim-sha-tsui', 'west-kowloon'].includes(d.id), `TST resolved to ${d.id}`);
});

test('spawn point and teleports stand on (or beside) a real road', async () => {
  const HK = await load();
  const spawn = HK.nearestRoad(HK.SPAWN.x, HK.SPAWN.z);
  assert.ok(spawn, 'the spawn must be near a road');
  assert.ok(spawn.dist < HK.LANE_WIDTH * 3, `spawn is ${spawn.dist.toFixed(1)} m off the centreline`);
  assert.ok(Number.isFinite(HK.SPAWN.heading));
  assert.equal(HK.TELEPORTS.length, 9);
  for (const tp of HK.TELEPORTS) {
    assert.match(tp.zh, /[\u4e00-\u9fff]/, `${tp.id} needs a Chinese name`);
    assert.ok(Number.isFinite(tp.x) && Number.isFinite(tp.z) && Number.isFinite(tp.heading));
    assert.ok(HK.nearestRoad(tp.x, tp.z, 600), `${tp.id} is nowhere near a road`);
  }
});

test('nearestRoad reports the corridor you are actually driving on', async () => {
  const HK = await load();
  for (const road of HK.ROADS.slice(0, 8)) {
    const p = HK.alongRoad(road, road.len * 0.4);
    const near = HK.nearestRoad(p.x, p.z, 60);
    assert.ok(near, `${road.en} has no nearest-road answer`);
    assert.ok(near.dist < 1.5, `${road.en}: nearest road is ${near.dist.toFixed(2)} m away`);
    assert.equal(near.road.en, road.en);
  }
});

test('world switching resolves queries without touching the DOM', async () => {
  const { resolveWorld, WORLDS } = await loadWorld();
  assert.equal(resolveWorld('?world=hk'), 'hk');
  assert.equal(resolveWorld('?world=hong-kong'), 'hk');
  assert.equal(resolveWorld('?city=%E9%A6%99%E6%B8%AF'), 'hk'); // 香港
  assert.equal(resolveWorld('?world=ny'), 'ny');
  assert.equal(resolveWorld('?world=NYC'), 'ny');
  assert.equal(resolveWorld('', null), 'ny');
  assert.equal(resolveWorld('', 'hk'), 'hk');
  assert.equal(resolveWorld('?world=nonsense', 'hk'), 'hk');
  assert.equal(WORLDS.hk.storageKey, 'hk-player-state');
  assert.notEqual(WORLDS.hk.storageKey, WORLDS.ny.storageKey);
});

test('car following: keep the gap, stop behind a stopped car, never exceed vmax', async () => {
  const HK = await load();
  assert.equal(HK.followSpeed(Infinity, 4.6, 14), 14, 'open road → vmax');
  assert.equal(HK.followSpeed(0, 4.6, 14), 0, 'overlapping → stopped');
  assert.equal(HK.followSpeed(6, 4.6, 14), 0, 'inside the standstill gap → stopped');
  const mid = HK.followSpeed(20, 4.6, 14);
  assert.ok(mid > 0 && mid < 14);
  assert.ok(HK.followSpeed(40, 4.6, 14) > mid, 'more room → faster');
  assert.ok(HK.followSpeed(400, 11.8, 11) <= 11);
  assert.ok(HK.followSpeed(20, 11.8, 11, 1.25) < HK.followSpeed(20, 11.8, 11, 1.1), 'a longer headway is slower');
});

test('both worlds can be reached from the UI', () => {
  const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /\?world=hk/, 'the New York HUD links to Hong Kong');
  const hkMain = readFileSync(join(__dirname, '../js/hk/main.js'), 'utf8');
  assert.match(hkMain, /\?world=ny/, 'the Hong Kong HUD links back to New York');
});

test('the Hong Kong entry point is wired into main.js and the HUD stylesheet is loaded', () => {
  const main = readFileSync(join(__dirname, '../js/main.js'), 'utf8');
  assert.match(main, /getWorldId\(\) === 'hk'/);
  assert.match(main, /import\('\.\/hk\/main\.js'\)/);
  const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /css\/hk\.css/);
});
