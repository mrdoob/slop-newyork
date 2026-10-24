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

import { deckHeights } from './geo-elevated.mjs';
export { deckNear, placePiers } from './geo-elevated.mjs';

const DECK_M = (layer) => (layer >= 3 ? 13 : 10); // deck top above the street (estimate: Taipei's elevated MRT runs ~3 storeys up)
const RAMP_SLOPE = 0.05; // rise per metre approaching a portal (estimate; metro grades are a few per cent)
const TRACK_W = 4.4; // deck width per mapped track (m; a double-track line mapped as two ways reads ~9 m)
const KINDS = /^(subway|light_rail|monorail)$/;

export function buildTransit(elements, toWorld) {
  const ways = elements.filter((e) => e.type === 'way' && KINDS.test(e.tags?.railway || '') && e.geometry?.length >= 2 && e.nodes?.length === e.geometry.length);
  const tunnel = (t) => (t.tunnel && t.tunnel !== 'no') || parseFloat(t.layer) < 0 || t.location === 'underground';
  const elevated = (t) => (t.bridge && t.bridge !== 'no') || parseFloat(t.layer) >= 1;
  const pos = new Map(); // node id -> [x, z]
  for (const w of ways) w.geometry.forEach((g, i) => pos.set(w.nodes[i], toWorld(g.lon, g.lat)));
  // the track network above ground; tunnel nodes are portals (deck height 0 there), as are nodes of track at grade
  const portals = ways.filter((w) => tunnel(w.tags)).flatMap((w) => w.nodes);
  const net = ways.filter((w) => !tunnel(w.tags)).map((w) => ({ ids: w.nodes, pts: w.nodes.map((n) => pos.get(n)), elevated: elevated(w.tags), deck: DECK_M(parseFloat(w.tags.layer) || 1) }));
  const heights = deckHeights(net, portals, RAMP_SLOPE);
  const heightOf = (n) => heights.get(n) ?? 0;

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
