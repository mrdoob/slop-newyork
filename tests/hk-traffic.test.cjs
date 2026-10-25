const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const test = require('node:test');

// A synchronous infinite loop cannot be interrupted from inside a test process, so the Hong Kong traffic
// system is built in a child process with a hard timeout. This is the regression test for the bug that made
// the browser report "Page Unresponsive": the fleet capacities summed to 95 while 96 cars were requested, and
// the "find a fleet with room" while-loop never terminated.
const root = join(__dirname, '..');
const harness = join(__dirname, 'helpers', 'hk-traffic-harness.cjs');

test('the traffic system builds and simulates without hanging', () => {
  const result = spawnSync(process.execPath, [harness], { timeout: 20000, encoding: 'utf8' });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail('building the Hong Kong traffic system did not finish in 20 s — infinite loop?');
  }
  assert.equal(result.status, 0, `harness failed:\n${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(report.cars, 96, 'every requested AI car must exist');
  assert.ok(report.lanes >= 60, `only ${report.lanes} lanes`);
  assert.equal(report.buses, 8);
  assert.equal(report.minibuses, 10);
  assert.equal(report.trams, 3);
  assert.ok(report.finite, 'a car ended up at a non-finite distance along its lane');
  assert.ok(report.buildMs < 2000, `traffic build took ${report.buildMs} ms`);
  assert.ok(report.frameMs < 8, `traffic update costs ${report.frameMs} ms/frame`);
});

test('fleet allocation always adds up to the number of cars requested', () => {
  const { allocateFleet } = require('../js/hk/fleet.js');
  const shares = [0.46, 0.22, 0.16, 0.16];
  for (const total of [0, 1, 2, 3, 4, 7, 96, 97, 100, 233, 1000]) {
    const counts = allocateFleet(shares, total);
    assert.equal(counts.length, shares.length);
    assert.equal(counts.reduce((a, b) => a + b, 0), total, `allocation for ${total}`);
    for (const n of counts) assert.ok(Number.isInteger(n) && n >= 0);
  }
  assert.deepEqual(allocateFleet(shares, 96), [44, 21, 16, 15]);
  assert.deepEqual(allocateFleet([1], 96), [96]);
  assert.deepEqual(allocateFleet([0, 0], 10), [10, 0], 'a zero-share fleet never takes cars');
  assert.deepEqual(allocateFleet([], 10), []);
  assert.deepEqual(allocateFleet(shares, 0), [0, 0, 0, 0]);
});

test('traffic.js no longer contains an unbounded fleet search', () => {
  const source = require('node:fs').readFileSync(join(root, 'js', 'hk', 'traffic.js'), 'utf8');
  assert.doesNotMatch(source, /while\s*\(\s*fleets\[[^\]]+\]\.cars\.length/, 'the fleet-scanning while-loop must stay gone');
  assert.match(source, /allocateFleet/, 'traffic.js must size its fleets with allocateFleet');
  // and the tram helper it needs must exist
  assert.match(source, /function withLength\(/, 'tramLine needs withLength()');
});
