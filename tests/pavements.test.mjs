import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAVEMENTS } from '../js/world/pavement-data.js';
import { GEO } from '../js/world/city-geodata.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('pavement-data.js is what tools/build-tepic-pavements.mjs writes from the committed OpenStreetMap data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pavements-'));
  try {
    const out = path.join(dir, 'pavement-data.js');
    const result = spawnSync(process.execPath, [path.join(root, 'tools/build-tepic-pavements.mjs'), out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(fs.readFileSync(out, 'utf8'), fs.readFileSync(path.join(root, 'js/world/pavement-data.js'), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pavements are well formed, in the city, and in the game frame', () => {
  const { x0, x1, z0, z1 } = GEO.frame.box;
  const kinds = new Set();
  for (const [kind, width, pts] of PAVEMENTS) {
    kinds.add(kind);
    assert.ok([0, 1, 2, 3].includes(kind));
    assert.ok(width >= 4 && width <= 30);
    assert.ok(pts.length >= 4 && pts.length % 2 === 0);
    assert.ok(pts.some((v, i) => i % 2 === 0 && v >= x0 && v <= x1 && pts[i + 1] >= z0 && pts[i + 1] <= z1));
  }
  assert.equal(kinds.size, 4);
  // the cobbled colonias: some empedrado around Gobernadores (GEO.places, same frame)
  const gob = GEO.places.find((p) => p.name === 'Gobernadores');
  assert.ok(PAVEMENTS.some(([kind, , pts]) => kind === 0 && Math.hypot(pts[0] - gob.x, pts[1] - gob.z) < 500));
});
