// js/world/lot-greenery.js
// The open ground inside Tepic's blocks, as the satellite sees it: the vacant lots (baldíos), the football fields no
// one mapped, the backyards and patios between the houses, green in the rains and straw-yellow in the dry season, with
// the mangos, laureles & tabachines that stand over them. Plain data in, plain data out (no three.js), so node --test
// reads it directly: city-grid.js draws the ground cover, street-details.js plants the trees.
// - openness(blocks, houses): the share of each curb island no building stands on, for the ground's look
// - lotTrees(blocks, houses): tree sites on the open ground, clear of the walls and the sidewalk, thick along the
//   edges of a lot and in the yards, sparse out in the middle of a big field (where the kids play football)

const TREE_SPACING = 9; // m between the candidate tree sites (jittered)
const WALL_CLEAR = 2.4; // m a trunk stands at least from any wall
const HOUSE_CELL = 24; // m cells of the houses' spatial index

const hash = (x, z, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * The houses (city-geodata.js `houses`: stride integers each, centre x & z in dm, width & depth in dm, turn θ in
 * thousandths of a radian) as oriented boxes in a grid of HOUSE_CELL m cells
 */
function indexHouses(houses, stride = 8) {
  const cells = new Map();
  const boxes = [];
  for (let i = 0; i + 4 < houses.length; i += stride) {
    const cx = houses[i] / 10, cz = houses[i + 1] / 10, hx = houses[i + 2] / 20, hz = houses[i + 3] / 20, th = houses[i + 4] / 1000;
    const cs = Math.cos(th), sn = Math.sin(th);
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    const box = { cx, cz, hx, hz, cs, sn };
    boxes.push(box);
    for (let ix = Math.floor((cx - ex) / HOUSE_CELL); ix <= Math.floor((cx + ex) / HOUSE_CELL); ix++) {
      for (let iz = Math.floor((cz - ez) / HOUSE_CELL); iz <= Math.floor((cz + ez) / HOUSE_CELL); iz++) {
        const k = ix * 100003 + iz;
        let list = cells.get(k);
        if (!list) cells.set(k, (list = []));
        list.push(box);
      }
    }
  }
  // distance (m) from (x, z) to the nearest wall within `reach`, 0 inside a house, reach if there is none that near
  const wallDistance = (x, z, reach) => {
    let best = reach;
    for (let ix = Math.floor((x - reach) / HOUSE_CELL); ix <= Math.floor((x + reach) / HOUSE_CELL); ix++) {
      for (let iz = Math.floor((z - reach) / HOUSE_CELL); iz <= Math.floor((z + reach) / HOUSE_CELL); iz++) {
        for (const b of cells.get(ix * 100003 + iz) || []) {
          // the box's own frame: world = c + R_y(θ)·local, so local = R_y(−θ)·(p − c)
          const dx = x - b.cx, dz = z - b.cz;
          const u = Math.abs(dx * b.cs - dz * b.sn) - b.hx, v = Math.abs(dx * b.sn + dz * b.cs) - b.hz;
          const d = u <= 0 && v <= 0 ? 0 : Math.hypot(Math.max(0, u), Math.max(0, v));
          if (d < best) best = d;
        }
      }
    }
    return best;
  };
  return { boxes, wallDistance };
}

function inPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// Distance (m) from (x, z) to the curb island's outline
function edgeDistance(x, z, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    const ux = b.x - a.x, uz = b.z - a.z;
    const L2 = ux * ux + uz * uz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ux + (z - a.z) * uz) / L2)) : 0;
    const d = Math.hypot(x - a.x - ux * t, z - a.z - uz * t);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Share (0..1) of each block's ground inside its sidewalk band (`sidewalk` m from the curb) no house stands on: a Map
 * block → share, from the houses' areas summed per block (`blockAt(x, z)`, city-config.js) against the block's
 * area less its sidewalk band
 */
function openness(blocks, houses, blockAt, { stride = 8, sidewalk = 2.2 } = {}) {
  const built = new Map();
  for (let i = 0; i + 4 < houses.length; i += stride) {
    const b = blockAt(houses[i] / 10, houses[i + 1] / 10);
    if (b) built.set(b, (built.get(b) || 0) + (houses[i + 2] * houses[i + 3]) / 100);
  }
  const out = new Map();
  for (const b of blocks) {
    let perimeter = 0;
    for (let i = 0, j = b.poly.length - 1; i < b.poly.length; j = i++) perimeter += Math.hypot(b.poly[i].x - b.poly[j].x, b.poly[i].z - b.poly[j].z);
    const inner = Math.max(b.area * 0.25, b.area - perimeter * sidewalk);
    out.set(b, Math.max(0, Math.min(1, 1 - (built.get(b) || 0) / inner)));
  }
  return out;
}

// The trees of Tepic's yards & lots (trees.js SPECIES: 0 laurel, 1 jacaranda, 2 mango, 3 tabachín, 4 palm): the mango
// in nearly every backyard and the laurel de la India, dense dark domes from the air; a few tabachines, jacarandas & fan
// palms
const YARD_MIX = [0.36, 0.06, 0.44, 0.08, 0.06];
const pickSpecies = (r) => {
  for (let k = 0; k < YARD_MIX.length; k++) if ((r -= YARD_MIX[k]) < 0) return k;
  return 0;
};

/**
 * Tree sites ({ x, z, scale, species, tier }) on the open ground of the house blocks (not the parks, the open country
 * or the camellones, planted already by city-grid.js & street-details.js). A site needs WALL_CLEAR m to every wall and
 * stays off the sidewalk band and the front strip by the street (the street trees' and the fronts' own); its chance
 * runs high in the yards and along the edges of a lot (trees round a field) and low out in the open middle of one.
 * `houses`, `stride`: city-geodata.js houses; `sidewalk`: the sidewalk's width (m); `skip`: blocks planted otherwise
 * (the Libramiento's camellón, medians.js)
 */
function lotTrees(blocks, houses, { stride = 8, sidewalk = 2.2, index = indexHouses(houses, stride), skip = null } = {}) {
  const sites = [];
  for (const b of blocks) {
    if (b.rural || b.median || b.park > 0.6 || b.area < 150 || (skip && skip.has(b))) continue;
    for (let gx = b.minX + TREE_SPACING * 0.5; gx < b.maxX; gx += TREE_SPACING) {
      for (let gz = b.minZ + TREE_SPACING * 0.5; gz < b.maxZ; gz += TREE_SPACING) {
        const x = gx + (hash(gx, gz, 1) - 0.5) * TREE_SPACING * 0.8;
        const z = gz + (hash(gz, gx, 2) - 0.5) * TREE_SPACING * 0.8;
        if (!inPolygon(x, z, b.poly)) continue;
        const edge = edgeDistance(x, z, b.poly);
        if (edge < sidewalk + 3) continue; // (the street trees' strip & the house fronts)
        const wall = index.wallDistance(x, z, 9);
        if (wall < WALL_CLEAR) continue;
        // a yard between houses (walls near), the edge of a lot (the fence near), or the open middle of a field
        const yard = wall < 9;
        const lotEdge = edge < sidewalk + 9;
        let p = yard ? 0.42 : lotEdge ? 0.36 : 0.05;
        // trees stand in clumps: the old mango groves of the colonias, the line of laureles along a field
        p *= 0.45 + 1.1 * hash(Math.floor(x / 40), Math.floor(z / 40), 3);
        if (hash(x, z, 4) >= p) continue;
        const species = pickSpecies(hash(x, z, 5));
        sites.push({ x, z, scale: (species === 4 ? 0.8 : 0.85) + hash(z, x, 6) * 0.5, species, tier: 2 });
      }
    }
  }
  return sites;
}

/**
 * How dry the grass is (0 green .. 1 straw) in `month` (0 = January): Tepic's rains run June to October; the grass
 * browns through the dry months and is at its driest in April-May, just before the first storms
 */
function grassDryness(month) {
  const DRY = [0.45, 0.6, 0.75, 0.9, 0.95, 0.6, 0.15, 0, 0, 0.05, 0.15, 0.3];
  return DRY[((Math.floor(month) % 12) + 12) % 12];
}

export { indexHouses, inPolygon, edgeDistance, openness, lotTrees, grassDryness };
