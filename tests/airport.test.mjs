import assert from 'node:assert/strict';
import test from 'node:test';

test("the airport's runway, taxiways, apron and gates are in the map, and no block covers them", async () => {
  const { GEO } = await import('../js/world/city-geodata.js');
  const { box } = GEO.frame;
  const a = GEO.airport;
  assert.match(a.name, /Tepic/);
  const inside = (x, z) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;
  // runway 02/20: ~3.1 km long, 45 m wide, running about along the grid's z
  const [ref, width, pts] = a.runways[0];
  assert.equal(ref, '02/20');
  assert.equal(width, 45);
  const [x0, z0] = pts, [x1, z1] = pts.slice(-2);
  assert.ok(inside(x0, z0) && inside(x1, z1));
  const len = Math.hypot(x1 - x0, z1 - z0);
  assert.ok(len > 2900 && len < 3300, `runway ${len.toFixed(0)} m`);
  assert.ok(a.taxiways.length > 20 && a.aprons.length >= 1 && a.gates.length === 4);
  // the terminal side of the apron is inside the extended box too
  const apron = a.aprons[0];
  for (let i = 0; i < apron.length; i += 2) assert.ok(inside(apron[i], apron[i + 1]), 'the whole apron is in the box');
  // the runway's centreline crosses no block (the builder cuts it out of them, like a road)
  const inRing = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) c = !c;
    }
    return c;
  };
  for (let t = 0.02; t < 1; t += 0.04) {
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    assert.ok(!GEO.blocks.some(([poly]) => inRing(poly, x, z)), `no block on the runway at ${x.toFixed(0)}, ${z.toFixed(0)}`);
  }
  // and the hills are levelled under it (they would poke through its pavement)
  const t = GEO.terrain;
  const buf = Buffer.from(t.data, 'base64');
  const hills = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const hillAt = (x, z) => {
    const fx = (x - t.x0) / t.cell, fz = (z - t.z0) / t.cell, i = Math.floor(fx), j = Math.floor(fz), u = fx - i, w = fz - j;
    const g = (a, b) => hills[b * t.w + a] / 10;
    return g(i, j) * (1 - u) * (1 - w) + g(i + 1, j) * u * (1 - w) + g(i, j + 1) * (1 - u) * w + g(i + 1, j + 1) * u * w;
  };
  for (let t2 = 0; t2 <= 1; t2 += 0.02) {
    for (const off of [-width / 2, 0, width / 2]) assert.equal(hillAt(x0 + (x1 - x0) * t2 + off, z0 + (z1 - z0) * t2), 0, 'no hill over the runway');
  }
  assert.ok(GEO.teleports.aeropuerto, 'a teleport to the terminal');
});
