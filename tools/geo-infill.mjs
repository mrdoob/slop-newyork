// tools/geo-infill.mjs
// Stand-in buildings for city blocks OpenStreetMap leaves empty, for footprint cities (tools/build-taipei-geodata.mjs).
//
// OSM maps only part of the buildings in older districts (Wanhua: ~390 outlines where Taipei's 3D city model has over
// 5,000), so whole blocks render as empty lots. Where a street frontage has no mapped building, no open ground (parks,
// parking, schoolyards, temple courts, plazas, water, rail) and no road or walkway, this fills it with rows of narrow
// lots facing the street, the way Taipei's street-front shophouses and walk-ups stand, and further rows behind them
// while the block has room. NOTHING here is mapped: footprints and heights are both inferred, and the output is kept
// apart from the OSM buildings (GEO.infill) so it can be labelled, highlighted and hidden.
//
// infillBuildings({ links, corridors, obstacles, open, bounds, context, large, seed }, opts) -> [{ outer, top, storeys }]
//   links      [{ pts: [[x, z], ...], w, median, cls }]  drivable street centre lines & curb-to-curb widths: lots face
//                                           these; median: the side (0 left, 1 right) facing a dual carriageway's median: no
//                                           lots; cls: the OSM highway class (see opts.skipClasses)
//   corridors  [{ pts, w }]                 everything lots must stay clear of: streets, walkways, sidewalks, rail
//   obstacles  [[[x, z], ...], ...]         mapped building rings
//   open       [[[x, z], ...], ...]         open-ground rings (no buildings inferred inside)
//   bounds     [x0, z0, x1, z1]             the area's box in world metres
//   context    [{ x, z, top, area }]        mapped buildings with a height tag or storey count: heights come from the
//                                           street's own mapped neighbours
//   large      [{ x, z, r }]                big mapped buildings (towers, malls) as circles: no lots within r + opts.largeClear
//                                           (in a planned district they stand in plazas, not in rows of shophouses)
//   seeds      [[x, z, floors]]             doors (house-number points) where no building is mapped. With opts.seedRadius,
//                                           only lots within that distance of one are kept (open ground has no doors), and a
//                                           lot whose nearest door names 2+ floors is that many storeys × opts.addressLevel
//                                           (fromDoor; the highest floor named is a lower bound). A door left with no lot
//                                           near it gets one of its own (opts.doorLots): DOOR_LOT_W wide, facing the
//                                           nearest street, from the door's line back as deep as fits
// Lot widths, depths and gaps are defaults (INFILL), not survey data.

export const INFILL = {
  lotWidth: [4.5, 9], // m along the street: shophouse bays to small walk-ups
  depths: [16, 12, 8, 5], // m: tried deepest first, the first that fits is used
  frontGaps: [0.4, 2.0, 3.6], // m beyond the street's curb (sidewalk / arcade); the nearest that fits is used
  backGap: 1.5, // m between a row and the row behind it (a rear lane / light well)
  rows: 4, // rows per frontage at most
  skipClasses: [], // OSM highway classes whose frontage gets no lots (e.g. boulevards lined with plazas & setbacks)
  largeClear: 0, // m kept clear around `large` buildings
  minCover: 0, // share of the ground within coverRadius that mapped buildings must already cover (0: no rule): stand-ins
  coverRadius: 100, //   then only fill gaps inside built-up fabric, not hillsides, campuses or the city's edge
  clearance: 0.3, // m kept from corridors, buildings and other lots
  sample: 1.25, // m between test points inside a lot
  contextRadius: 80, // m: mapped neighbours used for a lot's height
  contextMaxArea: 1500, // m²: larger mapped buildings (towers, malls) don't set a street's height
  level: 3.2, // m per storey, as tools/geo-height.mjs LEVEL_M
  seedRadius: 0, // m: lots only within this of a door (seeds); 0: seeds unused
  doorLots: true, // with seeds: a lot of its own for each door no frontage lot reached
  doorLotWidth: 6, // m along the street
  doorStreetMax: 40, // m: a door further than this from any street centre line gets no lot of its own
  addressLevel: 3.7 // m per floor named at a door
};

const CELL = 25; // m: spatial index bucket

function bucketIndex() {
  const map = new Map();
  const key = (i, j) => `${i},${j}`;
  return {
    add(item, [x0, z0, x1, z1]) {
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
        for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
          const k = key(i, j);
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(item);
        }
      }
    },
    near(x, z) {
      return map.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || [];
    }
  };
}
const bboxOf = (pts, pad = 0) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
};
function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(x, z, [x0, z0], [x1, z1]) {
  const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
  return Math.hypot(x0 + dx * t - x, z0 + dz * t - z);
}
const median = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };

export function infillBuildings({ links, corridors, obstacles, open, bounds, context, large = [], seeds = [], seed = 1 }, opts = {}) {
  const o = { ...INFILL, ...opts };
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const [bx0, bz0, bx1, bz1] = bounds;

  // Spatial indexes: corridor segments, solid rings (buildings & open ground), placed lots
  const segs = bucketIndex();
  for (const { pts, w } of corridors) {
    for (let i = 0; i + 1 < pts.length; i++) segs.add({ a: pts[i], b: pts[i + 1], r: w / 2 + o.clearance }, bboxOf([pts[i], pts[i + 1]], w / 2 + o.clearance));
  }
  const rings = bucketIndex();
  for (const r of obstacles) rings.add({ r, bb: bboxOf(r, o.clearance), solid: true }, bboxOf(r, o.clearance));
  for (const r of open) rings.add({ r, bb: bboxOf(r, o.clearance), solid: false }, bboxOf(r, o.clearance));
  const lots = bucketIndex();
  const placed = [];
  const bigs = bucketIndex();
  for (const b of large) { const r = b.r + o.largeClear; bigs.add({ ...b, r }, [b.x - r, b.z - r, b.x + r, b.z + r]); }
  const skip = new Set(o.skipClasses);
  // Built-up fabric: 10 m cells whose centre lies in a mapped building, summed over a square of side 2 × coverRadius
  let coverAt = () => 1;
  if (o.minCover > 0) {
    const C = 10, nx = Math.ceil((bx1 - bx0) / C), nz = Math.ceil((bz1 - bz0) / C);
    const sat = new Uint32Array((nx + 1) * (nz + 1)); // summed-area table of built cells
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = bx0 + (i + 0.5) * C, z = bz0 + (j + 0.5) * C;
        let built = 0;
        for (const { r, bb, solid } of rings.near(x, z)) if (solid && x >= bb[0] && x <= bb[2] && z >= bb[1] && z <= bb[3] && pointInRing(x, z, r)) { built = 1; break; }
        sat[(j + 1) * (nx + 1) + i + 1] = built + sat[j * (nx + 1) + i + 1] + sat[(j + 1) * (nx + 1) + i] - sat[j * (nx + 1) + i];
      }
    }
    const R = Math.round(o.coverRadius / C);
    coverAt = (x, z) => {
      const ci = Math.floor((x - bx0) / C), cj = Math.floor((z - bz0) / C);
      const i0 = Math.max(0, ci - R), i1 = Math.min(nx, ci + R + 1), j0 = Math.max(0, cj - R), j1 = Math.min(nz, cj + R + 1);
      const n = (i1 - i0) * (j1 - j0);
      return n > 0 ? (sat[j1 * (nx + 1) + i1] - sat[j0 * (nx + 1) + i1] - sat[j1 * (nx + 1) + i0] + sat[j0 * (nx + 1) + i0]) / n : 0;
    };
  }

  const free = (x, z) => {
    if (x < bx0 || x > bx1 || z < bz0 || z > bz1) return false;
    for (const g of segs.near(x, z)) if (segDist(x, z, g.a, g.b) < g.r) return false;
    for (const { r, bb } of rings.near(x, z)) if (x >= bb[0] && x <= bb[2] && z >= bb[1] && z <= bb[3] && pointInRing(x, z, r)) return false;
    for (const b of bigs.near(x, z)) if (Math.hypot(x - b.x, z - b.z) < b.r) return false;
    for (const q of lots.near(x, z)) if (pointInRing(x, z, q.grown)) return false;
    return true;
  };
  // A lot: front edge from p along unit d for width lw, extending depth D along unit n (away from the street)
  const corners = (p, d, n, lw, D) => [p, [p[0] + d[0] * lw, p[1] + d[1] * lw], [p[0] + d[0] * lw + n[0] * D, p[1] + d[1] * lw + n[1] * D], [p[0] + n[0] * D, p[1] + n[1] * D]];
  const fits = (p, d, n, lw, D) => {
    const c = o.clearance;
    const nu = Math.max(2, Math.ceil(lw / o.sample)), nv = Math.max(2, Math.ceil(D / o.sample));
    for (let i = 0; i <= nu; i++) {
      for (let j = 0; j <= nv; j++) {
        const u = c + ((lw - 2 * c) * i) / nu, v = c + ((D - 2 * c) * j) / nv;
        if (!free(p[0] + d[0] * u + n[0] * v, p[1] + d[1] * u + n[1] * v)) return false;
      }
    }
    return true;
  };
  const place = (ring) => {
    // grown by the clearance so neighbours keep their gap
    const [cx, cz] = [ring.reduce((t, q) => t + q[0], 0) / 4, ring.reduce((t, q) => t + q[1], 0) / 4];
    const grown = ring.map(([x, z]) => { const dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz) || 1; return [x + (dx / L) * o.clearance, z + (dz / L) * o.clearance]; });
    const item = { ring, grown, cx, cz };
    lots.add(item, bboxOf(grown));
    placed.push(item);
  };

  for (const { pts, w, median = -1, cls } of links) {
    if (skip.has(cls)) continue;
    for (const side of [1, -1]) {
      if (median === (side > 0 ? 1 : 0)) continue; // side +1 builds on the right of the line's direction
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
        const L = Math.hypot(x1 - x0, z1 - z0);
        if (L < o.lotWidth[0]) continue;
        // along the segment; n points away from the street on this side
        const d = side > 0 ? [(x1 - x0) / L, (z1 - z0) / L] : [(x0 - x1) / L, (z0 - z1) / L];
        const n = [-d[1], d[0]];
        const start = side > 0 ? [x0, z0] : [x1, z1];
        for (let t = 0; t + o.lotWidth[0] <= L;) {
          const lw = Math.min(L - t, o.lotWidth[0] + rand() * (o.lotWidth[1] - o.lotWidth[0]));
          let front = null, depth = 0;
          for (const g of o.frontGaps) {
            const off = w / 2 + g;
            const p = [start[0] + d[0] * t + n[0] * off, start[1] + d[1] * t + n[1] * off];
            depth = o.depths.find((D) => fits(p, d, n, lw, D)) || 0;
            if (depth) { front = p; break; }
          }
          if (!front) { t += 1.5; continue; } // blocked here: step on and try again
          if (coverAt(front[0] + n[0] * 6, front[1] + n[1] * 6) < o.minCover) { t += lw; continue; } // not built-up fabric
          place(corners(front, d, n, lw, depth));
          // rows behind, as long as the block has room
          let back = depth + o.backGap;
          for (let r = 1; r < o.rows; r++) {
            const p = [front[0] + n[0] * back, front[1] + n[1] * back];
            const D = o.depths.find((DD) => fits(p, d, n, lw, DD));
            if (!D) break;
            place(corners(p, d, n, lw, D));
            back += D + o.backGap;
          }
          t += lw;
        }
      }
    }
  }

  // Doors: keep only lots by one (seedRadius), and note the nearest door's floors
  if (o.seedRadius > 0) {
    const doorIdx = bucketIndex();
    const reach = o.seedRadius + Math.max(...o.depths) / 2 + o.lotWidth[1] / 2; // a lot's centre to its edge, at most
    for (const d of seeds) doorIdx.add(d, [d[0] - reach, d[1] - reach, d[0] + reach, d[1] + reach]);
    const ringDist = (x, z, ring) => {
      if (pointInRing(x, z, ring)) return 0;
      let dmin = Infinity;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) dmin = Math.min(dmin, segDist(x, z, ring[j], ring[i]));
      return dmin;
    };
    for (let k = placed.length - 1; k >= 0; k--) {
      const p = placed[k];
      let best = null, bd = o.seedRadius;
      for (const d of doorIdx.near(p.cx, p.cz)) { const dd = ringDist(d[0], d[1], p.ring); if (dd <= bd) { bd = dd; best = d; } }
      if (!best) placed.splice(k, 1);
      else p.door = best;
    }
    // Doors no lot reached: a lot of their own, facing the nearest street (the door sits on its front)
    if (o.doorLots) {
      const reached = new Set(placed.map((p) => p.door));
      const lotIdx = bucketIndex();
      for (const p of placed) lotIdx.add(p, bboxOf(p.ring, o.seedRadius));
      const streetSegs = bucketIndex();
      for (const { pts, w } of links) for (let i = 0; i + 1 < pts.length; i++) streetSegs.add({ a: pts[i], b: pts[i + 1], w }, bboxOf([pts[i], pts[i + 1]], o.doorStreetMax));
      for (const d of seeds) {
        if (reached.has(d)) continue;
        if (lotIdx.near(d[0], d[1]).some((p) => ringDist(d[0], d[1], p.ring) <= o.seedRadius)) continue;
        let s = null, sd = o.doorStreetMax;
        for (const g of streetSegs.near(d[0], d[1])) { const dd = segDist(d[0], d[1], g.a, g.b); if (dd < sd) { sd = dd; s = g; } }
        if (!s) continue;
        const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
        let dir = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L], n = [-dir[1], dir[0]];
        if ((d[0] - s.a[0]) * n[0] + (d[1] - s.a[1]) * n[1] < 0) { dir = [-dir[0], -dir[1]]; n = [-n[0], -n[1]]; } // n: street -> door
        const lw = o.doorLotWidth, off = Math.max(0, Math.min(1, sd - s.w / 2 - 0.2)); // the front a little before the door
        const p = [d[0] - n[0] * off - dir[0] * (lw / 2), d[1] - n[1] * off - dir[1] * (lw / 2)];
        const depth = o.depths.find((D) => fits(p, dir, n, lw, D));
        if (!depth) continue;
        place(corners(p, dir, n, lw, depth));
        placed[placed.length - 1].door = d;
        lotIdx.add(placed[placed.length - 1], bboxOf(placed[placed.length - 1].ring, o.seedRadius));
      }
    }
  }

  // Heights: the floors named at the lot's door when 2+, else the median top of the mapped (tagged) neighbours within
  // contextRadius, ±1 storey per lot
  const ctx = bucketIndex();
  for (const b of context) if (b.area <= o.contextMaxArea) ctx.add(b, [b.x - o.contextRadius, b.z - o.contextRadius, b.x + o.contextRadius, b.z + o.contextRadius]);
  const fallback = median(context.filter((b) => b.area <= o.contextMaxArea).map((b) => b.top)) ?? 4 * o.level;
  return placed.map(({ ring, cx, cz, door }) => {
    if (door && door[2] >= 2) return { outer: ring, storeys: door[2], top: Math.round(door[2] * o.addressLevel * 10) / 10, context: 0, fromDoor: true };
    const near = ctx.near(cx, cz).filter((b) => Math.hypot(b.x - cx, b.z - cz) <= o.contextRadius).map((b) => b.top);
    const typical = near.length >= 3 ? median(near) : fallback;
    const storeys = Math.max(1, Math.round(typical / o.level) + Math.round((rand() - 0.5) * 2.4));
    return { outer: ring, storeys, top: storeys * o.level, context: near.length >= 3 ? near.length : 0 };
  });
}
