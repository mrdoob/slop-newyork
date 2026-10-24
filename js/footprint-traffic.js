import * as THREE from 'three/webgpu';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, createLoftedCarMaterial } from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { SIGNAL_STATE } from './signal-control.js';
import { heightAt, rampDepthAt } from './terrain.js';

// js/footprint-traffic.js
// Cars driving a street centreline graph (GEO.roadGraph) and pedestrians walking its footways (GEO.paths), for cities
// built from OSM. City-agnostic: the graph comes in through `geo`; traffic side, paint colours and counts through
// `options`; signals from signal-control.js.
//
// Cars keep to a lane of their link, curve through junctions onto a randomly chosen exit the link directions allow,
// keep their distance to the car ahead (and the player), stop for red lights and give way to people on crossings.
// Pedestrians walk the footways, crossings and skywalks, switching ways where they meet; at signalised intersections
// they wait at the kerb until the traffic they would cross has red. Junctions without signals have no right-of-way rules: cars
// crossing each other's paths there pass through one another.

const ROAD_Y = 0.08;
const WALK_Y = 0.05;
const SIDEWALK_Y = 0.15; // raised sidewalks (graph-roads.js SIDEWALK_H)
const CAR_LEN = 4.6;
const LOOK_AHEAD = 32; // m: cars within this distance ahead are considered
const ACCEL = 2.6;
const BRAKE = 6.5;
const FAR_CAR = 160; // m: lofted proxy beyond
const DRAW_PED = 220; // m: pedestrians drawn within
const ANIMATE_PED = 320; // m: beyond this a pedestrian only moves along its way (its rig re-plants its feet on return)
const CELL = 32; // m: grid for finding the cars around a car

const DEFAULT_PALETTE = [0xf2f2f0, 0xf2f2f0, 0xc9ccd0, 0xc9ccd0, 0x8d9196, 0x1d1f22, 0x1d1f22, 0x2f4a6e, 0x7a1f1f, 0x5b6f5a];

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Polyline helpers ([[x, z], ...])
function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}
function track(pts) {
  const cum = cumulative(pts);
  return { pts, cum, len: cum[cum.length - 1] };
}
// Point & unit tangent at distance s along a track
function sample(t, s, out) {
  const { pts, cum } = t;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const L = cum[i] - cum[i - 1] || 1e-6;
  const f = Math.min(1, Math.max(0, (s - cum[i - 1]) / L));
  const dx = (pts[i][0] - pts[i - 1][0]) / L, dz = (pts[i][1] - pts[i - 1][1]) / L;
  out.x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f;
  out.z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
  out.dx = dx;
  out.dz = dz;
  out.i = i;
  out.f = f;
  return out;
}
// Polyline shifted `off` metres to the right of travel (mitred)
function offsetLine(pts, off) {
  return pts.map((p, i) => {
    const seg = (a, b) => {
      const dx = pts[b][0] - pts[a][0], dz = pts[b][1] - pts[a][1];
      const L = Math.hypot(dx, dz) || 1e-9;
      return [-dz / L, dx / L];
    };
    const na = i > 0 ? seg(i - 1, i) : seg(0, 1);
    const nb = i < pts.length - 1 ? seg(i, i + 1) : na;
    let mx = na[0] + nb[0], mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz) || 1e-9;
    mx /= ml;
    mz /= ml;
    const k = Math.min(3, 1 / Math.max(0.2, mx * na[0] + mz * na[1]));
    return [p[0] + mx * off * k, p[1] + mz * off * k];
  });
}
function trimLine(pts, d0, d1) {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  if (total - d0 - d1 < 2) {
    const m = (d0 + total - d1) / 2; // keep a short stub around the middle
    d0 = Math.max(0, m - 1);
    d1 = Math.max(0, total - m - 1);
  }
  const at = (s) => sample({ pts, cum }, s, {});
  const a = at(d0), b = at(total - d1);
  const out = [[a.x, a.z]];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > d0 && cum[i] < total - d1) out.push(pts[i]);
  out.push([b.x, b.z]);
  return out;
}

// --- Cars --------------------------------------------------------------------------------------------------------------
function buildCars(scene, geo, options, signals, rand) {
  const land = heightAt(geo), ramp = rampDepthAt(geo);
  const terrain = (x, z) => land(x, z) - ramp(x, z); // cars follow the ground (GEO.terrain), down underpass ramps
  const RG = geo.roadGraph;
  const driveOnRight = options.driveOnRight ?? true;
  const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
  const links = RG.links.map(([a, b, , w, lanes, dir, inner]) => {
    const pts = [node(a)];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push(node(b));
    return { a, b, w, lanes, dir, pts, len: cumulative(pts).at(-1) };
  });
  const nodeCount = RG.nodes.length / 2;
  const reach = new Float32Array(nodeCount);
  const linksAt = Array.from({ length: nodeCount }, () => []);
  links.forEach((l, li) => {
    for (const n of [l.a, l.b]) { reach[n] = Math.max(reach[n], l.w / 2); linksAt[n].push(li); }
  });
  const signalised = new Set(RG.signals || []);
  const trimAt = (n) => (linksAt[n].length >= 3 || (signalised.has(n) && linksAt[n].length >= 2) ? reach[n] + 1.5 : 0);

  // Lanes in the direction of travel and the offset of lane k (0 = innermost / leftmost) right of the centre line
  const lanesOf = (l) => (l.dir === 0 ? Math.max(1, Math.floor(l.lanes / 2)) : Math.max(1, l.lanes));
  const laneOffset = (l, k) => {
    if (l.dir !== 0) return -l.w / 2 + (k + 0.5) * (l.w / l.lanes);
    const lw = l.w / (2 * lanesOf(l));
    return (k + 0.5) * lw * (driveOnRight ? 1 : -1);
  };
  const canGo = (l, fwd) => (fwd ? l.dir !== -1 : l.dir !== 1);
  const laneCache = new Map();
  function laneTrack(li, fwd, k) {
    const key = `${li}|${fwd ? 1 : 0}|${k}`;
    if (laneCache.has(key)) return laneCache.get(key);
    const l = links[li];
    const from = fwd ? l.a : l.b, to = fwd ? l.b : l.a;
    const pts = fwd ? l.pts : l.pts.slice().reverse();
    const t = track(trimLine(offsetLine(pts, laneOffset(l, k)), trimAt(from), trimAt(to)));
    Object.assign(t, { li, fwd, k, from, to, lane: true });
    laneCache.set(key, t);
    return t;
  }
  // Curve from the end of one lane to the start of the next (cubic Bézier)
  function connector(a, b) {
    const p0 = a.pts.at(-1), p3 = b.pts[0];
    const ta = sample(a, a.len, {}), tb = sample(b, 0, {});
    const d = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    const k = d * 0.45;
    const p1 = [p0[0] + ta.dx * k, p0[1] + ta.dz * k], p2 = [p3[0] - tb.dx * k, p3[1] - tb.dz * k];
    const pts = [];
    const n = Math.max(2, Math.ceil(d / 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
    const c = track(pts);
    c.turn = Math.sign(ta.dx * tb.dz - ta.dz * tb.dx); // > 0: turning right (x east, z south)
    return c;
  }
  // Next lane at the end of lane track t
  function nextLane(t) {
    const n = t.to;
    const here = links[t.li];
    const options_ = [];
    for (const lj of linksAt[n]) {
      if (lj === t.li) continue;
      const l = links[lj];
      const fwd = l.a === n;
      if (!canGo(l, fwd)) continue;
      options_.push({ lj, fwd, w: l.w < 5 && here.w >= 5 ? 0.05 : l.w });
    }
    if (!options_.length) {
      if (here.dir === 0) options_.push({ lj: t.li, fwd: !t.fwd, w: 1 }); // dead end: turn around
      else return null;
    }
    let r = rand() * options_.reduce((s, o) => s + o.w, 0);
    let pick = options_[0];
    for (const o of options_) { r -= o.w; if (r <= 0) { pick = o; break; } }
    const l = links[pick.lj];
    return laneTrack(pick.lj, pick.fwd, Math.min(t.k, lanesOf(l) - 1));
  }

  // Spawn on lanes of real streets (not driveways or alleys), spaced apart
  const lanes = [];
  links.forEach((l, li) => {
    if (l.w < 5 || l.len < 12) return;
    for (const fwd of [true, false]) {
      if (!canGo(l, fwd)) continue;
      for (let k = 0; k < lanesOf(l); k++) lanes.push(laneTrack(li, fwd, k));
    }
  });
  const totalLen = lanes.reduce((s, t) => s + t.len, 0);
  const palette = options.palette || DEFAULT_PALETTE;
  const taxiShare = options.taxiShare ?? 0.1;
  const cars = [];
  const count = Math.min(options.carCount ?? 120, Math.floor(totalLen / 25));
  for (let i = 0, guard = 0; cars.length < count && guard < count * 20; guard++) {
    let r = rand() * totalLen;
    let t = lanes[0];
    for (const l of lanes) { r -= l.len; if (r <= 0) { t = l; break; } }
    const s = rand() * t.len;
    if (cars.some((c) => c.track === t && Math.abs(c.s - s) < 12)) continue;
    const roll = rand();
    const kind = roll < taxiShare ? 'taxi' : roll < taxiShare + 0.28 ? 'suv' : 'sedan';
    const paint = new THREE.Color(kind === 'taxi' ? options.taxiColour ?? 0xf3c316 : palette[Math.floor(rand() * palette.length)]);
    cars.push({ i: i++, kind, paint: [paint.r, paint.g, paint.b], track: t, lane: t, s, speed: 0, cruise: 0.85 + rand() * 0.25,
      x: 0, z: 0, dx: 0, dz: 1, yaw: 0, brake: 0, turn: 0, blink: rand() });
  }

  // Instanced lofted bodies per kind: near (with wheels) & far (proxy)
  const group = new THREE.Group();
  group.name = 'footprint-traffic-cars';
  const meshes = {};
  for (const kind of ['sedan', 'suv', 'taxi']) {
    const spec = BODY_SPECS[kind];
    const n = Math.max(1, cars.filter((c) => c.kind === kind).length);
    meshes[kind] = [true, false].map((near) => {
      const geo = near ? buildCarGeometry(spec, true) : buildCarProxyGeometry(spec);
      geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const mesh = new THREE.InstancedMesh(geo, createLoftedCarMaterial(spec), n);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = near;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    });
  }
  scene.add(group);

  const p = {};
  const dummy = new THREE.Object3D();
  let clock = 0;
  const grid = new Map();
  const cellKey = (ix, iz) => ix * 73856093 + iz;
  function update(dt, camera, player, walkers = []) {
    clock += dt;
    grid.clear();
    for (const c of cars) {
      const k = cellKey(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(c);
    }
    const near = [];
    // Leaders: nearby cars ahead in the same direction (and the player's car, whatever its heading)
    for (const c of cars) {
      let gap = LOOK_AHEAD;
      near.length = 0;
      const ix = Math.floor(c.x / CELL), iz = Math.floor(c.z / CELL);
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) for (const o of grid.get(cellKey(ix + gx, iz + gz)) || []) near.push(o);
      for (const o of near) {
        if (o === c) continue;
        const rx = o.x - c.x, rz = o.z - c.z;
        const along = rx * c.dx + rz * c.dz;
        if (along <= 0 || along > LOOK_AHEAD) continue;
        if (Math.abs(rx * c.dz - rz * c.dx) > 1.7) continue;
        if (o.dx * c.dx + o.dz * c.dz < 0.3) continue;
        gap = Math.min(gap, along - CAR_LEN);
      }
      // People on crossings in the lane ahead (turning cars give way too)
      for (const w of walkers) {
        const rx = w.x - c.x, rz = w.z - c.z;
        const along = rx * c.dx + rz * c.dz;
        if (along > 0 && along < LOOK_AHEAD && Math.abs(rx * c.dz - rz * c.dx) < 2.0) gap = Math.min(gap, along - CAR_LEN / 2 - 1.5);
      }
      if (player) {
        const rx = player.x - c.x, rz = player.z - c.z;
        const along = rx * c.dx + rz * c.dz;
        if (along > 0 && along < LOOK_AHEAD && Math.abs(rx * c.dz - rz * c.dx) < 2.2) gap = Math.min(gap, along - CAR_LEN);
      }
      // Red (or amber with room to stop) at the end of this lane
      if (c.track.lane && signals) {
        const state = signals.stateAt(c.track.to, c.track.li);
        const toStop = c.track.len - c.s - 0.5;
        if (state === SIGNAL_STATE.RED || (state === SIGNAL_STATE.AMBER && toStop > c.speed * 1.4)) gap = Math.min(gap, toStop);
      }
      const l = c.track.lane ? links[c.track.li] : null;
      const vmax = (l ? (l.w >= 9 ? 13.9 : l.w >= 6 ? 11 : 6) : 7.5) * c.cruise;
      const vStop = Math.sqrt(Math.max(0, 2 * 4 * (gap - 1.5)));
      const target = Math.min(vmax, vStop);
      const prev = c.speed;
      c.speed = target > c.speed ? Math.min(target, c.speed + ACCEL * dt) : Math.max(target, c.speed - BRAKE * 1.6 * dt);
      if (gap < 0.3) c.speed = 0;
      c.brake = c.speed < prev - 0.01 || c.speed < 0.2 ? 1 : 0;
      c.s += c.speed * dt;
      // Onto the next connector / lane
      while (c.s > c.track.len) {
        c.s -= c.track.len;
        if (c.track.lane) {
          const next = nextLane(c.track);
          if (!next) { c.track = lanes[Math.floor(rand() * lanes.length)]; c.s = 0; break; } // nowhere to go: respawn
          const con = connector(c.track, next);
          con.next = next;
          c.turn = con.turn;
          c.track = con;
        } else {
          c.track = c.track.next;
          c.turn = 0;
        }
      }
      sample(c.track, c.s, p);
      c.x = p.x;
      c.z = p.z;
      c.dx = p.dx;
      c.dz = p.dz;
      c.yaw = Math.atan2(p.dx, p.dz);
    }

    // Draw
    const cx = camera.position.x, cz = camera.position.z;
    for (const kind in meshes) for (const m of meshes[kind]) m.count = 0;
    for (const c of cars) {
      const mesh = meshes[c.kind][Math.hypot(c.x - cx, c.z - cz) < FAR_CAR ? 0 : 1];
      const slot = mesh.count++;
      dummy.position.set(c.x, ROAD_Y + terrain(c.x, c.z), c.z);
      dummy.rotation.set(0, c.yaw, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
      mesh.geometry.attributes.paintColor.array.set(c.paint, slot * 3);
      const blink = c.turn !== 0 && (clock + c.blink) % 0.8 < 0.4 ? 1 : 0;
      // carState: brake, left (+x) & right (-x) turn signal, livery
      mesh.geometry.attributes.carState.array.set([c.brake, c.turn < 0 ? blink : 0, c.turn > 0 ? blink : 0, 0], slot * 4);
    }
    for (const kind in meshes) {
      for (const m of meshes[kind]) {
        m.instanceMatrix.needsUpdate = true;
        m.geometry.attributes.paintColor.needsUpdate = true;
        m.geometry.attributes.carState.needsUpdate = true;
      }
    }
  }

  // Does a car body (centre x, z; unit forward fx, fz; half length & width) overlap any AI car? Oriented rectangles,
  // separating-axis test (for the player's collisions, front, back and sides alike)
  const AI_HALF = [CAR_LEN / 2, 0.95];
  function carOverlaps(x, z, fx, fz, hl, hw) {
    const axesOf = (ax, az) => [[ax, az], [-az, ax]];
    for (const c of cars) {
      const ox = c.x - x, oz = c.z - z;
      if (ox * ox + oz * oz > 64) continue;
      const A = { ax: axesOf(fx, fz), h: [hl, hw] };
      const B = { ax: axesOf(c.dx, c.dz), h: AI_HALF };
      let separated = false;
      for (const [nx, nz] of [...A.ax, ...B.ax]) {
        const dist = Math.abs(ox * nx + oz * nz);
        const ra = A.h[0] * Math.abs(A.ax[0][0] * nx + A.ax[0][1] * nz) + A.h[1] * Math.abs(A.ax[1][0] * nx + A.ax[1][1] * nz);
        const rb = B.h[0] * Math.abs(B.ax[0][0] * nx + B.ax[0][1] * nz) + B.h[1] * Math.abs(B.ax[1][0] * nx + B.ax[1][1] * nz);
        if (dist > ra + rb) { separated = true; break; }
      }
      if (!separated) return true;
    }
    return false;
  }
  return { cars, group, update, carOverlaps };
}

// --- Pedestrians ---------------------------------------------------------------------------------------------------------
function buildPedestrians(scene, geo, options, signals, rand) {
  const kinds = geo.pathKinds || [];
  const ways = (geo.paths || []).map(([k, w, elev, flatPts, heights]) => {
    const pts = [];
    for (let i = 0; i < flatPts.length; i += 2) pts.push([flatPts[i], flatPts[i + 1]]);
    const ground = kinds[k] === 'sidewalk' ? SIDEWALK_Y : WALK_Y;
    const ys = pts.map((_, i) => (heights ? heights[i] : elev) + (elev > 0 ? 0 : ground));
    return { ...track(pts), ys, w, kind: kinds[k] };
  });
  // Where ways meet: every vertex, keyed on a 1 m grid
  const key = (x, z) => `${Math.round(x)},${Math.round(z)}`;
  const meet = new Map();
  ways.forEach((wy, wi) => wy.pts.forEach(([x, z], vi) => {
    const k = key(x, z);
    if (!meet.has(k)) meet.set(k, []);
    meet.get(k).push([wi, vi]);
  }));
  const spawnable = ways.map((w, i) => i).filter((i) => ways[i].kind !== 'crossing' && ways[i].len > 8);
  const total = spawnable.reduce((s, i) => s + ways[i].len, 0);
  const count = Math.min(options.pedCount ?? 200, Math.floor(total / 6));
  const crowd = new PersonCrowd(count);
  scene.add(...crowd.meshes);
  const peds = [];
  for (let i = 0; i < count; i++) {
    let r = rand() * total;
    let wi = spawnable[0];
    for (const j of spawnable) { r -= ways[j].len; if (r <= 0) { wi = j; break; } }
    const female = rand() < 0.5;
    const hairRoll = rand();
    peds.push({
      wi, s: rand() * ways[wi].len, dir: rand() < 0.5 ? 1 : -1, side: (rand() - 0.5) * 0.7,
      speed: 1.15 + rand() * 0.4, x: 0, y: 0, z: 0, hx: 0, hz: 1, waiting: false,
      rig: new PersonRig({
        seed: i * 1.6180339 + 0.37, female, scale: (female ? 0.91 : 0.97) + rand() * 0.1, girth: 0.9 + rand() * 0.24,
        hair: female ? (hairRoll < 0.6 ? 1 : 0.3) : hairRoll * 0.35, armSwing: 0.75 + rand() * 0.5, stride: 0.94 + rand() * 0.12
      })
    });
  }
  const terrain = heightAt(geo);
  const ground = (owner, x, z) => owner.y + terrain(x, z); // owner.y: on the way (sidewalk kerb, stairs) above the ground
  const p = {};
  const walkers = []; // people out on crossings (cars give way to them)
  function update(dt, camera) {
    crowd.begin();
    walkers.length = 0;
    const cx = camera.position.x, cz = camera.position.z;
    for (const pd of peds) {
      let way = ways[pd.wi];
      // Waiting at the kerb for the lights
      if (pd.waiting) {
        sample(way, pd.s, p);
        pd.waiting = signals ? !signals.walkAllowed(p.x, p.z, Math.atan2(p.dx * pd.dir, p.dz * pd.dir)) : false;
      }
      const before = sample(way, pd.s, p).i;
      if (!pd.waiting) pd.s += pd.speed * dt * pd.dir;
      // Passing a vertex where other ways meet: sometimes switch onto one of them
      const after = pd.s < 0 || pd.s > way.len ? -1 : sample(way, pd.s, p).i;
      if (after !== before) {
        const vi = pd.dir > 0 ? (after < 0 ? way.pts.length - 1 : before) : (after < 0 ? 0 : after);
        const [vx, vz] = way.pts[vi];
        const others = (meet.get(key(vx, vz)) || []).filter(([wj]) => wj !== pd.wi);
        const atEnd = pd.s < 0 || pd.s > way.len;
        if (others.length && (atEnd || rand() < 0.35)) {
          const [wj, vj] = others[Math.floor(rand() * others.length)];
          const nw = ways[wj];
          pd.wi = wj;
          pd.dir = vj === 0 ? 1 : vj === nw.pts.length - 1 ? -1 : rand() < 0.5 ? 1 : -1;
          pd.s = nw.cum[vj];
          way = nw;
          pd.waiting = nw.kind === 'crossing'; // check the lights before stepping out
        } else if (atEnd) {
          pd.dir = -pd.dir; // dead end: turn around
          pd.s = Math.min(way.len, Math.max(0, pd.s));
        }
      }
      sample(way, pd.s, p);
      const hx = p.dx * pd.dir, hz = p.dz * pd.dir;
      const off = pd.side * way.w * 0.5;
      pd.x = p.x - hz * off;
      pd.z = p.z + hx * off;
      pd.y = way.ys[p.i - 1] + (way.ys[p.i] - way.ys[p.i - 1]) * p.f;
      if (way.kind === 'crossing' && !pd.waiting) walkers.push(pd);
      const dist = Math.hypot(pd.x - cx, pd.z - cz);
      if (dist > ANIMATE_PED) { pd.rig.placed = false; continue; } // stands afresh when it comes back into range
      const draw = dist < DRAW_PED;
      pd.rig.update(dt, pd.x, pd.z, Math.atan2(hx, hz), ground, pd, 0, draw);
      if (draw) crowd.add(pd.rig, dist);
    }
    crowd.end();
  }
  // Is a person within r of (x, z)? (for the player's collisions)
  const pedNear = (x, z, r) => peds.some((pd) => pd.y < 1 && Math.hypot(pd.x - x, pd.z - z) < r);
  return { peds, update, walkers, pedNear, meshes: crowd.meshes };
}

function buildFootprintTraffic(scene, geo, options = {}) {
  const rand = mulberry32(options.seed ?? 20261024);
  const cars = buildCars(scene, geo, options, options.signals || null, rand);
  const pedestrians = buildPedestrians(scene, geo, options, options.signals || null, rand);
  return {
    cars,
    pedestrians,
    update(dt, camera, player = null) {
      dt = Math.min(dt, 0.1);
      cars.update(dt, camera, player, pedestrians.walkers);
      pedestrians.update(dt, camera);
    },
    carOverlaps: cars.carOverlaps,
    pedNear: pedestrians.pedNear,
    stats: { cars: cars.cars.length, pedestrians: pedestrians.peds.length }
  };
}

export { buildFootprintTraffic };
