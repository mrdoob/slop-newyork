import * as THREE from 'three/webgpu';
import { heightAt, resample } from './terrain.js';
import { attribute, fract, step, mix, color, float } from 'three/tsl';

// js/graph-roads.js
// Road surfaces from a street centreline graph (GEO.roadGraph) and walking ways (GEO.paths), as flat ribbons:
// asphalt per link at its curb-to-curb width, a disc at every junction to close the joints, lane markings derived
// from each link's lane count and direction, paving for footways, raised sidewalks with kerbs, zebra stripes on
// crossings and raised skywalks.
// City-agnostic: everything comes in through `geo`; marking colours can be passed in `options`.

const Y = { path: 0.04, road: 0.08, marking: 0.12, crossing: 0.14 }; // stacking above the ground plane (m)
const MITER_LIMIT = 3;
const MARK_W = 0.15; // lane line width (m)
const DASH = [3, 6]; // lane divider dash & gap (m)
const ZEBRA_M = 1.0; // crossing stripe period (m)
const SKYWALK_DECK_M = 0.6;
// Surface colours (sRGB hex, converted to linear like every other THREE.Color)
const ASPHALT = 0x3b3d40;
const PAVING = 0xaaa59b;
const SIDEWALK_PAVING = 0xb9b3a7;
const KERB = 0x9a968e;
const SIDEWALK_H = 0.15; // m: sidewalk top above the ground (kerb height)
const ZEBRA_PAINT = 0xe6e6e0;

// Ground height under (x, z) (js/terrain.js; 0 for flat cities), set per build: everything drawn here sits on it
let ground = () => 0;
// Polylines are resampled this finely when there is terrain, so the ribbons follow the slopes
const TERRAIN_STEP_M = 8;

// Ribbon along `pts` ([[x, z], ...]) between lateral offsets o0..o1 (left of travel = negative), at height y above the
// ground (a number, or per-point heights for ramps).
// Appends to `buf` { pos, along, idx } and returns nothing. `along` is the running distance for dashes and stripes.
function ribbon(buf, pts, o0, o1, y) {
  const n = pts.length;
  if (n < 2) return;
  const base = buf.pos.length / 3;
  let dist = 0;
  for (let i = 0; i < n; i++) {
    // Unit normals of the segments either side, mitred
    const seg = (a, b) => {
      const dx = pts[b][0] - pts[a][0], dz = pts[b][1] - pts[a][1];
      const L = Math.hypot(dx, dz) || 1e-9;
      return [-dz / L, dx / L];
    };
    const na = i > 0 ? seg(i - 1, i) : seg(0, 1);
    const nb = i < n - 1 ? seg(i, i + 1) : na;
    let mx = na[0] + nb[0], mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz) || 1e-9;
    mx /= ml;
    mz /= ml;
    const scale = Math.min(MITER_LIMIT, 1 / Math.max(1e-3, mx * na[0] + mz * na[1]));
    if (i > 0) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const [x, z] = pts[i];
    const h = typeof y === 'number' ? y : y[i];
    const xa = x + mx * o0 * scale, za = z + mz * o0 * scale, xb = x + mx * o1 * scale, zb = z + mz * o1 * scale;
    buf.pos.push(xa, h + ground(xa, za), za, xb, h + ground(xb, zb), zb);
    buf.along.push(dist, dist);
    if (i > 0) {
      const v = base + 2 * i;
      buf.idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
    }
  }
}

function disc(buf, x, z, r, y, segs = 16) {
  const c = buf.pos.length / 3;
  buf.pos.push(x, y + ground(x, z), z);
  buf.along.push(0);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    buf.pos.push(px, y + ground(px, pz), pz);
    buf.along.push(0);
    buf.idx.push(c, c + 1 + ((i + 1) % segs), c + 1 + i); // counter-clockwise seen from above
  }
}

const newBuf = () => ({ pos: [], along: [], idx: [], extra: [] });
function toGeometry(buf, extraName) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(buf.pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('along', new THREE.Float32BufferAttribute(buf.along, 1));
  if (extraName) g.setAttribute(extraName, new THREE.Float32BufferAttribute(buf.extra, 1));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  return g;
}
// Fill the per-vertex `extra` attribute for the vertices appended since it was last filled
const tag = (buf, v) => { while (buf.extra.length < buf.pos.length / 3) buf.extra.push(v); };

// Trim a polyline by `d0` metres at its start and `d1` at its end (null when nothing is left)
function trim(pts, d0, d1) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = lens[lens.length - 1];
  if (total - d0 - d1 < 1) return null;
  const at = (s) => {
    let i = 1;
    while (i < pts.length - 1 && lens[i] < s) i++;
    const t = (s - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  const out = [at(d0)];
  for (let i = 1; i < pts.length - 1; i++) if (lens[i] > d0 && lens[i] < total - d1) out.push(pts[i]);
  out.push(at(total - d1));
  return out;
}

function buildGraphRoads(scene, geo, options = {}) {
  const centreColour = options.centreLineColour ?? 0xf2f2ee;
  const laneColour = options.laneLineColour ?? 0xf2f2ee;
  const RG = geo.roadGraph;
  ground = heightAt(geo);
  const follow = geo.terrain ? (pts) => resample(pts, TERRAIN_STEP_M) : (pts) => pts;
  const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
  const links = RG.links.map(([a, b, , w, lanes, dir, inner]) => {
    const pts = [node(a)];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push(node(b));
    return { a, b, w, lanes, dir, pts: follow(pts) };
  });
  // Junction size: the widest link meeting at each node; degree for trimming markings
  const reach = new Float32Array(RG.nodes.length / 2);
  const degree = new Uint16Array(RG.nodes.length / 2);
  for (const l of links) {
    for (const n of [l.a, l.b]) { reach[n] = Math.max(reach[n], l.w / 2); degree[n]++; }
  }

  // Asphalt
  const asphalt = newBuf();
  for (const l of links) ribbon(asphalt, l.pts, -l.w / 2, l.w / 2, Y.road);
  for (let n = 0; n < reach.length; n++) if (degree[n] >= 2) disc(asphalt, ...node(n), reach[n], Y.road);

  // Lane markings (extra attribute: 1 = dashed, 0 = solid; colour by line kind)
  const marks = newBuf();
  const markColour = [];
  const line = (pts, off, dashed, colour) => {
    ribbon(marks, pts, off - MARK_W / 2, off + MARK_W / 2, Y.marking);
    tag(marks, dashed ? 1 : 0);
    const c = new THREE.Color(colour);
    while (markColour.length < marks.pos.length) markColour.push(c.r, c.g, c.b);
  };
  for (const l of links) {
    if (l.w < 5) continue; // alleys & driveways carry no lane lines
    const pts = trim(l.pts, degree[l.a] > 1 ? reach[l.a] + 1 : 0, degree[l.b] > 1 ? reach[l.b] + 1 : 0);
    if (!pts) continue;
    const lw = l.w / l.lanes;
    if (l.dir === 0) {
      if (l.lanes >= 2) line(pts, 0, false, centreColour);
      const perSide = Math.floor(l.lanes / 2);
      for (let k = 1; k < perSide; k++) { line(pts, -k * lw, true, laneColour); line(pts, k * lw, true, laneColour); }
    } else {
      for (let k = 1; k < l.lanes; k++) line(pts, -l.w / 2 + k * lw, true, laneColour);
    }
  }

  // Walking ways (extra attribute: 1 = crossing) and skywalk decks
  const kinds = geo.pathKinds || [];
  const crossingKind = kinds.indexOf('crossing');
  const sidewalkKind = kinds.indexOf('sidewalk');
  const walks = newBuf();
  const decks = newBuf();
  const sidewalks = newBuf();
  const kerbPos = []; // kerb faces: vertical quads along both edges of every sidewalk
  for (const [k, w, elev, flatPts, heights] of geo.paths || []) {
    let pts = [];
    for (let i = 0; i < flatPts.length; i += 2) pts.push([flatPts[i], flatPts[i + 1]]);
    if (!heights) pts = follow(pts); // (ramps keep their points: their heights are per point)
    if (elev > 0) {
      ribbon(decks, pts, -w / 2, w / 2, heights ? heights.map((h) => Math.max(h, Y.crossing)) : elev);
      continue;
    }
    if (k === sidewalkKind && pts.length >= 2) {
      const from = sidewalks.pos.length / 3;
      ribbon(sidewalks, pts, -w / 2, w / 2, SIDEWALK_H);
      const p = sidewalks.pos;
      for (let v = from + 2; v < p.length / 3; v += 2) {
        for (const e of [0, 1]) { // left & right edge
          const a = (v - 2 + e) * 3, b = (v + e) * 3;
          const [ax, az, bx, bz] = [p[a], p[a + 2], p[b], p[b + 2]];
          const ay = p[a + 1], by = p[b + 1]; // sidewalk top (on the ground); the kerb face drops SIDEWALK_H from it
          kerbPos.push(ax, ay - SIDEWALK_H, az, bx, by - SIDEWALK_H, bz, bx, by, bz, ax, ay - SIDEWALK_H, az, bx, by, bz, ax, ay, az);
        }
      }
      continue;
    }
    ribbon(walks, pts, -w / 2, w / 2, k === crossingKind ? Y.crossing : Y.path);
    tag(walks, k === crossingKind ? 1 : 0);
  }

  const group = new THREE.Group();
  group.name = 'graph-roads';
  const asphaltColour = color(ASPHALT);
  {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    m.colorNode = asphaltColour;
    const mesh = new THREE.Mesh(toGeometry(asphalt), m);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (marks.pos.length) {
    const g = toGeometry(marks, 'dashed');
    g.setAttribute('color', new THREE.Float32BufferAttribute(markColour, 3));
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
    m.colorNode = attribute('color', 'vec3');
    const along = attribute('along', 'float');
    const dashOn = step(fract(along.div(DASH[0] + DASH[1])), float(DASH[0] / (DASH[0] + DASH[1])));
    m.opacityNode = mix(float(1), dashOn, attribute('dashed', 'float'));
    m.alphaTest = 0.5;
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (walks.pos.length) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
    const stripe = step(0.5, fract(attribute('along', 'float').div(ZEBRA_M)));
    const zebra = mix(asphaltColour, color(ZEBRA_PAINT), stripe);
    m.colorNode = mix(color(PAVING), zebra, attribute('crossing', 'float'));
    const mesh = new THREE.Mesh(toGeometry(walks, 'crossing'), m);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (sidewalks.pos.length) {
    const top = new THREE.Mesh(toGeometry(sidewalks), new THREE.MeshStandardNodeMaterial({ color: SIDEWALK_PAVING, roughness: 0.9 }));
    top.receiveShadow = true;
    const kerbGeo = new THREE.BufferGeometry();
    kerbGeo.setAttribute('position', new THREE.Float32BufferAttribute(kerbPos, 3));
    kerbGeo.computeVertexNormals();
    const kerbs = new THREE.Mesh(kerbGeo, new THREE.MeshStandardNodeMaterial({ color: KERB, roughness: 0.85, side: THREE.DoubleSide }));
    kerbs.receiveShadow = true;
    group.add(top, kerbs);
  }
  if (decks.pos.length) {
    // Skywalk decks: a slab of SKYWALK_DECK_M under the walking surface
    const top = toGeometry(decks);
    const pos = top.attributes.position.array;
    const bottom = top.clone();
    const bp = bottom.attributes.position.array;
    for (let i = 1; i < bp.length; i += 3) bp[i] = Math.max(Y.path + ground(bp[i - 1], bp[i + 1]), pos[i] - SKYWALK_DECK_M);
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xa8a49c, roughness: 0.7, side: THREE.DoubleSide });
    for (const g of [top, bottom]) {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  scene.add(group);
  return { group, stats: { links: links.length, paths: (geo.paths || []).length } };
}

export { buildGraphRoads };
