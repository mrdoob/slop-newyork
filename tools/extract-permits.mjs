// tools/extract-permits.mjs — building footprints from Taipei's building-permit drawings, per area
// usage: node tools/extract-permits.mjs [dir with taipei_*.shp/.dbf]   (default tools/data-local/permits/)
//
// Source: 臺北市建築執照套繪圖 (Taipei City building-permit overlay drawings), 臺北市建築管理工程處, data.gov.tw dataset
// 151936, Open Government Data License v1 (attribution required; redistribution allowed). Download the SHP zip from
// https://data.taipei/api/dataset/af067fb6-9e47-4f4c-a484-e72eba161319/resource/ccdfe8df-ef54-4c13-a93d-ba42968ced3b/download
// and unzip it into the directory above. TWD97 / TM2 coordinates are converted to latitude & longitude.
//
// Writes permits.json into each area's data directory (tools/data-taipei/, …/wanhua/): the footprints with any vertex in
// the area's box, with their permit number, floor count (the record's bud_floor, else the "nF" in the permit number,
// else 0 = unknown), construction type and permit year (ROC year + 1911). The drawings cover permits from about 2006
// on, so they add recent buildings only; tools/build-taipei-geodata.mjs decides which to use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tm2ToGeo } from './geo-twd97.mjs';
import { AREAS } from './geo-taipei-base.mjs';

const DIR = process.argv[2] || fileURLToPath(new URL('data-local/permits/', import.meta.url));
const base = fs.readdirSync(DIR).find((f) => /^taipei_.*\.shp$/.test(f));
if (!base) throw new Error(`no taipei_*.shp in ${DIR}`);
const shp = fs.readFileSync(path.join(DIR, base));
const dbf = fs.readFileSync(path.join(DIR, base.replace(/\.shp$/, '.dbf')));

// DBF records (UTF-8, per the .cpg)
const n = dbf.readUInt32LE(4), headerLen = dbf.readUInt16LE(8), recLen = dbf.readUInt16LE(10);
const fields = [];
for (let o = 32; dbf[o] !== 0x0d; o += 32) fields.push({ name: dbf.toString('latin1', o, o + 11).replace(/\0.*$/, ''), len: dbf[o + 16] });
const dec = new TextDecoder('utf-8');
const records = [];
for (let i = 0; i < n; i++) {
  let o = headerLen + i * recLen + 1;
  const r = {};
  for (const f of fields) { r[f.name] = dec.decode(dbf.subarray(o, o + f.len)).trim(); o += f.len; }
  records.push(r);
}

// SHP polygons (type 5): rings of [E, N]
const shapes = [];
for (let o = 100; o + 8 <= shp.length;) {
  const len = shp.readInt32BE(o + 4) * 2, type = shp.readInt32LE(o + 8);
  if (type === 5) {
    const parts = shp.readInt32LE(o + 44), points = shp.readInt32LE(o + 48);
    const starts = Array.from({ length: parts }, (_, k) => shp.readInt32LE(o + 52 + 4 * k));
    const p0 = o + 52 + 4 * parts;
    const rings = starts.map((s, k) => {
      const e = k + 1 < parts ? starts[k + 1] : points;
      const ring = [];
      for (let v = s; v < e; v++) ring.push([shp.readDoubleLE(p0 + 16 * v), shp.readDoubleLE(p0 + 16 * v + 8)]);
      return ring;
    });
    shapes.push(rings);
  } else shapes.push(null);
  o += 8 + len;
}
if (shapes.length !== records.length) throw new Error(`${shapes.length} shapes vs ${records.length} records`);

const r7 = (v) => Math.round(v * 1e7) / 1e7;
const features = [];
shapes.forEach((rings, i) => {
  if (!rings) return;
  const rec = records[i];
  const floorsTag = parseInt(rec.bud_floor, 10) || 0;
  const m = /(\d+)\s*F/i.exec(rec.budatt_no);
  const year = /^(\d{2,3})[.\s]/.exec(rec.budatt_no);
  features.push({
    permit: rec.budatt_no,
    floors: floorsTag || (m ? +m[1] : 0),
    floorsFrom: floorsTag ? 'bud_floor' : m ? 'permit number' : 'unknown',
    construction: rec.bud_const,
    year: year ? +year[1] + 1911 : null,
    rings: rings.map((ring) => ring.map(([E, N]) => { const [lat, lon] = tm2ToGeo(E, N); return [r7(lon), r7(lat)]; }))
  });
});

for (const [name, a] of Object.entries(AREAS)) {
  const [S, W, N, E] = a.box;
  const inBox = features.filter((f) => f.rings.some((r) => r.some(([lon, lat]) => lat >= S && lat <= N && lon >= W && lon <= E)));
  const out = fileURLToPath(new URL(`${a.data}permits.json`, import.meta.url));
  fs.writeFileSync(out, JSON.stringify({
    source: '臺北市建築執照套繪圖 (Taipei City building-permit overlay drawings), 臺北市建築管理工程處',
    url: 'https://data.gov.tw/dataset/151936', licence: 'Open Government Data License, version 1.0 (Taiwan)',
    file: base, features: inBox
  }));
  console.log(`[permits] ${name}: ${inBox.length} footprints -> ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}
