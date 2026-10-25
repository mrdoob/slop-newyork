import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// End-to-end: build the whole Hong Kong scene with the *real* three.js (no GPU needed) and simulate frames.
// Skipped automatically when three is not installed, so `node --test` still works on a bare checkout:
//   npm install three@0.186.1 --no-save && node --test tests/hk-smoke.test.mjs
const threePath = new URL('../node_modules/three/package.json', import.meta.url);

test('Hong Kong builds and simulates with real three.js', { skip: existsSync(threePath) ? false : 'three is not installed (npm install three@0.186.1 --no-save)' }, () => {
  const result = spawnSync(process.execPath, ['tools/smoke-hk.mjs'], {
    cwd: new URL('..', import.meta.url),
    timeout: 120000,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `smoke test failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /✓ Hong Kong builds and simulates headlessly/);
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1));
  assert.equal(report.counts.buildings, 1349);
  assert.equal(report.counts.roads, 17);
  assert.equal(report.traffic.cars, 96);
  assert.ok(report.triangles > 50000, `only ${report.triangles} triangles`);
  assert.ok(report.meshes > 100, `only ${report.meshes} meshes`);
  assert.ok(report.lights >= 2, `only ${report.lights} lights — the scene would render black`);
  assert.ok(report.instances > 1000, `only ${report.instances} instances`);
  assert.ok(report.frameMs < 8, `simulation costs ${report.frameMs} ms/frame`);
  assert.match(report.playerDistrict, /[\u4e00-\u9fff]/);
});
