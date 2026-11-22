import { blockAt } from './city-config.js';
import { hashPos } from './random.js';

// Fit surveyed street trees to the modeled curbs, preserving nearby park and plaza trees.
function placeStreetTrees(points, existingSites, isClear) {
  const cells = new Map();
  const insert = (site) => {
    const key = Math.floor(site.x / 4) + ',' + Math.floor(site.z / 4);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(site);
  };
  for (const site of existingSites) insert(site);
  const occupied = (x, z) => {
    const cx = Math.floor(x / 4), cz = Math.floor(z / 4);
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const s of cells.get(ix + ',' + iz) || []) {
          if ((s.x - x) ** 2 + (s.z - z) ** 2 < 9) return true;
        }
      }
    }
    return false;
  };

  const sites = [];
  for (let i = 0; i < points.length; i += 2) {
    const sourceX = points[i], sourceZ = points[i + 1];
    const originalBlock = blockAt(sourceX, sourceZ);
    if (originalBlock && (originalBlock.park > 0.6 || originalBlock.median)) continue;
    const blocks = new Set();
    if (originalBlock) blocks.add(originalBlock);
    else {
      for (const dx of [-2, 0, 2]) for (const dz of [-2, 0, 2]) {
        const b = blockAt(sourceX + dx, sourceZ + dz);
        if (b && b.park <= 0.6 && !b.median) blocks.add(b);
      }
    }

    let edge = null;
    for (const block of blocks) {
      for (let j = 0; j < block.poly.length; j++) {
        const a = block.poly[j], b = block.poly[(j + 1) % block.poly.length];
        const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
        if (length < 0.01) continue;
        const t = Math.max(0, Math.min(1, ((sourceX - a.x) * dx + (sourceZ - a.z) * dz) / (length * length)));
        const x = a.x + t * dx, z = a.z + t * dz;
        const distance = Math.hypot(sourceX - x, sourceZ - z);
        if (distance > (originalBlock ? 8 : 2) || (edge && distance >= edge.distance)) continue;
        edge = { block, x, z, dx: dx / length, dz: dz / length, distance };
      }
    }
    if (!edge) continue;
    let nx = -edge.dz, nz = edge.dx;
    if (blockAt(edge.x + nx * 0.9, edge.z + nz * 0.9) !== edge.block) { nx = -nx; nz = -nz; }
    const move = !originalBlock || edge.distance < 0.9;
    const x = move ? edge.x + nx * 0.9 : sourceX;
    const z = move ? edge.z + nz * 0.9 : sourceZ;
    if ((x - sourceX) ** 2 + (z - sourceZ) ** 2 > 9 || blockAt(x, z) !== edge.block) continue;
    if (!isClear(x, z) || occupied(x, z)) continue;

    const crossStreet = Math.abs(edge.dx) > Math.abs(edge.dz);
    const narrow = crossStreet && !!blockAt(x - nx * 14, z - nz * 14);
    const pitS = narrow ? 0.7 : 1;
    let fits = true;
    for (const across of [-0.85, 0.85]) for (const along of [-1.3, 1.3]) {
      if (blockAt(x + across * pitS * nx + along * edge.dx,
        z + across * pitS * nz + along * edge.dz) !== edge.block) fits = false;
    }
    if (!fits) continue;

    const r = hashPos(x, 6.1, z), species = hashPos(x, 4.4, z);
    const yaw = Math.atan2(edge.dx, edge.dz);
    const site = { x, y: 0.22, z, scale: narrow ? 0.54 + r * 0.1 : 0.6 + r * 0.2,
      species: narrow ? 1 : species < 0.4 ? 0 : species < 0.75 ? 1 : 2,
      yaw, sx: 0.82, tier: crossStreet ? 2 : 1, pitRot: yaw, grate: !crossStreet, pitS };
    sites.push(site);
    insert(site);
  }
  return sites;
}

export { placeStreetTrees };
