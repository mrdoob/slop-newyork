import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  createFrame, parseLength, parseYear, buildingHeight, buildingYear, canonicalRing, canonicalPolygons, joinWays,
  selfIntersects, signedArea, extract, packBuildings, packTrees, buildingModule, treeModule, parseArgs, overpassQuery
} from '../tools/build-osm.mjs';

const TOOL = new URL('../tools/build-osm.mjs', import.meta.url);

// Load a generated module through its own loader, serving its .bin.gz from disk (as tests/building-geodata.test.cjs)
async function loadModule(file, name) {
  const dir = path.dirname(file);
  const source = fs.readFileSync(file, 'utf8')
    .replace('import.meta.url', JSON.stringify(`https://example.test/js/${path.basename(file)}`))
    .replace(`export const ${name}`, `const ${name}`);
  return new vm.Script(`(async () => { ${source}\nreturn ${name}; })()`).runInNewContext({
    URL, Response, DecompressionStream,
    fetch: async (url) => new Response(fs.readFileSync(path.join(dir, path.basename(url.pathname))))
  });
}

test('the frame puts true north on -z, turns with the bearing and keeps metres', () => {
  const lat = 52.52, lon = 13.405;
  const frame = createFrame({ lat, lon });
  assert.deepEqual(frame.toWorld(lon, lat).map((v) => Math.abs(v)), [0, 0]);
  const [nx, nz] = frame.toWorld(lon, lat + 0.001);
  assert.ok(Math.abs(nx) < 1e-9 && nz < -110 && nz > -112, 'about 111 m per 0.001° of latitude, northward is -z');
  const [ex, ez] = frame.toWorld(lon + 0.001, lat);
  assert.ok(ex > 67 && ex < 68 && Math.abs(ez) < 1e-9, 'longitude shrinks with cos(latitude); eastward is +x');
  // With the grid's bearing, a point along it lands on -z
  const turned = createFrame({ lat, lon, bearing: 30 });
  const along = [lon + 0.001 * Math.sin(Math.PI / 6) / Math.cos((lat * Math.PI) / 180), lat + 0.001 * Math.cos(Math.PI / 6)];
  const [tx, tz] = turned.toWorld(...along);
  assert.ok(Math.abs(tx) < 0.2 && tz < -110, `a point along the 30° bearing lies on -z: ${tx}, ${tz}`);
});

test('heights come from height, levels or the building type; raised and non-buildings are skipped', () => {
  for (const [value, metres] of [['12', 12], ['12.5 m', 12.5], ['40 ft', 12.192], ["40'", 12.192], ['12\'6"', 3.81], ['7,5', 7.5]]) {
    assert.ok(Math.abs(parseLength(value) - metres) < 1e-9, `${value} -> ${parseLength(value)}`);
  }
  assert.equal(parseLength('tall'), null);
  assert.equal(buildingHeight({ building: 'yes', height: '30' }), 30);
  assert.ok(Math.abs(buildingHeight({ building: 'apartments', 'building:levels': '5', 'roof:levels': '1' }) - 6 * 3.2) < 1e-9);
  assert.equal(buildingHeight({ building: 'apartments', 'building:levels': '5' }, 3), 15);
  assert.ok(Math.abs(buildingHeight({ building: 'house' }) - 6.4) < 1e-9);
  assert.ok(Math.abs(buildingHeight({ building: 'yes' }) - 9.6) < 1e-9);
  for (const tags of [{ building: 'roof' }, { building: 'carport' }, { building: 'no' }, { building: 'yes', min_height: '6' },
    { building: 'yes', 'building:min_level': '2' }, { building: 'yes', location: 'underground' }]) {
    assert.equal(buildingHeight(tags), null, JSON.stringify(tags));
  }
});

test('construction years parse the common start_date forms', () => {
  for (const [value, year] of [['1925', 1925], ['1925-03-01', 1925], ['~1900', 1900], ['1890s', 1890], ['before 1910', 1910], ['C19', 1850], ['soon', 0]]) {
    assert.equal(parseYear(value), year, value);
  }
  assert.equal(buildingYear({ start_date: 'unknown', construction_date: '1931' }), 1931);
  assert.equal(buildingYear({}), 0);
});

test('rings land on the 0.5 m grid without repeats, collinear points or spikes, outer counterclockwise', () => {
  // A 10 x 6 m rectangle drawn clockwise with a repeated corner, a midpoint on an edge, a 1 cm jog and a closing point
  const ring = canonicalRing([[0, 0], [0, 6], [0, 6], [5, 6], [10, 6], [10.01, 3], [10, 0], [4, 0], [4, -2], [4, 0], [0, 0]]);
  assert.deepEqual(ring, [[0, 0], [0, 12], [20, 12], [20, 0]]);
  assert.equal(canonicalRing([[0, 0], [0.1, 0], [0.1, 0.1]]), null, 'smaller than the grid');
  assert.equal(canonicalRing([[0, 0], [5, 0], [10, 0]]), null, 'no area');
  assert.ok(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]]), 'a bow tie crosses itself');
  assert.ok(!selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]]));
  const [polygon] = canonicalPolygons([{ outer: [[0, 0], [0, 20], [20, 20], [20, 0]], holes: [[[5, 5], [15, 5], [15, 15], [5, 15]], [[30, 30], [31, 30], [31, 31]]] }]);
  assert.equal(polygon.length, 2, 'the hole outside the outline is dropped');
  assert.ok(signedArea(polygon[0]) > 0 && signedArea(polygon[1]) < 0, 'outer counterclockwise, courtyard clockwise');
  assert.equal(canonicalPolygons([{ outer: [[0, 0], [10, 10], [10, 0], [0, 10]], holes: [] }]), null);
});

test('relation member ways join into closed rings whichever way each is drawn', () => {
  const rings = joinWays([[[0, 0], [10, 0], [10, 10]], [[0, 10], [0, 0]], [[0, 10], [10, 10]].reverse().reverse()]);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0][0], rings[0][rings[0].length - 1]);
  assert.equal(rings[0].length, 5);
  assert.equal(joinWays([[[0, 0], [1, 0], [1, 1]]]).length, 0, 'an open way is not a ring');
});

// A tiny Overpass response: a building way, a courtyard building relation (whose outline way is tagged too),
// excluded and outside buildings, and trees (one duplicated on the 0.5 m grid)
const LAT = 48.8566, LON = 2.3522;
const m = 1 / 111000;
const geom = (pts) => pts.map(([e, n]) => ({ lat: LAT + n * m, lon: LON + e * m / Math.cos((LAT * Math.PI) / 180) }));
const square = (e0, n0, size) => geom([[e0, n0], [e0 + size, n0], [e0 + size, n0 + size], [e0, n0 + size], [e0, n0]]);
const OSM = {
  elements: [
    { type: 'way', id: 1, tags: { building: 'apartments', height: '21', start_date: '1907' }, geometry: square(0, 0, 20) },
    { type: 'way', id: 2, tags: { building: 'yes' }, geometry: square(40, 0, 30) },
    { type: 'relation', id: 3, tags: { building: 'yes', type: 'multipolygon', 'building:levels': '6' }, members: [
      { type: 'way', ref: 2, role: 'outer', geometry: square(40, 0, 30) },
      { type: 'way', ref: 4, role: 'inner', geometry: square(50, 10, 10) }
    ] },
    { type: 'way', id: 5, tags: { building: 'roof' }, geometry: square(0, 40, 10) },
    { type: 'way', id: 6, tags: { building: 'yes' }, geometry: square(5000, 5000, 10) },
    { type: 'node', id: 7, lat: LAT + 10 * m, lon: LON, tags: { natural: 'tree' } },
    { type: 'node', id: 8, lat: LAT + 10.1 * m, lon: LON, tags: { natural: 'tree' } },
    { type: 'node', id: 9, lat: LAT + 30 * m, lon: LON, tags: { natural: 'tree' } },
    { type: 'node', id: 10, lat: LAT, lon: LON, tags: { highway: 'crossing' } }
  ]
};
const BBOX = [LAT - 0.001, LON - 0.002, LAT + 0.002, LON + 0.003];

test('extract keeps real buildings once, with courtyards, heights and decades, and dedupes trees', () => {
  const frame = createFrame({ lat: LAT, lon: LON });
  const { buildings, trees, skipped } = extract(OSM, { toWorld: frame.toWorld, bbox: BBOX, defaultYear: 1920 });
  assert.equal(buildings.length, 2, 'the relation replaces its tagged outline way');
  assert.deepEqual(skipped, { excluded: 1, outside: 1, invalid: 0 });
  const plain = buildings.find((b) => b.polygons[0].length === 1);
  const courtyard = buildings.find((b) => b.polygons[0].length === 2);
  assert.deepEqual([plain.height, plain.year], [21, 1900]);
  assert.deepEqual([courtyard.height, courtyard.year], [19, 1920], '6 levels x 3.2 m, the default year');
  const area = Math.abs(signedArea(plain.polygons[0][0])) * 0.25;
  assert.ok(Math.abs(area - 400) < 12, `20 x 20 m footprint: ${area} m²`);
  assert.equal(trees.length, 2, 'two trees within 5 cm of each other share a grid point');
});

test('packed data decodes through the generated loaders exactly', async () => {
  const frame = createFrame({ lat: LAT, lon: LON });
  const { buildings, trees } = extract(OSM, { toWorld: frame.toWorld, bbox: BBOX });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-osm-'));
  try {
    const { gzipSync } = await import('node:zlib');
    fs.writeFileSync(path.join(dir, 'building-geodata.bin.gz'), gzipSync(packBuildings(buildings)));
    fs.writeFileSync(path.join(dir, 'building-geodata.js'), buildingModule(buildings.length, 'building-geodata.bin.gz', 'test'));
    fs.writeFileSync(path.join(dir, 'tree-geodata.bin.gz'), gzipSync(packTrees(trees)));
    fs.writeFileSync(path.join(dir, 'tree-geodata.js'), treeModule(trees.length, 'tree-geodata.bin.gz', 'test'));
    const decoded = await loadModule(path.join(dir, 'building-geodata.js'), 'REAL_BUILDINGS');
    assert.equal(decoded.length, buildings.length);
    decoded.forEach((b, i) => {
      assert.equal(b.height, buildings[i].height);
      assert.equal(b.year, buildings[i].year);
      // (JSON: the loader's arrays come from another realm)
      assert.equal(JSON.stringify(b.polygons.map((p) => [p.outer, ...p.holes].map((r) => r.map((q) => [q.x * 2, q.z * 2])))), JSON.stringify(buildings[i].polygons));
      assert.ok(Number.isFinite(b.cx + b.cz + b.minX + b.maxZ));
    });
    const decodedTrees = await loadModule(path.join(dir, 'tree-geodata.js'), 'REAL_TREES');
    assert.deepEqual(Array.from(decodedTrees), trees.flat().map((v) => v * 0.5));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated modules carry the same loaders as the Python generators', () => {
  // The runtime treats both sources alike: everything below the header comments must match the NYC modules
  const body = (text) => text.split('\n').filter((l) => !l.startsWith('//')).join('\n');
  const repo = (f) => fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
  assert.equal(body(buildingModule(1, 'building-geodata.bin.gz', 'x')), body(repo('building-geodata.js')));
  assert.equal(body(treeModule(1, 'tree-geodata.bin.gz', 'x')), body(repo('tree-geodata.js')));
});

test('the command line validates its options and writes both modules from a saved response', async () => {
  assert.throws(() => parseArgs([]), /--bbox/);
  assert.throws(() => parseArgs(['--bbox', '1,2,0,3']), /south,west,north,east/);
  assert.throws(() => parseArgs(['--bbox', '0,0,1,1', '--nyc-frame', '--bearing', '3']), /replaces/);
  assert.throws(() => parseArgs(['--bbox', '0,0,1,1', '--default-year', '20']), /default-year/);
  assert.equal(parseArgs(['--bbox', '0,0,1,1', '--skip-trees']).trees, false);
  assert.match(overpassQuery([1, 2, 3, 4]), /way\["building"\]\(1,2,3,4\);[\s\S]*node\["natural"="tree"\]\(1,2,3,4\);[\s\S]*out geom;/);
  assert.doesNotMatch(overpassQuery([1, 2, 3, 4], { trees: false }), /natural/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-osm-cli-'));
  try {
    const input = path.join(dir, 'osm.json');
    fs.writeFileSync(input, JSON.stringify(OSM));
    const { execFileSync } = await import('node:child_process');
    const run = () => execFileSync(process.execPath, [new URL(TOOL).pathname, '--bbox', BBOX.join(','), '--input', input, '--out-dir', dir, '--default-year', '1910'], { encoding: 'utf8' });
    const log = run();
    assert.match(log, /2 buildings/);
    assert.match(log, /2 trees/);
    const first = fs.readFileSync(path.join(dir, 'building-geodata.bin.gz'));
    run();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'building-geodata.bin.gz')), first, 'the same input writes byte-identical data');
    const buildings = await loadModule(path.join(dir, 'building-geodata.js'), 'REAL_BUILDINGS');
    assert.equal(buildings.length, 2);
    assert.ok(buildings.every((b) => b.year >= 1900));
    assert.match(fs.readFileSync(path.join(dir, 'building-geodata.js'), 'utf8'), /© OpenStreetMap contributors, ODbL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
