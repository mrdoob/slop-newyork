const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// A straight 60 m sidewalk line along +z at x = 0. `room` is how far off its line the sidewalk lets anyone stand.
function sidewalk({ room = 1.3, player = { active: false } } = {}) {
  const edge = {};
  const { createPedestrianSystem } = loadModule(readFileSync(join(__dirname, '../js/pedestrian-system.js'), 'utf8'), {
    imports: {
      './city-config.js': { blockAt: () => null },
      './pedestrian-routes.js': {
        createPedestrianRoutes: () => ({ next: () => null, share: () => 1, canDodge: (p, offset) => Math.abs(offset) <= room })
      },
      './ragdoll.js': { Ragdoll: class {}, RAGDOLL_POINTS: {}, moverLocal: () => {} },
      './pedestrians.js': {
        PersonRig: class { update() {} },
        PersonCrowd: class { meshes = []; begin() {} add() {} end() {} }
      }
    }
  });
  const system = createPedestrianSystem({ nodes: [] }, {
    player, nearEdges: [], nearSignals: [], mayCross: () => true, walkOn: () => true,
    visible: () => false, nearView: () => false
  });
  const track = { ax: 0, az: 0, ux: 0, uz: 1, len: 60, node: null, side: 0, line: 0, edge };
  const place = (i, t, dir, v = null) => {
    const p = system.peds[i];
    Object.assign(p, track, {
      placed: true, route: track, t, dir, x: 0, z: t, v: v ?? p.speed, pause: 0,
      goalX: 0, goalZ: 1e4, goalTime: Infinity, restTime: Infinity, socialTime: Infinity, avoidCheck: 0
    });
    return p;
  };
  let clock = 0, closest = Infinity;
  const advance = (seconds, mode = 'person', watch = []) => {
    const steps = Math.ceil(seconds / 0.05);
    for (let k = 0; k < steps; k++) {
      clock += seconds / steps;
      system.update(seconds / steps, clock, 0, 30, false, true, mode);
      for (let i = 0; i < watch.length; i++) {
        for (let j = i + 1; j < watch.length; j++) closest = Math.min(closest, Math.hypot(watch[i].x - watch[j].x, watch[i].z - watch[j].z));
      }
    }
  };
  return { system, place, advance, closest: () => closest };
}

// Stands still where it is (talking on the phone): paused for the whole test
const standStill = (p) => Object.assign(p, { v: 0, pause: 1e9 });

test('walkers meeting on one line each step aside and pass without bumping', () => {
  const { place, advance, closest } = sidewalk();
  const a = place(0, 10, 1), b = place(1, 30, -1);
  advance(20, 'person', [a, b]);
  assert.ok(closest() > 0.5, `they kept ${closest().toFixed(2)} m apart`);
  assert.ok(a.z > 30 && b.z < 10, 'both walked on past each other');
});

test('a walker steps round someone standing in its way and carries on', () => {
  const { place, advance, closest } = sidewalk();
  const a = place(0, 10, 1), b = standStill(place(1, 16, 1));
  advance(12, 'person', [a, b]);
  assert.ok(closest() > 0.55, `kept ${closest().toFixed(2)} m from them`);
  assert.ok(a.t > 22 && a.dir === 1, 'walked on past');
});

test('with no room to pass, a walker waits behind someone standing, then turns back', () => {
  const { place, advance, closest } = sidewalk({ room: 0.2 });
  const a = place(0, 10, 1), b = standStill(place(1, 16, 1));
  advance(5, 'person', [a, b]);
  assert.ok(closest() > 0.6, `stopped ${closest().toFixed(2)} m behind them`);
  assert.ok(a.t < 16);
  advance(6, 'person', [a, b]);
  assert.equal(a.dir, -1, 'gave up and went back');
});

test('with no room to pass, a walker follows a slower one at its pace', () => {
  const { place, advance, closest } = sidewalk({ room: 0.2 });
  const a = place(0, 10, 1), b = place(1, 13, 1);
  a.speed = 1.6; b.speed = 0.8; a.v = 1.6; b.v = 0.8;
  advance(10, 'person', [a, b]);
  assert.ok(closest() > 0.6, `kept ${closest().toFixed(2)} m behind`);
  assert.ok(Math.abs(a.v - 0.8) < 0.2, `followed at ${a.v.toFixed(2)} m/s`);
  assert.equal(a.dir, 1);
});

test('walkers go round the player standing on the sidewalk', () => {
  const player = { active: true, x: 0, z: 20, vx: 0, vz: 0, fx: 0, fz: 1, halfW: 0.32, halfL: 0.32 };
  const { place, advance } = sidewalk({ player });
  const a = place(0, 10, 1);
  let closest = Infinity;
  for (let k = 0; k < 200; k++) {
    advance(0.05);
    closest = Math.min(closest, Math.hypot(a.x - player.x, a.z - player.z));
  }
  assert.ok(closest > 0.55, `kept ${closest.toFixed(2)} m from the player`);
  assert.ok(a.z > player.z + 1 && a.dir === 1, 'walked on past');
});

test('a car parked on the sidewalk is walked round where there is room, else turned from', () => {
  for (const [room, passes] of [[2.6, true], [0.6, false]]) {
    // parked along the walking line, a little off it
    const player = { active: true, entity: { position: { y: 0 } }, x: 0.3, z: 20, vx: 0, vz: 0, fx: 0, fz: 1,
      halfW: 0.86, halfL: 2.18 };
    const { place, advance } = sidewalk({ room, player });
    const a = place(0, 8, 1);
    let inside = 0;
    for (let k = 0; k < 400; k++) {
      advance(0.05, 'car');
      if (Math.abs(a.x - player.x) < player.halfW + 0.2 && Math.abs(a.z - player.z) < player.halfL + 0.2) inside++;
    }
    assert.equal(inside, 0, 'never walked into the car');
    if (passes) assert.ok(a.t > 24 && a.dir === 1, `walked round it (t ${a.t.toFixed(1)})`);
    else assert.equal(a.dir, -1, 'turned back');
  }
});

test('nobody steps off the curb in front of the player driving up to the crosswalk', () => {
  const node = { curb: [], walkers: [] };
  const player = { active: true, entity: { position: { y: 0 } }, x: -40, z: 8, vx: 12, vz: 0, fx: 1, fz: 0,
    halfW: 0.86, halfL: 2.18 };
  const { system, advance } = sidewalk({ player });
  // a crosswalk over the road along +z, the car driving along +x over it at z = 8
  const p = system.peds[0];
  Object.assign(p, { placed: true, node, ax: 0, az: 0, ux: 0, uz: 1, len: 16, t: 1.6, x: 0, z: 1.6, dir: 1, v: 0,
    side: 2, line: 0, route: null, walkDelay: 0, goalTime: Infinity, restTime: Infinity, socialTime: Infinity });
  for (let k = 0; k < 40; k++) {
    player.x += player.vx * 0.05;
    advance(0.05, 'car');
    if (player.x < -player.halfL - 1) assert.equal(p.t, 1.6, `waited while the car came (car at x ${player.x.toFixed(1)})`);
  }
  player.vx = 0;
  player.x = 40;
  advance(2, 'car');
  assert.ok(p.t > 1.6, 'crossed once it had gone');
});
