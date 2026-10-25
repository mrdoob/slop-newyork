// js/world/medians.js
// The Periférico Libramiento's wide camellón: between its two carriageways (mapped as two one-way roads ~31 m apart
// centre to centre, so ~24 m of median) runs Tepic's ciclovía, down the middle of a tree-lined walk, nearly the whole
// way round the south of the city. Plain data (no three.js): city-grid.js draws the path, street-details.js plants the
// trees, lot-greenery.js leaves these medians to them.
// - cyclewayRuns(roads): the path's centre line, in runs broken where a cross street cuts the median: each point
//   { x, z, tx, tz (along the path, unit), half (m from the centre line to either carriageway's edge) }
// - medianTrees(runs): two rows of trees each side of the path

const CYCLEWAY_HALF = 1.6; // m: a two-way bike path 3.2 m wide

const hash = (x, z, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

// The nearest point to (x, z) on a flat [x0, z0, x1, z1, ...] polyline: { d, x, z, tx, tz }
function nearestOn(c, x, z) {
  let best = { d: Infinity, x: 0, z: 0, tx: 0, tz: 0 };
  for (let k = 0; k + 3 < c.length; k += 2) {
    const ax = c[k], az = c[k + 1], ux = c[k + 2] - ax, uz = c[k + 3] - az;
    const L2 = ux * ux + uz * uz;
    if (L2 <= 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / L2));
    const px = ax + ux * t, pz = az + uz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      best = { d, x: px, z: pz, tx: ux / L, tz: uz / L };
    }
  }
  return best;
}

/**
 * The cycleway's centre line between the paired carriageways of the roads named like `match` (city-geodata.js
 * `roads`: [name, width, dir, lanes, major, flat points]): every `step` m along each one-way carriageway, the point
 * halfway to the nearest carriageway running the other way `gap` m off. Each stretch is taken from the carriageway of
 * the pair listed first, so it is drawn once. `inMedian(x, z)` (city-config.js: a curb island no house stands on)
 * breaks the runs where a cross street or a junction cuts the median.
 */
function cyclewayRuns(roads, { match = /Libramiento/i, gap = [18, 46], step = 4, inMedian = () => true } = {}) {
  const ways = [];
  roads.forEach((r, i) => {
    if (match.test(r[0]) && r[2] !== 'TW' && r[5].length >= 4) ways.push({ i, w: r[1], c: r[5] });
  });
  const runs = [];
  for (const P of ways) {
    let run = null;
    const end = () => {
      if (run && run.length * step >= 48) runs.push(run); // (not the scraps where a ramp meets the median)
      run = null;
    };
    const c = P.c;
    for (let k = 0; k + 3 < c.length; k += 2) {
      const ux = c[k + 2] - c[k], uz = c[k + 3] - c[k + 1];
      const L = Math.hypot(ux, uz);
      if (L <= 0) continue;
      const tx = ux / L, tz = uz / L;
      for (let s = 0; s < L; s += step) {
        const x = c[k] + tx * s, z = c[k + 1] + tz * s;
        let partner = null;
        for (const Q of ways) {
          if (Q === P) continue;
          const q = nearestOn(Q.c, x, z);
          // running the other way, beside it (not ahead, where a ramp joins)
          if (q.d < gap[0] || q.d > gap[1] || q.tx * tx + q.tz * tz > -0.85) continue;
          if (!partner || q.d < partner.q.d) partner = { Q, q };
        }
        if (!partner || partner.Q.i < P.i) { end(); continue; }
        const mx = (x + partner.q.x) / 2, mz = (z + partner.q.z) / 2;
        if (!inMedian(mx, mz)) { end(); continue; }
        // the median's half width: half the gap less half of each carriageway
        const half = partner.q.d / 2 - (P.w + partner.Q.w) / 4;
        if (!run) run = [];
        // along the path: the average of the two carriageways' directions (they run opposite ways)
        let ax = tx - partner.q.tx, az = tz - partner.q.tz;
        const al = Math.hypot(ax, az) || 1;
        run.push({ x: mx, z: mz, tx: ax / al, tz: az / al, half });
      }
    }
    end();
  }
  return runs;
}

/**
 * Trees along the cycleway: rows `rows` m either side of its centre line every `spacing` m, staggered, where the
 * median is wide enough (2 m clear of the carriageway's curb); laureles & tabachines mostly, some jacarandas
 */
function medianTrees(runs, { spacing = 8, rows = [4.6, 8.4] } = {}) {
  const sites = [];
  for (const run of runs) {
    let along = 0;
    let next = spacing * 0.5;
    for (let i = 0; i < run.length; i++) {
      if (i) along += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
      if (along < next) continue;
      next += spacing;
      const p = run[i];
      const nx = -p.tz, nz = p.tx; // across the path
      rows.forEach((off, r) => {
        for (const side of [-1, 1]) {
          if (off > p.half - 2) continue;
          // the outer rows are staggered half a spacing, and some places are left empty
          const shift = r % 2 ? spacing * 0.5 : 0;
          const x = p.x + nx * off * side + p.tx * shift, z = p.z + nz * off * side + p.tz * shift;
          if (hash(x, z, 1) < 0.12) continue;
          const roll = hash(x, z, 2);
          const species = roll < 0.5 ? 0 : roll < 0.78 ? 3 : roll < 0.93 ? 1 : 2;
          sites.push({ x, z, scale: 0.85 + hash(z, x, 3) * 0.35, species, tier: 1 });
        }
      });
    }
  }
  return sites;
}

export { CYCLEWAY_HALF, nearestOn, cyclewayRuns, medianTrees };
