// tools/hk/blocks.mjs — buildable land → street-fronting lots → buildings, for the Hong Kong seed.
//
// The NYC pipeline rasterises a dense grid, so "whatever is left over" naturally closes into blocks. Hong Kong has no
// grid and (in the seed) a sparse network: connected components would collapse into one blob. So this generator does
// what the city itself does — every building fronts onto a street:
//
//   for each road segment, on both sides, step along it at the lot pitch
//     lot centre = road centre + normal × (roadway/2 + footway + depth/2), rotated with the segment
//     keep it only if its nine sample points are all land, off the roadway, and not already taken
//
// That gives street walls (the thing that makes a Hong Kong street read as Hong Kong), works on curved roads and
// diagonal reclamations alike, and needs no block topology at all.

import { pointInRing, rng } from './frame.mjs';

const CELL = 4; // metres per occupancy cell
const SIDEWALK = 3.5; // roadway + this is footway, not buildable
const LOT = 26; // pitch along the street (m)
const DEPTH = 22; // typical lot depth into the block (m)
const REACH = 460; // nothing is generated further than this from a road

export function buildLots({ roads, land, heights, districtAt = () => 'central', seed = 20261025 }) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const l of land) {
    for (const [x, z] of l.ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  minX -= REACH; minZ -= REACH; maxX += REACH; maxZ += REACH;
  const w = Math.ceil((maxX - minX) / CELL) + 2;
  const h = Math.ceil((maxZ - minZ) / CELL) + 2;
  const ix = (x) => Math.round((x - minX) / CELL);
  const iz = (z) => Math.round((z - minZ) / CELL);
  const cx = (i) => minX + i * CELL;
  const cz = (j) => minZ + j * CELL;
  const at = (i, j) => j * w + i;

  // 1. land
  const landMask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = cx(i);
      const z = cz(j);
      for (const l of land) {
        if (pointInRing(l.ring, x, z)) { landMask[at(i, j)] = 1; break; }
      }
    }
  }

  // 2. roadway + footway, stamped per segment
  const roadMask = new Uint8Array(w * h);
  const stamp = (x, z, r) => {
    const ri = Math.ceil(r / CELL);
    const ci = ix(x);
    const cj = iz(z);
    for (let j = Math.max(0, cj - ri); j <= Math.min(h - 1, cj + ri); j++) {
      for (let i = Math.max(0, ci - ri); i <= Math.min(w - 1, ci + ri); i++) {
        if ((cx(i) - x) ** 2 + (cz(j) - z) ** 2 <= r * r) roadMask[at(i, j)] = 1;
      }
    }
  };
  const nearMask = new Uint8Array(w * h);
  const reachCells = Math.ceil(REACH / CELL);
  for (const road of roads) {
    const roadHalf = road.w / 2 + SIDEWALK;
    for (let s = 0; s + 1 < road.pts.length; s++) {
      const [ax, az] = road.pts[s];
      const [bx, bz] = road.pts[s + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1e-9;
      const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
      for (let k = 0; k <= steps; k++) {
        const x = ax + ((bx - ax) * k) / steps;
        const z = az + ((bz - az) * k) / steps;
        stamp(x, z, roadHalf);
        const ci = ix(x);
        const cj = iz(z);
        for (let j = Math.max(0, cj - reachCells); j <= Math.min(h - 1, cj + reachCells); j++) {
          for (let i = Math.max(0, ci - reachCells); i <= Math.min(w - 1, ci + reachCells); i++) {
            if ((cx(i) - x) ** 2 + (cz(j) - z) ** 2 <= REACH * REACH) nearMask[at(i, j)] = 1;
          }
        }
      }
    }
  }
  const usable = (x, z) => {
    const i = ix(x);
    const j = iz(z);
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    const k = at(i, j);
    return landMask[k] === 1 && roadMask[k] === 0 && nearMask[k] === 1;
  };
  const occupied = new Uint8Array(w * h);
  const isFree = (x, z) => {
    const i = ix(x);
    const j = iz(z);
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    return !occupied[at(i, j)];
  };

  // 3. buildings fronting the streets
  const rand = rng(seed);
  const buildings = [];
  for (const road of roads) {
    for (let s = 0; s + 1 < road.pts.length; s++) {
      const [ax, az] = road.pts[s];
      const [bx, bz] = road.pts[s + 1];
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 12) continue;
      const ux = (bx - ax) / segLen;
      const uz = (bz - az) / segLen;
      const theta = Math.atan2(uz, ux);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      // left normal for the polyline direction (x, z): (uz, −ux)
      for (const side of [1, -1]) {
        for (let t = LOT * 0.6; t < segLen - LOT * 0.6; t += LOT) {
          const bx0 = ax + ux * t;
          const bz0 = az + uz * t;
          const off = road.w / 2 + SIDEWALK + DEPTH / 2;
          const px = bx0 + side * uz * off;
          const pz = bz0 - side * ux * off;
          const hw = LOT * 0.5 - 3.5;
          const hd = DEPTH * 0.5 - 2;
          let ok = true;
          for (let a = -1; a <= 1 && ok; a++) {
            for (let c = -1; c <= 1 && ok; c++) {
              const sx = px + (a * hw) * cos - (c * hd) * sin;
              const sz = pz + (a * hw) * sin + (c * hd) * cos;
              if (!usable(sx, sz) || !isFree(sx, sz)) ok = false;
            }
          }
          if (!ok) continue;
          for (let a = -1; a <= 1; a++) {
            for (let c = -1; c <= 1; c++) {
              const sx = px + (a * hw) * cos - (c * hd) * sin;
              const sz = pz + (a * hw) * sin + (c * hd) * cos;
              const si = ix(sx);
              const sj = iz(sz);
              if (si >= 0 && sj >= 0 && si < w && sj < h) occupied[at(si, sj)] = 1;
            }
          }
          const district = districtAt(px, pz);
          const [lo, hi, towerShare] = heights[district] || [35, 120, 0.15];
          const tower = rand() < towerShare;
          const hgt = tower ? hi * (0.6 + rand() * 0.4) : lo + rand() * (hi - lo) * 0.5;
          buildings.push({
            x: px,
            z: pz,
            w: LOT * (0.74 + rand() * 0.2),
            d: DEPTH * (0.78 + rand() * 0.18),
            h: Math.round(hgt * 10) / 10,
            rot: Math.round((theta + (rand() - 0.5) * 0.03) * 1000) / 1000,
            district,
            tower,
            road: road.en
          });
        }
      }
    }
  }

  return {
    buildings,
    stats: {
      cells: w * h,
      landCells: landMask.reduce((a, b) => a + b, 0),
      roadwayCells: roadMask.reduce((a, b) => a + b, 0),
      buildings: buildings.length,
      towers: buildings.filter((b) => b.tower).length
    }
  };
}
