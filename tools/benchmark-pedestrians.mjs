// Uses the application's Three.js math classes without installing dependencies or starting WebGPU.
// Run: node tools/benchmark-pedestrians.mjs /absolute/path/to/three.js/build/three.core.js
// THREE_CORE_PATH may supply the same path. The benchmark reports CPU time for 340 rigs, not whole-frame time.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { loadModule } from '../tests/helpers/module.cjs';

const corePath = process.argv[2] || process.env.THREE_CORE_PATH;
if (!corePath) throw new Error('Pass the path to an existing Three.js build/three.core.js, or set THREE_CORE_PATH.');
const THREE = await import(pathToFileURL(resolve(corePath)).href);
const source = readFileSync(new URL('../js/sim/pedestrians.js', import.meta.url), 'utf8');
// The previous path always solved the final pose; all other animation code stays identical.
const alwaysSolve = source.replaceAll('if (updatePose) this.solve();', 'this.solve();');
assert.notEqual(alwaysSolve, source, 'Expected deferred pose solves in PersonRig.update');

function rigClass(code) {
  return loadModule(code, {
    globals: { Math },
    imports: {
      'three/webgpu': THREE,
      'three/tsl': {},
      'three/addons/utils/BufferGeometryUtils.js': {}
    }
  }).PersonRig;
}
const BaselineRig = rigClass(alwaysSolve);
const DeferredRig = rigClass(source);
const ground = (_owner, x) => x % 30 < 15 ? 0.22 : 0;
const diagnosticKeys = new Set(['pose', 'reachError', 'stanceReachError']);
const gaitState = (rig) => JSON.stringify(rig, (key, value) => diagnosticKeys.has(key) ? undefined : value);
const equalPose = (a, b, message) => assert.ok(a.length === b.length && a.every((value, i) => Number.isFinite(value) && Object.is(value, b[i])), message);

// Hidden stretches include walking, stopping, turning, jumping and relocation. On returning to view, the full
// Float32 pose must match the always-solved reference exactly; feet and gait must match on every hidden frame too.
for (const female of [false, true]) {
  const baseline = new BaselineRig({ seed: 0.13, female });
  const deferred = new DeferredRig({ seed: 0.13, female });
  let previousPose;
  let skippedPose = false;
  for (let frame = 0; frame < 600; frame++) {
    const t = frame / 60;
    const travel = frame < 180 ? t : frame < 240 ? 3 : t - 1;
    const x = Math.sin(travel * 0.25) * 14 + (frame >= 300 ? 30 : 0);
    const z = Math.cos(travel * 0.25) * 14;
    const heading = Math.PI / 2 - t * 0.25;
    const air = frame >= 250 && frame < 280 ? Math.sin((frame - 250) / 30 * Math.PI) : 0;
    const visible = frame % 90 >= 75;
    const reset = frame === 0 || frame === 300;
    const args = [1 / 60, x, z, heading, ground, null, air];
    baseline.update(...args);
    deferred.update(...args, visible);
    assert.equal(gaitState(deferred), gaitState(baseline), `Gait changed at frame ${frame}`);
    if (visible || reset) {
      equalPose(deferred.pose, baseline.pose, `Pose changed at frame ${frame}`);
    } else if (previousPose) {
      equalPose(deferred.pose, previousPose, `Hidden pose was needlessly solved at frame ${frame}`);
      skippedPose = true;
    }
    previousPose = deferred.pose.slice();
  }
  assert.ok(skippedPose, 'Exercised hidden pose deferral');
}

// Player rigs omit the new argument: jumping and ordinary motion must continue solving by default.
const baselinePlayer = new BaselineRig();
const player = new DeferredRig();
for (let frame = 0; frame < 90; frame++) {
  const args = [1 / 60, frame / 30, 0, Math.PI / 2, ground, null, frame > 20 && frame < 40 ? 0.5 : 0];
  baselinePlayer.update(...args);
  player.update(...args);
  equalPose(player.pose, baselinePlayer.pose, 'Player default pose changed');
}

const count = 340;
const visibleCount = 68;
const makeRigs = (Rig) => Array.from({ length: count }, (_,i) => new Rig({ seed: i * 0.13, female: i % 2 === 1 }));
const baseline = makeRigs(BaselineRig), deferred = makeRigs(DeferredRig);
function frame(rigs, f, hide) {
  for (let i = 0; i < count; i++) {
    const angle = f / 60 * 0.11 + i;
    rigs[i].update(1 / 60, i * 3 + Math.sin(angle) * 14, Math.cos(angle) * 14,
      Math.PI / 2 - angle, ground, null, 0, !hide || i % 5 === 0);
  }
}
for (let f = 0; f < 300; f++) { frame(baseline, f, false); frame(deferred, f, true); }
const samples = [];
for (let run = 0; run < 5; run++) {
  let start = performance.now();
  for (let f = 0; f < 400; f++) frame(baseline, 300 + run * 400 + f, false);
  const before = (performance.now() - start) / 400;
  start = performance.now();
  for (let f = 0; f < 400; f++) frame(deferred, 300 + run * 400 + f, true);
  samples.push({ before, after: (performance.now() - start) / 400 });
}
const mean = (key) => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
console.log(JSON.stringify({
  threeRevision: THREE.REVISION,
  verified: 'Exact gait and visible/reset poses across hidden walking, turning, stops, jumps and relocation; player defaults unchanged',
  rigs: count, visible: visibleCount, samplesMsPerFrame: samples,
  meanMsPerFrame: { before: mean('before'), after: mean('after') },
  reductionPercent: (1 - mean('after') / mean('before')) * 100
}, null, 2));
