import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_IMPACT, createDamage, applyImpact, enginePower, condition, deformBody } from '../js/player/vehicle-damage.js';

test('light knocks bend nothing', () => {
  const dmg = createDamage();
  assert.equal(applyImpact(dmg, 0, 1, MIN_IMPACT - 0.1), 0);
  assert.equal(dmg.dents.length, 0);
  assert.equal(condition(dmg), 1);
  assert.equal(enginePower(dmg), 1);
});

test('a nose hit crushes the front and hurts the engine most; a few kill it', () => {
  const front = createDamage();
  const severity = applyImpact(front, 0, 1, 15);
  assert.equal(severity, 1);
  assert.equal(front.front, 0.55);
  assert.equal(front.dents.length, 1);
  assert.ok(front.dents[0].z > 2 && front.dents[0].nz < 0, 'dented at the nose, pushed back');
  const rear = createDamage();
  applyImpact(rear, 0, -1, 15);
  assert.ok(rear.rear > 0 && rear.engine < front.engine);
  const side = createDamage();
  applyImpact(side, -1, 0, 15);
  assert.ok(side.right > 0 && side.left === 0, '-x is the car\'s right');
  for (let i = 0; i < 2; i++) applyImpact(front, 0, 1, 15);
  assert.equal(front.engine, 1);
  assert.equal(enginePower(front), 0);
  assert.ok(condition(front) < 0.4);
});

test('front-corner hits pull the steering and bend that wheel', () => {
  const dmg = createDamage();
  applyImpact(dmg, 0.5, 1, 14);
  assert.ok(dmg.pull > 0, 'pulls to the left after a front-left hit');
  assert.ok(dmg.camber[0] !== 0 && dmg.camber[1] === 0);
});

test('repeat hits deepen a dent instead of piling up new ones', () => {
  const dmg = createDamage();
  applyImpact(dmg, 0, 1, 10);
  const depth = dmg.dents[0].depth;
  applyImpact(dmg, 0, 1, 10);
  assert.equal(dmg.dents.length, 1);
  assert.ok(dmg.dents[0].depth > depth);
  for (let i = 0; i < 40; i++) applyImpact(dmg, Math.cos(i), Math.sin(i), 8);
  assert.ok(dmg.dents.length <= 14);
});

test('dents move only the vertices near them, inward, and seams stay together', () => {
  const dmg = createDamage();
  applyImpact(dmg, 0, 1, 15);
  // two vertices at the same spot of the nose (a seam), one at the tail
  const base = new Float32Array([0, 0.6, 2.18, 0, 0.6, 2.18, 0, 0.6, -2.18]);
  const normals = new Float32Array([0, 0, 1, 0, 1, 0, 0, 0, -1]);
  const pos = new Float32Array(9), nrm = new Float32Array(9);
  deformBody(base, normals, pos, nrm, dmg.dents);
  assert.ok(pos[2] < 2.18 - 0.1, 'the nose is pushed in');
  assert.deepEqual([...pos.slice(0, 3)], [...pos.slice(3, 6)]);
  assert.deepEqual([...pos.slice(6)], [...base.slice(6)], 'the tail is untouched');
  assert.deepEqual([...nrm.slice(6)], [...normals.slice(6)]);
  assert.ok(Math.abs(Math.hypot(nrm[0], nrm[1], nrm[2]) - 1) < 1e-5, 'crumpled normals stay unit length');
});
