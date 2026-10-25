import assert from 'node:assert/strict';
import test from 'node:test';
import { WEAPONS, Arsenal, pickTarget, rayCircle, rayBox, boxOverlap, blastFalloff, hitChance } from '../js/sim/weapons.js';

const step = (arsenal, held, seconds, dt = 1 / 60) => {
  let shots = 0;
  for (let t = 0; t < seconds - 1e-9; t += dt) shots += arsenal.trigger(held, dt);
  return shots;
};

test('a semi-automatic pistol fires once per pull, an SMG keeps firing while held', () => {
  const a = new Arsenal();
  assert.equal(a.current, 'pistol');
  assert.equal(step(a, true, 1), 1, 'holding the pistol trigger fires one shot');
  step(a, false, 0.5);
  assert.equal(step(a, true, 0.1), 1, 'a new pull fires again');
  a.select('smg');
  step(a, false, 0.5);
  const shots = step(a, true, 1);
  assert.ok(Math.abs(shots - WEAPONS.smg.rate) <= 1, `about ${WEAPONS.smg.rate} rounds a second, got ${shots}`);
  assert.equal(a.ammo.smg, WEAPONS.smg.start - shots);
});

test('a pull just before the pistol is ready still fires, once', () => {
  const a = new Arsenal();
  assert.equal(a.trigger(true, 1 / 60), 1);
  for (let i = 0; i < 6; i++) a.trigger(false, 1 / 60);
  // pulled again 0.1 s later, a tap while it is still cycling (1 / 4.5 s): fires as soon as it can
  let shots = 0;
  for (let i = 0; i < 2; i++) shots += a.trigger(true, 1 / 60);
  for (let i = 0; i < 30; i++) shots += a.trigger(false, 1 / 60);
  assert.equal(shots, 1);
});

test('out of rounds it falls back to a weapon that has some; fists never run out', () => {
  const a = new Arsenal({ pistol: 1, smg: 0, bazooka: 0 });
  assert.equal(step(a, true, 0.1), 1);
  assert.equal(a.ammo.pistol, 0);
  step(a, false, 0.2);
  step(a, true, 0.1);
  assert.equal(a.current, 'fists');
  assert.equal(a.select('smg'), false, 'no SMG without rounds');
  a.add('bazooka', 4);
  assert.equal(a.cycle(1), 'bazooka');
  assert.equal(a.cycle(1), 'fists');
  assert.equal(a.ammo.fists, Infinity);
});

test('lock-on picks the target nearest the line of fire, within range and cone', () => {
  // facing +z
  const near = { x: 3, z: 10 };
  const ahead = { x: 0, z: 30 };
  const behind = { x: 0, z: -5 };
  const far = { x: 0, z: 200 };
  assert.equal(pickTarget(0, 0, 0, [near, ahead, behind, far], 60, 0.5), ahead);
  assert.equal(pickTarget(0, 0, Math.PI, [near, ahead, behind], 60, 0.5), behind);
  assert.equal(pickTarget(0, 0, 0, [far], 60, 0.5), null);
  assert.equal(pickTarget(0, 0, 0, [ahead], 60, 0.5, () => false), null);
});

test('rays hit circles and turned boxes at the near side', () => {
  assert.ok(Math.abs(rayCircle(0, 0, 0, 1, 0, 10, 0.5) - 9.5) < 1e-9);
  assert.equal(rayCircle(0, 0, 0, 1, 2, 10, 0.5), -1);
  assert.equal(rayCircle(0, 0, 0, 1, 0, -10, 0.5), -1, 'nothing behind the muzzle');
  // a car 4.4 m long along x (yaw π/2) centred 10 m ahead: its 0.9 m half width faces the shot
  assert.ok(Math.abs(rayBox(0, 0, 0, 1, 0, 10, Math.PI / 2, 0.9, 2.2) - 9.1) < 1e-9);
  // the same car along z: its 2.2 m half length faces it
  assert.ok(Math.abs(rayBox(0, 0, 0, 1, 0, 10, 0, 0.9, 2.2) - 7.8) < 1e-9);
  assert.equal(rayBox(0, 0, 0, 1, 3, 10, 0, 0.9, 2.2), -1);
});

test('overlapping boxes are pushed apart along the shallowest axis', () => {
  const a = { x: 0, z: 0, heading: 0, hw: 0.9, hl: 2.2 };
  const side = boxOverlap(a, { x: 1.5, z: 0, heading: 0, hw: 0.9, hl: 2.2 });
  assert.ok(side && Math.abs(side.nx - 1) < 1e-9 && Math.abs(side.pen - 0.3) < 1e-9);
  const front = boxOverlap(a, { x: 0, z: -4, heading: Math.PI, hw: 0.9, hl: 2.2 });
  assert.ok(front && Math.abs(front.nz + 1) < 1e-9 && Math.abs(front.pen - 0.4) < 1e-9);
  assert.equal(boxOverlap(a, { x: 2, z: 0, heading: 0, hw: 0.9, hl: 2.2 }), null);
});

test('blasts weaken to nothing at their edge; shots are surer close up and at slow targets', () => {
  assert.equal(blastFalloff(0, 8), 1);
  assert.equal(blastFalloff(8, 8), 0);
  assert.ok(blastFalloff(2, 8) > blastFalloff(5, 8));
  assert.ok(hitChance(5, 0, 0.8, 60) > hitChance(40, 0, 0.8, 60));
  assert.ok(hitChance(10, 0, 0.8, 60) > hitChance(10, 25, 0.8, 60));
  assert.equal(hitChance(70, 0, 1, 60), 0);
});
