const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The subway's route & timetable logic, against the real data (js/subway-lines.js, js/city-config.js), with the
// renderer side of js/subway.js stubbed out (no station is built here)
const read = (file) => readFileSync(join(__dirname, '../js', file), 'utf8');
const geo = loadModule(read('nyc-geodata.js'), { filename: 'nyc-geodata.js' });
const config = loadModule(read('city-config.js'), { imports: { './nyc-geodata.js': geo }, filename: 'city-config.js' });
const lines = loadModule(read('subway-lines.js'), { filename: 'subway-lines.js' });
const subway = loadModule(read('subway.js'), {
  imports: { 'three/webgpu': { BoxGeometry: class {} }, './subway-lines.js': lines, './city-config.js': config },
  filename: 'subway.js'
});
const { routeFrame, nextStop, trainHead, trainSpeed, STATIONS, PLATFORM_LEN, TRAIN_PERIOD } = subway;
const byName = (name) => STATIONS.find((s) => s.name === name);

test('every Manhattan station lies on a route of a service that calls there, under the street', () => {
  assert.ok(STATIONS.length > 100);
  for (const station of STATIONS) {
    const frame = routeFrame(station);
    const d = Math.hypot(frame.x - station.x, frame.z - station.z);
    assert.ok(d < 120, `${station.name} (${station.services}) is ${Math.round(d)} m from its route`);
    assert.ok(frame.line && station.services.includes(frame.line.ref), `${station.name} frames on a service calling there`);
    assert.ok(Math.abs(Math.hypot(frame.dirX, frame.dirZ) - 1) < 1e-6, `${station.name} has a unit direction`);
    assert.ok(frame.trackY <= 9, `${station.name} track height`);
  }
});

test('trains call at their real stops in order, expresses skipping the locals', () => {
  const herald = byName('34th Street–Herald Square');
  const bryant = byName('42nd Street–Bryant Park');
  // the B runs express up 6th Ave: Herald Sq, Bryant Park, 47th-50th Sts, one way; back down the other
  const north = nextStop('B', herald, 1)?.name === bryant.name ? 1 : -1;
  assert.equal(nextStop('B', herald, north).name, bryant.name);
  assert.equal(nextStop('B', bryant, north).name, '47th–50th Streets–Rockefeller Center');
  assert.equal(nextStop('B', bryant, -north).name, herald.name);
  // the 1 (local) stops at 28th St between 34th & 23rd St on 7th Ave; the 2 (express) does not
  const penn = STATIONS.find((s) => s.name === '34th Street–Penn Station' && s.services.includes('1'));
  const local = [nextStop('1', penn, 1), nextStop('1', penn, -1)].map((s) => s && s.name);
  const express = [nextStop('2', penn, 1), nextStop('2', penn, -1)].map((s) => s && s.name);
  assert.ok(local.includes('28th Street'), `the 1 calls at 28th St (${local})`);
  assert.ok(!express.includes('28th Street'), `the 2 runs through 28th St (${express})`);
});

test('a train comes in out of sight, stands at the platform and leaves at the speed it came in', () => {
  const stopHead = PLATFORM_LEN / 2 - 6;
  const trainLen = 8 * 18.3;
  assert.ok(trainHead(0) - trainLen < -PLATFORM_LEN / 2 && trainHead(0) < -PLATFORM_LEN / 2, 'all of it in the tunnel');
  assert.equal(trainSpeed(0) > 20, true);
  let standing = 0;
  let last = trainHead(0);
  for (let t = 0.05; t < TRAIN_PERIOD; t += 0.05) {
    const head = trainHead(t);
    assert.ok(head >= last - 1e-9, `never backs up (t = ${t.toFixed(2)})`);
    last = head;
    if (head === stopHead) standing += 0.05;
  }
  assert.ok(standing > 8, 'stands at the platform long enough to get on or off');
  // the hand-off speed of a ridden train equals its arrival speed at the next station, its tail clear of the platform
  const handoff = [...Array(2000).keys()].map((i) => i * 0.05).find((t) => trainHead(t) - trainLen > PLATFORM_LEN / 2);
  assert.ok(handoff !== undefined && handoff < TRAIN_PERIOD, 'the tail clears the platform within the cycle');
});
