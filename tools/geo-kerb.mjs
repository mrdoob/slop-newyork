// tools/geo-kerb.mjs
// Keeping point objects (street furniture, trees) off the carriageways the viewer draws.
//
// The drawn carriageway is the street centre line widened to its curb-to-curb width, and that width is often an
// estimate (lanes × 3.25 m, a class default, or fitted to mapped sidewalks: tools/geo-osm-roadgraph.mjs,
// tools/geo-sidewalks.mjs). A hydrant or tree mapped correctly at the real kerb can then land inside the drawn road.
// kerbClear() moves such a point straight out to the nearest drawn kerb (plus a margin), so it stands where the street
// meets the pavement in the render. When that spot is inside another carriageway or a building it tries tighter and wider
// spots, then the far kerb, and reports null when none is clear.
//
// kerbClear(roadGraph, solid) -> (x, z, margin = 0.5) -> { x, z, moved, yaw } | null
//   yaw: radians turning the item's front (+z) towards the road it was moved off (moved items only)

const CELL = 20;

export function kerbClear(RG, solid = () => false) {
  const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
  const segs = [];
  for (const [a, b, , w, , , inner] of RG.links) {
    const pts = [node(a)];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push(node(b));
    for (let k = 0; k + 1 < pts.length; k++) segs.push({ a: pts[k], b: pts[k + 1], r: w / 2 });
  }
  const grid = new Map();
  const PAD = 4;
  for (const s of segs) {
    const x0 = Math.min(s.a[0], s.b[0]) - s.r - PAD, x1 = Math.max(s.a[0], s.b[0]) + s.r + PAD;
    const z0 = Math.min(s.a[1], s.b[1]) - s.r - PAD, z1 = Math.max(s.a[1], s.b[1]) + s.r + PAD;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = `${i},${j}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }
  const closest = (x, z, { a: [x0, z0], b: [x1, z1] }) => {
    const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
    const px = x0 + dx * t, pz = z0 + dz * t;
    return { px, pz, d: Math.hypot(px - x, pz - z), nx: -dz / Math.sqrt(L2), nz: dx / Math.sqrt(L2) };
  };
  // The carriageway the point is deepest inside (smallest d / r), or null
  const inside = (x, z, extra = 0) => {
    let best = null;
    for (const s of grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      const c = closest(x, z, s);
      if (c.d < s.r + extra && (!best || c.d / s.r < best.d / best.s.r)) best = { ...c, s };
    }
    return best;
  };
  return (x, z, margin = 0.5) => {
    const hit = inside(x, z, Math.min(margin, 0.25));
    if (!hit) return { x, z, moved: false };
    // straight out from the centre line; a point on the line itself goes to whichever side is clear
    const out = hit.d > 0.05 ? [[(x - hit.px) / hit.d, (z - hit.pz) / hit.d]] : [[hit.nx, hit.nz], [-hit.nx, -hit.nz]];
    // the margin first, then tighter against the kerb (a lane hemmed in by walls), then further out (a pavement
    // crowded by another road's edge), on the far side last
    const steps = [margin, ...[0.35, 0.2, 0.1].filter((m) => m < margin), ...[0.5, 1, 1.5, 2, 3].map((m) => margin + m)];
    for (const [ux, uz] of [...out, [-out[0][0], -out[0][1]]]) {
      for (const m of steps) {
        const nx = hit.px + ux * (hit.s.r + m), nz = hit.pz + uz * (hit.s.r + m);
        if (!inside(nx, nz, 0.05) && !solid(nx, nz)) return { x: nx, z: nz, moved: true, yaw: Math.atan2(-ux, -uz) };
      }
    }
    return null;
  };
}
