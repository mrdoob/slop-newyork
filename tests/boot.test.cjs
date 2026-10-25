const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
const entryScript = html.match(/<script type="module">([\s\S]*?)<\/script>/);
const bootstrapIndex = html.indexOf('__slopBootFail = function');
const stylesheetIndex = html.indexOf('rel="stylesheet"');

// 開機時會預載哪兩個世界（index.html 的 bootstrap 用 var NY_MODULES / HK_MODULES 宣告）
function preloadList(name) {
  const match = html.match(new RegExp(`var ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `index.html 應該有 ${name} 預載清單`);
  // index.html 內寫 'js/...'，統一成 './js/...' 方便同 import 解析結果比較
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => `./${m[1].replace(/^\.\//, '')}`);
}

test('import map 仍然把 three 與 three/webgpu 指去同一個模組實例', () => {
  assert.ok(importMap);
  assert.match(html, /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin\s*\/>/);
  const { imports } = JSON.parse(importMap[1]);
  assert.equal(imports.three, imports['three/webgpu']);
});

test('世界切換在 module 之前開始：先註冊錯誤處理、先決定世界，只 import 一個世界', () => {
  assert.ok(entryScript, 'index.html 應該有一個 inline 的 module 入口');
  assert.ok(bootstrapIndex > -1, '要有 __slopBootFail（module 之前就註冊的錯誤顯示）');
  assert.ok(importMap.index < bootstrapIndex, 'import map 必須在 bootstrap 之前');
  assert.ok(bootstrapIndex < entryScript.index, '錯誤處理必須在 module 入口之前');
  assert.ok(entryScript.index < stylesheetIndex, 'module 入口照舊要早過 stylesheet 開始載入');

  // 唔可以有無條件載入紐約世界入口的 script 標籤
  assert.equal([...html.matchAll(/<script\s+type="module"\s+src=/g)].length, 0, '唔應該再有 <script type="module" src>');
  assert.match(entryScript[1], /import\('\.\/js\/hk\/main\.js'\)/);
  assert.match(entryScript[1], /import\('\.\/js\/main\.js'\)/);

  // 只有 import map + bootstrap + module 入口三個 script
  assert.equal([...html.matchAll(/<script\b/g)].length, 3);
});

test('預載清單：冇重複、檔案都存在、每個相對 import 都已被同一個世界預載', () => {
  const ny = preloadList('NY_MODULES');
  const hk = preloadList('HK_MODULES');
  assert.ok(ny.length >= 30, `紐約模組清單太短：${ny.length}`);
  assert.ok(hk.length >= 8, `香港模組清單太短：${hk.length}`);
  assert.equal(new Set(ny).size, ny.length, '紐約清單有重複');
  assert.equal(new Set(hk).size, hk.length, '香港清單有重複');
  assert.ok(!ny.includes('./js/hk/main.js'), '兩個世界唔應該互相預載入口');
  assert.ok(!hk.includes('./js/main.js'));
  assert.equal(hk[0], './js/world.js', '兩個世界都要先載入世界切換層');

  const all = new Set([...ny, ...hk]);
  for (const src of all) {
    assert.match(src, /^\.\/js\//, `預載路徑要用相對形式：${src}`);
    assert.ok(existsSync(join(__dirname, '..', src)), `預載了不存在的檔案：${src}`);
    const base = 'https://example.test/slop-newyork/';
    const urls = new Set(all);
    const source = readFileSync(join(__dirname, '..', src), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)) {
      const resolved = new URL(specifier, new URL(src, base));
      const expected = new URL(resolved.href).pathname.replace('/slop-newyork/', './');
      assert.ok(urls.has(expected), `${src} import 了未預載的 ${specifier}（解析為 ${expected}）`);
    }
  }
});

test('香港預載清單不包含任何紐約模組', () => {
  for (const src of preloadList('HK_MODULES')) {
    assert.match(src, /^\.\/js\/(world\.js|hk\/[\w-]+\.js|hk-geodata\.js)$/, `香港唔應該預載 ${src}`);
  }
});
