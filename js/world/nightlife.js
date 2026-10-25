import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isOpen } from './venues.js';
import { Bystanders } from '../sim/bystanders.js';
import { OUTFIT_SEED } from '../sim/pedestrians.js';

// js/world/nightlife.js
// Tepic at night: the cantinas and bars open from the afternoon, the antros from ten (the Tapanko on the Libramiento,
// Queens Disco...), their neon over the door pulsing with the music, a line at the door past the bouncer, people
// smoking outside; and in the colonias, on Friday and Saturday nights (now and then any night), a house party under a
// lona across the street, string lights, plastic chairs, the speakers out, people dancing and cohetes going up.
// The places come from the city's real shop signs (venues.js); the parties from its houses. The music plays through
// the audio's loop pool (audio-ambience.js): reggaetón in the antros, cumbia or banda in the bars and at the parties.

const DRAW_DISTANCE = 280;
const PEOPLE_DISTANCE = 120;
const MAX_CLUBS = 16;
const MAX_PARTIES = 6;
const MAX_LIGHTS = 8;
const MAX_ROCKETS = 8;
const PARTY_SHARE = 1 / 120; // of the colonias' houses that throw a party on a Friday or Saturday night

const hash = (x, z, k = 0) => {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};
const NEON = [0xff2bd6, 0x2be0ff, 0x8a5bff, 0xff3b3b, 0x3bff8a, 0xffb02b];

class Nightlife {
  /**
   * @param {object} o - scene; venues (venues.js findVenues); houses & stride (city-geodata.js, for the parties);
   *   controllers (the ground: player/controllers.js); audio (the cohetes' bangs: audio-system.js)
   */
  constructor({ scene, venues, houses = [], stride = 8, controllers, audio = null }) {
    this.controllers = controllers;
    this.audio = audio;
    this.ground = (x, z) => controllers.getGroundHeight(x, z, 'person');
    this.clubs = venues.filter((v) => v.kind === 'bar' || v.kind === 'disco').map((v) => ({
      ...v, kindOf: 'club', seed: Math.floor(hash(v.x, v.z, 1) * 1e6),
      music: v.kind === 'disco' ? 'reggaeton' : hash(v.x, v.z, 2) < 0.5 ? 'cumbia' : 'banda',
      neon: NEON[Math.floor(hash(v.x, v.z, 3) * NEON.length)], bpm: v.kind === 'disco' ? 92 : 100
    }));
    // the parties: houses of the colonias (not shops, halls or plazas), their street front long enough for a lona
    this.parties = [];
    for (let i = 0; i + 7 < houses.length; i += stride) {
      const bits = houses[i + 6];
      if (bits & (4 | 8 | 16)) continue;
      const x = houses[i] / 10, z = houses[i + 1] / 10;
      if (hash(x, z, 4) >= PARTY_SHARE * 4) continue; // (a quarter of these on any one weekend night)
      const th = houses[i + 4] / 1000, w = houses[i + 2] / 10, d = houses[i + 3] / 10, front = bits & 3;
      const ou = front === 0 ? -1 : front === 1 ? 1 : 0, ov = front === 2 ? -1 : front === 3 ? 1 : 0;
      const cs = Math.cos(th), sn = Math.sin(th);
      const nx = ou * cs + ov * sn, nz = -ou * sn + ov * cs;
      const half = ou ? w / 2 : d / 2;
      this.parties.push({
        kindOf: 'party', x: x + nx * (half + 4.5), z: z + nz * (half + 4.5), nx, nz, heading: Math.atan2(nx, nz),
        seed: Math.floor(hash(x, z, 5) * 1e6), night: hash(x, z, 6), music: hash(x, z, 7) < 0.55 ? 'banda' : 'cumbia', bpm: 125
      });
    }
    this.cells = new Map();
    for (const list of [this.clubs, this.parties]) {
      for (const p of list) {
        const k = Math.floor(p.x / 100) * 100003 + Math.floor(p.z / 100);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(p);
      }
    }

    this.group = new THREE.Group();
    this.group.name = 'Nightlife';
    scene.add(this.group);
    this.buildMeshes();
    this.lights = Array.from({ length: MAX_LIGHTS }, () => {
      const l = new THREE.PointLight(0xffffff, 0, 16, 1.5);
      l.position.y = -1000;
      l.visible = false;
      this.group.add(l);
      return l;
    });
    this.people = new Bystanders(scene, 140, this.ground);
    // the hand-placed places (venues.js NAMED_VENUES: the Tapanko) have no sign of theirs in the city data: a lit one
    // over the door with their name
    for (const c of this.clubs) {
      if (!c.tapanco) continue;
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 128;
      const g = canvas.getContext('2d');
      g.fillStyle = '#0b0910';
      g.fillRect(0, 0, 512, 128);
      g.strokeStyle = '#ff4fe0';
      g.lineWidth = 6;
      g.strokeRect(6, 6, 500, 116);
      g.fillStyle = '#ff7ff0';
      g.font = 'bold 72px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(c.name.toUpperCase(), 256, 66);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicNodeMaterial({ map: tex }));
      sign.position.set(c.x - c.nx * 0.45, this.ground(c.x, c.z) + 3.6, c.z - c.nz * 0.45);
      sign.rotation.y = c.heading;
      this.group.add(sign);
    }
    this.rockets = Array.from({ length: MAX_ROCKETS }, () => ({ t: -1, x: 0, y: 0, z: 0, vy: 0 }));
    this.near = [];
    this.time = 0;
    this.hour = 12;
    this.weekday = 5;
  }

  buildMeshes() {
    const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
    const cyl = (r, h, x, y, z) => new THREE.CylinderGeometry(r, r, h, 6).translate(x, y, z).toNonIndexed();
    // (local frame: +z out of the door towards the street)
    const neonGeo = box(2.6, 0.12, 0.08, 0, 3.0, 0.15);
    // a party's lona over the street: an 8 x 7 m tarp on six poles, the bulbs strung along its edges
    const lonaGeo = new THREE.BoxGeometry(8, 0.04, 7).translate(0, 3.4, 0);
    const polesGeo = mergeGeometries([-4, 0, 4].flatMap((x) => [cyl(0.05, 3.4, x, 1.7, -3.5), cyl(0.05, 3.4, x, 1.7, 3.5)]));
    const bulbs = [];
    for (let i = 0; i <= 16; i++) for (const z of [-3.4, 3.4]) bulbs.push(new THREE.SphereGeometry(0.06, 6, 4).translate(-4 + i * 0.5, 3.3 - Math.sin((i / 16) * Math.PI) * 0.25, z).toNonIndexed());
    const bulbsGeo = mergeGeometries(bulbs);
    // plastic chairs in rows along the house side, the speakers by the door, a table with the drinks
    const chairs = [];
    for (let i = 0; i < 8; i++) {
      const x = -3.5 + i;
      chairs.push(box(0.42, 0.04, 0.42, x, 0.45, -2.6), box(0.42, 0.45, 0.04, x, 0.7, -2.82), box(0.04, 0.45, 0.04, x - 0.18, 0.22, -2.42), box(0.04, 0.45, 0.04, x + 0.18, 0.22, -2.42));
    }
    const chairsGeo = mergeGeometries(chairs);
    const gearGeo = mergeGeometries([box(0.55, 1.1, 0.45, -3.6, 0.55, 2.8), box(0.55, 1.1, 0.45, 3.6, 0.55, 2.8), box(1.6, 0.05, 0.7, 0, 0.75, 2.8),
      cyl(0.03, 0.75, -0.7, 0.37, 2.8), cyl(0.03, 0.75, 0.7, 0.37, 2.8)]);
    const inst = (geo, mat, max, colored = false) => {
      const m = new THREE.InstancedMesh(geo, mat, max);
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
      if (colored) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
      this.group.add(m);
      return m;
    };
    const lit = new THREE.MeshBasicNodeMaterial();
    this.meshes = {
      neon: inst(neonGeo, lit, MAX_CLUBS, true),
      lona: inst(lonaGeo, new THREE.MeshStandardNodeMaterial({ roughness: 0.8, side: THREE.DoubleSide }), MAX_PARTIES, true),
      poles: inst(polesGeo, new THREE.MeshStandardNodeMaterial({ color: 0x9a9a96, roughness: 0.4, metalness: 0.7 }), MAX_PARTIES),
      bulbs: inst(bulbsGeo, new THREE.MeshBasicNodeMaterial({ color: 0xffe2a8 }), MAX_PARTIES),
      chairs: inst(chairsGeo, new THREE.MeshStandardNodeMaterial({ color: 0xf2f2ee, roughness: 0.5 }), MAX_PARTIES, true),
      gear: inst(gearGeo, new THREE.MeshStandardNodeMaterial({ color: 0x18181a, roughness: 0.6 }), MAX_PARTIES)
    };
    this.meshes.lona.castShadow = true;
    const rocketMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd27a });
    this.rocketMesh = inst(new THREE.SphereGeometry(0.12, 6, 4), rocketMat, MAX_ROCKETS);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  // Is a party on tonight? Friday & Saturday nights (and the small hours after), now and then a weekday
  partyOn(p) {
    const h = this.hour;
    if (!(h >= 20.5 || h < 3.5)) return false;
    const day = h < 12 ? (this.weekday + 6) % 7 : this.weekday; // (after midnight it is still last night's party)
    const weekend = day === 5 || day === 6;
    return p.night < (weekend ? 0.25 : 0.03);
  }

  /**
   * The frame: the clubs open & parties on round the camera with their lights, people & rockets. `hour` local,
   * `weekday` 0 Sunday .. 6 Saturday
   */
  update(dt, hour, weekday, camera) {
    this.time += dt;
    this.hour = hour;
    this.weekday = weekday;
    const cx = camera.position.x, cz = camera.position.z;
    const near = this.near;
    near.length = 0;
    const r = Math.ceil(DRAW_DISTANCE / 100);
    const ix0 = Math.floor(cx / 100), iz0 = Math.floor(cz / 100);
    for (let ix = ix0 - r; ix <= ix0 + r; ix++) {
      for (let iz = iz0 - r; iz <= iz0 + r; iz++) {
        for (const p of this.cells.get(ix * 100003 + iz) || []) {
          const d = Math.hypot(p.x - cx, p.z - cz);
          if (d > DRAW_DISTANCE) continue;
          if (p.kindOf === 'club' ? !isOpen(p.kind, hour) : !this.partyOn(p)) continue;
          p.distance = d;
          near.push(p);
        }
      }
    }
    near.sort((a, b) => a.distance - b.distance);

    const M = this.meshes;
    let clubs = 0, parties = 0;
    for (const p of near) {
      p.y = this.ground(p.x, p.z);
      this._q.setFromAxisAngle(this._up, p.heading);
      this._m.compose(this._p.set(p.x, p.y, p.z), this._q, this._s);
      const beat = 0.5 + 0.5 * Math.cos(this.time * Math.PI * 2 * (p.bpm / 60));
      if (p.kindOf === 'club' && clubs < MAX_CLUBS) {
        // the neon over the door, pulsing with the beat
        this._p.set(p.x - p.nx * 0.55, p.y, p.z - p.nz * 0.55);
        this._m.compose(this._p, this._q, this._s);
        M.neon.setMatrixAt(clubs, this._m);
        M.neon.setColorAt(clubs, this._c.setHex(p.neon).multiplyScalar(1.4 + beat * 1.6));
        clubs++;
      } else if (p.kindOf === 'party' && parties < MAX_PARTIES) {
        for (const k of ['lona', 'poles', 'bulbs', 'chairs', 'gear']) M[k].setMatrixAt(parties, this._m);
        M.lona.setColorAt(parties, this._c.setHex([0xf1efe6, 0x2a62b8, 0xd8322a, 0xe8c228][p.seed % 4]));
        M.chairs.setColorAt(parties, this._c.setHex(p.seed % 3 ? 0xf2f2ee : 0xc62a2a));
        parties++;
      }
    }
    M.neon.count = clubs;
    for (const k of ['lona', 'poles', 'bulbs', 'chairs', 'gear']) M[k].count = parties;
    for (const m of Object.values(M)) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // light: the clubs' doors in their neon's colour to the beat, the parties' lonas warm
    this.lights.forEach((light, i) => {
      const p = near[i];
      light.visible = !!p; // (an unlit light is hidden: the clustered lighting takes 256 lights at most)
      if (!p) return;
      const beat = 0.5 + 0.5 * Math.cos(this.time * Math.PI * 2 * (p.bpm / 60));
      if (p.kindOf === 'club') {
        light.color.setHex(p.kind === 'disco' ? NEON[Math.floor(this.time * (p.bpm / 60)) % NEON.length] : p.neon);
        light.position.set(p.x + p.nx * 0.8, p.y + 2.6, p.z + p.nz * 0.8);
        light.intensity = (p.kind === 'disco' ? 40 : 18) * (0.55 + 0.45 * beat);
      } else {
        light.color.setHex(0xffc988);
        light.position.set(p.x, p.y + 3.1, p.z);
        light.intensity = 30;
      }
    });

    // the people: a line at an antro's door past its bouncer, smokers outside a bar, dancers under a lona
    const ppl = this.people;
    ppl.begin();
    for (const p of near) {
      if (p.distance > PEOPLE_DISTANCE) break;
      const ax = p.nz, az = -p.nx; // along the front
      if (p.kindOf === 'club') {
        const disco = p.kind === 'disco';
        ppl.place(`${p.seed}b`, p.x + ax * 1.2 + p.nx * 0.3, p.z + az * 1.2 + p.nz * 0.3, p.heading, p.distance,
          { seed: 5 * OUTFIT_SEED + (p.seed % 997) + 0.5, scale: 1.08, female: false }); // (the bouncer, in black)
        const n = disco ? 6 + (p.seed % 9) : 2 + (p.seed % 4);
        for (let k = 0; k < n; k++) {
          const along = disco ? 2.2 + k * 0.75 : (k - n / 2) * 1.2 + 3;
          const out = disco ? 0.6 + (k % 2) * 0.35 : 1.2 + hash(p.seed, k, 1) * 1.2;
          const face = disco ? Math.atan2(-ax, -az) : p.heading + Math.PI * (hash(p.seed, k, 2) < 0.5 ? 1 : 0.5);
          ppl.place(`${p.seed}q${k}`, p.x + ax * along + p.nx * out, p.z + az * along + p.nz * out, face, p.distance, { seed: p.seed + k + 1, sway: 1 });
        }
      } else {
        const n = 8 + (p.seed % 8);
        for (let k = 0; k < n; k++) {
          const u = (hash(p.seed, k, 3) - 0.5) * 6.5, v = (hash(p.seed, k, 4) - 0.5) * 4;
          const x = p.x + ax * u + p.nx * v, z = p.z + az * u + p.nz * v;
          const face = hash(p.seed, k, 5) * Math.PI * 2;
          ppl.place(`${p.seed}d${k}`, x, z, face, p.distance, { seed: p.seed + k + 1, dance: k % 4 === 0 ? 0.3 : 1 });
        }
      }
    }
    ppl.end(dt);

    // cohetes: now and then from a party, a rocket whistling up and a bang a second later
    for (const p of near) {
      if (p.kindOf !== 'party' || p.distance > 400 || Math.random() > dt / 25) continue;
      const rk = this.rockets.find((q) => q.t < 0);
      if (rk) Object.assign(rk, { t: 0, x: p.x + (Math.random() - 0.5) * 4, y: p.y + 1, z: p.z + (Math.random() - 0.5) * 4, vy: 34 });
    }
    let n = 0;
    for (const rk of this.rockets) {
      if (rk.t < 0) continue;
      rk.t += dt;
      rk.y += rk.vy * dt;
      rk.vy -= 9.8 * dt;
      if (rk.t > 1.4) {
        rk.t = -1;
        this.audio?.gunfire?.('pistol', rk.x, rk.y, rk.z); // (a cohete's crack: a shot's sound, high up)
        continue;
      }
      this._m.makeTranslation(rk.x, rk.y, rk.z);
      this.rocketMesh.setMatrixAt(n++, this._m);
    }
    this.rocketMesh.count = n;
    this.rocketMesh.instanceMatrix.needsUpdate = true;
  }

  // The music & the crowds' talk for the audio's loops: a club's from inside its door (its walls muffle it outside)
  sounds(out) {
    for (const p of this.near) {
      if (p.distance > 200) break;
      if (p.kindOf === 'club') {
        out.push({ kind: p.music, id: p, x: p.x - p.nx * 3, y: p.y + 1.5, z: p.z - p.nz * 3, gain: p.kind === 'disco' ? 1 : 0.6, range: 160, seed: p.seed });
      } else {
        out.push({ kind: p.music, id: p, x: p.x, y: p.y + 1.5, z: p.z, gain: 1, range: 200, seed: p.seed });
        out.push({ kind: 'crowd', id: p.seed, x: p.x, y: p.y + 1.6, z: p.z, gain: 0.5, range: 35, seed: p.seed });
      }
    }
    return out;
  }
}

export { Nightlife };
