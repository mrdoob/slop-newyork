// tools/geo-elevated.mjs
// Shared by elevated structures above ground (metro guideways, tools/geo-transit.mjs; elevated roads, the build):
//   deckHeights   a deck height per node of a network of OSM ways. OSM maps `layer`, not heights, so heights are
//                 ESTIMATES: the deck height for the way's layer, ramping down at `slope` to 0 where the network meets
//                 ways at ground level (graph distance along the network from those nodes).
//   placePiers    piers under elevated lines: one every PIER_EVERY_M, twin lines (two one-way carriageways, two tracks)
//                 sharing a row where their piers fall within PAIR_M, none in a drawn carriageway or a building.

// ways: [{ ids: [node id], pts: [[x, z]], elevated: bool, deck: m (elevated ways) }]; portals: node ids at ground level
// (ways leaving the network there). -> Map node id -> deck top height m
export function deckHeights(ways, portals, slope) {
  const adj = new Map(), deck = new Map(), atGrade = new Set(portals);
  for (const w of ways) {
    for (let i = 0; i < w.ids.length; i++) {
      const n = w.ids[i];
      if (!w.elevated) atGrade.add(n);
      else deck.set(n, Math.max(deck.get(n) || 0, w.deck));
      if (i) {
        const m = w.ids[i - 1], d = Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
        for (const [p, q] of [[m, n], [n, m]]) { if (!adj.has(p)) adj.set(p, []); adj.get(p).push([q, d]); }
      }
    }
  }
  // Dijkstra from the ground-level nodes (a few thousand nodes at most; a linear scan for the minimum is enough)
  const dist = new Map([...atGrade].filter((n) => adj.has(n)).map((n) => [n, 0]));
  const queue = [...dist.keys()];
  while (queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (dist.get(queue[i]) < dist.get(queue[bi])) bi = i;
    const n = queue.splice(bi, 1)[0], dn = dist.get(n);
    for (const [m, d] of adj.get(n) || []) {
      if (dn + d < (dist.get(m) ?? Infinity)) { dist.set(m, dn + d); queue.push(m); }
    }
  }
  const out = new Map();
  for (const n of adj.keys()) out.set(n, atGrade.has(n) ? 0 : Math.min(deck.get(n) || 0, (dist.get(n) ?? Infinity) * slope));
  return out;
}

// Deck top height m nearest (x, z) within `within` m on elevated lines [elevated 0|1, width, [x, z, ...], [heights]]
export function deckNear(lines, x, z, within = 40) {
  let best = null, bd = within;
  for (const [up, , f, hs] of lines) {
    if (!up) continue;
    for (let i = 0; i < f.length; i += 2) {
      const d = Math.hypot(f[i] - x, f[i + 1] - z);
      if (d < bd && hs[i / 2] > 0) { bd = d; best = hs[i / 2]; }
    }
  }
  return best;
}

// lines as deckNear; onRoad(x, z, margin): kerbClear (null or { moved } inside a carriageway); -> { piers: [[x, z, yaw,
// deck underside height m]], candidates }
const PIER_EVERY_M = 32, PAIR_M = 8, PIER_HALF_M = 1.0;
export function placePiers(lines, deckDepth, onRoad, inBuilding = () => false) {
  const raw = [];
  for (const [up, , f, hs] of lines) {
    if (!up) continue;
    let carry = PIER_EVERY_M / 2;
    for (let i = 0; i + 2 < f.length; i += 2) {
      const ax = f[i], az = f[i + 1], bx = f[i + 2], bz = f[i + 3], L = Math.hypot(bx - ax, bz - az);
      while (carry < L) {
        const t = carry / L, under = hs[i / 2] + (hs[i / 2 + 1] - hs[i / 2]) * t - deckDepth;
        if (under > 2.5) raw.push([ax + (bx - ax) * t, az + (bz - az) * t, Math.atan2(bx - ax, bz - az), under]);
        carry += PIER_EVERY_M;
      }
      carry -= L;
    }
  }
  const used = new Uint8Array(raw.length), piers = [];
  const r1 = (v) => Math.round(v * 10) / 10;
  for (let i = 0; i < raw.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let j = -1, bd = PAIR_M;
    for (let k = i + 1; k < raw.length; k++) {
      if (used[k]) continue;
      const d = Math.hypot(raw[k][0] - raw[i][0], raw[k][1] - raw[i][1]);
      if (d < bd) { bd = d; j = k; }
    }
    let [x, z, yaw, under] = raw[i];
    if (j >= 0) { used[j] = 1; x = (x + raw[j][0]) / 2; z = (z + raw[j][1]) / 2; under = Math.min(under, raw[j][3]); }
    const c = onRoad(x, z, PIER_HALF_M);
    if (!c || c.moved || inBuilding(x, z)) continue;
    piers.push([r1(x), r1(z), Math.round(yaw * 1000) / 1000, r1(under)]);
  }
  return { piers, candidates: raw.length };
}
