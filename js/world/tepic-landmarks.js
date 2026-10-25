import * as THREE from 'three/webgpu';
import { color, mix, positionWorld, fract, step } from 'three/tsl';
import { GEO } from './city-geodata.js';
import { cityUniforms } from '../render/tsl-materials.js';
import { liftAt } from './ground.js';

// js/world/tepic-landmarks.js
// Tepic's landmarks on their real footprints (city-geodata.js `landmarks`, from OpenStreetMap): the Catedral on the
// Plaza Principal, its facade towards the plaza between two neo-Gothic towers (a tall shaft, two belfries with open
// arches, an octagonal spire with a cross). LANDMARK_RESERVES are their lots, kept clear of the generic houses.

// Oriented box around a flat [x, z, ...] ring: the turned rectangle of least area
function orientedBox(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of pts) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { ux, uz, u0, u1, v0, v1 } = best;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ax: [ux, uz], bx: [-uz, ux], a: u1 - u0, b: v1 - v0 };
}

// The Catedral's frame: centre, facade normal f (towards the plaza), across-axis r, facade width & depth
const CATEDRAL = (() => {
  const site = GEO.landmarks && GEO.landmarks.Catedral;
  if (!site || !site.ring) return null;
  const box = orientedBox(site.ring);
  if (!box) return null;
  const toPlaza = [-box.cx, -box.cz];
  const sides = [[box.ax, box.a, box.b], [box.bx, box.b, box.a]].flatMap(([n, along, across]) => [
    { f: n, depth: along, width: across },
    { f: [-n[0], -n[1]], depth: along, width: across }
  ]);
  const front = sides.reduce((p, q) => (q.f[0] * toPlaza[0] + q.f[1] * toPlaza[1] > p.f[0] * toPlaza[0] + p.f[1] * toPlaza[1] ? q : p));
  return { x: box.cx, z: box.cz, f: front.f, width: front.width, depth: front.depth, yaw: Math.atan2(front.f[0], front.f[1]) };
})();

// Lots the generic houses keep off: { contains(x, z) }
const LANDMARK_RESERVES = [];
if (CATEDRAL) {
  const { x, z, f, width, depth } = CATEDRAL;
  LANDMARK_RESERVES.push({
    contains(px, pz) {
      const dx = px - x, dz = pz - z;
      const along = dx * f[0] + dz * f[1];
      const across = -dx * f[1] + dz * f[0];
      return Math.abs(along) < depth / 2 + 3 && Math.abs(across) < width / 2 + 3;
    }
  });
}

function stoneMaterial(tint) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0 });
  // ashlar courses: a darker joint every 0.55 m
  const joint = step(0.93, fract(positionWorld.y.div(0.55)));
  mat.colorNode = mix(color(tint), color(tint).mul(0.78), joint.mul(0.6));
  return mat;
}

// A pointed (Gothic) arch, w wide and h tall, as a flat shape standing on y = 0
function pointedArch(w, h) {
  const shape = new THREE.Shape();
  const spring = h - w * 0.75; // where the arch springs from its jambs
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(w / 2, spring);
  shape.quadraticCurveTo(w / 2, h - w * 0.15, 0, h);
  shape.quadraticCurveTo(-w / 2, h - w * 0.15, -w / 2, spring);
  shape.closePath();
  return shape;
}

// The Catedral de Tepic (from photographs): a tall front of brownish-grey cantera with a pointed-arch portal, two lancet
// windows and a round medallion; two towers rising from its corners in three tiers that step in (each with pointed
// openings on every face under a flaring cornice), crowned by a small dome, a lantern and a cross; the clock gable
// between them; the nave behind.
function buildCatedral(group, colliders) {
  const C = CATEDRAL;
  const root = new THREE.Group();
  root.name = 'Catedral';
  // OpenStreetMap's outline takes in the atrium & the annexes: the church itself is ~26 m across and at most 60 m long,
  // its front on the front of the lot
  const W = Math.min(26, Math.max(18, C.width)), L = Math.min(60, Math.max(30, C.depth));
  const shift = (C.depth - L) / 2;
  const cx = C.x + C.f[0] * shift, cz = C.z + C.f[1] * shift;
  // on the ground at the lowest corner of the church, a little into it (the town's slopes)
  const cs = Math.cos(C.yaw), sn = Math.sin(C.yaw);
  let base = Infinity;
  for (const [a, b] of [[-W / 2, -L / 2], [W / 2, -L / 2], [W / 2, L / 2], [-W / 2, L / 2]]) base = Math.min(base, liftAt(cx + a * cs + b * sn, cz - a * sn + b * cs));
  base = base > 0 ? base - 0.15 : 0;
  root.position.set(cx, base, cz);
  root.rotation.y = C.yaw; // local +z: the facade's normal, towards the plaza
  const stone = stoneMaterial(0x8f8272);
  const light = stoneMaterial(0xa89a86);
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x1b1916, roughness: 0.9 });
  const glass = new THREE.MeshStandardNodeMaterial({ color: 0x3a4a5e, roughness: 0.3 });
  glass.emissiveNode = color(0xffc77a).mul(cityUniforms.uInteriorGlow).mul(0.5);
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xf2efe6, roughness: 0.5 });
  const add = (geo, mat, x, y, z, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const box = (w, h, d, x, y, z, mat = stone) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const arch = (w, h, x, y, z, ry, mat = dark) => add(new THREE.ShapeGeometry(pointedArch(w, h)), mat, x, y, z, ry);
  const FRONT_H = 20, NAVE_H = 15;
  const fz = L / 2; // the facade's plane
  // nave & roof
  box(W - 3, NAVE_H, L - 6, 0, NAVE_H / 2, -3);
  const ridge = new THREE.Shape();
  ridge.moveTo(-(W - 3) / 2, 0);
  ridge.lineTo((W - 3) / 2, 0);
  ridge.lineTo(0, 4);
  ridge.closePath();
  add(new THREE.ExtrudeGeometry(ridge, { depth: L - 6, bevelEnabled: false }), new THREE.MeshStandardNodeMaterial({ color: 0x7a6e60, roughness: 0.85 }), 0, NAVE_H, -3 - (L - 6) / 2);
  // the front block, its plinth & string courses
  box(W, FRONT_H, 6, 0, FRONT_H / 2, fz - 3);
  box(W + 0.6, 1.2, 6.6, 0, 0.6, fz - 3, light);
  for (const y of [7.5, 13.5]) box(W + 0.3, 0.45, 6.3, 0, y, fz - 3, light);
  box(W + 0.9, 0.7, 6.9, 0, FRONT_H, fz - 3, light);
  // portal, side doors under the towers, lancet windows, medallion
  const s = Math.min(8.5, W * 0.32); // tower width
  arch(4.6, 8.5, 0, 0, fz + 0.03, 0);
  for (const side of [-1, 1]) {
    arch(3.0, 6.0, side * (W / 2 - s / 2), 0, fz + 0.03, 0);
    arch(1.9, 4.4, side * 1.7, 9.0, fz + 0.03, 0, glass);
    arch(1.5, 3.4, side * (W / 2 - s / 2), 14.5, fz + 0.03, 0, dark);
  }
  const medallion = new THREE.Mesh(new THREE.CircleGeometry(1.25, 28), light);
  medallion.position.set(0, 16.2, fz + 0.04);
  root.add(medallion);
  // the clock gable between the towers
  box(5.2, 5, 2.2, 0, FRONT_H + 2.5, fz - 1.4);
  box(5.8, 0.4, 2.6, 0, FRONT_H + 5.1, fz - 1.4, light);
  const clock = new THREE.Mesh(new THREE.CircleGeometry(1.25, 28), white);
  clock.position.set(0, FRONT_H + 2.6, fz - 0.28);
  root.add(clock);
  for (const [hx, hy, hr] of [[0, 0.55, 0], [0.4, 0.15, -1.2]]) {
    const hand = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 1.0), dark);
    hand.position.set(hx * 0.5, FRONT_H + 2.6 + hy * 0.5, fz - 0.26);
    hand.rotation.z = hr;
    root.add(hand);
  }
  const finial = (x, y, z, r = 0.35) => {
    add(new THREE.CylinderGeometry(r * 0.5, r * 0.6, 1.0, 8), light, x, y + 0.5, z);
    add(new THREE.SphereGeometry(r, 10, 8), light, x, y + 1.2, z);
  };
  finial(-2.4, FRONT_H + 5.3, fz - 1.4);
  finial(2.4, FRONT_H + 5.3, fz - 1.4);
  // the towers, from the front's corners: three tiers stepping in, pointed openings on all four faces, flaring cornices
  const tiers = [[s, 9.0], [s * 0.8, 7.5], [s * 0.6, 6.0]];
  for (const side of [-1, 1]) {
    const tx = side * (W / 2 - s / 2), tz = fz - s / 2;
    let y = FRONT_H + 0.35;
    for (const [w, h] of tiers) {
      box(w, h, w, tx, y + h / 2, tz);
      // corner pilasters
      for (const [px, pz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) box(w * 0.14, h, w * 0.14, tx + px * w * 0.46, y + h / 2, tz + pz * w * 0.46, light);
      // the openings (two per face on the lowest tier)
      const n = w > 7 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const off = n === 1 ? 0 : (k - 0.5) * w * 0.42;
        const aw = w * (n === 1 ? 0.42 : 0.3), ah = h * 0.72;
        arch(aw, ah, tx + off, y + h * 0.1, tz + w / 2 + 0.02, 0);
        arch(aw, ah, tx - off, y + h * 0.1, tz - w / 2 - 0.02, Math.PI);
        arch(aw, ah, tx + w / 2 + 0.02, y + h * 0.1, tz - off, Math.PI / 2);
        arch(aw, ah, tx - w / 2 - 0.02, y + h * 0.1, tz + off, -Math.PI / 2);
      }
      y += h;
      // the flaring cornice & finials on its corners
      box(w + 1.3, 0.35, w + 1.3, tx, y + 0.15, tz, light);
      box(w + 0.8, 0.35, w + 0.8, tx, y - 0.15, tz, light);
      for (const [px, pz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) finial(tx + px * (w / 2 + 0.3), y + 0.3, tz + pz * (w / 2 + 0.3), 0.28);
      y += 0.35;
    }
    // small dome, lantern, cross
    const top = tiers[2][0];
    const dome = add(new THREE.SphereGeometry(top * 0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), stone, tx, y, tz);
    dome.scale.y = 0.9;
    box(top * 0.32, 2.4, top * 0.32, tx, y + top * 0.38 + 1.2, tz, light);
    add(new THREE.ConeGeometry(top * 0.24, 1.6, 8), stone, tx, y + top * 0.38 + 3.2, tz);
    box(0.22, 2.4, 0.22, tx, y + top * 0.38 + 5.2, tz, dark);
    box(1.2, 0.22, 0.22, tx, y + top * 0.38 + 5.6, tz, dark);
  }
  group.add(root);
  // a collider over the church
  const hx = W / 2, hz = L / 2;
  const ox = root.position.x, oz = root.position.z;
  const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
  colliders.push({ minX: ox - ex, maxX: ox + ex, minZ: oz - ez, maxZ: oz + ez, minY: base, maxY: base + 50, obb: { cx: ox, cz: oz, hx, hz, cs, sn } });
}

function buildTepicLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'TepicLandmarks';
  const colliders = [];
  if (CATEDRAL) buildCatedral(group, colliders);
  scene.add(group);
  return { group, colliders };
}

export { buildTepicLandmarks, LANDMARK_RESERVES, CATEDRAL };
