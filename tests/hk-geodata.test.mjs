import assert from 'node:assert/strict';
import test from 'node:test';
import { GEO } from '../js/hk-geodata.js';
import { toWorld, toLatLon, pointInRing, ringArea } from '../tools/hk/frame.mjs';

// Polygons & polylines are flat [x0, z0, x1, z1, ...] in the app, [[x, z]] in these helpers.
const pairs = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
const rings = () => GEO.land.map((l) => pairs(l.ring));
const onLand = (x, z) => rings().some((ring) => pointInRing(ring, x, z));

test('the Hong Kong pack is a v2 world with a true-north frame', () => {
  assert.equal(GEO.version, 2);
  assert.equal(GEO.world, 'hong-kong');
  assert.equal(GEO.frame.units, 'm');
  assert.equal(GEO.frame.northUp, true);
  assert.ok(GEO.frame.mPerDegLat > 110000 && GEO.frame.mPerDegLat < 112000);
  assert.ok(GEO.frame.mPerDegLon > 102000 && GEO.frame.mPerDegLon < 104000);
  assert.ok(Math.abs(GEO.frame.waterLevel + 2.2) < 1e-9);
});

test('north is −z and east is +x (the frame has no grid rotation)', () => {
  const clock = GEO.landmarks.find((l) => l.id === 'clock-tower');
  const ifc = GEO.landmarks.find((l) => l.id === 'ifc');
  // The clock tower is north of IFC across the harbour, so its z must be smaller.
  assert.ok(clock.z < ifc.z, 'the clock tower must be north (−z) of IFC');
  assert.ok(Math.abs(clock.x - ifc.x) < 1500, 'TST and Central are ~1 km apart east-west');
  // Causeway Bay is east of Central: its roads must have larger x.
  const yeeWo = GEO.roads.find((r) => r.en === 'Yee Wo Street');
  const connaught = GEO.roads.find((r) => r.en === 'Connaught Road Central');
  assert.ok(Math.min(...pairs(yeeWo.pts).map((p) => p[0])) > Math.max(...pairs(connaught.pts).map((p) => p[0])),
    'Yee Wo Street (Causeway Bay) must be east of Connaught Road Central');
});

test('projection round-trips to well under a millimetre', () => {
  for (const [lon, lat] of [[114.158, 22.282], [114.17, 22.3], [114.19, 22.28], [114.15, 22.26]]) {
    const [x, z] = toWorld([lon, lat]);
    const [lon2, lat2] = toLatLon([x, z]);
    assert.ok(Math.abs(lon2 - lon) < 1e-9, `lon ${lon}`);
    assert.ok(Math.abs(lat2 - lat) < 1e-9, `lat ${lat}`);
  }
});

test('roads are named in both languages and carry real widths', () => {
  assert.ok(GEO.roads.length >= 12, 'the seed network must cover the island and Kowloon');
  for (const road of GEO.roads) {
    assert.match(road.zh, /[\u4e00-\u9fff]/, `${road.en} needs a Chinese name`);
    assert.ok(road.en.length > 2);
    assert.ok(road.w >= 10 && road.w <= 40, `${road.en} width ${road.w}`);
    assert.ok(road.lanes >= 1 && road.lanes <= 4);
    assert.ok(pairs(road.pts).length >= 2);
    assert.ok(road.len === undefined || Number.isFinite(road.len));
  }
  // Both sides of the harbour must be represented.
  const names = GEO.roads.map((r) => r.en);
  assert.ok(names.includes('Nathan Road'), 'Kowloon side');
  assert.ok(names.includes('Hennessy Road'), 'island side');
});

test('every landmark stands on land, with a real height', () => {
  assert.ok(GEO.landmarks.length >= 20);
  for (const lm of GEO.landmarks) {
    assert.ok(lm.h > 0 && lm.h < 600, `${lm.en} height`);
    assert.ok(lm.w > 0 && lm.d > 0);
    assert.ok(onLand(lm.x, lm.z), `${lm.en} (${lm.id}) is in the harbour`);
    assert.ok(GEO.districts.some((d) => d.id === lm.district));
  }
  const icc = GEO.landmarks.find((l) => l.id === 'icc');
  assert.ok(icc.h > 450, 'ICC is 484 m');
});

test('buildings front the streets and never sit on the roadway', () => {
  assert.ok(GEO.buildings.length > 400, `only ${GEO.buildings.length} buildings generated`);
  const halfWidth = new Map(GEO.roads.map((r) => [r.en, r.w / 2]));
  let checked = 0;
  for (const b of GEO.buildings) {
    assert.ok(b.h >= 20 && b.h <= 320, `building height ${b.h}`);
    assert.ok(b.w > 8 && b.d > 8 && b.w < 30 && b.d < 24, `footprint ${b.w}×${b.d}`);
    assert.ok(onLand(b.x, b.z), `building at ${b.x},${b.z} is in the harbour`);
    assert.ok(Number.isFinite(b.rot));
    assert.ok(GEO.districts.some((d) => d.id === b.district));
    checked++;
    if (checked > 300) break;
  }
  // The generator places each lot at roadHalf + footway + depth/2 from the centreline, so no building centre
  // may be within the carriageway of the road it fronts.
  for (const b of GEO.buildings.slice(0, 200)) {
    const road = GEO.roads.find((r) => r.en === b.road) || GEO.roads.find((r) => Math.abs(r.w / 2 - (halfWidth.get(r.en) || 0)) < 99);
    if (!road) continue;
    let best = Infinity;
    const pts = pairs(road.pts);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((b.x - ax) * dx + (b.z - az) * dz) / l2));
      best = Math.min(best, Math.hypot(ax + t * dx - b.x, az + t * dz - b.z));
    }
    assert.ok(best > road.w / 2 + 2, `building ${Math.round(best)} m from ${road.en} centreline`);
  }
});

test('land outlines enclose real area and the harbour separates them', () => {
  assert.ok(GEO.land.length >= 2);
  for (const l of GEO.land) {
    assert.ok(Math.abs(ringArea(pairs(l.ring))) > 1e6, `${l.en} is suspiciously small`);
    assert.match(l.zh, /[\u4e00-\u9fff]/);
  }
  const island = pairs(GEO.land.find((l) => l.id === 'hk-island').ring);
  const kowloon = pairs(GEO.land.find((l) => l.id === 'kowloon').ring);
  // A point in the middle of Victoria Harbour belongs to neither.
  const harbour = toWorld([114.166, 22.289]);
  assert.ok(!pointInRing(island, harbour[0], harbour[1]));
  assert.ok(!pointInRing(kowloon, harbour[0], harbour[1]));
});

test('transport data is present: tram line, Star Ferry, harbour tunnel', () => {
  assert.ok(GEO.tram.length >= 8);
  assert.equal(GEO.ferry.piers.length, 2);
  assert.ok(GEO.ferry.minutes > 0);
  assert.equal(GEO.tunnels.length, 1);
  assert.match(GEO.tunnels[0].zh, /海底隧道/);
});
