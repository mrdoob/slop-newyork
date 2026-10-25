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
  assert.ok(report.frameMs < 12, `traffic update costs ${report.frameMs} ms/frame`);
  // 「啲車好似棋子咁跳」的回歸測試：200 幀之内冇任何一架車換車道
  assert.equal(report.laneChanges, 0, `${report.laneChanges} 架車喺自己條街中途跳去第二條車道`);
  assert.equal(report.heavyLaneChanges, 0, `${report.heavyLaneChanges} 架巴士／小巴中途跳車道`);
  assert.ok(report.minSameLaneGap > 1.5, `同一條車道有車疊在一起（最細間距 ${report.minSameLaneGap} m）`);
  // 撞車反應
  assert.equal(report.bumpHit, true, '玩家貼住一架車都冇碰撞反應');
  assert.ok(report.bumpedSpeed < 3, `撞車之後速度仍然係 ${report.bumpedSpeed} m/s`);
  assert.ok(report.pushedBy > 1, `撞車之後只推開 ${report.pushedBy} m`);
  // 用戶截圖「巴士穿過我架車」：玩家貼在 11.8 m 長的巴士中段旁邊（距中心 4.7 m）也要偵測到，
  // 而且要推到完全離開車身矩形（半闊 1.28 m）＋玩家半徑 1.35 m。
  assert.equal(report.busSideHit, true, '玩家貼住巴士中段旁邊竟然冇碰撞 —— 舊版用「中心點距離」就是這個 bug');
  assert.ok(report.busClearance > 1.3, `推開之後仍然在巴士車身內（離車身只有 ${report.busClearance} m）`);
  assert.equal(report.busStopped, 0, '撞到玩家的巴士要即刻停車，唔可以一路頂住推');
  assert.ok(report.busSlowed < 11, `玩家在前方 12 m 時巴士應該收油（仍然 ${report.busSlowed} m/s）`);
  // 「汽車穿過電車」的回歸測試：AI 車道唔可以疊在電車軌上
  assert.ok(report.lanesOnTramTracks >= 1, `應該有車道因為壓住電車軌而被剔走（實際 ${report.lanesOnTramTracks}）`);
  assert.ok(report.tramNear / report.tramSamples < 0.01, `${report.tramNear}/${report.tramSamples} 個車道取樣點仍然貼住電車軌 —— 汽車會穿過電車`);
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
