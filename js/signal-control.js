import * as THREE from 'three/webgpu';
import { attribute, color, float, mix, texture, uv, vec2, floor, step } from 'three/tsl';
import { heightAt } from './terrain.js';

// js/signal-control.js
// Traffic signals at the signalised nodes of a street centreline graph (GEO.roadGraph.signals): a two-phase controller
// per junction and signal poles with lit heads facing each approach. City-agnostic: the graph comes in through `geo`,
// the timing, traffic side and the look of the heads through `options`:
//   style.armHead      'vertical' (default: red on top) or 'horizontal' (red at the left as drivers see it, then amber,
//                      green) for the head hanging over the road
//   style.countdown    a square red-digit display beside the arm head's red lamp, counting down the red (seconds)
//   style.pedestrian   pedestrian signals at both ends of each crossing at a signalised junction (geo.paths kind
//                      'crossing'): two lenses, a red standing figure over a green walking one (animated, quicker and
//                      then flashing as time runs out), with a green countdown above
//   style.pedFlashS    seconds of flashing green at the end of the walk phase (default 5)
//
// Junction nodes closer than CLUSTER_M are one intersection (a dual carriageway crossing is several graph nodes) and
// share a clock. Each approach belongs to the intersection's main axis (phase 0: the widest road) or the cross axis
// (phase 1), which run green alternately. The timings are a plausible fixed cycle, not real signal plans.

const CLUSTER_M = 45;
const MIN_APPROACH_M = 20; // links shorter than this are inside a junction: no stop line, no pole
const POLE_H = 6.2;
const ARM_Y = 5.7;
const PED_POLE_H = 3.4;
const PED_HEAD_Y = 2.75; // pedestrian head centre (its box bottom ~2.3 m)
const LENS_R = 0.14; // 28 cm lenses
const LENS_STEP = 0.34;
const STATE = { GREEN: 0, AMBER: 1, RED: 2 };

function buildSignalControl(scene, geo, options = {}) {
  const ground = heightAt(geo); // poles stand on the ground (GEO.terrain)
  const { green = 26, amber = 3, allRed = 2 } = options.timing || {};
  const style = { armHead: 'vertical', countdown: false, pedestrian: false, pedFlashS: 5, ...(options.style || {}) };
  const driveOnRight = options.driveOnRight ?? true;
  const RG = geo.roadGraph;
  const signalised = new Set(RG.signals || []);
  const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
  const half = green + amber + allRed;
  const cycle = 2 * half;

  // Links at each node, with the bearing of travel arriving at the node and the link's shape towards it
  const links = RG.links.map(([a, b, , w, lanes, dir, inner]) => {
    const pts = [node(a)];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push(node(b));
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { a, b, w, lanes, dir, pts, len };
  });
  const at = new Map();
  for (const [li, l] of links.entries()) {
    for (const n of [l.a, l.b]) {
      if (!signalised.has(n)) continue;
      if (!at.has(n)) at.set(n, []);
      at.get(n).push(li);
    }
  }

  // Intersections: signalised nodes within CLUSTER_M (union-find), with a clock offset and a main axis each
  const parent = new Map([...signalised].map((n) => [n, n]));
  const find = (n) => (parent.get(n) === n ? n : (parent.set(n, find(parent.get(n))), parent.get(n)));
  const sig = [...signalised];
  for (let i = 0; i < sig.length; i++) {
    for (let j = i + 1; j < sig.length; j++) {
      const [ax, az] = node(sig[i]), [bx, bz] = node(sig[j]);
      if (Math.hypot(ax - bx, az - bz) < CLUSTER_M) parent.set(find(sig[i]), find(sig[j]));
    }
  }
  const clusters = new Map();
  for (const n of sig) {
    const c = find(n);
    if (!clusters.has(c)) clusters.set(c, { nodes: [], axis: 0, widest: -1, offset: 0 });
    clusters.get(c).nodes.push(n);
  }
  // Bearing of the link where it meets node n (direction of travel arriving at n)
  const arrivalBearing = (l, n) => {
    const p = l.b === n ? l.pts : l.pts.slice().reverse();
    const [x0, z0] = p[p.length - 2], [x1, z1] = p[p.length - 1];
    return Math.atan2(x1 - x0, z1 - z0);
  };
  for (const [id, c] of clusters) {
    for (const n of c.nodes) {
      for (const li of at.get(n) || []) {
        const l = links[li];
        if (l.w > c.widest) { c.widest = l.w; c.axis = arrivalBearing(l, n); }
      }
    }
    const [x, z] = node(id);
    c.offset = (((Math.sin(x * 0.0123 + z * 0.0347) * 43758.5453) % 1) + 1) % 1 * cycle;
  }
  const clusterOf = (n) => clusters.get(find(n));
  const phaseOf = (c, bearing) => {
    let d = Math.abs((((bearing - c.axis) % Math.PI) + Math.PI) % Math.PI);
    d = Math.min(d, Math.PI - d);
    return d < Math.PI / 4 ? 0 : 1;
  };

  let clock = 0;
  const phaseTime = (c, phase) => (clock + c.offset + phase * half) % cycle; // 0 = green starts
  const stateFor = (c, phase) => {
    const t = phaseTime(c, phase);
    return t < green ? STATE.GREEN : t < green + amber ? STATE.AMBER : STATE.RED;
  };

  // Signal state for traffic arriving at node `n` along link index `li` (green where there is no signal or the link is
  // inside a junction)
  function stateAt(n, li) {
    if (!signalised.has(n)) return STATE.GREEN;
    const l = links[li];
    if (l.len < MIN_APPROACH_M) return STATE.GREEN;
    const c = clusterOf(n);
    return stateFor(c, phaseOf(c, arrivalBearing(l, n)));
  }

  // May pedestrians at (x, z) cross heading `bearing`? Yes away from signals; at a signalised intersection only while
  // the traffic running alongside them has green (so the traffic they cross has red).
  const centres = [...clusters.values()].map((c) => {
    const pts = c.nodes.map(node);
    return { c, x: pts.reduce((s, p) => s + p[0], 0) / pts.length, z: pts.reduce((s, p) => s + p[1], 0) / pts.length };
  });
  function walkAllowed(x, z, bearing) {
    let best = null, bd = CLUSTER_M + 15;
    for (const k of centres) {
      const d = Math.hypot(k.x - x, k.z - z);
      if (d < bd) { bd = d; best = k.c; }
    }
    return !best || stateFor(best, phaseOf(best, bearing)) === STATE.GREEN;
  }

  // --- Poles & heads: one per approach that traffic can arrive on ---------------------------------------------------
  const armHeads = [], poleHeads = []; // { m: matrix, c, phase }
  const poleMats = [];
  const armMats = [];
  const dummy = new THREE.Object3D();
  const place = (x, y, z, yaw) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    return dummy.matrix.clone();
  };
  for (const [n, lis] of at) {
    for (const li of lis) {
      const l = links[li];
      if (l.len < MIN_APPROACH_M) continue;
      const arrivesAtB = l.b === n;
      if (l.dir === 1 && !arrivesAtB) continue; // one-way away from n
      if (l.dir === -1 && arrivesAtB) continue;
      // Stop line: a few metres back from the node along the link
      const p = arrivesAtB ? l.pts.slice().reverse() : l.pts.slice(); // from n outwards
      let back = Math.min(l.len * 0.4, l.w * 0.35 + 6);
      let k = 0;
      while (k + 1 < p.length && Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]) < back) {
        back -= Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
        k++;
      }
      if (k + 1 >= p.length) continue;
      const sl = Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]) || 1;
      const ox = (p[k + 1][0] - p[k][0]) / sl, oz = (p[k + 1][1] - p[k][1]) / sl; // outwards = against travel
      const sx = p[k][0] + ox * back, sz = p[k][1] + oz * back;
      const ux = -ox, uz = -oz; // travel direction
      const side = driveOnRight ? 1 : -1;
      const rx = -uz * side, rz = ux * side; // kerb side of travel
      const px = sx + rx * (l.w / 2 + 0.7), pz = sz + rz * (l.w / 2 + 0.7); // pole just off the kerb
      const facing = Math.atan2(-ux, -uz); // heads face oncoming traffic
      const reach = Math.min(Math.max(3, (l.dir === 0 ? l.w / 2 : l.w) * 0.75), 8);
      const gy = ground(px, pz);
      const c = clusterOf(n), phase = phaseOf(c, Math.atan2(ux, uz));
      poleMats.push(place(px, gy + POLE_H / 2, pz, facing));
      // Arm over the road (towards the centre line, -r)
      dummy.position.set(px - rx * reach / 2, gy + ARM_Y, pz - rz * reach / 2);
      dummy.scale.set(1, 1, reach);
      dummy.rotation.set(0, Math.atan2(-rx, -rz), 0);
      dummy.updateMatrix();
      armMats.push(dummy.matrix.clone());
      // Heads: over the lanes at the arm's end (hanging just under it), and low on the pole
      const armY = style.armHead === 'horizontal' ? ARM_Y - 0.3 : ARM_Y - 0.55;
      armHeads.push({ m: place(px - rx * reach, gy + armY, pz - rz * reach, facing), c, phase });
      poleHeads.push({ m: place(px, gy + 3.1, pz, facing), c, phase });
    }
  }

  const group = new THREE.Group();
  group.name = 'traffic-signals';
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x5d6166, roughness: 0.55, metalness: 0.6 });
  const black = new THREE.MeshStandardNodeMaterial({ color: 0x1b1d1f, roughness: 0.6, metalness: 0.2 });
  const inst = (geo, mat, mats) => {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, mats.length));
    mats.forEach((mx, i) => m.setMatrixAt(i, mx));
    m.count = mats.length;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  inst(new THREE.CylinderGeometry(0.11, 0.14, POLE_H, 10), metal, poleMats);
  inst(new THREE.BoxGeometry(0.12, 0.14, 1), metal, armMats);

  // A lit face on every head of a set: geometry `geo` (on the head's front, +z), coloured `hex` while `lit` > 0. With an
  // atlas (a canvas of `cells` square-ish cells across), the face shows cell `cell` (per head) as a lit pattern on dark
  // glass, e.g. a figure or a digit pair; without, the whole lens glows.
  const faces = [];
  const face = (heads, geo, hex, atlas = null) => {
    const lit = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, heads.length)), 1);
    const cell = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, heads.length)), 1);
    geo.setAttribute('lit', lit);
    geo.setAttribute('cell', cell);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3 });
    const on = attribute('lit', 'float');
    let mask = float(1);
    if (atlas) {
      // two-digit displays sample the tens cell on the left half, the units cell on the right
      const v = attribute('cell', 'float');
      const u = atlas.pairs
        ? mix(floor(v.div(10)), v.mod(10), step(0.5, uv().x)).add(uv().x.mul(2).fract()).div(atlas.cells)
        : v.add(uv().x).div(atlas.cells);
      mask = texture(atlas.tex, vec2(u, uv().y)).r;
    }
    mat.colorNode = mix(color(hex).mul(0.1), color(hex), on.mul(mask));
    mat.emissiveNode = color(hex).mul(on.mul(mask).mul(2.5));
    mat.roughnessNode = float(0.3);
    const mesh = inst(geo, mat, heads.map((h) => h.m));
    mesh.castShadow = false;
    faces.push({ heads, lit, cell, mesh });
    return faces[faces.length - 1];
  };
  const lensGeo = (x, y) => new THREE.CircleGeometry(LENS_R, 18).translate(x, y, 0.152);
  const vehicleLenses = (heads, horizontal) => {
    // horizontal: drivers face the head (looking along its -z), so their left is its -x: red there, then amber, green
    const at = (i) => (horizontal ? [(i - 1) * LENS_STEP, 0] : [0, (1 - i) * LENS_STEP]);
    return [[0xff2a1a, STATE.RED], [0xffb000, STATE.AMBER], [0x22e070, STATE.GREEN]].map(([hex, st], i) => ({ st, f: face(heads, lensGeo(...at(i)), hex) }));
  };
  const H = style.armHead === 'horizontal';
  inst(H ? new THREE.BoxGeometry(LENS_STEP * 3 + 0.08, 0.38, 0.3) : new THREE.BoxGeometry(0.38, LENS_STEP * 3 + 0.08, 0.3), black, armHeads.map((h) => h.m));
  inst(new THREE.BoxGeometry(0.38, LENS_STEP * 3 + 0.08, 0.3), black, poleHeads.map((h) => h.m));
  const lensSets = [vehicleLenses(armHeads, H), vehicleLenses(poleHeads, false)];

  // Digit atlas (cells 0–9, 10 = blank): seven-segment digits, white on black (the face's colour tints them)
  const digitAtlas = (() => {
    const cv = document.createElement('canvas');
    cv.width = 11 * 32;
    cv.height = 48;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#fff';
    const SEG = { a: [6, 4, 20, 5], b: [24, 7, 5, 16], c: [24, 26, 5, 16], d: [6, 39, 20, 5], e: [3, 26, 5, 16], f: [3, 7, 5, 16], g: [6, 21.5, 20, 5] };
    const ON = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
    ON.forEach((segs, d) => { for (const k of segs) { const [x, y, w, h] = SEG[k]; g.fillRect(d * 32 + x, y, w, h); } });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    return { tex, cells: 11, pairs: true };
  })();
  const countdowns = [];
  if (style.countdown && H) {
    // square display left of the red lamp (as drivers see it)
    const x = -(LENS_STEP * 1.5 + 0.04) - 0.22;
    inst(new THREE.BoxGeometry(0.4, 0.38, 0.3).translate(x, 0, 0), black, armHeads.map((h) => h.m));
    countdowns.push({ f: face(armHeads, new THREE.PlaneGeometry(0.34, 0.3).translate(x, 0, 0.152), 0xff2a1a, digitAtlas), st: STATE.RED });
  }

  // --- Pedestrian signals: both ends of each crossing at a signalised junction, facing the people waiting opposite ---
  const peds = []; // { m, c, phase }
  const pedPoles = [];
  if (style.pedestrian) {
    const crossing = (geo.pathKinds || []).indexOf('crossing');
    for (const [kind, , elev, pts] of geo.paths || []) {
      if (kind !== crossing || elev > 0 || pts.length < 4) continue;
      const ax = pts[0], az = pts[1], bx = pts[pts.length - 2], bz = pts[pts.length - 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 4) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      let c = null, bd = CLUSTER_M + 15;
      for (const k of centres) { const d = Math.hypot(k.x - mx, k.z - mz); if (d < bd) { bd = d; c = k.c; } }
      if (!c) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len, phase = phaseOf(c, Math.atan2(dx, dz));
      // at each end (f: from that end across the road): a pole just behind it and beside the crossing, its head facing
      // across, to the people waiting at the other end
      for (const [ex, ez, fx, fz] of [[ax, az, dx, dz], [bx, bz, -dx, -dz]]) {
        const x = ex - fx * 0.8 - fz * 2.4, z = ez - fz * 0.8 + fx * 2.4, gy = ground(x, z);
        pedPoles.push(place(x, gy + PED_POLE_H / 2, z, 0));
        peds.push({ m: place(x, gy + PED_HEAD_Y, z, Math.atan2(fx, fz)), c, phase });
      }
    }
    if (peds.length) {
      inst(new THREE.CylinderGeometry(0.06, 0.07, PED_POLE_H, 8), metal, pedPoles);
      inst(new THREE.BoxGeometry(0.36, 1.02, 0.24).translate(0, 0.17, 0), black, peds.map((h) => h.m));
      // Figures atlas: cell 0 standing, 1–6 walking (a stride cycle), white on black
      const FRAMES = 6;
      const cv = document.createElement('canvas');
      cv.width = (FRAMES + 1) * 64;
      cv.height = 64;
      const g = cv.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, cv.width, cv.height);
      g.strokeStyle = g.fillStyle = '#fff';
      g.lineCap = 'round';
      const limb = (x, y, a, l) => { g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(a) * l, y + Math.cos(a) * l); g.stroke(); };
      const figure = (cx, arms, legs) => {
        g.beginPath(); g.arc(cx, 10, 6.5, 0, Math.PI * 2); g.fill();
        g.lineWidth = 11;
        g.beginPath(); g.moveTo(cx, 21); g.lineTo(cx, 37); g.stroke(); // body
        g.lineWidth = 6;
        limb(cx, 21, arms, 16); limb(cx, 21, -arms, 16);
        g.lineWidth = 7;
        limb(cx, 37, legs, 23); limb(cx, 37, -legs, 23);
      };
      figure(32, 0.35, 0.18); // standing: arms a little out, feet apart
      for (let i = 0; i < FRAMES; i++) { const k = Math.sin((i / FRAMES) * Math.PI * 2); figure(64 * (i + 1) + 32, 0.15 + 0.6 * k, 0.1 + 0.5 * k); }
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      const figs = { tex, cells: FRAMES + 1, frames: FRAMES };
      const plane = (y) => new THREE.PlaneGeometry(0.28, 0.28).translate(0, y, 0.122);
      countdowns.push({ f: face(peds, plane(0.52).scale(1.15, 0.9, 1), 0x22e070, digitAtlas), st: STATE.GREEN, ped: true });
      lensSets.push([
        { st: STATE.RED, f: face(peds, plane(0.17), 0xff2a1a, figs), cell: () => 0, ped: true },
        { st: STATE.GREEN, f: face(peds, plane(-0.17), 0x22e070, figs), walk: figs.frames, ped: true }
      ]);
    }
  }
  scene.add(group);

  let walkPhase = 0; // stride cycles of the walking figures
  function update(dt) {
    clock += dt;
    walkPhase += dt;
    for (const set of lensSets) {
      for (const lens of set) {
        const a = lens.f.lit.array, cells = lens.f.cell.array, heads = lens.f.heads;
        let changed = false;
        for (let i = 0; i < heads.length; i++) {
          const h = heads[i];
          let on = stateFor(h.c, h.phase) === lens.st ? 1 : 0;
          if (lens.walk) {
            // walking figure: strides quicken over the last 10 s of the walk phase, then it flashes
            const left = green - phaseTime(h.c, h.phase);
            if (on && left < style.pedFlashS && (clock * 2) % 1 > 0.5) on = 0;
            const rate = on && left < 10 ? 2.4 : 1.2; // strides a second
            const frame = 1 + (Math.floor(walkPhase * rate * lens.walk + h.phase * 3) % lens.walk);
            if (cells[i] !== frame) { cells[i] = frame; changed = true; }
          }
          if (a[i] !== on) { a[i] = on; changed = true; }
        }
        if (changed) { lens.f.lit.needsUpdate = true; lens.f.cell.needsUpdate = true; }
      }
    }
    // Countdowns: seconds left of the red (vehicles) or the walk (pedestrians), blank otherwise
    for (const cd of countdowns) {
      const a = cd.f.lit.array, cells = cd.f.cell.array, heads = cd.f.heads;
      let changed = false;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i], t = phaseTime(h.c, h.phase), st = stateFor(h.c, h.phase);
        const on = st === cd.st ? 1 : 0;
        const left = Math.min(99, Math.ceil(cd.st === STATE.GREEN ? green - t : cycle - t));
        const v = on ? (left < 10 ? 100 + left : left) : 0; // 100 + n: blank tens digit (cell 10)
        if (a[i] !== on || cells[i] !== v) { a[i] = on; cells[i] = v; changed = true; }
      }
      if (changed) { cd.f.lit.needsUpdate = true; cd.f.cell.needsUpdate = true; }
    }
  }
  update(0);

  return { group, stateAt, walkAllowed, update, STATE, stats: { intersections: clusters.size, heads: armHeads.length + poleHeads.length, pedestrian: peds.length } };
}

export { buildSignalControl, STATE as SIGNAL_STATE };
