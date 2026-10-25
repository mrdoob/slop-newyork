// tests/hk-boot-graph.test.mjs
// 開機圖（module graph）的測試 —— 專門對付「用戶畫面卡在 Slop New York / 黑畫面」這一類失敗。
//
// 為什麼要有這個測試：香港世界如果任何一個模組有 early error（例如重複宣告），
// 或者不小心靜態匯入了某個紐約模組（而該模組依賴 CDN 上會變的 addon），
// 瀏覽器就會停在 loading 畫面：冇 stack、冇提示。單元測試匯入個別模組永遠驗唔到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const exists = (p) => existsSync(root + p);

/** 抽出頂層（非動態）的 import 來源。 */
function staticImports(source) {
  const out = [];
  const re = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

test('所有 JS 模組都通過語法／early error 檢查（重複宣告會直接炸死整個世界）', async () => {
  const { findSyntaxErrors } = await import('../tools/check-modules.mjs');
  const failures = findSyntaxErrors(['js']);
  assert.deepEqual(
    failures,
    [],
    '有模組載入唔到，瀏覽器會停在 loading：\n' + failures.map((f) => `  ${f.file}: ${f.message}`).join('\n')
  );
});

test('香港入口只依賴 three 與 ./hk/*，唔會因為紐約模組壞掉而開唔到機', () => {
  const source = read('js/hk/main.js');
  const imports = staticImports(source);
  assert.ok(imports.length > 0, 'js/hk/main.js 應該有匯入');
  const allowed = new Set(['../world.js']);
  const offenders = imports.filter((spec) => {
    if (spec.startsWith('three')) return false; // three/webgpu、three/tsl 由 dev CDN 同一個檔案提供
    if (spec.startsWith('./')) return !exists('js/hk/' + spec.slice(2)); // ./hk/* 而且檔案真係存在
    return !allowed.has(spec);
  });
  assert.deepEqual(offenders, [], `香港入口有脆弱依賴：${offenders.join(', ')}`);
  // 紐約的後處理同天空一定要「用到才 import」，唔可以出現在頂層 import。
  assert.ok(!imports.some((s) => /post-processing|\.\.\/lighting\.js|\.\.\/main\.js/.test(s)));
});

test('index.html 的香港分支直接載入 js/hk/main.js（唔會先拖入整個紐約模組圖）', () => {
  const html = read('index.html');
  assert.match(html, /const \{ startHongKong \} = await import\(`\.\/js\/hk\/main\.js\?v=\$\{HK_BUILD\}`\)/);
  assert.ok(exists('js/hk/main.js'));
  // 香港分支唔應該同時靜態載入紐約入口。
  assert.ok(!/<script[^>]+type="module"[^>]+src="\.\/js\/main\.js"/.test(html), 'index.html 唔應該靜態 script src 紐約入口');
});

test('版本號在「載入畫面、HUD、診斷面板」三個位都出現', async () => {
  const { BUILD } = await import('../js/hk/build.js');
  const html = read('index.html');
  const main = read('js/hk/main.js');
  assert.match(html, /id="loading-build"/, '載入畫面要有版本位');
  assert.match(html, /loadingBuild\.textContent = [^;]*HK_BUILD/, '載入畫面版本要由 HK_BUILD 填');
  assert.match(html, new RegExp(`const HK_BUILD = '${BUILD.replace(/\./g, '\\.')}'`), 'index.html 版本要同 build.js 一致');
  assert.match(main, /class="hk-build"[^`]*\$\{BUILD\}/, 'HUD 要顯示版本');
  assert.match(main, /版本 v\$\{BUILD\}/, '診斷面板第一行要寫版本');
  assert.match(read('css/hk.css'), /\.hk-build\s*\{/, 'HUD 版本要有樣式，唔然可能睇唔到');
});
