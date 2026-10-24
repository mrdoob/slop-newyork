// tools/geo-furniture.mjs
// Street furniture from OpenStreetMap nodes & areas, for footprint cities (tools/build-taipei-geodata.mjs).
//
// buildFurniture(elements, toWorld, roadGraph, solid) -> rows [kind index, x, z, yaw, source index, extra]
//   kind: FURNITURE_KINDS; yaw: radians, the item's front (+z of its model) turned towards the nearest road;
//   source: FURNITURE_SOURCES ('mapped': an OSM node at its mapped position; 'inferred': see below);
//   extra: bicycle_rental capacity (docks), otherwise 0.
// Inferred items, labelled as such:
//   - street lamps: OSM maps very few here, while streets this wide are lit; one every LAMP_M along each kerb of
//     streets ≥ 9 m wide (one kerb for 6–9 m streets), clear of junctions, buildings and mapped lamps.
//   - scooters: rows filling mapped motorcycle_parking areas (the area is mapped, the number of scooters is not).
//   - bikes (expandDocks): one per dock in a row beside a bike-share kiosk (count from its mapped capacity) or a
//     bicycle rack (4), on whichever side of it keeps the row clear.

export const FURNITURE_KINDS = ['street_lamp', 'bus_stop', 'bus_shelter', 'subway_entrance', 'bicycle_rental', 'fire_hydrant', 'flagpole',
  'drinking_water', 'post_box', 'waste_basket', 'telephone', 'vending_machine', 'bicycle_parking', 'scooter', 'bike_share', 'bike'];
export const FURNITURE_SOURCES = ['mapped', 'inferred'];

const LAMP_M = 32;
const LAMP_CLEAR_M = 12; // m: no inferred lamp this close to a mapped one
const SCOOTER = [0.9, 2.1]; // m: one parked scooter's slot (across, along)

function kindOf(t) {
  if (t.highway === 'street_lamp') return 'street_lamp';
  if (t.highway === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes')) return t.shelter === 'yes' ? 'bus_shelter' : 'bus_stop';
  if (t.railway === 'subway_entrance') return /電梯|elevator/i.test(t.name || '') || String(t.level || '').startsWith('-') ? null : 'subway_entrance';
  if (t.emergency === 'fire_hydrant') return 'fire_hydrant';
  if (t.man_made === 'flagpole') return 'flagpole';
  const a = t.amenity;
  return ['bicycle_rental', 'drinking_water', 'post_box', 'waste_basket', 'telephone', 'vending_machine', 'bicycle_parking'].includes(a) ? a : null;
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function buildFurniture(elements, toWorld, roadGraph, solid = () => false) {
  const RG = roadGraph;
  const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
  const lines = RG.links.map(([a, b, , w, , , inner]) => {
    const pts = [node(a)];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push(node(b));
    return { pts, w, a, b };
  });
  // Yaw turning an item's front towards the nearest road centre line (0 when no road within 60 m). Segments are
  // bucketed in 60 m cells, so the 3 × 3 cells around an item hold every segment within reach; they are tested in
  // their original order, which keeps ties resolving as a full scan would.
  const REACH = 60, segCells = new Map(), segs = [];
  for (const { pts } of lines) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const s = segs.push([pts[i], pts[i + 1]]) - 1;
      const [[x0, z0], [x1, z1]] = segs[s];
      for (let a = Math.floor(Math.min(x0, x1) / REACH); a <= Math.floor(Math.max(x0, x1) / REACH); a++) {
        for (let b = Math.floor(Math.min(z0, z1) / REACH); b <= Math.floor(Math.max(z0, z1) / REACH); b++) {
          const k = `${a},${b}`;
          if (!segCells.has(k)) segCells.set(k, []);
          segCells.get(k).push(s);
        }
      }
    }
  }
  function yawToRoad(x, z) {
    let best = null, bd = REACH;
    const ci = Math.floor(x / REACH), cj = Math.floor(z / REACH), near = new Set();
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) for (const s of segCells.get(`${a},${b}`) || []) near.add(s);
    for (const s of [...near].sort((p, q) => p - q)) {
      const [[x0, z0], [x1, z1]] = segs[s];
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
      const px = x0 + dx * t, pz = z0 + dz * t, d = Math.hypot(px - x, pz - z);
      if (d < bd) { bd = d; best = [px, pz]; }
    }
    return best && bd > 0.1 ? Math.atan2(best[0] - x, best[1] - z) : 0;
  }
  const rows = [];
  const add = (kind, x, z, yaw, source, extra = 0) => rows.push([FURNITURE_KINDS.indexOf(kind), x, z, yaw, FURNITURE_SOURCES.indexOf(source), extra]);

  // Mapped nodes
  for (const e of elements) {
    if (e.type !== 'node' || !e.tags) continue;
    const kind = kindOf(e.tags);
    if (!kind) continue;
    const [x, z] = toWorld(e.lon, e.lat);
    add(kind, x, z, yawToRoad(x, z), 'mapped', kind === 'bicycle_rental' ? parseInt(e.tags.capacity, 10) || 10 : 0);
  }
  // Scooters filling mapped motorcycle parking areas, in rows across the area's long axis
  for (const e of elements) {
    if (e.type !== 'way' || !e.geometry || !e.tags || e.tags.amenity !== 'motorcycle_parking') continue;
    const ring = e.geometry.map((g) => toWorld(g.lon, g.lat));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const alongX = x1 - x0 > z1 - z0;
    const [sa, sb] = alongX ? [SCOOTER[0], SCOOTER[1]] : [SCOOTER[1], SCOOTER[0]];
    for (let x = x0 + sa / 2; x < x1; x += sa) {
      for (let z = z0 + sb / 2; z < z1; z += sb) if (pointInRing(x, z, ring)) add('scooter', x, z, alongX ? 0 : Math.PI / 2, 'inferred');
    }
  }
  // Inferred street lamps along kerbs, clear of junctions, buildings and mapped lamps
  const mappedLamps = rows.filter((r) => FURNITURE_KINDS[r[0]] === 'street_lamp').map((r) => [r[1], r[2]]);
  const nodeCount = RG.nodes.length / 2;
  const reach = new Float32Array(nodeCount), degree = new Uint16Array(nodeCount);
  for (const { a, b, w } of lines) for (const n of [a, b]) { reach[n] = Math.max(reach[n], w / 2); degree[n]++; }
  lines.forEach(({ pts, w, a, b }) => {
    if (w < 6) return;
    const sides = w >= 9 ? [-1, 1] : [1];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1];
    const clear0 = degree[a] >= 3 ? reach[a] + 6 : 4, clear1 = degree[b] >= 3 ? reach[b] + 6 : 4;
    for (let s = clear0, k = 0; s < total - clear1; s += LAMP_M, k++) {
      let i = 1;
      while (i < pts.length - 1 && cum[i] < s) i++;
      const L = cum[i] - cum[i - 1] || 1, f = (s - cum[i - 1]) / L;
      const dx = (pts[i][0] - pts[i - 1][0]) / L, dz = (pts[i][1] - pts[i - 1][1]) / L;
      const cx = pts[i - 1][0] + dx * L * f, cz = pts[i - 1][1] + dz * L * f;
      for (const side of sides) {
        if (sides.length === 2 && (k % 2 === 0) !== (side < 0)) continue; // staggered across wide streets
        const off = (w / 2 + 0.6) * side;
        const x = cx - dz * off, z = cz + dx * off;
        if (solid(x, z) || mappedLamps.some(([lx, lz]) => Math.hypot(lx - x, lz - z) < LAMP_CLEAR_M)) continue;
        add('street_lamp', x, z, Math.atan2(cx - x, cz - z), 'inferred');
      }
    }
  });
  return rows;
}

// One bike per dock in a row beside each bike-share kiosk / bicycle rack, along the kerb (the item's +x). The row
// starts DOCK_START m from the item on one side; it goes to whichever side leaves more bikes where ok(x, z), and bikes
// that still land somewhere not ok (a road, a building) are left out. Returns the new 'bike_share' / 'bike' rows.
const DOCK_M = 0.62;
const DOCK_START = { bicycle_rental: 0.9, bicycle_parking: 1.1 };
export function expandDocks(rows, ok = () => true) {
  const out = [];
  for (const [k, x, z, yaw, , extra] of rows) {
    const kind = FURNITURE_KINDS[k];
    if (!(kind in DOCK_START)) continue;
    const n = kind === 'bicycle_rental' ? Math.min(14, Math.max(4, Math.round((extra || 10) / 3))) : 4;
    const ax = Math.cos(yaw), az = -Math.sin(yaw); // the model's +x in the world
    const row = (side) => Array.from({ length: n }, (_, i) => { const t = side * (DOCK_START[kind] + i * DOCK_M); return [x + ax * t, z + az * t]; });
    const sides = [1, -1].map((side) => row(side).filter(([bx, bz]) => ok(bx, bz)));
    const bikes = sides[1].length > sides[0].length ? sides[1] : sides[0];
    const bike = FURNITURE_KINDS.indexOf(kind === 'bicycle_rental' ? 'bike_share' : 'bike');
    for (const [bx, bz] of bikes) out.push([bike, bx, bz, yaw, FURNITURE_SOURCES.indexOf('inferred'), 0]);
  }
  return out;
}
