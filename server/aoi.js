// server/aoi.js
// Area of interest: a uniform grid over the world's x/z plane so each player is only sent the others near them.
// A query touches the cells overlapping a square around the point and then filters by true distance.

class SpatialGrid {
  constructor(cellSize = 250) {
    this.cellSize = cellSize;
    this.cells = new Map(); // "cx,cz" → Set of ids
    this.where = new Map(); // id → its cell key
  }

  keyAt(x, z) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }

  update(id, x, z) {
    const key = this.keyAt(x, z);
    const old = this.where.get(id);
    if (old === key) return;
    if (old !== undefined) this.removeFromCell(id, old);
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = new Set()));
    cell.add(id);
    this.where.set(id, key);
  }

  remove(id) {
    const old = this.where.get(id);
    if (old === undefined) return;
    this.removeFromCell(id, old);
    this.where.delete(id);
  }

  removeFromCell(id, key) {
    const cell = this.cells.get(key);
    if (!cell) return;
    cell.delete(id);
    if (cell.size === 0) this.cells.delete(key);
  }

  // Ids in every cell overlapping the square of half-size radius around (x, z): a superset of those within radius
  candidates(x, z, radius, out = []) {
    const c = this.cellSize;
    const x0 = Math.floor((x - radius) / c);
    const x1 = Math.floor((x + radius) / c);
    const z0 = Math.floor((z - radius) / c);
    const z1 = Math.floor((z + radius) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.cells.get(`${cx},${cz}`);
        if (cell) for (const id of cell) out.push(id);
      }
    }
    return out;
  }
}

// The (at most) max players nearest to self within radius, nearest first. positions: id → { x, z }
function nearestInView(grid, positions, selfId, radius, max) {
  const self = positions.get(selfId);
  if (!self) return [];
  const r2 = radius * radius;
  const found = [];
  for (const id of grid.candidates(self.x, self.z, radius)) {
    if (id === selfId) continue;
    const p = positions.get(id);
    if (!p) continue;
    const d2 = (p.x - self.x) ** 2 + (p.z - self.z) ** 2;
    if (d2 <= r2) found.push({ id, d2 });
  }
  found.sort((a, b) => a.d2 - b.d2);
  if (found.length > max) found.length = max;
  return found.map((f) => f.id);
}

export { SpatialGrid, nearestInView };
