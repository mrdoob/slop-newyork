// Tests the data tools (slow), so it stays out of the default run: node --test tests/tools/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('geodata builds with default paths in a checkout containing spaces and non-ASCII characters', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'New York 東京 '));
  try {
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'js'));
    fs.copyFileSync(path.join(root, 'js/city-config.js'), path.join(dir, 'js/city-config.js'));
    for (const name of fs.readdirSync(path.join(root, 'tools'))) {
      if (name.endsWith('.mjs')) fs.copyFileSync(path.join(root, 'tools', name), path.join(dir, 'tools', name));
    }
    fs.symlinkSync(path.join(root, 'tools/data'), path.join(dir, 'tools/data'), 'dir');
    const env = { ...process.env };
    delete env.GEO_DATA;
    const result = spawnSync(process.execPath, ['--max-old-space-size=8192', path.join(dir, 'tools/build-geodata.mjs')], {
      encoding: 'utf8', env, timeout: 180000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { GEO } = await import(pathToFileURL(path.join(dir, 'js/nyc-geodata.js')).href);
    assert.ok(GEO.roadGraph.links.length > 0);
    assert.ok(GEO.blocks.length > 0);
    const { blockAt } = await import(pathToFileURL(path.join(dir, 'js/city-config.js')).href);
    assert.equal(blockAt(-575, -225), null, 'Times Square pedestrian plaza remains clear');
    assert.ok(blockAt(-565, -225), 'The neighboring building block remains intact');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
