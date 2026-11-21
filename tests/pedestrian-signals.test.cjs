const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

function crossing() {
  const node = {};
  const state = { walk: false, clear: true };
  const { createPedestrianSystem } = loadModule(readFileSync(join(__dirname, '../js/pedestrian-system.js'), 'utf8'), {
    imports: {
      './city-config.js': { blockAt: () => null },
      './pedestrian-routes.js': { createPedestrianRoutes: () => ({ next: () => null }) },
      './ragdoll.js': { Ragdoll: class {}, RAGDOLL_POINTS: {}, moverLocal: () => {} },
      './pedestrians.js': {
        PersonRig: class { update() {} },
        PersonCrowd: class { meshes = []; begin() {} add() {} end() {} }
      }
    }
  });
  const system = createPedestrianSystem({ nodes: [node] }, {
    player: { active: false }, nearEdges: [], nearSignals: [],
    mayCross: () => state.walk && state.clear,
    walkOn: () => state.walk, visible: () => false, nearView: () => false
  });
  const people = system.peds.slice(0, 2);
  people.forEach((p, i) => Object.assign(p, {
    placed: true, node, ax: i * 2, az: 0, ux: 0, uz: 1, len: 20, t: 1.6,
    x: i * 2, z: 1.6, line: i * 2, dir: 1, goalX: 0, goalZ: 100,
    goalTime: Infinity, restTime: Infinity, socialTime: Infinity, walkDelay: 0.2 + i
  }));
  let clock = 0;
  const advance = (seconds) => {
    const steps = Math.ceil(seconds / 0.05);
    for (let i = 0; i < steps; i++) {
      clock += seconds / steps;
      system.update(seconds / steps, clock, 0, 0, false, true, 'person');
    }
  };
  return { people, state, advance };
}

test('pedestrians waiting at WALK set off at individual times', () => {
  const { people, state, advance } = crossing();
  advance(0.1);
  assert.ok(people.every((p) => p.waiting && p.t === 1.6));
  state.walk = true;
  advance(0.35);
  assert.ok(people[0].t > 1.6 && !people[0].waiting);
  assert.equal(people[1].t, 1.6);
  advance(1);
  assert.ok(people[1].t > 1.6 && !people[1].waiting);
});

test('a new WALK phase resets an unfinished reaction delay', () => {
  const { people, state, advance } = crossing();
  state.walk = true;
  advance(0.2);
  state.walk = false;
  advance(0.1);
  assert.equal(people[1].walkAt, -1);
  state.walk = true;
  advance(1.1);
  assert.equal(people[1].t, 1.6);
  advance(0.2);
  assert.ok(people[1].t > 1.6);
});

test('reverse crossings respect red and reaction delays despite curb rounding', () => {
  const { people, state, advance } = crossing();
  for (const p of people) { p.dir = -1; p.t = p.len - 1.6; p.z = p.t; }
  advance(0.2);
  assert.ok(people.every((p) => p.waiting && p.t === p.len - 1.6 && p.v === 0));
  state.walk = true;
  advance(0.35);
  assert.ok(people[0].t < people[0].len - 1.6);
  assert.equal(people[1].t, people[1].len - 1.6);
  advance(1);
  assert.ok(people[1].t < people[1].len - 1.6);
});

test('reaction delays do not bypass traffic checks or restart when a vehicle clears', () => {
  const { people, state, advance } = crossing();
  state.walk = true;
  state.clear = false;
  advance(2);
  assert.ok(people.every((p) => p.waiting && p.t === 1.6));
  state.clear = true;
  advance(0.05);
  assert.ok(people.every((p) => p.t > 1.6));
});

test('pedestrians already crossing continue when WALK ends', () => {
  const { people, advance } = crossing();
  for (const p of people) { p.t = 3; p.z = 3; p.v = p.speed; }
  advance(0.2);
  assert.ok(people.every((p) => p.t > 3 && !p.waiting));
});
