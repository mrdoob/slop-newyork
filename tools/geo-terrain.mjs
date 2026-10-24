// tools/geo-terrain.mjs
// Ground heights for footprint cities: a height grid over the area from open elevation tiles, with buildings filtered
// out so only the land's shape (hills) remains, and the city's basin floor at y = 0.
//
// Source: AWS Terrain Tiles ("terrarium" PNG encoding, https://registry.opendata.aws/terrain-tiles/), which for Taiwan
// come from SRTM (NASA, public domain) via Mapzen. Attribution: "Elevation: Mapzen terrain tiles (SRTM, NASA)".
// SRTM is a surface model with ~30 m cells: in the city it measures roofs, not the street. So the build keeps only
// shapes wider than OPEN_M (a morphological opening: a min filter, then a max filter, removes anything narrower, i.e.
// buildings, while hills survive), lifts the basin floor to 0 and fades out the last few metres, so the flat city stays
// flat. On hillsides (no buildings to remove; the opening would shave the ridges) the lightly smoothed heights are used
// instead. It is approximate (30 m source, smoothed), not survey-grade.
//
// buildTerrain(box, toWorld, cacheDir, log) -> { x0, z0, step, nx, nz, h: [decimetres, row-major z then x], max } | null

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZOOM = 14; // ~9.5 m pixels at 25° N (the source is ~30 m)
const STEP_M = 10; // output grid spacing
const MARGIN_M = 300; // grid reaches this far beyond the box
const OPEN_M = 140; // shapes narrower than this (buildings, blocks) are filtered out
const FLOOR_FADE_M = 10; // heights up to this above the basin floor fade to 0 (the basin's SRTM noise)
const HILL_M = [15, 40]; // where the opened land rises this far above the floor it is hillside: the less-filtered heights return
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Minimal PNG decoder: 8-bit RGB / RGBA, non-interlaced (what terrarium tiles are)
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), kind = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs');
      type = data[9];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG colour type ${type} not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i], a = i >= bpp ? out[dst + i - bpp] : 0, b = y ? out[dst - stride + i] : 0, c = y && i >= bpp ? out[dst - stride + i - bpp] : 0;
      let v = x;
      if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + i] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };

async function tile(z, x, y, cacheDir) {
  const file = path.join(cacheDir, `${z}_${x}_${y}.png`);
  if (!fs.existsSync(file)) {
    const res = await fetch(TILE_URL(z, x, y));
    if (!res.ok) throw new Error(`${res.status} ${TILE_URL(z, x, y)}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return decodePng(fs.readFileSync(file));
}

// Running min / max over a window of 2r + 1 along rows, then columns (separable square filter)
function filter2d(src, nx, nz, r, pick) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let v = src[j * nx + i];
      for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) v = pick(v, src[j * nx + k]);
      tmp[j * nx + i] = v;
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      let v = tmp[j * nx + i];
      for (let k = Math.max(0, j - r); k <= Math.min(nz - 1, j + r); k++) v = pick(v, tmp[k * nx + i]);
      out[j * nx + i] = v;
    }
  }
  return out;
}
function boxBlur(src, nx, nz, r) {
  const out = new Float32Array(src.length);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      for (let b = Math.max(0, j - r); b <= Math.min(nz - 1, j + r); b++) for (let a = Math.max(0, i - r); a <= Math.min(nx - 1, i + r); a++) { s += src[b * nx + a]; n++; }
      out[j * nx + i] = s / n;
    }
  }
  return out;
}

export async function buildTerrain(box, frame, cacheDir, log = () => {}) {
  const [S, W, N, E] = box;
  const x0f = Math.floor(tileX(W, ZOOM) - 0.2), x1f = Math.floor(tileX(E, ZOOM) + 0.2);
  const y0f = Math.floor(tileY(N, ZOOM) - 0.2), y1f = Math.floor(tileY(S, ZOOM) + 0.2);
  const tiles = new Map();
  for (let x = x0f; x <= x1f; x++) for (let y = y0f; y <= y1f; y++) tiles.set(`${x},${y}`, await tile(ZOOM, x, y, cacheDir));
  // Elevation (m) at a latitude / longitude, bilinear over the tile pixels
  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), t = tiles.get(`${tx},${ty}`);
    if (!t) return null;
    const i = ((gy - ty * 256) * 256 + (gx - tx * 256)) * t.bpp;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
  const elev = (lon, lat) => {
    const gx = tileX(lon, ZOOM) * 256 - 0.5, gy = tileY(lat, ZOOM) * 256 - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const v = [px(ix, iy), px(ix + 1, iy), px(ix, iy + 1), px(ix + 1, iy + 1)];
    if (v.some((a) => a === null)) return null;
    return (v[0] * (1 - fx) + v[1] * fx) * (1 - fy) + (v[2] * (1 - fx) + v[3] * fx) * fy;
  };
  // World grid over the box + margin; world -> lon/lat by inverting the north-up frame's local scales
  const [kx] = frame.enu(frame.lon0 + 1, frame.lat0), [, ky] = frame.enu(frame.lon0, frame.lat0 + 1);
  const toGeo = (x, z) => [frame.lon0 + x / kx, frame.lat0 - z / ky];
  const [wx0, wz1] = frame.toWorld(W, S), [wx1, wz0] = frame.toWorld(E, N);
  const gx0 = Math.floor((wx0 - MARGIN_M) / STEP_M) * STEP_M, gz0 = Math.floor((wz0 - MARGIN_M) / STEP_M) * STEP_M;
  const nx = Math.ceil((wx1 + MARGIN_M - gx0) / STEP_M) + 1, nz = Math.ceil((wz1 + MARGIN_M - gz0) / STEP_M) + 1;
  const raw = new Float32Array(nx * nz);
  let missing = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const e = elev(...toGeo(gx0 + i * STEP_M, gz0 + j * STEP_M));
      if (e === null) missing++;
      raw[j * nx + i] = e ?? 0;
    }
  }
  // Opening (buildings out), then the basin floor (the 5th percentile) to 0 with a soft fade, then a light blur
  const r = Math.round(OPEN_M / 2 / STEP_M);
  const opened = filter2d(filter2d(raw, nx, nz, r, Math.min), nx, nz, r, Math.max);
  const sorted = Array.from(opened).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.05)];
  const smooth = boxBlur(raw, nx, nz, 2);
  const lifted = opened.map((v, k) => {
    const t = Math.min(1, Math.max(0, (v - floor - HILL_M[0]) / (HILL_M[1] - HILL_M[0]))), hill = t * t * (3 - 2 * t);
    const d = Math.max(0, v + (Math.max(v, smooth[k]) - v) * hill - floor);
    return d < FLOOR_FADE_M ? (d * d) / (2 * FLOOR_FADE_M) : d - FLOOR_FADE_M / 2;
  });
  const h = boxBlur(lifted, nx, nz, 2);
  let max = 0;
  for (const v of h) max = Math.max(max, v);
  log(`terrain: ${tiles.size} elevation tiles (z${ZOOM}), ${nx}×${nz} grid every ${STEP_M} m, basin floor ${floor.toFixed(1)} m (SRTM) -> 0, ` +
    `highest ${max.toFixed(0)} m above it${missing ? `, ${missing} samples outside the tiles` : ''}`);
  return { x0: gx0, z0: gz0, step: STEP_M, nx, nz, floor: Math.round(floor * 10) / 10, max: Math.round(max), h: Array.from(h, (v) => Math.round(v * 10)), elev: (lon, lat) => elev(lon, lat) };
}

// Height (m) at world (x, z) from a terrain grid (bilinear; 0 outside it)
export function terrainHeight(t, x, z) {
  if (!t) return 0;
  const gx = (x - t.x0) / t.step, gz = (z - t.z0) / t.step;
  const i = Math.floor(gx), j = Math.floor(gz);
  if (i < 0 || j < 0 || i >= t.nx - 1 || j >= t.nz - 1) return 0;
  const fx = gx - i, fz = gz - j, at = (a, b) => t.h[b * t.nx + a] / 10;
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fz) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fz;
}
