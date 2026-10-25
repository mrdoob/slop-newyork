import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GEO } from './city-geodata.js';
import { createAirfieldMaterial } from '../render/tsl-materials.js';
import { drapeGeometry } from './drape.js';
import { townHeight } from './ground.js';

// js/world/airport.js
// The Aeropuerto Internacional de Tepic – Riviera Nayarit (MMEP) south-east of town, from OpenStreetMap's aeroway=*
// (GEO.airport, tools/build-tepic-geodata.mjs 4): runway 02/20 (45 m wide, ~3.1 km), its taxiways, the apron and the
// helipads, laid over the asphalt deck the builder leaves there (like pavements.js, a few millimetres up, the
// markings painted by the material), and airliners standing at the terminal's boarding bridges.

// over the asphalt deck, each kind a hair apart where they overlap: apron, taxiways, runway
const LIFT = [0.007, 0.011, 0.009, 0.007];

function buildAirfieldGeometry(airport) {
  const position = [], field = [], along = [], across = [], half = [], span = [];
  const index = [];
  const vertex = (x, z, k, a, c, h, l) => {
    position.push(x, LIFT[k], z);
    field.push(k);
    along.push(a);
    across.push(c);
    half.push(h);
    span.push(l);
    return position.length / 3 - 1;
  };
  // A strip along a centreline: a quad per segment, carrying how far along it and how far across each corner is.
  // Taxiways run on half their width past their ends so their joins close; the runway ends square at its thresholds.
  const strip = (k, width, pts, extend) => {
    const h = width / 2;
    let total = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    let s = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.1) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const e = extend ? h : 0;
      const x0 = ax - ux * e, z0 = az - uz * e, x1 = bx + ux * e, z1 = bz + uz * e;
      const rx = -uz * h, rz = ux * h;
      const a0 = s - e, a1 = s + len + e;
      const v0 = vertex(x0 - rx, z0 - rz, k, a0, -h, h, total);
      const v1 = vertex(x0 + rx, z0 + rz, k, a0, h, h, total);
      const v2 = vertex(x1 + rx, z1 + rz, k, a1, h, h, total);
      const v3 = vertex(x1 - rx, z1 - rz, k, a1, -h, h, total);
      index.push(v0, v1, v2, v0, v2, v3); // counter-clockwise seen from above (as pavements.js)
      s += len;
    }
  };
  // A paved area: its ring triangulated
  const area = (k, ring) => {
    const contour = [];
    for (let i = 0; i + 1 < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
    if (contour.length < 3) return;
    const v = contour.map((p) => vertex(p.x, p.y, k, 0, 0, 1, 1));
    // each triangle wound to face up (+y), whichever way the ring runs
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const A = contour[a], B = contour[b], C = contour[c];
      const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) > 0;
      index.push(v[a], up ? v[b] : v[c], up ? v[c] : v[b]);
    }
  };
  for (const ring of airport.aprons) area(0, ring);
  for (const ring of airport.helipads) area(3, ring);
  for (const [, width, pts] of airport.taxiways) strip(2, width, pts, true);
  for (const [, width, pts] of airport.runways) strip(1, width, pts, false);
  if (!index.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(position.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('field', new THREE.Float32BufferAttribute(field, 1));
  g.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  g.setAttribute('across', new THREE.Float32BufferAttribute(across, 1));
  g.setAttribute('half', new THREE.Float32BufferAttribute(half, 1));
  g.setAttribute('span', new THREE.Float32BufferAttribute(span, 1));
  g.setIndex(index);
  return g;
}

// A narrow-body airliner (A320 / 737 size: 37.6 m long, 34 m across the wings), nose toward +z, its wheels at y = 0:
// [white body parts, tail & cheatline in the livery colour, dark parts (windows, engines' intakes, tyres)]
function buildAirlinerGeometry() {
  const body = [], livery = [], dark = [];
  const Y = 3.1; // the fuselage's axis over the apron
  // fuselage: a lathe along z, a round nose and a tail cone
  const profile = [[0, -18.8], [0.35, -18.6], [0.9, -17.2], [1.5, -15.2], [1.95, -12.8], [2.0, -10], [2.0, 13.5], [1.9, 15.4],
    [1.55, 17.0], [0.95, 18.2], [0.3, 18.75], [0, 18.8]].map(([r, z]) => new THREE.Vector2(r, z));
  const fuselage = new THREE.LatheGeometry(profile, 24).rotateX(Math.PI / 2).translate(0, Y, 0);
  // (the tail cone sweeps up towards the fin)
  const fp = fuselage.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    const z = fp.getZ(i);
    if (z < -12) fp.setY(i, fp.getY(i) + ((-12 - z) / 6.8) ** 2 * 1.1);
  }
  fuselage.computeVertexNormals();
  body.push(fuselage);
  // cockpit windows & the cabin window band, a hair proud of the skin
  dark.push(new THREE.BoxGeometry(2.2, 0.45, 1.2).rotateX(-0.5).translate(0, Y + 1.35, 16.6));
  for (const side of [-1, 1]) {
    dark.push(new THREE.BoxGeometry(0.06, 0.32, 27).translate(side * 1.985, Y + 0.55, 0.5));
    livery.push(new THREE.BoxGeometry(0.06, 0.22, 33).translate(side * 1.99, Y - 0.15, -0.5));
  }
  // a swept, tapered slab: a wing, a tailplane or the fin, from its root chord to its tip chord
  const panel = (rootZ, rootChord, tipChord, spanLen, sweep, thick) => {
    const s = new THREE.Shape();
    s.moveTo(0, rootZ);
    s.lineTo(spanLen, rootZ - sweep);
    s.lineTo(spanLen, rootZ - sweep - tipChord);
    s.lineTo(0, rootZ - rootChord);
    s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false }).translate(0, 0, -thick / 2);
  };
  for (const side of [-1, 1]) {
    // wings (25° of sweep, a little dihedral), low on the fuselage
    const wing = panel(3.5, 6.2, 1.6, 15.5, 7.2, 0.35).rotateX(Math.PI / 2).rotateZ(0.09);
    if (side < 0) wing.scale(-1, 1, 1);
    body.push(wing.translate(side * 1.6, Y - 1.1, 0));
    // engines under the wings
    const nacelle = new THREE.CylinderGeometry(1.05, 0.85, 4.2, 18, 1, true).rotateX(Math.PI / 2).translate(side * 5.7, Y - 2.15, 4.3);
    body.push(nacelle);
    dark.push(new THREE.CircleGeometry(1.0, 18).translate(side * 5.7, Y - 2.15, 6.4));
    // tailplanes
    const stab = panel(-12.5, 3.6, 1.3, 6.0, 3.2, 0.22).rotateX(Math.PI / 2);
    if (side < 0) stab.scale(-1, 1, 1);
    livery.push(stab.translate(side * 0.6, Y + 1.0, 0));
    // main gear
    dark.push(new THREE.CylinderGeometry(0.55, 0.55, 0.7, 14).rotateZ(Math.PI / 2).translate(side * 3.8, 0.55, -1.2));
    body.push(new THREE.BoxGeometry(0.22, Y - 1.6, 0.22).translate(side * 3.8, (Y - 1.6) / 2 + 0.55, -1.2));
  }
  // the fin, in the livery colour
  livery.push(panel(-11.2, 5.6, 1.8, 6.3, 5.0, 0.3).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, Y + 1.6, 0));
  // nose gear
  dark.push(new THREE.CylinderGeometry(0.38, 0.38, 0.5, 12).rotateZ(Math.PI / 2).translate(0, 0.38, 13.2));
  body.push(new THREE.BoxGeometry(0.16, Y - 1.5, 0.16).translate(0, (Y - 1.5) / 2 + 0.38, 13.2));
  const merge = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    return g;
  }));
  return [merge(body), merge(livery), merge(dark)];
}

// Liveries for the airliners at the gates (generic, no airline's): the tail & cheatline colour
const LIVERIES = [0x5b2a86, 0x0b3d91, 0xc8102e];

function buildAirport(scene) {
  const airport = GEO.airport;
  if (!airport || !airport.runways.length) return null;
  const group = new THREE.Group();
  group.name = 'Airport';
  const geometry = buildAirfieldGeometry(airport);
  if (geometry) {
    const field = new THREE.Mesh(drapeGeometry(geometry), createAirfieldMaterial());
    field.name = 'Airfield';
    field.receiveShadow = true;
    group.add(field);
  }

  // Airliners nosed in at three of the four boarding bridges: the bridge's end meets the front door on the left, 5.5 m
  // behind the nose; the aircraft points at the terminal along the bridge
  const [bodyGeo, liveryGeo, darkGeo] = buildAirlinerGeometry();
  // (double-sided: the mirrored wings & tailplanes are wound the other way)
  const white = new THREE.MeshStandardNodeMaterial({ color: 0xf2f3f4, roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardNodeMaterial({ color: 0x15181c, roughness: 0.4, metalness: 0.2, side: THREE.DoubleSide });
  airport.gates.forEach(([tx, tz, dx, dz], i) => {
    if (i === 2) return; // (one gate stands empty)
    const len = Math.hypot(tx - dx, tz - dz) || 1;
    const fx = (tx - dx) / len, fz = (tz - dz) / len; // toward the terminal
    const rx = -fz, rz = fx; // the aircraft's right
    const noseX = dx + rx * 2.1 + fx * 5.5, noseZ = dz + rz * 2.1 + fz * 5.5;
    const cx = noseX - fx * 18.8, cz = noseZ - fz * 18.8;
    const plane = new THREE.Group();
    plane.name = 'Airliner';
    const liveryMat = new THREE.MeshStandardNodeMaterial({ color: LIVERIES[i % LIVERIES.length], roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide });
    for (const [geo, mat] of [[bodyGeo, white], [liveryGeo, liveryMat], [darkGeo, darkMat]]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      plane.add(mesh);
    }
    plane.position.set(cx, townHeight(cx, cz), cz);
    plane.rotation.y = Math.atan2(fx, fz);
    group.add(plane);
  });
  scene.add(group);
  console.info(`[airport] ${airport.name}: runway ${airport.runways.map((r) => r[0]).join(', ')}, ${airport.taxiways.length} taxiways, ${airport.gates.length} gates`);
  return group;
}

export { buildAirport, buildAirfieldGeometry, buildAirlinerGeometry };
