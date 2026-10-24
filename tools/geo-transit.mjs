// tools/geo-transit.mjs
// Metro / light-rail track above ground, from OSM (osm_transit.json: railway=subway|light_rail|monorail ways, with their
// node ids): elevated guideways (bridge=yes or layer >= 1) and track at grade. Tunnels are left out.
//
// OSM gives no guideway heights (layer / level only), so the deck height is an ESTIMATE: DECK_M by layer, ramping down at
// RAMP_SLOPE to 0 where the guideway meets track at grade or a tunnel portal (graph distance along the track from those
// nodes). Labelled as estimated in GEO.rail.note.
//
// buildTransit(elements, toWorld) -> { lines: [[elevated 0|1, width m, [x, z, ...], [deck height m per point]]],
//   stations: [[name, name:en, x, z]] (railway=station nodes: metro and rail, underground ones included), stats }

const DECK_M = (layer) => (layer >= 3 ? 13 : 10); // deck top above the street (estimate: Taipei's elevated MRT runs ~3 storeys up)
const RAMP_SLOPE = 0.05; // rise per metre approaching a portal (estimate; metro grades are a few per cent)
const TRACK_W = 4.4; // deck width per mapped track (m; a double-track line mapped as two ways reads ~9 m)
const KINDS = /^(subway|light_rail|monorail)$/;

export function buildTransit(elements, toWorld) {
  const ways = elements.filter((e) => e.type === 'way' && KINDS.test(e.tags?.railway || '') && e.geometry?.length >= 2 && e.nodes?.length === e.geometry.length);
  const tunnel = (t) => (t.tunnel && t.tunnel !== 'no') || parseFloat(t.layer) < 0 || t.location === 'underground';
  const elevated = (t) => (t.bridge && t.bridge !== 'no') || parseFloat(t.layer) >= 1;
  const pos = new Map(); // node id -> [x, z]
  const adj = new Map(); // node id -> [[node id, m]] along non-tunnel track
  const deck = new Map(); // node id -> deck height of the elevated ways through it
  const portal = new Set(); // nodes on tunnels or track at grade: deck height 0 there
  for (const w of ways) {
    const t = w.tags;
    w.geometry.forEach((g, i) => pos.set(w.nodes[i], toWorld(g.lon, g.lat)));
    if (tunnel(t) || !elevated(t)) { for (const n of w.nodes) portal.add(n); }
    if (tunnel(t)) continue;
    for (let i = 0; i < w.nodes.length; i++) {
      const n = w.nodes[i];
      if (elevated(t)) deck.set(n, Math.max(deck.get(n) || 0, DECK_M(parseFloat(t.layer) || 1)));
      if (i) {
        const m = w.nodes[i - 1], [ax, az] = pos.get(m), [bx, bz] = pos.get(n), d = Math.hypot(bx - ax, bz - az);
        for (const [p, q] of [[m, n], [n, m]]) { if (!adj.has(p)) adj.set(p, []); adj.get(p).push([q, d]); }
      }
    }
  }
  // Distance along the track from the nearest portal (Dijkstra; few thousand nodes at most)
  const dist = new Map([...portal].filter((n) => adj.has(n)).map((n) => [n, 0]));
  const queue = [...dist.keys()];
  while (queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (dist.get(queue[i]) < dist.get(queue[bi])) bi = i;
    const n = queue.splice(bi, 1)[0], dn = dist.get(n);
    for (const [m, d] of adj.get(n) || []) {
      if (dn + d < (dist.get(m) ?? Infinity)) { dist.set(m, dn + d); queue.push(m); }
    }
  }
  const heightOf = (n) => (portal.has(n) ? 0 : Math.min(deck.get(n) || 0, (dist.get(n) ?? Infinity) * RAMP_SLOPE));

  const lines = [];
  const stats = { elevated: 0, grade: 0, tunnel: 0, elevatedM: 0 };
  const r1 = (v) => Math.round(v * 10) / 10;
  for (const w of ways) {
    const t = w.tags;
    if (tunnel(t)) { stats.tunnel++; continue; }
    const pts = w.nodes.map((n) => pos.get(n));
    const up = elevated(t);
    const hs = up ? w.nodes.map(heightOf) : w.nodes.map(() => 0);
    lines.push([up ? 1 : 0, TRACK_W, pts.flatMap(([x, z]) => [r1(x), r1(z)]), hs.map(r1)]);
    if (up) {
      stats.elevated++;
      for (let i = 1; i < pts.length; i++) stats.elevatedM += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    } else stats.grade++;
  }
  stats.elevatedM = Math.round(stats.elevatedM);
  const stations = elements.filter((e) => e.type === 'node' && e.tags?.railway === 'station' && e.tags.name && !/under construction|興建中/i.test(e.tags['name:en'] || ''))
    .map((e) => { const [x, z] = toWorld(e.lon, e.lat); return [e.tags.name, e.tags['name:en'] || '', r1(x), r1(z)]; });
  return { lines, stations, stats };
}

// Deck height (estimate) by layer, for an elevated station building with no guideway mapped beside it
export const STATION_DECK_M = DECK_M;

// Deck top height (m) of the elevated guideway nearest (x, z) within `within` m, or null
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

// Piers under the elevated guideways: every PIER_EVERY_M along each line where the deck's underside is over 2.5 m up.
// A double track mapped as two ways shares one row (piers of the two within PAIR_M merge at their midpoint). Like the
// real viaduct, which spans junctions, no pier stands in a drawn carriageway (`onRoad(x, z, margin)`: kerbClear, null or
// { moved } inside a road) or a building (`inBuilding(x, z)`).
// -> [[x, z, yaw, deck underside height m]]
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
