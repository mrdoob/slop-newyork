import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// 端到端開機測試：用真正的 index.html + 真正的 three.js 幾何 + 假的 WebGPURenderer，
// 照 index.html 的順序行一次：?world=hk → applyBranding → import hk/main.js → startHongKong()。
//
// 這一個測試補的洞：2026-10-25 的事故是 js/hk/main.js 有語法錯誤（重複宣告 const info），
// 瀏覽器 `await import('./js/hk/main.js')` 直接 reject，畫面永遠停在
// 「Slop New York / Initializing WebGPURenderer & TSL Shaders...」。
// 當時 144 個測試全綠，因為冇任何測試 import 過 main.js。這個測試會行整條開機路徑。
//
//   npm install three@0.186.1 jsdom --no-save && node --test tests/hk-boot.test.mjs
const threePath = new URL('../node_modules/three/package.json', import.meta.url);
const jsdomPath = new URL('../node_modules/jsdom/package.json', import.meta.url);
const skip = !existsSync(threePath)
  ? 'three is not installed (npm install three@0.186.1 --no-save)'
  : !existsSync(jsdomPath)
    ? 'jsdom is not installed (npm install jsdom --no-save)'
    : false;

test('香港世界可以由 index.html 一路開到第一幀', { skip }, () => {
  const result = spawnSync(
    process.execPath,
    ['--import', './tools/hk-boot/register.mjs', 'tools/boot-hk.mjs'],
    { cwd: new URL('..', import.meta.url), timeout: 180000, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `boot failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /✓ 香港世界可以開機/);

  const line = result.stdout.split('\n').find((l) => l.startsWith('__BOOT_REPORT__ '));
  assert.ok(line, `boot-hk.mjs 冇輸出報告：\n${result.stdout}`);
  const report = JSON.parse(line.slice('__BOOT_REPORT__ '.length));
  assert.equal(report.world, 'hk');
  assert.equal(report.title, 'Slop Hong Kong');
  assert.equal(report.location, '中環 Central');
  assert.ok(report.frames >= 2, `動畫迴圈只跑了 ${report.frames} 幀`);
  assert.ok(report.compiled > 50, `只預編譯了 ${report.compiled} 個 pipeline`);
  assert.equal(report.buildings, 1349);
  assert.ok(report.landmarks > 10, `landmarks=${report.landmarks}`);
  assert.equal(report.cars, 96);
  assert.ok(report.checks.length >= 12, `只通過 ${report.checks.length} 項檢查`);
});
