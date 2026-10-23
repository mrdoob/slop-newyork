// tools/geo-osm-roadgraph.mjs
// Street graph from OpenStreetMap `highway` ways, for cities without a street centerline dataset or a regular grid
// (NYC's graph comes from the CSCL in geo-roadgraph.mjs). City-agnostic: the frame's toWorld is passed in.
//
// buildOsmRoadGraph(elements, toWorld) returns
//   roadGraph  { nodes [x, z, ...], links [[node a, node b, name index, curb-to-curb width m, travel lanes,
//              direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...]], ...], names }
//              (the same shape as NYC's GEO.roadGraph): drivable ways at grade, split wherever two ways share a node
//              and at traffic signals; plus `signals` [node index, ...]: nodes carrying a traffic signal (`signalIds`),
//              and per link (parallel to `links`): `widthSource` (WIDTH_SOURCES index), `highway` (OSM class) and
//              `sidewalk` [left, right] (SIDEWALK_TAGS index, sides relative to the link's a -> b direction)
//   paths      [[kind index, width m, elevation m, [x, z, ...], per-vertex heights [y, ...] | 0], ...] for walking
//              ways, with `pathKinds` naming kinds (heights only for ramps: stairs up to a skywalk)
//
// Widths: OSM `width` when tagged, else `lanes` × LANE_M, else a per-class default (lanes per carriageway way; a dual
// carriageway is two one-way ways). Untagged widths are class defaults, not measurements.
// Underground ways are left out: tunnels, building passages, indoor ways (MRT corridors, malls), `level` below ground
// and anything with layer < 0 (Taipei maps underground walkways and parking ramps with only layer=-1). Elevated
// walkways (layer ≥ 1, e.g. skywalks) get an elevation of SKYWALK_M per layer: OSM `layer` orders levels but does not
// give a height, so this is an estimate. Elevated stairs ramp from the ground up to the end that meets another elevated
// walkway.

export const LANE_M = 3.25;
const SKYWALK_M = 6;
// Travel lanes per way by highway class when `lanes` is untagged
const DEFAULT_LANES = {
  motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, motorway_link: 1, trunk_link: 1, primary_link: 1,
  secondary_link: 1, tertiary_link: 1, unclassified: 2, residential: 2, living_street: 1, busway: 1, service: 1
};
const SERVICE_WIDTH = { alley: 3.5, driveway: 3, parking_aisle: 5 };
const PATH_WIDTH = { footway: 2.5, sidewalk: 2.5, crossing: 4, pedestrian: 6, cycleway: 2.5, steps: 2.5, path: 2, track: 3, bridleway: 2 };
export const PATH_KINDS = ['footway', 'crossing', 'pedestrian', 'cycleway', 'steps', 'path', 'sidewalk'];
export const WIDTH_SOURCES = ['width tag', 'lanes tag', 'class default', 'fitted to sidewalks'];
export const SIDEWALK_TAGS = ['unknown', 'yes', 'no', 'separate'];
// OSM sidewalk tags of a way -> [left, right] SIDEWALK_TAGS indices
function sidewalkSides(t) {
  const code = (v) => (v == null ? 0 : v === 'separate' ? 3 : v === 'no' || v === 'none' ? 2 : 1);
  const s = t.sidewalk;
  let left = s === 'both' || s === 'left' ? 1 : s === 'right' || s === 'no' || s === 'none' ? 2 : s === 'separate' ? 3 : 0;
  let right = s === 'both' || s === 'right' ? 1 : s === 'left' || s === 'no' || s === 'none' ? 2 : s === 'separate' ? 3 : 0;
  if (t['sidewalk:both'] != null) left = right = code(t['sidewalk:both']);
  if (t['sidewalk:left'] != null) left = code(t['sidewalk:left']);
  if (t['sidewalk:right'] != null) right = code(t['sidewalk:right']);
  return [left, right];
}

const isTrue = (v) => v != null && v !== 'no';
const belowGround = (t) => {
  const levels = String(t.level ?? '').split(';').map(parseFloat).filter(Number.isFinite);
  return isTrue(t.tunnel) || isTrue(t.indoor) || t.location === 'underground' || t.highway === 'corridor' ||
    (parseFloat(t.layer) || 0) < 0 || (levels.length > 0 && levels.every((l) => l < 0));
};
const metres = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*m?\s*$/.exec(v || '');
  return m ? parseFloat(m[1]) : null;
};

export function buildOsmRoadGraph(elements, toWorld, log = () => {}, { signalIds = new Set() } = {}) {
  const drivable = [];
  const paths = [];
  let skipped = 0;
  for (const e of elements) {
    const t = e.tags || {};
    const hw = t.highway;
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || !hw) continue;
    if (belowGround(t)) { skipped++; continue; }
    const layer = parseFloat(t.layer) || 0;
    const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
    if (hw in DEFAULT_LANES) {
      if (layer >= 1) { skipped++; continue; } // elevated roadways: none in scope yet
      if (t.area === 'yes' || t.access === 'no') { skipped++; continue; }
      const lanes = Math.max(1, Math.round(parseFloat(t.lanes) || DEFAULT_LANES[hw]));
      const tagged = metres(t.width);
      const width = tagged ?? (hw === 'service' && !t.lanes ? SERVICE_WIDTH[t.service] ?? 4 : lanes * LANE_M);
      const widthSource = tagged != null ? 0 : t.lanes ? 1 : 2;
      const dir = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0;
      drivable.push({ ids: e.nodes, pts, name: t['name:en'] || t.name || '', width, lanes, dir, widthSource, hw, sidewalk: sidewalkSides(t),
        sidewalkWidth: metres(t['sidewalk:both:width']) ?? metres(t['sidewalk:width']) });
    } else {
      const kind = t.footway === 'crossing' || t.cycleway === 'crossing' ? 'crossing' : t.footway === 'sidewalk' ? 'sidewalk'
        : PATH_KINDS.includes(hw) ? hw : hw === 'track' || hw === 'bridleway' ? 'path' : null;
      if (!kind || t.area === 'yes') { skipped++; continue; }
      const elev = layer >= 1 ? layer * SKYWALK_M : 0;
      paths.push({ k: PATH_KINDS.indexOf(kind), w: metres(t.width) ?? PATH_WIDTH[kind], elev, pts, ids: e.nodes || [], steps: kind === 'steps' });
    }
  }

  // Split drivable ways at shared nodes (junctions) and at their ends
  const uses = new Map();
  for (const w of drivable) for (const id of w.ids) uses.set(id, (uses.get(id) || 0) + 1);
  const nodeIndex = new Map();
  const nodes = [];
  const nodeOf = (id, p) => {
    if (!nodeIndex.has(id)) { nodeIndex.set(id, nodes.length / 2); nodes.push(p[0], p[1]); }
    return nodeIndex.get(id);
  };
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
    return nameIds.get(n);
  };
  const links = [];
  const widthSource = [], highway = [], sidewalk = [], sidewalkWidth = [];
  for (const w of drivable) {
    let start = 0;
    for (let i = 1; i < w.ids.length; i++) {
      if (i < w.ids.length - 1 && uses.get(w.ids[i]) < 2 && !signalIds.has(w.ids[i])) continue;
      if (w.ids[start] !== w.ids[i]) {
        const a = nodeOf(w.ids[start], w.pts[start]);
        const b = nodeOf(w.ids[i], w.pts[i]);
        links.push([a, b, nameId(w.name), w.width, w.lanes, w.dir, w.pts.slice(start + 1, i)]);
        widthSource.push(w.widthSource);
        highway.push(w.hw);
        sidewalk.push(w.sidewalk);
        sidewalkWidth.push(w.sidewalkWidth ?? 0);
      }
      start = i;
    }
  }
  // Elevated stairs: high where they meet another elevated walkway, on the ground at their other end
  const deckNodes = new Map();
  for (const p of paths) {
    if (p.elev > 0 && !p.steps) for (const id of p.ids) deckNodes.set(id, p.elev);
  }
  const pathsOut = paths.map((p) => {
    let ys = 0;
    if (p.elev > 0 && p.steps && p.ids.length === p.pts.length) {
      const top0 = deckNodes.get(p.ids[0]), top1 = deckNodes.get(p.ids[p.ids.length - 1]);
      if ((top0 != null) !== (top1 != null)) {
        const cum = [0];
        for (let i = 1; i < p.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]));
        const L = cum[cum.length - 1] || 1;
        ys = cum.map((d) => (top0 != null ? top0 * (1 - d / L) : top1 * (d / L)));
      }
    }
    return [p.k, p.w, p.elev, p.pts, ys];
  });

  const signals = [...nodeIndex].filter(([id]) => signalIds.has(id)).map(([, i]) => i);
  log(`road graph: ${signals.length} signalised nodes`);
  log(`road graph: ${nodes.length / 2} nodes, ${links.length} links from ${drivable.length} drivable ways; ${paths.length} walking ways; ${skipped} underground/indoor/area/elevated-road ways skipped`);
  return { roadGraph: { nodes, links, names, signals, widthSource, highway, sidewalk, sidewalkWidth }, paths: pathsOut };
}
