import * as THREE from 'three/webgpu';
import { color, mix, positionWorld, fract, step, smoothstep, sin, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO } from './city-geodata.js';
import { cityUniforms } from '../render/tsl-materials.js';
import { liftAt, landHeight } from './ground.js';

// js/world/tepic-landmarks.js
// Tepic's landmarks on their real footprints (city-geodata.js `landmarks`, from OpenStreetMap): the Catedral on the
// Plaza Principal, its facade towards the plaza between two neo-Gothic towers (a tall shaft, two belfries with open
// arches, an octagonal spire with a cross). LANDMARK_RESERVES are their lots, kept clear of the generic houses.
// And the monuments the town finds its way by, at their OpenStreetMap points (city-geodata.js `pois`): the Columna de
// la Pacificación and the Monumento a los Constituyentes on the Plaza Principal, the golden Ángel de la Independencia,
// the Rey Nayar over his fountain, the bronze statues on their pedestals (Amado Nervo, Esteban Baca Calderón,
// Francisco Villa...), the fountains (Los 3 Delfines, the Molcajete), the big TEPIC & NAYARIT letters, the cross on the
// Cerro de la Cruz and the antennas of the Cerro Microondas, their red lights blinking at night.

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

// =====================================================================================================================
// THE MONUMENTS: a kit of parts (each a geometry in the monument's frame, base on y = 0, front towards +z), merged per
// material for each monument
// =====================================================================================================================
const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z).toNonIndexed();
const cyl = (r0, r1, h, x = 0, y = 0, z = 0, n = 16) => new THREE.CylinderGeometry(r1, r0, h, n).translate(x, y + h / 2, z).toNonIndexed();

// A standing figure s metres tall: legs under a coat or robe, torso, head, one arm raised when `raised` (a flag, a
// greeting) and the other down
function figure(s = 2.4, raised = false) {
  const k = s / 1.8;
  const parts = [
    // robe / coat to the knees, legs below
    new THREE.LatheGeometry([[0.0, 0.0], [0.23, 0.0], [0.26, 0.5], [0.28, 0.95], [0.24, 1.3], [0.2, 1.42], [0.0, 1.45]].map(([x, y]) => new THREE.Vector2(x * k, y * k)), 14),
    new THREE.SphereGeometry(0.12 * k, 12, 10).translate(0, 1.58 * k, 0),
    new THREE.CylinderGeometry(0.05 * k, 0.06 * k, 0.12 * k, 8).translate(0, 1.47 * k, 0),
    // the arm down at the side
    new THREE.CylinderGeometry(0.05 * k, 0.06 * k, 0.62 * k, 8).translate(0.3 * k, 1.05 * k, 0)
  ];
  // the other arm: raised high or held across the chest
  const arm = new THREE.CylinderGeometry(0.05 * k, 0.06 * k, 0.62 * k, 8);
  if (raised) parts.push(arm.rotateZ(2.6).translate(-0.38 * k, 1.62 * k, 0));
  else parts.push(arm.rotateX(1.2).translate(-0.18 * k, 1.2 * k, 0.18 * k));
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

// A winged Victory (the Ángel): a figure with two swept wings, a wreath held up
function angel(s = 3.6) {
  const k = s / 1.8;
  const wing = new THREE.Shape();
  wing.moveTo(0, 0);
  wing.quadraticCurveTo(0.5, 0.9, 1.0, 1.25);
  wing.quadraticCurveTo(0.7, 0.55, 0.62, 0.05);
  wing.closePath();
  const w = new THREE.ExtrudeGeometry(wing, { depth: 0.04, bevelEnabled: false }).scale(k, k, k);
  return mergeGeometries([
    figure(s, true),
    w.clone().rotateY(-0.5).translate(0.08 * k, 1.05 * k, -0.12 * k),
    w.clone().scale(-1, 1, 1).rotateY(0.5).translate(-0.08 * k, 1.05 * k, -0.12 * k),
    new THREE.TorusGeometry(0.16 * k, 0.025 * k, 6, 16).translate(-0.5 * k, 2.0 * k, 0).toNonIndexed()
  ]);
}

// A stepped stone pedestal h tall, w across
function pedestal(w, h) {
  return mergeGeometries([
    box(w + 1.2, 0.3, w + 1.2),
    box(w + 0.6, 0.3, w + 0.6, 0, 0.3),
    box(w, h - 0.9, w, 0, 0.6),
    box(w + 0.3, 0.3, w + 0.3, 0, h - 0.3)
  ]);
}

// A round fountain: a stone basin r across with its water, a bowl on a stem in the middle
function fountain(r) {
  const rim = new THREE.LatheGeometry([[r - 0.35, 0], [r, 0], [r, 0.6], [r - 0.35, 0.6], [r - 0.35, 0.05]].map(([x, y]) => new THREE.Vector2(x, y)), 40).toNonIndexed();
  return {
    stone: mergeGeometries([rim, cyl(0.35, 0.25, 1.6), new THREE.LatheGeometry([[0, 1.5], [1.1, 1.6], [1.2, 1.85], [1.0, 1.8], [0, 1.7]].map(([x, y]) => new THREE.Vector2(x, y)), 24).toNonIndexed()]),
    water: new THREE.CircleGeometry(r - 0.36, 40).rotateX(-Math.PI / 2).translate(0, 0.45, 0).toNonIndexed(),
    jet: cyl(0.06, 0.03, 1.4, 0, 1.75, 0, 8)
  };
}

// The block letters of a word, h tall, standing on y = 0, centred on x: each letter a set of boxes on a 3 x 5 grid
const GLYPHS = {
  T: ['111', '010', '010', '010', '010'], E: ['111', '100', '111', '100', '111'], P: ['111', '101', '111', '100', '100'],
  I: ['111', '010', '010', '010', '111'], C: ['111', '100', '100', '100', '111'], N: ['101', '111', '111', '111', '101'],
  A: ['111', '101', '111', '101', '101'], Y: ['101', '101', '010', '010', '010'], R: ['111', '101', '110', '101', '101']
};
function letters(word, h) {
  const u = h / 5;
  const out = [];
  [...word].forEach((ch, i) => {
    const g = GLYPHS[ch];
    const x0 = (i - (word.length - 1) / 2) * u * 4;
    const parts = [];
    g.forEach((row, r) => [...row].forEach((on, c) => {
      if (on === '1') parts.push(box(u, u, u * 0.8, x0 + (c - 1) * u, (4 - r) * u, 0));
    }));
    out.push(mergeGeometries(parts));
  });
  return out;
}

// A lattice telecom tower h tall (four legs braced every 4 m, narrowing up), dishes & a beacon on top
function tower(h) {
  const legs = [];
  const base = h * 0.09;
  for (let y = 0; y < h; y += 4) {
    const a = base * (1 - (y / h) * 0.75), b = base * (1 - ((y + 4) / h) * 0.75);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const leg = new THREE.CylinderGeometry(0.07, 0.07, 4.05, 4);
      const dx = (b - a) * sx, dz = (b - a) * sz;
      leg.rotateZ(-Math.atan2(dx, 4) * 0.98).rotateX(Math.atan2(dz, 4) * 0.98).translate(a * sx + dx / 2, y + 2, a * sz + dz / 2);
      legs.push(leg.toNonIndexed());
    }
    // a ring of struts and a diagonal on each face
    for (const [sx, sz, rot] of [[0, 1, 0], [0, -1, 0], [1, 0, Math.PI / 2], [-1, 0, Math.PI / 2]]) {
      legs.push(new THREE.BoxGeometry(2 * a, 0.06, 0.06).rotateY(rot).translate(sx * a, y + 0.05, sz * a).toNonIndexed());
      legs.push(new THREE.BoxGeometry(Math.hypot(2 * a, 4), 0.05, 0.05).rotateZ(Math.atan2(4, 2 * a)).rotateY(rot).translate(sx * a, y + 2, sz * a).toNonIndexed());
    }
  }
  const top = base * 0.25;
  const dishes = [0, 2.1, 4.2].map((r, i) => new THREE.CylinderGeometry(0.8, 0.8, 0.25, 16).rotateX(Math.PI / 2).translate(0, h - 4 - i * 3, top + 0.3).rotateY(r).toNonIndexed());
  return { steel: mergeGeometries(legs), dishes: mergeGeometries(dishes), beacon: new THREE.SphereGeometry(0.35, 10, 8).translate(0, h + 0.4, 0).toNonIndexed() };
}

function buildMonuments(group, colliders) {
  const pois = new Map((GEO.pois || []).map((p) => [p.name, p]));
  const stone = stoneMaterial(0xb3a893);
  const darkStone = stoneMaterial(0x6d655b);
  const bronze = new THREE.MeshStandardNodeMaterial({ color: 0x4f3d2a, roughness: 0.42, metalness: 0.75 });
  const gold = new THREE.MeshStandardNodeMaterial({ color: 0xd8b04a, roughness: 0.28, metalness: 1.0 });
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xf1eee6, roughness: 0.6 });
  const water = new THREE.MeshStandardNodeMaterial({ color: 0x2f5f6e, roughness: 0.08, metalness: 0.2 });
  const jetMat = new THREE.MeshStandardNodeMaterial({ color: 0xe6f2f5, roughness: 0.2, transparent: true, opacity: 0.7 });
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0xc9c9c4, roughness: 0.5, metalness: 0.6 });
  const towerRed = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.3 });
  // aviation red & white bands every 6 m
  towerRed.colorNode = mix(color(0xd9d6cf), color(0xc4321f), step(0.5, fract(positionWorld.y.div(12.0))));
  // the beacons: dull by day, a slow red blink after dusk
  const beacon = new THREE.MeshBasicNodeMaterial();
  beacon.colorNode = mix(color(0x6a1d16), color(0xff2a14).mul(3.0), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(step(0.0, sin(time.mul(3.2)))));
  const LETTER_COLS = [0xe4007c, 0x00a3e0, 0xffc20e, 0x43b02a, 0xff6a13, 0x8a2be2, 0xe4002b];
  const letterMats = LETTER_COLS.map((c) => new THREE.MeshStandardNodeMaterial({ color: c, roughness: 0.45 }));
  let built = 0;

  // A monument at POI `name` (or at x, z): parts [geometry, material], yaw, footprint half-size for its collider
  const place = (name, parts, { yaw = 0, half = 1.5, height = 6, at = null } = {}) => {
    const p = at || pois.get(name);
    if (!p) return;
    const root = new THREE.Group();
    root.name = name;
    root.position.set(p.x, landHeight(p.x, p.z) - 0.05, p.z);
    root.rotation.y = yaw;
    const byMat = new Map();
    for (const [geo, mat] of parts) {
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat).push(geo);
    }
    for (const [mat, geos] of byMat) {
      const mesh = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], mat);
      mesh.castShadow = mesh.receiveShadow = !mat.transparent && !mat.isMeshBasicNodeMaterial;
      root.add(mesh);
    }
    group.add(root);
    if (half > 0) colliders.push({ minX: p.x - half, maxX: p.x + half, minZ: p.z - half, maxZ: p.z + half, minY: root.position.y, maxY: root.position.y + height });
    built++;
  };

  // Columns: the Columna de la Pacificación, with its figure, and the Ángel de la Independencia, golden on top
  const column = (h, top, topMat) => [
    [pedestal(3.2, 4), stone],
    [cyl(0.85, 0.7, h, 0, 4), stone],
    [cyl(0.95, 1.05, 1.0, 0, 4 + h), stone],
    [top.translate(0, 5 + h, 0), topMat]
  ];
  place('Columna de la Pacificación', column(14, figure(3.0, true), bronze), { half: 2.2, height: 22 });
  place('Ángel de la Independencia', column(22, angel(4.2), gold), { half: 2.2, height: 32 });
  // The Monumento a los Constituyentes: a wide pedestal carrying a group of figures
  place('Monumento a los Constituyentes', [
    [pedestal(4.5, 3.2), stone],
    ...[-1.1, 0, 1.1].map((x) => [figure(2.5, x === 0).translate(x, 3.2, 0), bronze])
  ], { half: 3, height: 7 });
  // Statues on pedestals
  for (const [name, raised] of [['Amado Nervo', false], ['Monumento al Gral. Esteban Baca Calderón', true], ['Monumento al Gral. Francisco Villa', true],
    ['Monumento a Juan Espinoza Bávara', false], ['Monumento a Marcelino Cedano Mora', false], ['Monumento a Esteban Baca Calderón', true], ['Rotonda del Titulado', true]]) {
    place(name, [[pedestal(1.6, 2.6), stone], [figure(2.6, raised).translate(0, 2.6, 0), bronze]], { half: 1.4, height: 5.5 });
  }
  // The Monumento of the Alameda: an obelisk
  place('Monumento alameda', [[pedestal(2.4, 1.6), stone], [cyl(0.9, 0.5, 11, 0, 1.6, 0, 4), stone], [new THREE.ConeGeometry(0.5, 1.2, 4).translate(0, 13.2, 0).toNonIndexed(), stone]], { half: 1.8, height: 14 });
  // Fountains: Los 3 Delfines; the Rey Nayar, the king standing over his; the Molcajete, a stone mortar on three legs
  {
    const f = fountain(5);
    place('Fuente Los 3 Delfines', [[f.stone, stone], [f.water, water], [f.jet, jetMat]], { half: 0 });
  }
  {
    const f = fountain(7);
    place('Rey Nayar', [[f.stone, stone], [f.water, water], [pedestal(2.0, 4.5), darkStone], [figure(3.6, true).translate(0, 4.5, 0), bronze]], { half: 2.2, height: 9 });
  }
  {
    const bowl = new THREE.LatheGeometry([[0, 1.0], [2.6, 1.2], [3.2, 2.6], [3.0, 2.7], [2.4, 1.6], [0, 1.4]].map(([x, y]) => new THREE.Vector2(x, y)), 32).toNonIndexed();
    const legs = [0, 2.09, 4.19].map((a) => cyl(0.5, 0.35, 1.2, Math.cos(a) * 1.6, 0, Math.sin(a) * 1.6, 8));
    const f = fountain(7);
    place('Fuente Molcajete', [[f.stone, stone], [f.water, water], [mergeGeometries([bowl, ...legs]), darkStone], [new THREE.CircleGeometry(2.7, 32).rotateX(-Math.PI / 2).translate(0, 2.45, 0).toNonIndexed(), water]], { half: 3.2, height: 3 });
  }
  // The big letters: TEPIC & NAYARIT, each letter its own colour
  for (const [name, word] of [['Tepic', 'TEPIC'], ['Nayarit', 'NAYARIT']]) {
    const glyphs = letters(word, 2.6);
    place(name, glyphs.map((g, i) => [g, letterMats[i % letterMats.length]]), { half: word.length * 1.1, height: 2.6 });
  }
  // The cross on the Cerro de la Cruz (white, 14 m) and the antennas of the Cerro Microondas
  place('Cerro de la Cruz', [[box(0.9, 14, 0.9), white], [box(6.5, 0.9, 0.9, 0, 9.2), white], [box(2.4, 0.8, 2.4), white]], { half: 1.2, height: 14 });
  {
    const p = pois.get('Cerro Microondas');
    if (p) {
      [[0, 0, 42], [26, 14, 30], [-18, 22, 24]].forEach(([dx, dz, h], i) => {
        const t = tower(h);
        place(`Antena ${i + 1}`, [[t.steel, towerRed], [t.dishes, steel], [t.beacon, beacon]], { at: { x: p.x + dx, z: p.z + dz }, yaw: i * 0.7, half: h * 0.09, height: h });
      });
    }
  }
  return built;
}

function buildTepicLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'TepicLandmarks';
  const colliders = [];
  if (CATEDRAL) buildCatedral(group, colliders);
  const monuments = buildMonuments(group, colliders);
  console.info(`[landmarks] the Catedral and ${monuments} monuments`);
  scene.add(group);
  return { group, colliders };
}

export { buildTepicLandmarks, LANDMARK_RESERVES, CATEDRAL };
