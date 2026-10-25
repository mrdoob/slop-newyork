#!/usr/bin/env node
// tools/check-modules.mjs
// 逐個 .js 模組做「語法／early error」檢查。
//
// 為什麼要這個工具：index.html 用 `<script type="module">` 一次只載入一個世界，
// 所以只要該世界其中一個模組有語法錯誤（例如重複宣告 `const info`），
// 整個 import 就會 reject，瀏覽器只會停在 loading 畫面 —— 冇 stack、冇提示、冇反應。
// 這類錯誤在 node 的單元測試裡完全驗不到（因為測試只 import 個別模組）。
//
//   node tools/check-modules.mjs            # 檢查 js/ 全部
//   node tools/check-modules.mjs js/hk      # 只檢查某個目錄
//
// 做法：把檔案複製成暫存 .mjs 後跑 `node --check`。這樣：
//   ① 唔需要真的解析 import（唔會因為 node_modules 或 CDN 而誤報）
//   ② 仍然抓到語法錯誤、重複宣告、非法 return 等等 early error
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/** 回傳 [{ file, message }]；空陣列 = 全部模組語法正常。 */
export function findSyntaxErrors(targets = ['js']) {
  const scratch = mkdtempSync(join(tmpdir(), 'slop-syntax-'));
  const failures = [];
  try {
    for (const target of targets) {
      const dir = join(ROOT, target);
      let files = [];
      try {
        files = statSync(dir).isDirectory() ? walk(dir) : [dir];
      } catch {
        continue;
      }
      for (const file of files) {
        const copy = join(scratch, relative(ROOT, file).replace(/[\\/]/g, '_') + '.mjs');
        writeFileSync(copy, readFileSync(file));
        try {
          execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
        } catch (error) {
          const stderr = String(error.stderr || '');
          const line = stderr.split('\n').find((l) => /SyntaxError/.test(l)) || stderr.split('\n')[0] || 'unknown error';
          failures.push({ file: relative(ROOT, file).replace(/\\/g, '/'), message: line.trim() });
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-modules.mjs')) {
  const failures = findSyntaxErrors(process.argv.slice(2).length ? process.argv.slice(2) : ['js']);
  if (failures.length) {
    for (const f of failures) console.error(`✗ ${f.file}\n    ${f.message}`);
    console.error(`\n${failures.length} 個模組有語法錯誤 —— 瀏覽器會直接停在 loading 畫面。`);
    process.exit(1);
  }
  console.log('✓ 全部模組語法正常');
}
