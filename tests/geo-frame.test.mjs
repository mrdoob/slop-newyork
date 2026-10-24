import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFrame } from '../tools/geo-frame.mjs';
import { frame as taipei, BOX } from '../tools/geo-taipei-base.mjs';

test('Taipei frame puts Taipei 101 at the origin, north-up, in metres', () => {
  assert.ok(taipei.toWorld(121.564468, 25.033964).every((v) => v === 0)); // 0 or -0
  const [xe, ze] = taipei.toWorld(121.564468 + 0.001, 25.033964);
  const [xn, zn] = taipei.toWorld(121.564468, 25.033964 + 0.001);
  assert.ok(Math.abs(xe - 100.9) < 0.5 && ze === 0, `0.001° east -> (${xe}, ${ze})`); // ~101 km per degree of lon at 25° N
  assert.ok(xn === 0 && Math.abs(zn + 110.8) < 0.5, `0.001° north -> (${xn}, ${zn})`); // north is -z
});

test('Taipei 2 km test box is centred on the origin, ±1 km each way', () => {
  const [s, w, n, e] = BOX;
  const [x0, z1] = taipei.toWorld(w, s);
  const [x1, z0] = taipei.toWorld(e, n);
  for (const v of [x0, z0]) assert.ok(v < -980 && v > -1020, `west/north edge ${v}`);
  for (const v of [x1, z1]) assert.ok(v > 980 && v < 1020, `east/south edge ${v}`);
});

test('theta is the bearing of frame north and origin shifts the frame', () => {
  const f = makeFrame({ lat0: 0, lon0: 0, theta: Math.PI / 2, origin: [10, 0] });
  const [x, z] = f.toWorld(0, 0.001); // frame north points due east, so due north lies to frame west
  assert.ok(Math.abs(x - (-110.6 - 10)) < 0.5 && Math.abs(z) < 1e-9, `(${x}, ${z})`);
});
