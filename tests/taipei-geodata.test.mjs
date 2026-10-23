import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildingHeight, estimateHeight, parseMetres, LEVEL_M } from '../tools/geo-height.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('heights prefer the height tag, then storeys, then an estimate', () => {
  assert.deepEqual(buildingHeight({ building: 'apartments', height: '42', 'building:levels': '5' }, 400), { top: 42, base: 0, source: 'height' });
  assert.deepEqual(buildingHeight({ building: 'apartments', 'building:levels': '5' }, 400), { top: 5 * LEVEL_M, base: 0, source: 'levels' });
  assert.equal(buildingHeight({ building: 'apartments' }, 400).source, 'estimate');
  assert.equal(parseMetres('93.2m'), 93.2);
  assert.equal(parseMetres('100 ft'), 30.48);
  assert.equal(parseMetres('tall'), null);
});

test('parts stack on min_height or building:min_level and roofs are thin slabs', () => {
  assert.deepEqual(buildingHeight({ 'building:part': 'yes', height: '508', min_height: '448' }, 3), { top: 508, base: 448, source: 'height' });
  assert.equal(buildingHeight({ 'building:part': 'yes', 'building:levels': '20', 'building:min_level': '10' }, 300).base, 10 * LEVEL_M);
  const roof = buildingHeight({ building: 'roof' }, 200);
  assert.ok(roof.top > roof.base && roof.top - roof.base < 1, JSON.stringify(roof));
});

test('estimates vary with footprint and type instead of one flat default', () => {
  const sizes = [80, 200, 500, 1200, 3000];
  const apartments = sizes.map((a) => estimateHeight('apartments', a));
  for (let i = 1; i < sizes.length; i++) assert.ok(apartments[i] >= apartments[i - 1], `non-decreasing: ${apartments}`);
  assert.ok(new Set(apartments).size >= 4, `distinct: ${apartments}`);
  assert.ok(estimateHeight('house', 1000) < estimateHeight('apartments', 1000));
  assert.ok(estimateHeight('office', 2000) > estimateHeight('retail', 2000));
});

test('Taipei geodata builds with Taipei 101 at 508 m and labelled height sources', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taipei 台北 '));
  try {
    const out = path.join(dir, 'taipei-geodata.js');
    const result = spawnSync(process.execPath, [path.join(root, 'tools/build-taipei-geodata.mjs'), out], { encoding: 'utf8', timeout: 60000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { GEO } = await import(pathToFileURL(out).href);
    assert.equal(GEO.city, 'taipei');
    assert.deepEqual(GEO.heightSources, ['height', 'levels', 'estimate']);
    assert.equal(GEO.landmarks['Taipei 101'].top, 508);
    assert.ok(Math.hypot(GEO.landmarks['Taipei 101'].x, GEO.landmarks['Taipei 101'].z) < 60, 'Taipei 101 sits at the origin');
    assert.ok(GEO.buildings.length > 800, `${GEO.buildings.length} buildings`);
    const tops = [];
    for (const [id, outer, holes, top, base, source, kind] of GEO.buildings) {
      assert.match(id, /^[wr]\d+$/);
      assert.ok(outer.length >= 6 && outer.length % 2 === 0, id);
      assert.ok(Array.isArray(holes), id);
      assert.ok(top > base && base >= 0, `${id}: ${base}..${top}`);
      assert.ok(source >= 0 && source < GEO.heightSources.length && kind >= 0 && kind < GEO.kinds.length, id);
      tops.push(top);
    }
    // Skyline variation: no single height dominates, and 101 stands far above everything else
    const counts = new Map();
    for (const t of tops) counts.set(t, (counts.get(t) || 0) + 1);
    assert.ok(Math.max(...counts.values()) < tops.length * 0.2, 'one height covers 20%+ of buildings');
    assert.ok(tops.filter((t) => t > 300).every((t) => t >= 386), 'only Taipei 101 rises past 300 m');
    assert.ok(GEO.buildings.some((b) => GEO.heightSources[b[5]] === 'estimate'), 'estimates are labelled');

    // Road graph: same shape as NYC's GEO.roadGraph, with Xinyi's main streets
    const RG = GEO.roadGraph;
    const nodeCount = RG.nodes.length / 2;
    assert.ok(RG.links.length > 300, `${RG.links.length} links`);
    for (const [a, b, ni, w, lanes, dir, inner] of RG.links) {
      assert.ok(a >= 0 && a < nodeCount && b >= 0 && b < nodeCount && a !== b, `link ${a}-${b}`);
      assert.ok(ni >= 0 && ni < RG.names.length && w > 0 && lanes >= 1 && [-1, 0, 1].includes(dir) && inner.length % 2 === 0);
    }
    for (const name of ['Songzhi Road', 'Songren Road', 'Keelung Road', 'Xinyi Road']) {
      assert.ok(RG.names.some((n) => n.includes(name)), `${name} in the road graph`);
    }
    // Junctions: most nodes join two or more links
    const degree = new Uint16Array(nodeCount);
    for (const [a, b] of RG.links) { degree[a]++; degree[b]++; }
    assert.ok(degree.filter((d) => d >= 2).length > nodeCount * 0.6, 'graph is connected at junctions');
    for (const [k, w, elev, pts] of GEO.paths) {
      assert.ok(k >= 0 && k < GEO.pathKinds.length && w > 0 && elev >= 0 && pts.length >= 4 && pts.length % 2 === 0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
