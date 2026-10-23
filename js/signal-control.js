import * as THREE from 'three/webgpu';
import { attribute, color, float, mix } from 'three/tsl';

// js/signal-control.js
// Traffic signals at the signalised nodes of a street centreline graph (GEO.roadGraph.signals): a two-phase controller
// per junction and signal poles with lit heads facing each approach. City-agnostic: the graph comes in through `geo`,
// the timing and traffic side through `options`.
//
// Junction nodes closer than CLUSTER_M are one intersection (a dual carriageway crossing is several graph nodes) and
// share a clock. Each approach belongs to the intersection's main axis (phase 0: the widest road) or the cross axis
// (phase 1), which run green alternately. The timings are a plausible fixed cycle, not real signal plans.

const CLUSTER_M = 45;
const MIN_APPROACH_M = 20; // links shorter than this are inside a junction: no stop line, no pole
const POLE_H = 6.2;
const ARM_Y = 5.7;
const STATE = { GREEN: 0, AMBER: 1, RED: 2 };

function buildSignalControl(scene, geo, options = {}) {
  const { green = 26, amber = 3, allRed = 2 } = options.timing || {};
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
  const stateFor = (c, phase) => {
    const t = (clock + c.offset + phase * half) % cycle;
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
  const heads = []; // { c, phase }
  const poleMats = [];
  const armMats = [];
  const headMats = [];
  const dummy = new THREE.Object3D();
  const v = new THREE.Vector3();
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
      // Pole
      dummy.position.set(px, POLE_H / 2, pz);
      dummy.rotation.set(0, facing, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poleMats.push(dummy.matrix.clone());
      // Arm over the road (towards the centre line, -r)
      const ax = px - rx * reach / 2, az = pz - rz * reach / 2;
      dummy.position.set(ax, ARM_Y, az);
      dummy.scale.set(1, 1, reach);
      dummy.rotation.set(0, Math.atan2(-rx, -rz), 0);
      dummy.updateMatrix();
      armMats.push(dummy.matrix.clone());
      // Heads: over the lanes at the arm's end, and low on the pole
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, facing, 0);
      for (const [hx, hy, hz] of [[px - rx * reach, ARM_Y - 0.55, pz - rz * reach], [px, 3.1, pz]]) {
        v.set(hx, hy, hz);
        dummy.position.copy(v);
        dummy.updateMatrix();
        headMats.push(dummy.matrix.clone());
        const c = clusterOf(n);
        heads.push({ c, phase: phaseOf(c, Math.atan2(ux, uz)) });
      }
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
  inst(new THREE.BoxGeometry(0.36, 1.05, 0.3), black, headMats);
  // Lenses (red top, amber, green bottom) on the head's front face, lit per instance
  const lenses = [[0xff2a1a, 0.33], [0xffb000, 0], [0x22e070, -0.33]].map(([hex, y], li) => {
    const geo = new THREE.CircleGeometry(0.12, 16);
    geo.translate(0, y, 0.152);
    const lit = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, headMats.length)), 1);
    geo.setAttribute('lit', lit);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3 });
    const on = attribute('lit', 'float');
    mat.colorNode = mix(color(hex).mul(0.12), color(hex), on);
    mat.emissiveNode = color(hex).mul(on.mul(2.5));
    mat.roughnessNode = float(0.3);
    const mesh = inst(geo, mat, headMats);
    mesh.castShadow = false;
    return { lit, state: li === 0 ? STATE.RED : li === 1 ? STATE.AMBER : STATE.GREEN };
  });
  scene.add(group);

  function update(dt) {
    clock += dt;
    for (const lens of lenses) {
      const a = lens.lit.array;
      let changed = false;
      for (let i = 0; i < heads.length; i++) {
        const on = stateFor(heads[i].c, heads[i].phase) === lens.state ? 1 : 0;
        if (a[i] !== on) { a[i] = on; changed = true; }
      }
      if (changed) lens.lit.needsUpdate = true;
    }
  }
  update(0);

  return { group, stateAt, walkAllowed, update, STATE, stats: { intersections: clusters.size, heads: heads.length } };
}

export { buildSignalControl, STATE as SIGNAL_STATE };
