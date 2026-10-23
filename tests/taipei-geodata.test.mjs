import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildingHeight, estimateHeight, parseMetres, LEVEL_M } from '../tools/geo-height.mjs';
import { buildOsmRoadGraph } from '../tools/geo-osm-roadgraph.mjs';
import { roofOf, facadeOf } from '../tools/geo-building-style.mjs';
import { fitRoadWidths, inferSidewalks } from '../tools/geo-sidewalks.mjs';

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

test('roof shapes and facade styles come from OSM tags', () => {
  assert.deepEqual(roofOf({ 'roof:shape': 'dome', 'roof:height': '8' }, 400, 30, 0), { shape: 'dome', height: 8, colour: 0 });
  assert.equal(roofOf({ 'roof:shape': 'gambrel' }, 400, 30, 0).shape, 'flat', 'unsupported shapes draw flat');
  assert.ok(roofOf({ 'roof:shape': 'hipped' }, 400, 12, 0).height <= 12 * 0.4, 'untagged roof height stays proportionate');
  assert.equal(roofOf({ 'roof:colour': 'green' }, 400, 30, 0).colour, 'green');
  assert.equal(facadeOf({}, 'office', 120, 0), 'curtain');
  assert.equal(facadeOf({ 'building:material': 'glass' }, 'apartments', 20, 0), 'curtain');
  assert.equal(facadeOf({}, 'apartments', 40, 0), 'punched');
  assert.equal(facadeOf({}, 'retail', 15, 0), 'podium');
  assert.equal(facadeOf({}, 'roof', 4, 3.4), 'none');
});

test('road widths fit mapped sidewalks and missing sidewalks are inferred from tags', () => {
  const way = (id, nodes, tags, pts) => ({ type: 'way', id, nodes, tags, geometry: pts.map(([x, z]) => ({ lon: x, lat: z })) });
  const toWorld = (lon, lat) => [lon, lat];
  // A 200 m untagged street along x (class default 6.5 m) flanked by mapped sidewalks 10 m either side,
  // a street tagged sidewalk=no, and one with sidewalks mapped separately
  const { roadGraph, paths } = buildOsmRoadGraph([
    way(1, [1, 2], { highway: 'tertiary' }, [[0, 0], [200, 0]]),
    way(2, [3, 4], { highway: 'footway', footway: 'sidewalk' }, [[0, -10], [200, -10]]),
    way(3, [5, 6], { highway: 'footway', footway: 'sidewalk' }, [[0, 10], [200, 10]]),
    way(4, [7, 8], { highway: 'tertiary', sidewalk: 'no' }, [[0, 500], [200, 500]]),
    way(5, [9, 10], { highway: 'tertiary' }, [[0, 1000], [200, 1000]])
  ], toWorld);
  const kinds = ['footway', 'crossing', 'pedestrian', 'cycleway', 'steps', 'path', 'sidewalk'];
  fitRoadWidths(roadGraph, paths, kinds);
  assert.equal(roadGraph.links[0][3], 2 * (10 - 2.5 / 2), 'kerb to kerb between the mapped sidewalks');
  assert.equal(roadGraph.widthSource[0], 3);
  assert.equal(roadGraph.links[1][3], 6.5, 'no sidewalks mapped: width unchanged');
  const inferred = inferSidewalks(roadGraph, paths, kinds);
  assert.equal(inferred.filter(([line]) => Math.abs(line[0][1]) < 50).length, 0, 'street with mapped sidewalks gets none');
  assert.equal(inferred.filter(([line]) => Math.abs(line[0][1] - 500) < 50).length, 0, 'sidewalk=no gets none');
  const both = inferred.filter(([line]) => Math.abs(line[0][1] - 1000) < 50);
  assert.equal(both.length, 2, 'untagged street gets one each side');
  assert.ok(both.every(([, w, src]) => w > 0 && src === 'inferred'));
});

test('underground ways are left out and skywalk stairs ramp to the ground', () => {
  const way = (id, nodes, tags) => ({ type: 'way', id, nodes, tags, geometry: nodes.map((n) => ({ lon: n, lat: 0 })) });
  const toWorld = (lon) => [lon * 10, 0];
  const { roadGraph, paths } = buildOsmRoadGraph([
    way(1, [0, 1], { highway: 'footway', layer: '-1' }), // underground walkway tagged only with layer
    way(2, [2, 3], { highway: 'service', layer: '-1' }), // parking ramp
    way(3, [4, 5], { highway: 'footway', tunnel: 'building_passage' }),
    way(4, [6, 7], { highway: 'residential' }),
    way(5, [8, 9], { highway: 'footway', bridge: 'yes', layer: '1' }), // skywalk deck
    way(6, [9, 10], { highway: 'steps', bridge: 'yes', layer: '1' }) // stairs down from its end
  ], toWorld);
  assert.equal(roadGraph.links.length, 1, 'only the at-grade road');
  assert.equal(paths.length, 2, 'deck and stairs, no underground walkways');
  const [deck, stairs] = paths;
  assert.ok(deck[2] > 0 && deck[4] === 0, 'flat elevated deck');
  assert.deepEqual(stairs[4], [deck[2], 0], 'stairs start at the deck and end on the ground');
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
    for (const [id, outer, holes, top, base, source, kind, , roof, roofH, , facade] of GEO.buildings) {
      assert.ok(roof >= 0 && roof < GEO.roofShapes.length && roofH >= 0 && roofH <= top - base && facade >= 0 && facade < GEO.facades.length, id);
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
    // Roof shapes from OSM roof:shape; Taipei 101 (building:material=mirror) reads as a glass curtain wall
    assert.ok(GEO.buildings.some((b) => GEO.roofShapes[b[8]] === 'dome') && GEO.buildings.some((b) => GEO.roofShapes[b[8]] === 'hipped'));
    const tallest = GEO.buildings.reduce((a, b) => (b[3] > a[3] ? b : a));
    assert.equal(GEO.facades[tallest[11]], 'curtain');

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
    assert.equal(RG.widthSource.length, RG.links.length);
    for (const [k, w, elev, pts, heights, src] of GEO.paths) {
      assert.ok(k >= 0 && k < GEO.pathKinds.length && w > 0 && elev >= 0 && pts.length >= 4 && pts.length % 2 === 0);
      assert.ok(src >= 0 && src < GEO.pathSources.length);
      if (heights) assert.equal(heights.length, pts.length / 2, 'one height per ramp point');
    }
    // Signals sit on graph nodes; trees and green areas carry their source / kind
    assert.ok(RG.signals.length > 50 && RG.signals.every((n) => n >= 0 && n < nodeCount), `${RG.signals.length} signals`);
    assert.ok(GEO.trees.length > 100 && GEO.trees.every(([x, z, src, h]) => Number.isFinite(x + z + h) && src >= 0 && src < GEO.treeSources.length));
    assert.ok(GEO.trees.some(([, , src]) => GEO.treeSources[src] === 'osm tree'), 'mapped trees');
    assert.ok(GEO.green.length > 0 && GEO.green.every(([k, ring]) => k >= 0 && k < GEO.greenKinds.length && ring.length >= 6));
    // Skywalk stairs ramp down to the ground
    assert.ok(GEO.paths.some(([kind, , elev, , heights]) => GEO.pathKinds[kind] === 'steps' && elev > 0 && heights && Math.min(...heights) === 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
