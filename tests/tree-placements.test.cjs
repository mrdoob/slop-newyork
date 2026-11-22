const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');
const random = loadModule(readFileSync(join(__dirname, '../js/random.js'), 'utf8'));

const source = readFileSync(join(__dirname, '../js/tree-placements.js'), 'utf8');
const rectangle = (x, z, w, d, angle = 0, extra = {}) => ({ park: 0, ...extra,
  poly: [[0, 0], [w, 0], [w, d], [0, d]].map(([u, v]) => ({
    x: x + u * Math.cos(angle) - v * Math.sin(angle), z: z + u * Math.sin(angle) + v * Math.cos(angle)
  })) });
function contains(b, x, z) {
  let inside = false;
  for (let i = 0, j = b.poly.length - 1; i < b.poly.length; j = i++) {
    const a = b.poly[i], p = b.poly[j];
    if ((a.z > z) !== (p.z > z) && x < (p.x - a.x) * (z - a.z) / (p.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function setup(blocks) {
  const blockAt = (x, z) => blocks.find(b => contains(b, x, z)) || null;
  return loadModule(source, { imports: { './city-config.js': { blockAt }, './random.js': random } }).placeStreetTrees;
}
const clear = () => true;

test('surveyed locations stay fixed unless they need a small curb correction', () => {
  const place = setup([rectangle(0, 0, 40, 80)]);
  const sites = place([2, 10, -1.5, 20, 0.2, 30], [], clear);
  assert.equal(sites.length, 3);
  assert.equal(sites[0].x, 2);
  assert.equal(sites[0].z, 10);
  assert.ok(Math.abs(sites[1].x - 0.9) < 1e-9);
  assert.ok(Math.abs(sites[2].x - 0.9) < 1e-9);
  for (const site of sites) assert.equal(site.y, 0.22);
});

test('pits follow angled curbs and remain wholly on the same sidewalk', () => {
  const angle = 0.6, block = rectangle(0, 0, 40, 80, angle), place = setup([block]);
  const x = -Math.cos(angle) - 20 * Math.sin(angle);
  const z = -Math.sin(angle) + 20 * Math.cos(angle);
  const [site] = place([x, z], [], clear);
  assert.ok(site);
  const cs = Math.cos(site.pitRot), sn = Math.sin(site.pitRot);
  for (const u of [-0.85, 0.85]) for (const v of [-1.3, 1.3]) {
    assert.ok(contains(block, site.x + u * cs + v * sn, site.z - u * sn + v * cs));
  }
  assert.ok(Math.abs(Math.sin(site.pitRot + angle)) < 1e-9);
  assert.equal(place([-0.1, -0.1], [], clear).length, 0, 'corner pits must not cross either curb');
});

test('narrow pits keep their full length when checking corner clearance', () => {
  for (const angle of [0, 0.35]) {
    const cs = Math.cos(angle), sn = Math.sin(angle);
    const block = rectangle(0, 0, 40, 80, angle);
    const opposite = rectangle(30 * sn, -30 * cs, 40, 20, angle);
    const place = setup([block, opposite]);
    const point = (x, z) => [x * cs - z * sn, x * sn + z * cs];
    assert.equal(place(point(1.1, 0.9), [], clear).length, 0, 'full pit length crosses the corner');

    const [site] = place(point(6, 0.9), [], clear);
    assert.ok(site);
    assert.equal(site.pitS, 0.7);
    const yawCos = Math.cos(site.pitRot), yawSin = Math.sin(site.pitRot);
    // Match the rendered pit: scale local X, then rotate around Y.
    for (const u of [-0.85, 0.85]) for (const v of [-1.3, 1.3]) {
      const localX = u * site.pitS;
      assert.ok(contains(block, site.x + localX * yawCos + v * yawSin,
        site.z - localX * yawSin + v * yawCos));
    }
  }
});

test('road, courtyard, park and median coordinates are excluded', () => {
  const blocks = [rectangle(0, 0, 40, 80), rectangle(50, 0, 40, 80, 0, { park: 1 }),
    rectangle(100, 0, 4, 80, 0, { median: true })];
  assert.equal(setup(blocks)([-2.1, 20, 20, 40, 52, 20, 102, 20], [], clear).length, 0);
});

test('placements respect existing trees, source duplicates and clearance at corrected coordinates', () => {
  const place = setup([rectangle(0, 0, 40, 80)]), existing = [{ x: 2, z: 10 }];
  const sites = place([2, 11, 2, 20, 2, 20, 2, 22, -1, 30, 2, 40], existing,
    (x, z) => z !== 30 || x < 0);
  assert.equal(sites.length, 2);
  assert.deepEqual(Array.from(sites, s => s.z), [20, 40]);
  assert.equal(existing.length, 1);
});

test('placement and generated appearance are deterministic without changing inputs', () => {
  const place = setup([rectangle(0, 0, 40, 80)]), points = [2, 10, 2, 20, 15, 2];
  const original = [...points], sites = place(points, [], clear);
  assert.deepEqual(place(points, [], clear), sites);
  assert.deepEqual(points, original);
  assert.equal(sites[0].tier, 1);
  assert.equal(sites[2].tier, 2);
  for (const site of sites) assert.ok(site.scale >= 0.6 && site.scale <= 0.8 && site.species >= 0 && site.species <= 2);
});
