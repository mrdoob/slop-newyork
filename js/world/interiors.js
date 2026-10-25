import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Fn, color, positionWorld, floor, fract, step, mix, sin, uniform } from 'three/tsl';
import { isOpen } from './venues.js';
import { Bystanders } from '../sim/bystanders.js';

// js/world/interiors.js
// Going into a restaurant, a cantina or an antro (F at its door: "Entrar a ..."): the room the street front opens on,
// built once per kind and kept high over an empty corner of the map (inside the city's box, which the controllers keep
// the player in), where the player walks about it on its own floor & walls (controllers.js setInterior) under a
// camera kept inside it (cameras.js). F at the door again goes back out to the street.
// - restaurant (the restaurants, marisquerías, taquerías & burger places): tables, a counter with the kitchen behind,
//   papel picado; the cooks & customers; F at the counter orders something to eat
// - bar (the cantinas & bars): a long bar with its bottles, high tables, a pool table, the TV; cumbia or banda
// - disco (the antros: the Tapanko, Queens Disco...): a dark hall, a dance floor lit from under, the DJ up on the
//   tapanco (the mezzanine across the back, up its stairs), the bar along the side, reggaetón, a crowd dancing

const POCKET = { x: 10150, z: 9850, y: 2600 }; // over the box's empty south-east corner, 2.6 km up
const KINDS = {
  restaurant: { w: 12, d: 10, h: 3.3, music: 'cumbia', price: 80, heal: 50, item: 'una orden de comida', light: 1.2 },
  bar: { w: 12, d: 9, h: 3.4, music: 'banda', price: 40, heal: 10, item: 'una cerveza', light: 1.3 },
  disco: { w: 16, d: 15, h: 6.4, music: 'reggaeton', price: 70, heal: 5, item: 'una cuba', light: 8 }
};
// (`light`: the lamps' intensities below scaled for the room: the antro's dark walls take much more than a dining room's)
const ROOM_OF = { restaurant: 'restaurant', seafood: 'restaurant', tacos: 'restaurant', burger: 'restaurant', bar: 'bar', disco: 'disco' };
const MEZZ_Y = 3.0; // the tapanco's floor over the hall's
const MEZZ_D = 4.5; // its depth from the back wall
const DOOR_REACH = 1.8; // m from a door the player goes in or out by

const hash = (x, z, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

// Box geometry at (x, y, z) local, its bottom at y
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z).toNonIndexed();
const cyl = (r0, r1, h, x, y, z, n = 12) => new THREE.CylinderGeometry(r0, r1, h, n).translate(x, y + h / 2, z).toNonIndexed();

// A tiled floor: square tiles `size` m in two tones (TSL, in world metres)
function tileMaterial(a, b, size = 0.5, roughness = 0.35) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
  m.colorNode = Fn(() => {
    const p = positionWorld.xz.div(size);
    const check = step(0.5, fract(floor(p.x).add(floor(p.y)).mul(0.5))); // (alternate tiles)
    const grout = step(0.95, fract(p.x)).max(step(0.95, fract(p.y)));
    return mix(mix(color(a), color(b), check), color(0x5a554e), grout.mul(0.6));
  })();
  return m;
}

// An antro's dance floor: tiles lit from under in colours that run across it with the beat (uniform uBeat: s)
function danceFloorMaterial(uTime) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const p = positionWorld.xz;
    const tile = floor(p.div(0.8));
    const phase = fract(sin(tile.x.mul(12.9).add(tile.y.mul(78.2))).mul(437.5));
    const beat = floor(uTime.mul(92 / 60));
    const on = step(0.55, fract(phase.add(beat.mul(0.37))));
    const hue = fract(phase.add(beat.mul(0.13)));
    const c = mix(mix(color(0xff2bd6), color(0x2be0ff), step(0.33, hue)), color(0x8a5bff), step(0.66, hue));
    const edge = step(0.9, fract(p.x.div(0.8))).max(step(0.9, fract(p.y.div(0.8))));
    return mix(c.mul(on.mul(1.6).add(0.12)), color(0x111111), edge);
  })();
  return m;
}

// A sign's or a menu board's text on a canvas (the venue's name, or the menu)
function textTexture(lines, w = 512, h = 256, bg = '#1d1b19', fg = '#f6e7b0', font = 'bold 44px sans-serif') {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = font;
  lines.forEach((t, i) => g.fillText(t, w / 2, (h / (lines.length + 1)) * (i + 1)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, canvas, g };
}

class Interiors {
  /**
   * @param {object} o - scene; venues (venues.js findVenues); controllers (player/controllers.js); camera
   *   (cameras.js CameraSystem); crime (money, health, toasts: sim/crime.js); colliders: the controllers' own list
   *   (the rooms' walls & furniture join it)
   */
  constructor({ scene, venues, controllers, cameras, crime }) {
    this.controllers = controllers;
    this.cameras = cameras;
    this.crime = crime;
    this.venues = venues.filter((v) => ROOM_OF[v.kind]);
    this.cells = new Map();
    for (const v of this.venues) {
      const k = Math.floor(v.x / 50) * 100003 + Math.floor(v.z / 50);
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(v);
    }
    this.uTime = uniform(0);
    this.rooms = {};
    let i = 0;
    for (const kind of Object.keys(KINDS)) this.rooms[kind] = this.buildRoom(scene, kind, POCKET.x - i++ * 40, POCKET.z);
    this.people = new Bystanders(scene, 48, (x, z) => controllers.getGroundHeight(x, z, 'person', POCKET.y + 4));
    this.inside = null; // { room, venue }
    this.doorNear = null;
    this.counterNear = false;
    this.time = 0;
  }

  // One room of `kind` at (ox, POCKET.y, oz): its meshes, its walls & furniture as colliders, its floor, its spots
  buildRoom(scene, kind, ox, oz) {
    const K = KINDS[kind];
    const { w, d, h } = K;
    const y0 = POCKET.y;
    const group = new THREE.Group();
    group.name = `Interior_${kind}`;
    group.position.set(ox, y0, oz);
    scene.add(group);
    const colliders = [];
    // (local x across, z from the back wall (-d/2) to the street front (+d/2) with its door in the middle)
    const solid = (x0, x1, z0, z1, yMin = 0, yMax = h) => colliders.push({
      minX: ox + x0, maxX: ox + x1, minZ: oz + z0, maxZ: oz + z1, minY: y0 + yMin, maxY: y0 + yMax
    });
    const T = 0.3; // walls' thickness
    const wallGeos = [
      box(w + 2 * T, h, T, 0, 0, -d / 2 - T / 2), // back
      box(T, h, d, -w / 2 - T / 2, 0, 0), box(T, h, d, w / 2 + T / 2, 0, 0), // sides
      box(w / 2 - 0.8 + T, h, T, -(w / 4 + 0.4) - T / 2, 0, d / 2 + T / 2), box(w / 2 - 0.8 + T, h, T, w / 4 + 0.4 + T / 2, 0, d / 2 + T / 2), // front, either side of the door
      box(1.6, h - 2.3, T, 0, 2.3, d / 2 + T / 2) // over the door
    ];
    solid(-w / 2 - 1, w / 2 + 1, -d / 2 - 1, -d / 2); // back
    solid(-w / 2 - 1, -w / 2, -d / 2 - 1, d / 2 + 1);
    solid(w / 2, w / 2 + 1, -d / 2 - 1, d / 2 + 1);
    solid(-w / 2 - 1, -0.8, d / 2, d / 2 + 1);
    solid(0.8, w / 2 + 1, d / 2, d / 2 + 1);
    solid(-0.8, 0.8, d / 2 + 0.6, d / 2 + 1.5); // (the doorway leads nowhere: the street is out the other side)
    const paint = kind === 'disco' ? 0x16141c : kind === 'bar' ? 0x7a3b2a : [0xe7c98f, 0xd7e6c8, 0xf0b8a0][Math.floor(hash(ox, oz) * 3)];
    const wallMat = new THREE.MeshStandardNodeMaterial({ color: paint, roughness: 0.85 });
    const add = (geos, mat, cast = true) => {
      const mesh = new THREE.Mesh(Array.isArray(geos) ? mergeGeometries(geos) : geos, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    add(wallGeos, wallMat);
    add(box(w + 2 * T, 0.3, d + 2 * T, 0, h, 0), new THREE.MeshStandardNodeMaterial({ color: kind === 'disco' ? 0x0c0b10 : 0xf1ede4, roughness: 0.9 })); // ceiling
    add(box(w, 0.2, d, 0, -0.2, 0), kind === 'disco' ? new THREE.MeshStandardNodeMaterial({ color: 0x1a1a1d, roughness: 0.4 })
      : kind === 'bar' ? tileMaterial(0x6b4a33, 0x5a3c28, 0.6, 0.5) : tileMaterial(0xe8e2d4, 0xb04a32, 0.4), false); // floor
    // the street out of the door: a bright doorway (day or night it is lighter than the room)
    add(new THREE.PlaneGeometry(1.6, 2.3).rotateY(Math.PI).translate(0, 1.15, d / 2 + T - 0.02), new THREE.MeshBasicNodeMaterial({ color: 0xbfd6e8 }), false);
    // the venue's name over the counter / the bar / the DJ (redrawn for each venue)
    const sign = textTexture(['']);
    const signMesh = add(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicNodeMaterial({ map: sign.tex }), false);
    const lights = [];
    const light = (x, y, z, c, intensity, dist) => {
      const l = new THREE.PointLight(c, intensity * K.light, dist, 1.6);
      l.position.set(x, y, z);
      l.visible = false; // (on only while the player is in the room: the clustered lighting takes 256 lights at most)
      group.add(l);
      lights.push(l);
      return l;
    };
    const spots = { staff: [], guests: [], dancers: [], counter: null, music: [0, 2, 0] };
    const wood = new THREE.MeshStandardNodeMaterial({ color: 0x6a4630, roughness: 0.6 });
    const steel = new THREE.MeshStandardNodeMaterial({ color: 0xb8bbbd, roughness: 0.3, metalness: 0.8 });
    const plastic = new THREE.MeshStandardNodeMaterial({ color: 0xc8241f, roughness: 0.5 });
    let floorAt = () => y0;

    if (kind === 'restaurant') {
      // the counter across the back, the kitchen behind it, the menu over it
      add([box(7, 1.05, 0.7, 0, 0, -d / 2 + 2.2), box(7, 0.06, 0.9, 0, 1.05, -d / 2 + 2.2)], steel);
      add([box(2.2, 0.9, 0.7, -2.2, 0, -d / 2 + 0.4), box(1.2, 0.05, 0.7, -2.2, 0.9, -d / 2 + 0.4)], new THREE.MeshStandardNodeMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 }));
      solid(-3.5, 3.5, -d / 2 + 1.75, -d / 2 + 2.65);
      const menu = textTexture(['TACOS AL PASTOR $18', 'QUESADILLAS $35', 'TORTA AHOGADA $60', 'AGUA DE HORCHATA $25'], 512, 256, '#1b2a1d', '#f2efe2', 'bold 30px sans-serif');
      add(new THREE.PlaneGeometry(3.4, 1.4).translate(2.4, 2.3, -d / 2 + 0.02), new THREE.MeshBasicNodeMaterial({ map: menu.tex }), false);
      signMesh.position.set(-1.8, 2.45, -d / 2 + 0.03);
      // tables with their red plastic chairs (the brewery's), in two rows
      const tables = [], chairs = [];
      for (const tx of [-3.8, 0, 3.8]) {
        for (const tz of [-0.6, 2.0]) { // (clear of the way in at the door)
          tables.push(box(1.0, 0.04, 1.0, tx, 0.74, tz), cyl(0.04, 0.04, 0.74, tx, 0, tz, 6), cyl(0.3, 0.3, 0.03, tx, 0, tz, 12));
          for (const [cx, cz] of [[-0.75, 0], [0.75, 0], [0, -0.75], [0, 0.75]]) {
            chairs.push(box(0.42, 0.04, 0.42, tx + cx, 0.44, tz + cz), box(0.42, 0.42, 0.04, tx + cx * 1.25, 0.46, tz + cz * 1.25 + (cx ? 0 : 0)));
          }
          solid(tx - 0.55, tx + 0.55, tz - 0.55, tz + 0.55, 0, 0.8);
          spots.guests.push([tx + 0.9, tz + 0.6, Math.atan2(-0.9, -0.6)], [tx - 0.9, tz - 0.4, Math.atan2(0.9, 0.4)]);
        }
      }
      add(tables, wood);
      add(chairs, plastic);
      // papel picado strung across the ceiling, in rows of colours
      const flags = [];
      const colors = [0xe8336d, 0x2bb5e0, 0xf2c12e, 0x3ccf6e, 0xa45be0, 0xff7a1c];
      for (let r = 0; r < 4; r++) {
        for (let i = 0; i < 22; i++) {
          const g = new THREE.PlaneGeometry(0.4, 0.3).translate(-w / 2 + 0.5 + i * 0.52, h - 0.45 - (Math.sin((i / 21) * Math.PI) * 0.25), -d / 2 + 2.5 + r * 2.2).toNonIndexed();
          const c = new THREE.Color(colors[(i + r) % colors.length]);
          const cols = new Float32Array(g.attributes.position.count * 3);
          for (let k = 0; k < cols.length; k += 3) cols.set([c.r, c.g, c.b], k);
          g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
          flags.push(g);
        }
      }
      add(flags, new THREE.MeshStandardNodeMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 }), false);
      spots.staff.push([-1.5, -d / 2 + 1.2, 0], [1.8, -d / 2 + 1.2, 0]);
      spots.counter = [0, -d / 2 + 3.1];
      spots.music = [w / 2 - 0.6, 2.6, -d / 2 + 0.6];
      light(-3, h - 0.3, 0, 0xffe0b0, 25, 9);
      light(3, h - 0.3, 0, 0xffe0b0, 25, 9);
      light(0, h - 0.3, -d / 2 + 1.5, 0xfff2dc, 20, 7);
    } else if (kind === 'bar') {
      // the long bar down the left, the bottles on their shelves behind it lit from under, stools, a pool table, the TV
      add([box(0.7, 1.1, 6.5, -w / 2 + 2.0, 0, -0.8), box(0.95, 0.06, 6.6, -w / 2 + 2.0, 1.1, -0.8)], wood);
      solid(-w / 2 + 1.6, -w / 2 + 2.45, -4.1, 2.5);
      const bottles = [];
      for (let s = 0; s < 3; s++) for (let i = 0; i < 16; i++) bottles.push(cyl(0.04, 0.045, 0.3, -w / 2 + 0.25, 1.15 + s * 0.42, -3.8 + i * 0.4, 6));
      add(bottles, new THREE.MeshBasicNodeMaterial({ color: 0xd9a441 }), false);
      add([box(0.35, 0.03, 6.6, -w / 2 + 0.25, 1.12, -0.8), box(0.35, 0.03, 6.6, -w / 2 + 0.25, 1.54, -0.8), box(0.35, 0.03, 6.6, -w / 2 + 0.25, 1.96, -0.8)], wood);
      const stools = [];
      for (let i = 0; i < 7; i++) stools.push(cyl(0.2, 0.2, 0.05, -w / 2 + 2.85, 0.72, -3.6 + i * 0.95), cyl(0.04, 0.04, 0.72, -w / 2 + 2.85, 0, -3.6 + i * 0.95, 6));
      add(stools, steel);
      // the pool table
      add([box(2.6, 0.12, 1.45, 2.4, 0.72, -1.2)], new THREE.MeshStandardNodeMaterial({ color: 0x1f6b3a, roughness: 0.9 }));
      add([box(2.8, 0.72, 1.6, 2.4, 0, -1.2)], wood);
      solid(1.0, 3.8, -2.0, -0.4, 0, 0.9);
      // high tables
      const tops = [];
      for (const [tx, tz] of [[0.8, 1.4], [3.6, 2.6], [-1.2, -2.8]]) {
        tops.push(cyl(0.38, 0.38, 0.04, tx, 1.05, tz, 14), cyl(0.04, 0.04, 1.05, tx, 0, tz, 6));
        solid(tx - 0.4, tx + 0.4, tz - 0.4, tz + 0.4, 0, 1.1);
        spots.guests.push([tx + 0.6, tz, -Math.PI / 2], [tx - 0.55, tz + 0.2, Math.PI / 2]);
      }
      add(tops, steel);
      // the TV (the football on), its glow flickering
      add(new THREE.PlaneGeometry(1.6, 0.9).translate(2.4, 2.4, -d / 2 + 0.03), new THREE.MeshBasicNodeMaterial({ color: 0x3a8a4a }), false);
      signMesh.position.set(-w / 2 + 0.05, 2.6, -0.8);
      signMesh.rotation.y = Math.PI / 2;
      for (let i = 0; i < 5; i++) spots.guests.push([-w / 2 + 3.2, -3.4 + i * 1.3, -Math.PI / 2]);
      spots.guests.push([1.8, -0.2, Math.PI], [3.3, -2.3, 0]);
      spots.staff.push([-w / 2 + 1.0, -1.5, Math.PI / 2], [-w / 2 + 1.0, 1.0, Math.PI / 2]);
      spots.counter = [-w / 2 + 3.0, 1.6];
      spots.music = [w / 2 - 0.7, 1.4, d / 2 - 1];
      light(-w / 2 + 2, h - 0.3, -0.8, 0xffb070, 22, 8);
      light(2.4, 1.6, -1.2, 0xfff0c8, 12, 4);
      light(1, h - 0.3, 2.5, 0xff9a5a, 14, 8);
    } else {
      // the antro: the dance floor in the middle, the tapanco across the back (up the stairs on the right), the DJ's
      // booth at its rail, the bar down the left, speaker stacks either side of the floor
      add(box(9, 0.04, 7, 0.5, 0, 1.0), danceFloorMaterial(this.uTime), false);
      add([box(w, 0.3, MEZZ_D, 0, MEZZ_Y - 0.3, -d / 2 + MEZZ_D / 2), ...[-w / 2 + 2, -2, 2, w / 2 - 2].map((x) => cyl(0.12, 0.12, MEZZ_Y - 0.3, x, 0, -d / 2 + MEZZ_D - 0.3, 8))],
        new THREE.MeshStandardNodeMaterial({ color: 0x2a2a30, roughness: 0.6, metalness: 0.4 }));
      // its railing (a gap for the stairs), the stairs up the right wall
      add([box(w - 2.2, 0.06, 0.06, -1.1, MEZZ_Y + 1.0, -d / 2 + MEZZ_D), ...Array.from({ length: 12 }, (_, i) => box(0.05, 1.0, 0.05, -w / 2 + 0.3 + i * 1.12, MEZZ_Y, -d / 2 + MEZZ_D))], steel);
      const steps = [];
      const STEPS = 12, RUN = 4.8;
      for (let i = 0; i < STEPS; i++) steps.push(box(1.6, (MEZZ_Y / STEPS) * (i + 1), RUN / STEPS, w / 2 - 0.8, 0, -d / 2 + MEZZ_D + RUN - (i + 0.5) * (RUN / STEPS)));
      add(steps, new THREE.MeshStandardNodeMaterial({ color: 0x3a3a40, roughness: 0.7 }));
      // the tapanco's rail stops whoever is up there falling off (but for the stairs' gap); the stairs' side wall
      colliders.push({ minX: ox - w / 2, maxX: ox + w / 2 - 2.2, minZ: oz - d / 2 + MEZZ_D - 0.1, maxZ: oz - d / 2 + MEZZ_D + 0.1, minY: y0 + MEZZ_Y - 0.2, maxY: y0 + MEZZ_Y + 1.2 });
      solid(w / 2 - 2.0, w / 2 - 1.6, -d / 2 + MEZZ_D, -d / 2 + MEZZ_D + RUN, 0.4, MEZZ_Y);
      // the DJ's booth at the rail, the bar down the left wall
      add([box(2.4, 1.1, 0.8, 0, MEZZ_Y, -d / 2 + MEZZ_D - 0.6)], new THREE.MeshStandardNodeMaterial({ color: 0x101012, roughness: 0.4, metalness: 0.5 }));
      colliders.push({ minX: ox - 1.2, maxX: ox + 1.2, minZ: oz - d / 2 + MEZZ_D - 1.0, maxZ: oz - d / 2 + MEZZ_D - 0.2, minY: y0 + MEZZ_Y, maxY: y0 + MEZZ_Y + 1.2 });
      add([box(0.8, 1.1, 7, -w / 2 + 1.0, 0, 3.2), box(1.0, 0.06, 7.1, -w / 2 + 1.0, 1.1, 3.2)], new THREE.MeshStandardNodeMaterial({ color: 0x1b1b22, roughness: 0.3, metalness: 0.4 }));
      add(box(0.8, 0.05, 7, -w / 2 + 1.0, 1.15, 3.2), new THREE.MeshBasicNodeMaterial({ color: 0x2be0ff }), false); // (its lit edge)
      solid(-w / 2 + 0.55, -w / 2 + 1.45, -0.3, 6.7, 0, 1.2);
      add([box(1.0, 2.2, 0.9, -5.2, 0, -1.6), box(1.0, 2.2, 0.9, 5.9, 0, -1.6)], new THREE.MeshStandardNodeMaterial({ color: 0x0a0a0a, roughness: 0.5 }));
      solid(-5.7, -4.7, -2.05, -1.15);
      solid(5.4, 6.4, -2.05, -1.15);
      signMesh.position.set(0, MEZZ_Y + 2.0, -d / 2 + 0.03);
      // the floor: the hall's, the tapanco's up there, the stairs between
      const backZ = -d / 2 + MEZZ_D;
      floorAt = (x, z, fromY) => {
        const lx = x - ox, lz = z - oz;
        const up = fromY !== undefined && fromY > y0 + MEZZ_Y - 0.7;
        if (lx > w / 2 - 1.6 && lz > backZ - 0.2 && lz < backZ + RUN) {
          const t = 1 - (lz - backZ) / RUN; // (the stairs: up towards the back)
          return y0 + Math.max(0, Math.min(MEZZ_Y, Math.ceil(t * STEPS) * (MEZZ_Y / STEPS)));
        }
        if (lz < backZ && up) return y0 + MEZZ_Y;
        return y0;
      };
      for (let i = 0; i < 22; i++) spots.dancers.push([(hash(i, 1) - 0.5) * 8 + 0.5, (hash(i, 2) - 0.5) * 6 + 1.0, hash(i, 3) * 6.28]);
      for (let i = 0; i < 6; i++) spots.dancers.push([(hash(i, 4) - 0.5) * 10 - 1, -d / 2 + 1.0 + hash(i, 5) * 2.2, 0, MEZZ_Y]);
      for (let i = 0; i < 6; i++) spots.guests.push([-w / 2 + 2.0, 0.4 + i * 1.05, -Math.PI / 2]);
      spots.staff.push([0, -d / 2 + MEZZ_D - 1.4, 0, MEZZ_Y], [-w / 2 + 0.4, 2.2, Math.PI / 2], [-w / 2 + 0.4, 4.6, Math.PI / 2]);
      spots.counter = [-w / 2 + 2.1, 3.4];
      spots.music = [0, MEZZ_Y + 1.5, -d / 2 + MEZZ_D - 0.6];
      // the moving lights: colours sweeping the floor and the crowd
      for (let i = 0; i < 4; i++) light(-4 + i * 3, h - 0.5, 0.5, 0xff2bd6, 60, 14);
      light(0, MEZZ_Y + 2.2, -d / 2 + 1.5, 0x8a5bff, 30, 9);
    }
    // the room's air: a dim fill so its corners aren't black
    light(0, h * 0.6, d / 2 - 1.5, 0xffe8d0, kind === 'disco' ? 4 : 10, Math.max(w, d) * 1.2);
    return { kind, K, group, colliders, floorAt, spots, lights, sign, signMesh, ox, oz, y0, w, d, h };
  }

  // The door of an open venue the player on foot is at (within DOOR_REACH of it), or null
  doorAt(x, z, hour) {
    let best = null, bd = DOOR_REACH;
    const ix = Math.floor(x / 50), iz = Math.floor(z / 50);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const v of this.cells.get((ix + a) * 100003 + iz + b) || []) {
          const d = Math.hypot(v.x - x, v.z - z);
          if (d < bd && isOpen(v.kind, hour)) { bd = d; best = v; }
        }
      }
    }
    return best;
  }

  get active() {
    return !!this.inside;
  }

  // In through the venue's door: the room of its kind, its name over the counter, the player just inside the door
  enter(venue) {
    const room = this.rooms[ROOM_OF[venue.kind]];
    const c = this.controllers;
    this.inside = { room, venue };
    for (const l of room.lights) l.visible = true;
    const { g, canvas, tex } = room.sign;
    g.fillStyle = room.kind === 'disco' ? '#0b0b10' : '#1d1b19';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = room.kind === 'disco' ? '#ff4fe0' : '#f6e7b0';
    g.font = 'bold 54px sans-serif';
    g.fillText(venue.name.toUpperCase().slice(0, 18), canvas.width / 2, canvas.height / 2);
    tex.needsUpdate = true;
    c.setInterior({
      minX: room.ox - room.w / 2 - 1, maxX: room.ox + room.w / 2 + 1, minZ: room.oz - room.d / 2 - 1, maxZ: room.oz + room.d / 2 + 1.5,
      floorAt: room.floorAt, colliders: room.colliders
    });
    // (just inside the door, wherever the teleport's search for a clear spot would rather put it)
    c.teleportActiveTo(room.ox, room.oz + room.d / 2 - 1.2, Math.PI);
    c.entities.person.position.set(room.ox, room.y0, room.oz + room.d / 2 - 1.2);
    c.settle(c.entities.person);
    this.cameras.setInterior({ minX: room.ox - room.w / 2 + 0.35, maxX: room.ox + room.w / 2 - 0.35, minZ: room.oz - room.d / 2 + 0.35, maxZ: room.oz + room.d / 2 - 0.35, maxY: room.y0 + room.h - 0.3 });
    this.cameras.resetForTeleport();
    this.crime.toast(venue.tapanco ? `${venue.name}: sube al tapanco por la escalera` : venue.name);
  }

  // Back out to the street, at the door, facing away from it
  leave() {
    const v = this.inside.venue;
    const c = this.controllers;
    for (const l of this.inside.room.lights) l.visible = false;
    this.inside = null;
    c.setInterior(null);
    this.cameras.setInterior(null);
    c.teleportActiveTo(v.x + v.nx * 1.2, v.z + v.nz * 1.2, v.heading);
    this.cameras.resetForTeleport();
  }

  /**
   * The frame: which door is at hand outside, or inside the room's people, lights & music, the counter at hand.
   * `hour` local
   */
  update(dt, hour) {
    this.time += dt;
    this.uTime.value = this.time;
    const c = this.controllers;
    const p = c.entities.person.position;
    this.doorNear = null;
    this.counterNear = false;
    this.exitNear = false;
    const ppl = this.people;
    ppl.begin();
    if (this.inside) {
      const { room } = this.inside;
      const s = room.spots;
      this.exitNear = Math.hypot(p.x - room.ox, p.z - (room.oz + room.d / 2 - 0.4)) < DOOR_REACH;
      this.counterNear = !!s.counter && Math.hypot(p.x - (room.ox + s.counter[0]), p.z - (room.oz + s.counter[1])) < 1.6 && p.y < room.y0 + 1;
      const seed = Math.floor(hash(this.inside.venue.x, this.inside.venue.z) * 1e4);
      const put = (list, tag, opts) => list.forEach(([x, z, yaw], i) => ppl.place(`${tag}${seed}_${i}`, room.ox + x, room.oz + z, yaw, 6, { seed: seed + i * 7 + tag.length, ...opts }));
      put(s.staff, 's', { sway: 1 });
      put(s.guests, 'g', { sway: 1 });
      put(s.dancers, 'd', { dance: 1 });
      // the antro's lights sweep to the beat
      if (room.kind === 'disco') {
        room.lights.forEach((l, i) => {
          if (i > 3) return;
          const a = this.time * 1.3 + i * 1.7;
          l.position.set(Math.sin(a) * 5, room.h - 0.5, Math.cos(a * 0.8) * 4 + 1);
          l.color.setHSL((this.time * 0.15 + i * 0.25) % 1, 1, 0.55);
          l.intensity = (40 + 30 * Math.max(0, Math.cos(this.time * Math.PI * 2 * (92 / 60)))) * room.K.light;
        });
      }
    } else if (c.activeMode === 'person') {
      this.doorNear = this.doorAt(p.x, p.z, hour);
    }
    ppl.end(dt);
  }

  // What F would do here (main.js updatePrompt)
  prompt() {
    if (this.inside) {
      if (this.exitNear) return 'Salir a la calle';
      if (this.counterNear) {
        const K = this.inside.room.K;
        return `Pedir ${K.item} ($${K.price})`;
      }
      return '';
    }
    return this.doorNear ? `Entrar a ${this.doorNear.name}` : '';
  }

  // F: in or out of the door, or an order at the counter; true if it did something
  act() {
    if (this.inside) {
      if (this.exitNear) {
        this.leave();
        return true;
      }
      if (this.counterNear) {
        const K = this.inside.room.K;
        const crime = this.crime;
        if (crime.money < K.price) crime.toast('No te alcanza');
        else {
          crime.money -= K.price;
          crime.health = Math.min(100, crime.health + K.heal);
          crime.toast(`¡Salud! ${K.item}, +${K.heal} de salud`);
        }
        return true;
      }
      return false;
    }
    if (this.doorNear && this.crime.state === 'play') {
      this.enter(this.doorNear);
      return true;
    }
    return false;
  }

  // The room's music & talk, for the audio's loops (inside it, nothing of the street's carries)
  sounds(out) {
    if (!this.inside) return out;
    const { room, venue } = this.inside;
    const [x, y, z] = room.spots.music;
    const music = room.kind === 'restaurant' ? 'cumbia' : room.kind === 'bar' ? (hash(venue.x, venue.z) < 0.5 ? 'banda' : 'cumbia') : 'reggaeton';
    out.push({ kind: music, id: room, x: room.ox + x, y: room.y0 + y, z: room.oz + z, gain: room.kind === 'disco' ? 1 : 0.45, range: 60, seed: 3 });
    out.push({ kind: 'crowd', id: room.spots, x: room.ox, y: room.y0 + 1.6, z: room.oz, gain: room.kind === 'restaurant' ? 0.5 : 0.35, range: 40, seed: 4 });
    return out;
  }
}

export { Interiors, KINDS as INTERIOR_KINDS, POCKET };
