import fs from 'node:fs';
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

test('Taipei Xinyi box is the district bounding box and contains Taipei 101', () => {
  const [s, w, n, e] = BOX;
  assert.ok(s < 25.033964 && n > 25.033964 && w < 121.564468 && e > 121.564468, 'Taipei 101 (the origin) inside');
  // every vertex of the district outline (OSM relation 2881027) lies in the box, which hugs it within ~50 m
  const rel = JSON.parse(fs.readFileSync(new URL('../tools/data-taipei/osm_boundary.json', import.meta.url))).elements.find((x) => x.id === 2881027);
  const pts = rel.members.flatMap((m) => m.geometry || []);
  assert.ok(pts.length > 100 && pts.every((p) => p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e), 'district inside the box');
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  for (const [a, b] of [[s, Math.min(...lats)], [n, Math.max(...lats)], [w, Math.min(...lons)], [e, Math.max(...lons)]]) assert.ok(Math.abs(a - b) < 0.0005);
});

test('theta is the bearing of frame north and origin shifts the frame', () => {
  const f = makeFrame({ lat0: 0, lon0: 0, theta: Math.PI / 2, origin: [10, 0] });
  const [x, z] = f.toWorld(0, 0.001); // frame north points due east, so due north lies to frame west
  assert.ok(Math.abs(x - (-110.6 - 10)) < 0.5 && Math.abs(z) < 1e-9, `(${x}, ${z})`);
});
