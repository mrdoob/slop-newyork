// tools/extract-addresses.mjs — Taipei house-number points (doors), per area
// usage: node tools/extract-addresses.mjs [taipei-addresses.csv]   (default tools/data-local/addresses/taipei-addresses.csv)
//
// Source: 臺北市門牌位置數值資料 (Taipei City house-number locations), 臺北市政府民政局, data.gov.tw dataset 155472,
// Open Government Data License v1 (attribution required; redistribution allowed). Download the CSV from
// https://data.taipei/api/dataset/b7c8e724-1e98-45ee-a0bd-f3840623ed97/resource/ce76ca0c-7f94-4935-ab47-1d2a41ca2abb/download
// into tools/data-local/addresses/ (62 MB, not committed). Coordinates are TWD97 / TM2 (EPSG:3826), placed by the
// district offices from field surveys of the house numbers; the dataset states no accuracy.
//
// Each row is one address; a building's floors above the ground floor are separate rows at the same point ("91號",
// "91號二樓", "91號三樓"…). Writes addresses.json into each area's data directory: one entry per door point inside the
// area's box, [lon, lat, addresses at the point, highest floor named (1 when none)]. The highest floor named is a LOWER
// BOUND on the storeys (not every floor carries its own number), used as such by the build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS } from './geo-taipei-base.mjs';
import { tm2ToGeo } from './geo-twd97.mjs';

const src = process.argv[2] || fileURLToPath(new URL('data-local/addresses/taipei-addresses.csv', import.meta.url));
const text = fs.readFileSync(src, 'utf8');
const lines = text.split(/\r?\n/);
const head = lines[0].split(',');
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`column ${name} not in ${src}`); return i; };
const iNo = col('號'), iX = col('橫座標'), iY = col('縱座標');

// "二十三樓" / "23樓" / "２３樓" -> 23
const FULL = '０１２３４５６７８９';
const half = (s) => s.replace(/[０-９]/g, (c) => String(FULL.indexOf(c)));
const DIGIT = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function chineseNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  let total = 0, cur = 0;
  for (const c of s) {
    if (c in DIGIT) cur = DIGIT[c];
    else if (c === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (c === '百') { total += (cur || 1) * 100; cur = 0; }
    else return NaN;
  }
  return total + cur;
}
const floorOf = (no) => {
  const m = /([0-9一二三四五六七八九十百零]+)樓/.exec(half(no));
  const f = m ? chineseNumber(m[1]) : 1;
  return Number.isFinite(f) && f >= 1 && f <= 101 ? f : 1;
};

const doors = new Map(); // "E,N" (0.1 m) -> [E, N, count, max floor]
let rows = 0;
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const f = lines[i].split(',');
  const E = parseFloat(f[iX]), N = parseFloat(f[iY]);
  if (!Number.isFinite(E) || !Number.isFinite(N)) continue;
  rows++;
  const key = `${Math.round(E * 10)},${Math.round(N * 10)}`;
  const d = doors.get(key) || [E, N, 0, 1];
  d[2]++;
  d[3] = Math.max(d[3], floorOf(f[iNo] || ''));
  doors.set(key, d);
}
console.log(`[addresses] ${rows} addresses at ${doors.size} door points`);

const r7 = (v) => Math.round(v * 1e7) / 1e7;
const points = [...doors.values()].map(([E, N, n, fl]) => { const [lat, lon] = tm2ToGeo(E, N); return [r7(lon), r7(lat), n, fl]; });
for (const [name, a] of Object.entries(AREAS)) {
  const [S, W, N, E] = a.box;
  const inBox = points.filter(([lon, lat]) => lat >= S && lat <= N && lon >= W && lon <= E);
  const out = fileURLToPath(new URL(`${a.data}addresses.json`, import.meta.url));
  fs.writeFileSync(out, JSON.stringify({
    source: '臺北市門牌位置數值資料 (Taipei City house-number locations), 臺北市政府民政局',
    url: 'https://data.gov.tw/dataset/155472', licence: 'Open Government Data License, version 1.0 (Taiwan)',
    fields: ['lon', 'lat', 'addresses at the point', 'highest floor named (lower bound on storeys)'],
    file: path.basename(src), points: inBox
  }));
  console.log(`[addresses] ${name}: ${inBox.length} door points -> ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}
