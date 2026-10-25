#!/usr/bin/env node
// tools/hk/prepare-coastline.mjs — turns the raw Hong Kong terrestrial boundary GeoJSON into
// tools/data/hk/coastline.json (the intermediate that tools/hk/build-coastline.mjs bakes into js/hk-coastline.js).
//
//   curl -L -o /tmp/hk_terrestrial_2m.geojson \
//     https://github.com/aknopla/hk-terrestrial-geojson/raw/main/hk_terrestrial_2m.geojson
//   node --import ./tools/hk-boot/register.mjs tools/hk/prepare-coastline.mjs /tmp/hk_terrestrial_2m.geojson
//   node tools/hk/build-coastline.mjs
//
// 資料來源：香港地政總署（Lands Department）陸地邊界，經 aknopla/hk-terrestrial-geojson 轉成 GeoJSON。
// 我們把它簡化（Ramer–Douglas–Peucker）並投影到遊戲的世界座標：
//   · land       玩樂範圍（x −3…4 km、z −5.2…1.2 km）內的海岸線，~12 m 精度
//   · territory  全港其餘陸地（新界、大嶼山、西貢、離島），~150 m 精度
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rdp, toWorld, ringArea } from './frame.mjs';

const src = process.argv[2] || '/tmp/hk_terrestrial_2m.geojson';
const out = process.argv[3] || fileURLToPath(new URL('../data/hk/coastline.json', import.meta.url));

const geo = JSON.parse(readFileSync(src, 'utf8'));
const polys = geo.features?.[0]?.geometry?.coordinates;
if (!Array.isArray(polys)) throw new Error(`${src} 唔似係 hk_terrestrial_2m.geojson`);

const PLAY = { minX: -3000, maxX: 4000, minZ: -5200, maxZ: 1200 };
const near = [];
const far = [];
for (const poly of polys) {
  const ring = poly[0].map(([lon, lat]) => toWorld([lon, lat]));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const intersects = !(maxX < PLAY.minX || minX > PLAY.maxX || maxZ < PLAY.minZ || minZ > PLAY.maxZ);
  const simplified = rdp(ring, intersects ? 12 : 150);
  const area = Math.abs(ringArea(simplified));
  if (intersects) {
    if (area > 4000) near.push(simplified);
  } else if (area > 60000) {
    far.push(simplified);
  }
}

const quantise = (rings, digits) => rings.map((ring) => ring.map(([x, z]) => [Math.round(x * digits) / digits, Math.round(z * digits) / digits]));
const data = {
  source: 'HK Lands Department terrestrial boundary (hk_terrestrial_2m.geojson, via aknopla/hk-terrestrial-geojson); Ramer–Douglas–Peucker simplified; projected into the sim world frame (1 unit = 1 m, x east, z south, origin Statue Square, true north up)',
  land: quantise(near, 2),
  territory: quantise(far, 1)
};
writeFileSync(out, JSON.stringify(data));
console.log(`[prepare-coastline] land ${near.length} rings (${near.reduce((a, r) => a + r.length, 0)} pts) · territory ${far.length} rings (${far.reduce((a, r) => a + r.length, 0)} pts) → ${out}`);
