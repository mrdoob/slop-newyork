// Tests the data tools (slow), so it stays out of the default run: node --test tests/tools/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const original = '{"elements":[{"id":1}]}\n';
const replacement = '\n {"elements":[{"id":2}]}\n';

function download(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overpass test '));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const output = path.join(dir, 'data.json');
    const query = path.join(dir, 'query.overpassql');
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(output, original);
    fs.writeFileSync(query, '[out:json];node(1);out;');
    fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs');
const responses = JSON.parse(process.env.TEST_RESPONSES);
const calls = process.env.TEST_CALLS;
const n = fs.existsSync(calls) ? Number(fs.readFileSync(calls, 'utf8')) : 0;
fs.writeFileSync(calls, String(n + 1));
const response = responses[Math.min(n, responses.length - 1)];
fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], response.body);
process.stdout.write(String(response.status));
process.exitCode = response.exitCode || 0;
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('bash', [path.join(root, 'tools/overpass.sh'), output, query, '1'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TEST_RESPONSES: JSON.stringify(responses), TEST_CALLS: calls }
    });
    assert.ifError(result.error);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('data.json.tmp')), [], 'temporary downloads are removed');
    return { ...result, data: fs.readFileSync(output, 'utf8'), calls: Number(fs.readFileSync(calls, 'utf8')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Overpass accepts complete JSON with leading whitespace', () => {
  const result = download([{ status: 200, body: replacement }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data, replacement);
  assert.equal(result.calls, 1);
});

for (const [name, response] of [
  ['failed transfer after HTTP 200', { status: 200, body: replacement, exitCode: 28 }],
  ['malformed JSON', { status: 200, body: '{"elements":[' }],
  ['HTTP error', { status: 503, body: replacement }],
  ['Overpass runtime error', { status: 200, body: '{"elements":[],"remark":"runtime error: Query timed out"}' }],
  ['missing elements', { status: 200, body: '{}' }]
]) {
  test(`Overpass preserves existing data after ${name}`, () => {
    const result = download([response]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.data, original);
    assert.equal(result.calls, 3, 'all three endpoints are tried');
  });
}

test('Overpass retries a failed endpoint before replacing data', () => {
  const result = download([{ status: 200, body: '{', exitCode: 28 }, { status: 200, body: replacement }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.data, replacement);
  assert.equal(result.calls, 2);
});
