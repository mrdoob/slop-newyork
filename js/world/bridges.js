import * as THREE from 'three/webgpu';
import { GEO } from './city-geodata.js';
import { groundHeight, decks } from './ground.js';
import { drapeGeometry } from './drape.js';
import { createRoadSurfaceMaterial, createBridgeConcreteMaterial, createTrackBedMaterial } from '../render/tsl-materials.js';

// js/world/bridges.js
// The overpasses, their ramps and the railway, drawn from the lifts the geodata builder solved for every road link and
// rail line (tools/build-tepic-geodata.mjs, 3B: dm over the ground at each vertex, piecewise linear between them) — the
// same heights the traffic drives (road-network.js edgeLift) and the player stands on (ground.js deckLift).
// A deck is asphalt over concrete: its walls run down to the ground while it is low (a ramp's embankment), and once it
// is OPEN m up it is a slab on piers, which stand off whatever road or track passes under it. Parapets line a deck from
// PARAPET m up, and the at-grade bridges over the streams. The railway is a ballast bed with sleepers and two rails,
// set flush into the road where it crosses one at grade.
// Everything is built flat (y = lift over the ground) and laid on the town's slopes like the other ground layers.

const OPEN = 2.5; // m: from here up a deck stands on piers (below it its walls reach the ground)
const SLAB = 1.1; // m: the deck's depth under its road
const PARAPET = 0.6; // m: a deck this far up gets parapets
const PARAPET_H = 0.9;
const PARAPET_T = 0.3;
const PIER_EVERY = 18; // m along a span
const GAUGE = 1.435; // standard gauge (Ferromex's line through Tepic)
const BED_TOP = 0.25; // the ballast's top over the ground
const RAIL_H = 0.16;
const JUNCTION_GAP = 9; // m: parapets stop short of a junction on a deck so traffic can turn

// Non-indexed triangle soup (position, normal, optional track coordinates)
function soup(withTrack = false) {
  const position = [], normal = [], track = withTrack ? [] : null;
  return {
    position, normal, track,
    // quad a-b-c-d (corners in order around it) facing n, wound to face that way; t: [u, v] per corner
    quad(a, b, c, d, n, t = null) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const facing = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
      const order = facing >= 0 ? [[a, 0], [b, 1], [c, 2], [a, 0], [c, 2], [d, 3]] : [[a, 0], [c, 2], [b, 1], [a, 0], [d, 3], [c, 2]];
      for (const [p, k] of order) {
        position.push(p[0], p[1], p[2]);
        normal.push(n[0], n[1], n[2]);
        if (track) track.push(...(t ? t[k] : [0, 0]));
      }
    },
    geometry() {
      if (!position.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
      if (track) geo.setAttribute('track', new THREE.Float32BufferAttribute(track, 2));
      return geo;
    }
  };
}

// A box (centre, half sizes along/across/up, turned by its along direction ux, uz) as quads, without its bottom
function addBox(s, cx, cy, cz, ux, uz, hl, hw, hh) {
  const rx = -uz, rz = ux; // across, to the left of along
  const p = (a, w, h) => [cx + ux * a + rx * w, cy + h, cz + uz * a + rz * w];
  s.quad(p(-hl, -hw, hh), p(-hl, hw, hh), p(hl, hw, hh), p(hl, -hw, hh), [0, 1, 0]);
  s.quad(p(hl, -hw, -hh), p(hl, -hw, hh), p(hl, hw, hh), p(hl, hw, -hh), [ux, 0, uz]);
  s.quad(p(-hl, hw, -hh), p(-hl, hw, hh), p(-hl, -hw, hh), p(-hl, -hw, -hh), [-ux, 0, -uz]);
  s.quad(p(-hl, -hw, -hh), p(-hl, -hw, hh), p(hl, -hw, hh), p(hl, -hw, -hh), [-rx, 0, -rz]);
  s.quad(p(hl, hw, -hh), p(hl, hw, hh), p(-hl, hw, hh), p(-hl, hw, -hh), [rx, 0, rz]);
}

// The road links' and rail lines' centrelines in 32 m cells, for "does a road or the track pass here, at grade?"
function createUnderQuery(roads, rails) {
  const CELL = 32;
  const cells = new Map();
  const add = (sg) => {
    const r = sg.half;
    for (let ix = Math.floor((Math.min(sg.ax, sg.bx) - r) / CELL); ix <= Math.floor((Math.max(sg.ax, sg.bx) + r) / CELL); ix++) {
      for (let iz = Math.floor((Math.min(sg.az, sg.bz) - r) / CELL); iz <= Math.floor((Math.max(sg.az, sg.bz) + r) / CELL); iz++) {
        const k = ix * 100003 + iz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(sg);
      }
    }
  };
  for (const line of roads) for (const sg of line.segs) add(sg);
  for (const line of rails) for (const sg of line.segs) add(sg);
  /** Is something (but `owner`) under (x, z) within its half width + pad, below `below` m over the ground? */
  return (x, z, pad, below, owner, kind = null) => {
    const list = cells.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL));
    if (!list) return false;
    for (const sg of list) {
      if (sg.owner === owner || (kind && sg.kind !== kind)) continue;
      const ux = sg.bx - sg.ax, uz = sg.bz - sg.az;
      const L2 = ux * ux + uz * uz || 1;
      const t = Math.min(1, Math.max(0, ((x - sg.ax) * ux + (z - sg.az) * uz) / L2));
      if (Math.hypot(x - sg.ax - ux * t, z - sg.az - uz * t) > sg.half + pad) continue;
      if (sg.la + (sg.lb - sg.la) * t < below) return true;
    }
    return false;
  };
}

// A polyline's per-vertex offset to its left (unit across, stretched at bends so both sides keep their width; capped)
function miters(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const p = pts[i];
    const d0 = i > 0 ? norm(p[0] - a[0], p[1] - a[1]) : null;
    const d1 = i + 1 < pts.length ? norm(b[0] - p[0], b[1] - p[1]) : null;
    const dx = (d0 ? d0[0] : 0) + (d1 ? d1[0] : 0), dz = (d0 ? d0[1] : 0) + (d1 ? d1[1] : 0);
    const [tx, tz] = norm(dx, dz) || d0 || d1;
    const cos = d1 ? tx * d1[0] + tz * d1[1] : 1;
    const k = 1 / Math.max(0.5, cos);
    out.push([tz * k, -tx * k]);
  }
  return out;
}
function norm(x, z) {
  const l = Math.hypot(x, z);
  return l > 1e-9 ? [x / l, z / l] : null;
}

function buildBridges(scene) {
  const group = new THREE.Group();
  group.name = 'Bridges';
  const colliders = [];
  const RG = GEO.roadGraph;
  if (!RG) return { group, colliders };
  const N = RG.nodes;

  // The roads (every link: what passes under a deck matters as much as the decks) and the rail lines, as polylines
  // with their lifts in metres
  const degree = new Map();
  const roads = RG.links.map((link, id) => {
    const pts = [[N[link[0] * 2], N[link[0] * 2 + 1]]];
    for (let k = 0; k < link[6].length; k += 2) pts.push([link[6][k], link[6][k + 1]]);
    pts.push([N[link[1] * 2], N[link[1] * 2 + 1]]);
    for (const n of [link[0], link[1]]) degree.set(n, (degree.get(n) || 0) + 1);
    const lifts = link[7] ? link[7].map((v) => v / 10) : pts.map(() => 0);
    return { id, a: link[0], b: link[1], pts, lifts, half: link[3] / 2, bridge: link[8] === 1 };
  });
  const rails = (GEO.rails || []).map(([flat, lifts, bridge], id) => {
    const pts = [];
    for (let k = 0; k + 1 < flat.length; k += 2) pts.push([flat[k], flat[k + 1]]);
    return { id: -1 - id, pts, lifts: lifts ? lifts.map((v) => v / 10) : pts.map(() => 0), half: 2.0, bridge: bridge === 1, rail: true };
  });
  for (const line of [...roads, ...rails]) {
    line.segs = [];
    for (let i = 0; i + 1 < line.pts.length; i++) {
      const [ax, az] = line.pts[i], [bx, bz] = line.pts[i + 1];
      line.segs.push({ ax, az, bx, bz, la: line.lifts[i], lb: line.lifts[i + 1], half: line.half, owner: line, kind: line.rail ? 'rail' : 'road' });
    }
  }
  const under = createUnderQuery(roads, rails);

  const asphalt = soup();
  const concrete = soup();
  const bed = soup(true);
  const steel = soup();

  // An oriented box collider from a to b (centre line), `off` to the left of it, half thickness ht, between heights
  const wallCollider = (ax, az, bx, bz, off, ht, y0, y1) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.2) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const cx = (ax + bx) / 2 - uz * off, cz = (az + bz) / 2 + ux * off;
    const yaw = Math.atan2(-uz, ux);
    const cs = Math.cos(yaw), sn = Math.sin(yaw), hx = len / 2, hz = ht;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: y0, maxY: y1, obb: { cx, cz, hx, hz, cs, sn } });
  };

  // Parapets along one side of a deck (side +1: left of the line, -1: right) from a to b, lifts la..lb
  const parapet = (a, b, ma, mb, la, lb, half, side, cap0, cap1) => {
    const o0 = half * side, o1 = (half - PARAPET_T) * side;
    const P = (p, m, o, y) => [p[0] + m[0] * o, y, p[1] + m[1] * o];
    const outA = (y) => P(a, ma, o0, y), outB = (y) => P(b, mb, o0, y), inA = (y) => P(a, ma, o1, y), inB = (y) => P(b, mb, o1, y);
    const ha = la + PARAPET_H, hb = lb + PARAPET_H;
    const ux = b[0] - a[0], uz = b[1] - a[1];
    const [nx, nz] = norm(uz * side, -ux * side) || [0, 1]; // outward
    const q = (p0, p1, p2, p3, n) => concrete.quad(p0, p1, p2, p3, n);
    q(outB(lb), outB(hb), outA(ha), outA(la), [nx, 0, nz]);
    q(inA(la), inA(ha), inB(hb), inB(lb), [-nx, 0, -nz]);
    q(inA(ha), outA(ha), outB(hb), inB(hb), [0, 1, 0]);
    const [dx, dz] = norm(ux, uz) || [1, 0];
    if (cap0) q(outA(la), outA(ha), inA(ha), inA(la), [-dx, 0, -dz]);
    if (cap1) q(inB(lb), inB(hb), outB(hb), outB(lb), [dx, 0, dz]);
    const off = -(half - PARAPET_T / 2) * side; // (wallCollider's offsets run the other way to the miters')
    // (in pieces of at most 6 m, so each spans little of a ramp's rise)
    const n = Math.ceil(Math.hypot(ux, uz) / 6);
    for (let j = 0; j < n; j++) {
      const f0 = j / n, f1 = (j + 1) / n;
      const x0 = a[0] + ux * f0, z0 = a[1] + uz * f0, x1 = a[0] + ux * f1, z1 = a[1] + uz * f1;
      const g = groundHeight((x0 + x1) / 2, (z0 + z1) / 2);
      const l0 = la + (lb - la) * f0, l1 = la + (lb - la) * f1;
      wallCollider(x0, z0, x1, z1, off, PARAPET_T / 2 + 0.05, g + Math.min(l0, l1) - 0.2, g + Math.max(l0, l1) + PARAPET_H);
    }
  };

  // A deck along a line: its top (asphalt for a road, left out for the railway, whose bed goes on top), walls, slab
  // underside, end walls where it opens up over the ground, piers under its spans and parapets
  function deck(line) {
    const { pts, lifts } = line;
    if (!lifts.some((l) => l > 0.05)) return;
    const half = line.half + 0.4;
    const m = miters(pts);
    // parapets stop short of junctions at either end (more than two links meeting at a node)
    const total = pts.reduce((s, p, i) => s + (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
    const trim0 = !line.rail && (degree.get(line.a) || 0) > 2 ? JUNCTION_GAP : 0;
    const trim1 = !line.rail && (degree.get(line.b) || 0) > 2 ? JUNCTION_GAP : 0;
    let walked = 0;
    let nextPier = PIER_EVERY / 2;
    let railing = false; // a parapet run is open
    for (let i = 0; i + 1 < pts.length; i++) {
      const A = pts[i], B = pts[i + 1];
      const segLen = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (segLen < 0.01) continue;
      // cut where the lift crosses OPEN or PARAPET, and where a parapet run starts or stops for a junction
      const la = lifts[i], lb = lifts[i + 1];
      const cuts = [0, 1];
      for (const h of [OPEN, PARAPET, 0.05]) if ((la - h) * (lb - h) < 0) cuts.push((h - la) / (lb - la));
      for (const d of [trim0, total - trim1]) { const f = (d - walked) / segLen; if (f > 0 && f < 1) cuts.push(f); }
      cuts.sort((p, q) => p - q);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const f0 = cuts[k], f1 = cuts[k + 1];
        if (f1 - f0 < 1e-4) continue;
        const lerp = (f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
        const mlerp = (f) => [m[i][0] + (m[i + 1][0] - m[i][0]) * f, m[i][1] + (m[i + 1][1] - m[i][1]) * f];
        const a = lerp(f0), b = lerp(f1), ma = mlerp(f0), mb = mlerp(f1);
        const l0 = la + (lb - la) * f0, l1 = la + (lb - la) * f1;
        const mid = (l0 + l1) / 2;
        const sAt = walked + segLen * (f0 + f1) / 2;
        if (mid <= 0.05) {
          railing = false;
          continue;
        }
        const ux = (b[0] - a[0]), uz = (b[1] - a[1]);
        const [dx, dz] = norm(ux, uz) || [1, 0];
        const P = (p, mm, o, y) => [p[0] + mm[0] * o, y, p[1] + mm[1] * o];
        const open = mid >= OPEN;
        const bot0 = open ? l0 - SLAB : -0.3, bot1 = open ? l1 - SLAB : -0.3;
        // top: the road's asphalt, at the lift itself (flush with the asphalt at grade where a ramp starts)
        if (!line.rail) asphalt.quad(P(a, ma, half, l0), P(b, mb, half, l1), P(b, mb, -half, l1), P(a, ma, -half, l0), [0, 1, 0]);
        else concrete.quad(P(a, ma, half, l0), P(b, mb, half, l1), P(b, mb, -half, l1), P(a, ma, -half, l0), [0, 1, 0]);
        // walls (both sides) down to the slab's underside or into the ground; a low deck's walls stop who is beside it
        concrete.quad(P(b, mb, half, bot1), P(b, mb, half, l1), P(a, ma, half, l0), P(a, ma, half, bot0), [dz, 0, -dx]);
        concrete.quad(P(a, ma, -half, bot0), P(a, ma, -half, l0), P(b, mb, -half, l1), P(b, mb, -half, bot1), [-dz, 0, dx]);
        if (!open && Math.min(l0, l1) > 0.3) {
          // (in pieces of at most 6 m, each topped just under its lower end: whoever drives on the deck clears them)
          const n = Math.ceil(Math.hypot(ux, uz) / 6);
          for (let j = 0; j < n; j++) {
            const g0 = j / n, g1 = (j + 1) / n;
            const c0 = [a[0] + ux * g0, a[1] + uz * g0], c1 = [a[0] + ux * g1, a[1] + uz * g1];
            const g = groundHeight((c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2);
            const top = g + Math.min(l0 + (l1 - l0) * g0, l0 + (l1 - l0) * g1) - 0.05;
            for (const side of [1, -1]) wallCollider(c0[0], c0[1], c1[0], c1[1], -(half - 0.15) * side, 0.2, g - 0.3, top);
          }
        }
        if (open) {
          // the slab's underside, and an end wall (the abutment) wherever the span starts or ends
          concrete.quad(P(a, ma, -half, bot0), P(b, mb, -half, bot1), P(b, mb, half, bot1), P(a, ma, half, bot0), [0, -1, 0]);
          const startsHere = Math.abs(l0 - OPEN) < 0.02, endsHere = Math.abs(l1 - OPEN) < 0.02;
          if (startsHere) concrete.quad(P(a, ma, -half, -0.3), P(a, ma, -half, bot0), P(a, ma, half, bot0), P(a, ma, half, -0.3), [dx, 0, dz]);
          if (endsHere) concrete.quad(P(b, mb, half, -0.3), P(b, mb, half, bot1), P(b, mb, -half, bot1), P(b, mb, -half, -0.3), [-dx, 0, -dz]);
          // piers every PIER_EVERY m, but where a road or the track passes under (it holds the clearance)
          const s0 = walked + segLen * f0, s1 = walked + segLen * f1;
          while (nextPier < s1) {
            if (nextPier >= s0) {
              const f = (nextPier - walked) / segLen;
              const [px, pz] = lerp(f);
              const lift = la + (lb - la) * f;
              const clear = !under(px, pz, half + 1.5, lift - 1, line);
              if (clear && lift - SLAB > 0.8) pier(px, pz, dx, dz, line.half, lift - SLAB);
            }
            nextPier += PIER_EVERY;
          }
        }
        // parapets: from PARAPET m up, and not within a junction's reach
        const want = mid >= PARAPET && sAt > trim0 && sAt < total - trim1;
        if (want) {
          const cap0 = !railing;
          railing = true;
          // (closing the run where the next piece won't continue it)
          const nextMid = k + 2 < cuts.length ? (la + (lb - la) * (cuts[k + 1] + cuts[k + 2]) / 2) : (i + 2 < pts.length ? (lb + lifts[i + 2]) / 2 : 0);
          const nextS = k + 2 < cuts.length ? walked + segLen * (cuts[k + 1] + cuts[k + 2]) / 2 : walked + segLen + 0.01;
          const cap1 = !(nextMid >= PARAPET && nextS > trim0 && nextS < total - trim1);
          for (const side of [1, -1]) parapet(a, b, ma, mb, l0, l1, half, side, cap0, cap1);
          if (cap1) railing = false;
        } else railing = false;
      }
      walked += segLen;
    }
  }

  // A pier under a deck: a cap beam across it on one column (two under a wide deck), from the ground up to `top`
  function pier(x, z, dx, dz, half, top) {
    const capH = Math.min(0.9, top * 0.25);
    const colTop = top - capH;
    const rx = -dz, rz = dx;
    addBox(concrete, x, top - capH / 2, z, dx, dz, 0.7, Math.max(1.5, half - 0.6), capH / 2);
    const cols = half > 6 ? [-half / 2, half / 2] : [0];
    for (const o of cols) {
      const cx = x + rx * o, cz = z + rz * o;
      addBox(concrete, cx, (colTop - 0.5) / 2, cz, dx, dz, 0.6, 0.6, (colTop + 0.5) / 2);
      const g = groundHeight(cx, cz);
      colliders.push({ minX: cx - 0.75, maxX: cx + 0.75, minZ: cz - 0.75, maxZ: cz + 0.75, minY: g - 0.5, maxY: g + colTop });
    }
  }

  for (const line of roads) deck(line);
  for (const line of rails) deck(line);

  // The raised junctions: a disc of deck joining the links that meet there (ground.js gives it to the traffic and
  // the player too), its rim walled like theirs
  for (const j of decks.junctions) {
    const SIDES = 16;
    const bot = j.lift >= OPEN ? j.lift - SLAB : -0.3;
    const rim = (k) => [j.x + Math.cos((k / SIDES) * Math.PI * 2) * j.r, j.z + Math.sin((k / SIDES) * Math.PI * 2) * j.r];
    for (let k = 0; k < SIDES; k++) {
      const a = rim(k), b = rim(k + 1);
      const mx = (a[0] + b[0]) / 2 - j.x, mz = (a[1] + b[1]) / 2 - j.z;
      const [nx, nz] = norm(mx, mz);
      asphalt.quad([j.x, j.lift, j.z], [a[0], j.lift, a[1]], [b[0], j.lift, b[1]], [j.x, j.lift, j.z], [0, 1, 0]);
      concrete.quad([a[0], bot, a[1]], [a[0], j.lift, a[1]], [b[0], j.lift, b[1]], [b[0], bot, b[1]], [nx, 0, nz]);
      if (j.lift >= OPEN) concrete.quad([j.x, bot, j.z], [a[0], bot, a[1]], [b[0], bot, b[1]], [j.x, bot, j.z], [0, -1, 0]);
    }
  }

  // The at-grade bridges over the streams (bridge ways the solve left on the ground): low parapets along both sides
  for (const line of roads) {
    if (!line.bridge || line.lifts.some((l) => l > 0.05)) continue;
    const m = miters(line.pts);
    const total = line.pts.reduce((s, p, i) => s + (i ? Math.hypot(p[0] - line.pts[i - 1][0], p[1] - line.pts[i - 1][1]) : 0), 0);
    const t0 = Math.min(total * 0.3, (degree.get(line.a) || 0) > 2 ? JUNCTION_GAP : 1);
    const t1 = total - Math.min(total * 0.3, (degree.get(line.b) || 0) > 2 ? JUNCTION_GAP : 1);
    let walked = 0;
    for (let i = 0; i + 1 < line.pts.length; i++) {
      const A = line.pts[i], B = line.pts[i + 1];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const f0 = Math.max(0, (t0 - walked) / len), f1 = Math.min(1, (t1 - walked) / len);
      if (len > 0.01 && f1 > f0) {
        const at = (f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f];
        const mat = (f) => [m[i][0] + (m[i + 1][0] - m[i][0]) * f, m[i][1] + (m[i + 1][1] - m[i][1]) * f];
        for (const side of [1, -1]) parapet(at(f0), at(f1), mat(f0), mat(f1), 0, 0, line.half + 0.4, side, walked + len * f0 <= t0 + 0.01, walked + len * f1 >= t1 - 0.01);
      }
      walked += len;
    }
  }

  // The railway: ballast bed (sleepers in its material) and two rails, flush into the road where it crosses one at grade
  for (const line of rails) {
    const { pts, lifts } = line;
    let u = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const A = pts[i], B = pts[i + 1];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < 0.01) continue;
      const [dx, dz] = norm(B[0] - A[0], B[1] - A[1]);
      const rx = -dz, rz = dx;
      // runs of the segment on the open ground or across a road at grade, sampled every metre
      const steps = Math.max(1, Math.ceil(len));
      let runStart = 0;
      let inRoad = null;
      const flush = (f0, f1, road) => {
        const p = (f, o, y) => [A[0] + (B[0] - A[0]) * f + rx * o, y, A[1] + (B[1] - A[1]) * f + rz * o];
        const l0 = lifts[i] + (lifts[i + 1] - lifts[i]) * f0, l1 = lifts[i] + (lifts[i + 1] - lifts[i]) * f1;
        const u0 = u + len * f0, u1 = u + len * f1;
        const top0 = l0 + (road ? 0 : BED_TOP), top1 = l1 + (road ? 0 : BED_TOP);
        if (!road) {
          // ballast: a flat top 3.2 m wide, its shoulders sloping down to 2.4 m out
          bed.quad(p(f0, 1.6, top0), p(f1, 1.6, top1), p(f1, -1.6, top1), p(f0, -1.6, top0), [0, 1, 0], [[u0, 1.6], [u1, 1.6], [u1, -1.6], [u0, -1.6]]);
          bed.quad(p(f0, 2.4, l0 - 0.05), p(f1, 2.4, l1 - 0.05), p(f1, 1.6, top1), p(f0, 1.6, top0), [rx * 0.3, 0.95, rz * 0.3], [[u0, 2.4], [u1, 2.4], [u1, 1.6], [u0, 1.6]]);
          bed.quad(p(f0, -1.6, top0), p(f1, -1.6, top1), p(f1, -2.4, l1 - 0.05), p(f0, -2.4, l0 - 0.05), [-rx * 0.3, 0.95, -rz * 0.3], [[u0, -1.6], [u1, -1.6], [u1, -2.4], [u0, -2.4]]);
        }
        // the rails: on the sleepers, or flush with the asphalt through a crossing
        const h = road ? 0.03 : RAIL_H + 0.02;
        for (const o of [GAUGE / 2 + 0.035, -GAUGE / 2 - 0.035]) {
          const ox = o - 0.035, oi = o + 0.035;
          steel.quad(p(f0, oi, top0 + h), p(f1, oi, top1 + h), p(f1, ox, top1 + h), p(f0, ox, top0 + h), [0, 1, 0]);
          if (!road) {
            steel.quad(p(f1, oi, top1), p(f1, oi, top1 + h), p(f0, oi, top0 + h), p(f0, oi, top0), [rx, 0, rz]);
            steel.quad(p(f0, ox, top0), p(f0, ox, top0 + h), p(f1, ox, top1 + h), p(f1, ox, top1), [-rx, 0, -rz]);
          }
        }
      };
      for (let s = 0; s <= steps; s++) {
        const f = Math.min(1, (s + 0.5) / steps);
        const x = A[0] + (B[0] - A[0]) * f, z = A[1] + (B[1] - A[1]) * f;
        const lift = lifts[i] + (lifts[i + 1] - lifts[i]) * f;
        const road = s < steps && under(x, z, 1.2, lift + 0.5, line, 'road');
        if (inRoad === null) inRoad = road;
        if (road !== inRoad || s === steps) {
          const end = s === steps ? 1 : s / steps;
          if (end > runStart) flush(runStart, end, inRoad);
          runStart = end;
          inRoad = road;
        }
      }
      u += len;
    }
  }

  const add = (s, material, name, cast) => {
    const geo = s.geometry();
    if (!geo) return;
    const mesh = new THREE.Mesh(drapeGeometry(geo), material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(asphalt, createRoadSurfaceMaterial(), 'BridgeDecks', false);
  add(concrete, createBridgeConcreteMaterial(), 'BridgeConcrete', true);
  add(bed, createTrackBedMaterial(), 'TrackBed', false);
  add(steel, new THREE.MeshStandardNodeMaterial({ color: 0x6b6660, metalness: 0.75, roughness: 0.38 }), 'Rails', false);
  scene.add(group);
  return { group, colliders };
}

export { buildBridges, createUnderQuery, miters };
