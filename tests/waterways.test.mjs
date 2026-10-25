import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNELS, createWaterways, cutHoles } from '../js/world/waterways.js';
import { GEO } from '../js/world/city-geodata.js';
import { waterways, groundHeight, landHeight, townHeight } from '../js/world/ground.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} should equal ${b}`);

// A river flowing east along z = 0 for 200 m (the blocks 6 m either side), over a floor falling 1 m per 100 m east,
// and a street 10 m wide crossing it at x = 100
const river = [['river', 6, 'Río de prueba', 0, [0, 0, 200, 0]]];
const floor = (x) => 50 - x / 100;
const street = [{ w: 10, pts: [100, -40, 100, 40] }];

test('a river is cut into the town floor: a flat bed between sloping banks, nothing past them', () => {
  const w = createWaterways(river, { floor });
  const { depth, margin, bed } = CHANNELS.river;
  const half = 6 - margin;
  const [ch] = w.channels;
  assert.equal(ch.half, half);
  close(ch.bedHalf, half * bed);
  // the bed, the bank halfway up, and the street's level past the bank's top
  close(w.offset(50, 0), -depth);
  close(w.offset(50, ch.bedHalf + (half - ch.bedHalf) / 2), -depth / 2);
  assert.equal(w.offset(50, half + 0.01), 0);
  assert.equal(w.offset(50, 30), 0);
  // its square ends: nothing before the first cross-section or past the last
  assert.equal(w.offset(-1, 0), 0);
  assert.equal(w.offset(201, 0), 0);
});

test('the water runs downhill: the bed never rises downstream, but sinks no more than 2 m extra', () => {
  // a floor that dips 3 m in the middle and rises again
  const bumpy = (x) => 50 - 3 * Math.exp(-(((x - 100) / 20) ** 2));
  const w = createWaterways(river, { floor: bumpy });
  const bedAt = (s) => s.rel + bumpy(s.x);
  const { s } = w.channels[0];
  for (let i = 1; i < s.length; i++) assert.ok(bedAt(s[i]) <= bedAt(s[i - 1]) + 1e-9 || s[i].rel >= -CHANNELS.river.depth - 2 - 1e-9);
  assert.ok(Math.min(...s.map((p) => p.rel)) >= -CHANNELS.river.depth - 2 - 1e-9);
});

test('a street crossing a river bridges it: its deck on top, the channel under it for a body down in it', () => {
  const w = createWaterways(river, { floor, roads: street });
  // on the street (no height given, or coming from the deck): no channel
  assert.equal(w.offset(100, 0), 0);
  assert.equal(w.offset(100, 0, floor(100)), 0);
  // in the channel, metres under the deck: the bed
  close(w.offset(100, 0, floor(100) - 3), -CHANNELS.river.depth);
  // and the hole in the deck stops short of the street
  const holes = w.holes();
  assert.ok(holes.length > 0);
  for (let k = 0; k < holes.length; k += 2) assert.ok(Math.abs(holes[k] - 100) > 5, `hole vertex at x = ${holes[k]}`);
  const { bridges } = w.meshData();
  assert.ok(bridges.position.length > 0, 'the deck is seen from below');
});

test('a river under the hills is neither cut nor drawn', () => {
  const w = createWaterways(river, { floor, hills: (x) => (x < 80 ? 5 : 0) });
  assert.equal(w.offset(40, 0), 0);
  close(w.offset(150, 0), -CHANNELS.river.depth);
  const { banks } = w.meshData();
  for (let k = 0; k < banks.position.length; k += 3) assert.ok(banks.position[k] >= 77);
});

test('culverts, drains and ways with no gap between the blocks are left to the maps', () => {
  const w = createWaterways([
    ['stream', 2.5, '', 2, [0, 0, 100, 0]],
    ['drain', 0, '', 0, [0, 10, 100, 10]],
    ['canal', 0, '', 0, [0, 20, 100, 20]]
  ]);
  assert.equal(w.channels.length, 0);
});

test('holes are cut out of a triangle with its attributes carried along the cuts', () => {
  // a 20 x 20 m square of two triangles, uv = its x/20, z/20; a 4 x 4 m square hole in its middle
  const pos = Float32Array.from([0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 0, 20, 0, 20, 0, 0, 20]);
  const uv = Float32Array.from([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
  const holes = [8, 8, 12, 8, 12, 12, 8, 8, 12, 12, 8, 12];
  const [p, t] = cutHoles([pos, uv], [3, 2], null, holes);
  let area = 0;
  for (let k = 0; k < p.length; k += 9) {
    const ux = p[k + 3] - p[k], uz = p[k + 5] - p[k + 2], vx = p[k + 6] - p[k], vz = p[k + 8] - p[k + 2];
    area += Math.abs(ux * vz - uz * vx) / 2;
    // no piece reaches into the hole
    const cx = (p[k] + p[k + 3] + p[k + 6]) / 3, cz = (p[k + 2] + p[k + 5] + p[k + 8]) / 3;
    assert.ok(!(cx > 8 && cx < 12 && cz > 8 && cz < 12));
  }
  close(area, 400 - 16, 1e-3);
  for (let v = 0; v < p.length / 3; v++) {
    close(t[v * 2], p[v * 3] / 20, 1e-5);
    close(t[v * 2 + 1], p[v * 3 + 2] / 20, 1e-5);
  }
});

test('Tepic: the Río Mololoa runs through town in a channel the ground everyone stands on drops into', () => {
  assert.ok(GEO.waterways.some(([kind, , name]) => kind === 'river' && /Mololoa/.test(name)));
  const mololoa = waterways.channels.filter((c) => /Mololoa/.test(c.name));
  assert.ok(mololoa.length > 0);
  const bridges = mololoa.reduce((n, c) => n + c.s.filter((p) => p.bridge).length, 0);
  assert.ok(bridges > 20, `${bridges} cross-sections under bridges`);
  // somewhere along it, off any bridge: the ground under the town's floor, the land itself unchanged
  const p = mololoa[0].s.find((q, i, s) => i > 10 && !q.hill && !q.bridge && !s[i - 1].bridge && !s[i + 1]?.bridge);
  assert.ok(groundHeight(p.x, p.z) < townHeight(p.x, p.z) - CHANNELS.river.depth + 0.01);
  close(landHeight(p.x, p.z), townHeight(p.x, p.z), 1e-3);
});
