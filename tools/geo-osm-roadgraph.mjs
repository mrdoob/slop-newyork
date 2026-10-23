// tools/geo-osm-roadgraph.mjs
// Street graph from OpenStreetMap `highway` ways, for cities without a street centerline dataset or a regular grid
// (NYC's graph comes from the CSCL in geo-roadgraph.mjs). City-agnostic: the frame's toWorld is passed in.
//
// buildOsmRoadGraph(elements, toWorld) returns
//   roadGraph  { nodes [x, z, ...], links [[node a, node b, name index, curb-to-curb width m, travel lanes,
//              direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...]], ...], names }
//              (the same shape as NYC's GEO.roadGraph): drivable ways at grade, split wherever two ways share a node
//   paths      [[kind index, width m, elevation m, [x, z, ...]], ...] for walking ways, with `pathKinds` naming kinds
//
// Widths: OSM `width` when tagged, else `lanes` × LANE_M, else a per-class default (lanes per carriageway way; a dual
// carriageway is two one-way ways). Untagged widths are class defaults, not measurements.
// Tunnels and indoor ways (MRT corridors, malls) are left out. Elevated walkways (bridge + layer ≥ 1, e.g. skywalks)
// get an elevation of SKYWALK_M per layer: OSM `layer` orders levels but does not give a height, so this is an estimate.

export const LANE_M = 3.25;
const SKYWALK_M = 6;
// Travel lanes per way by highway class when `lanes` is untagged
const DEFAULT_LANES = {
  motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, motorway_link: 1, trunk_link: 1, primary_link: 1,
  secondary_link: 1, tertiary_link: 1, unclassified: 2, residential: 2, living_street: 1, busway: 1, service: 1
};
const SERVICE_WIDTH = { alley: 3.5, driveway: 3, parking_aisle: 5 };
const PATH_WIDTH = { footway: 2.5, crossing: 4, pedestrian: 6, cycleway: 2.5, steps: 2.5, path: 2, track: 3, bridleway: 2 };
export const PATH_KINDS = ['footway', 'crossing', 'pedestrian', 'cycleway', 'steps', 'path'];

const isTrue = (v) => v != null && v !== 'no';
const metres = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*m?\s*$/.exec(v || '');
  return m ? parseFloat(m[1]) : null;
};

export function buildOsmRoadGraph(elements, toWorld, log = () => {}) {
  const drivable = [];
  const paths = [];
  let skipped = 0;
  for (const e of elements) {
    const t = e.tags || {};
    const hw = t.highway;
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || !hw) continue;
    if (isTrue(t.tunnel) || isTrue(t.indoor) || t.level != null || t.location === 'underground' || hw === 'corridor') { skipped++; continue; }
    const layer = parseFloat(t.layer) || 0;
    const pts = e.geometry.map((g) => toWorld(g.lon, g.lat));
    if (hw in DEFAULT_LANES) {
      if (isTrue(t.bridge) && layer >= 1) { skipped++; continue; } // elevated roadways: none in scope yet
      if (t.area === 'yes' || t.access === 'no') { skipped++; continue; }
      const lanes = Math.max(1, Math.round(parseFloat(t.lanes) || DEFAULT_LANES[hw]));
      const width = metres(t.width) ?? (hw === 'service' && !t.lanes ? SERVICE_WIDTH[t.service] ?? 4 : lanes * LANE_M);
      const dir = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0;
      drivable.push({ ids: e.nodes, pts, name: t['name:en'] || t.name || '', width, lanes, dir });
    } else {
      const kind = t.footway === 'crossing' || t.cycleway === 'crossing' ? 'crossing' : PATH_KINDS.includes(hw) ? hw : hw === 'track' || hw === 'bridleway' ? 'path' : null;
      if (!kind || t.area === 'yes') { skipped++; continue; }
      const elev = isTrue(t.bridge) && layer >= 1 ? layer * SKYWALK_M : 0;
      paths.push([PATH_KINDS.indexOf(kind), metres(t.width) ?? PATH_WIDTH[kind], elev, pts]);
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
  for (const w of drivable) {
    let start = 0;
    for (let i = 1; i < w.ids.length; i++) {
      if (i < w.ids.length - 1 && uses.get(w.ids[i]) < 2) continue;
      if (w.ids[start] !== w.ids[i]) {
        const a = nodeOf(w.ids[start], w.pts[start]);
        const b = nodeOf(w.ids[i], w.pts[i]);
        links.push([a, b, nameId(w.name), w.width, w.lanes, w.dir, w.pts.slice(start + 1, i)]);
      }
      start = i;
    }
  }
  log(`road graph: ${nodes.length / 2} nodes, ${links.length} links from ${drivable.length} drivable ways; ${paths.length} walking ways; ${skipped} tunnel/indoor/area/elevated ways skipped`);
  return { roadGraph: { nodes, links, names }, paths };
}
