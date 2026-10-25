// tests/hk-modules.test.mjs
// 開機路徑的回歸測試。
//
// 背景（真實事故）：js/hk/main.js 在同一個 try 區塊裡宣告了兩次 `const info`。
// 這是 early SyntaxError —— 模組連評估都不會開始，`await import('./js/hk/main.js')`
// 直接 reject，而當時 index.html 沒有任何地方接住這個 rejection，
// 結果畫面永遠停在「Slop New York / Initializing WebGPURenderer & TSL Shaders...」。
// 更糟的是：144 個既有測試全部照樣綠燈，因為冇任何測試 import 過這個檔案。
//
// 這裡補上兩層防守：
//   ① 逐個模組做語法檢查（node --check）—— 必定抓到重複宣告這類 early error。
//   ② 檢查香港的靜態 import 清單 —— 唔准再依賴紐約模組，避免紐約任何檔案壞掉就拖死香港。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { findSyntaxErrors } from '../tools/check-modules.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

test('每個 js 模組都通過語法檢查（沒有 early error）', () => {
  const failures = findSyntaxErrors(['js']);
  assert.deepEqual(
    failures,
    [],
    `以下模組有語法錯誤，瀏覽器會停在 loading 畫面：\n${failures.map((f) => `${f.file}: ${f.message}`).join('\n')}`
  );
});

test('香港 main.js 的靜態 import 只有 three/webgpu 與 ./hk/*', () => {
  const source = read('js/hk/main.js');
  const staticImports = [...source.matchAll(/^import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(staticImports.length > 0, 'js/hk/main.js 應該有 import');
  const allowed = /^(three\/webgpu|\.\.\/world\.js|\.\/[a-z-]+\.js)$/i;
  for (const spec of staticImports) {
    assert.ok(allowed.test(spec), `香港不應該靜態 import ${spec}（紐約模組會拖死香港開機）`);
  }
  // 紐約的後處理與天空系統只可以在 ?post=1 / ?sky=1 時動態載入
  assert.match(source, /import\('\.\.\/post-processing\.js'\)/, '後處理應該保持動態載入');
  assert.match(source, /import\('\.\.\/lighting\.js'\)/, '完整天空應該保持動態載入');
});

test('index.html 先決定世界，再只 import 一個世界', () => {
  const html = read('index.html');
  // 唔可以再有無條件載入紐約 main.js 的 script 標籤
  assert.doesNotMatch(
    html,
    /<script\s+type="module"\s+src="\.\/js\/main\.js"/,
    'index.html 唔應該再靜態 <script src="js/main.js">，否則香港要先吞下整個紐約模組圖'
  );
  assert.match(html, /import\([`']\.\/js\/hk\/main\.js[^`']*[`']\)/, '香港分支要動態 import js/hk/main.js');
  assert.match(html, /__slopBootFail/, '載入失敗一定要有畫面提示');
  assert.match(html, /applyBranding/, '世界未載入就要先換品牌，唔好顯示 Slop New York');
});

test('index.html 預載清單內的檔案全部存在', () => {
  const html = read('index.html');
  const listed = [...html.matchAll(/'((?:js\/)[^']+\.js)'/g)].map((m) => m[1]);
  assert.ok(listed.length > 30, `預載清單應該包含紐約與香港的模組，實際 ${listed.length}`);
  const missing = [...new Set(listed)].filter((p) => !existsSync(fileURLToPath(new URL(p, root))));
  assert.deepEqual(missing, [], `index.html 預載了不存在的檔案：${missing.join(', ')}`);
});

test('建置版本在 index.html 與 js/hk/build.js 一致（避免新舊模組混用）', async () => {
  const { BUILD } = await import('../js/hk/build.js');
  const html = read('index.html');
  const declared = html.match(/const HK_BUILD = '([^']+)'/);
  assert.ok(declared, 'index.html 應該宣告 HK_BUILD');
  assert.equal(declared[1], BUILD, 'index.html 與 js/hk/build.js 的版本唔一致');
  assert.match(html, /import\(`\.\/js\/hk\/main\.js\?v=\$\{HK_BUILD\}`\)/, '入口模組要帶版本，強制重新抓取');
  const source = read('js/hk/main.js');
  assert.match(source, /from '\.\/build\.js'/, 'main.js 應該匯入建置版本');
});

test('香港的後處理與天空係可選的，唔會令預設路徑依賴 addon', () => {
  const source = read('js/hk/main.js');
  assert.doesNotMatch(source, /^import .*three\/tsl/m, 'three/tsl 應該動態載入，避免多拉一個 CDN 檔案');
  assert.doesNotMatch(source, /^import .*post-processing\.js/m, '紐約後處理唔可以靜態 import');
});
