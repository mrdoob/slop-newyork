import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Bystanders } from './bystanders.js';
import { OUTFIT, OUTFIT_SEED } from './pedestrians.js';
import { getLocationLabel } from '../world/city-config.js';

// js/sim/fires.js
// Fires: a car burning after a blast, a house on fire now and then somewhere near, and in the dry season (March to
// May, the grass straw-yellow) the quemas on the hills round the valley sending up their smoke. Flames & smoke in the
// gunfire effects' particle pools (gunfire-fx.js), a flickering light, heat that hurts whoever stands in it. The
// bomberos come for the cars & houses: their red truck drives in along the streets (crime.js route, the patrol cars'
// road graph), parks, and three firefighters in their turnout gear hose the fire down.

const MAX_FIRES = 6;
const MAX_LIGHTS = 3;
const HOUSE_EVERY = [420, 840]; // s between house fires near the player
const GRASS_EVERY = [150, 300]; // s between the dry season's quemas
const TRUCK_SPEED = 13; // m/s
const TRUCK_DELAY = [18, 32]; // s the bomberos take to arrive

const rnd = (a, b) => a + Math.random() * (b - a);

class Fires {
  /**
   * @param {object} o - scene; crime (sim/crime.js: its effects, the player's health, toasts, the road graph);
   *   controllers (the ground, the walls: player/controllers.js); houses & stride (city-geodata.js, for house fires);
   *   audio (CityAudioSystem, optional)
   */
  constructor({ scene, crime, controllers, houses = [], stride = 8 }) {
    this.crime = crime;
    this.fx = crime.fx;
    this.controllers = controllers;
    this.houses = houses;
    this.stride = stride;
    this.fires = [];
    this.timers = { house: rnd(...HOUSE_EVERY) * 0.5, grass: rnd(...GRASS_EVERY) * 0.3 };
    this.dryness = 0;
    this.lights = Array.from({ length: MAX_LIGHTS }, () => {
      const l = new THREE.PointLight(0xff7a2a, 0, 26, 1.4);
      l.position.y = -1000;
      l.visible = false;
      scene.add(l);
      return l;
    });
    this.buildTruck(scene);
    this.people = new Bystanders(scene, 9, (x, z) => controllers.getGroundHeight(x, z, 'person'));
    this.time = 0;
  }

  // The bomberos' truck: a red cab & body, its ladder on top, the hose reel, a light bar
  buildTruck(scene) {
    const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z).toNonIndexed();
    const red = new THREE.MeshStandardNodeMaterial({ color: 0xb3121b, roughness: 0.35, metalness: 0.3 });
    const chrome = new THREE.MeshStandardNodeMaterial({ color: 0xc9cccf, roughness: 0.25, metalness: 0.9 });
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x151515, roughness: 0.7 });
    this.barMat = new THREE.MeshBasicNodeMaterial({ color: 0xff2020 });
    const root = new THREE.Group();
    root.name = 'FireTruck';
    const add = (geos, mat) => {
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      m.castShadow = true;
      root.add(m);
    };
    add([box(2.5, 2.2, 2.4, 0, 0.6, 3.1), box(2.5, 2.1, 6.0, 0, 0.6, -1.2)], red);
    add([box(0.5, 0.2, 7.2, -0.5, 2.7, -0.8), box(0.5, 0.2, 7.2, 0.5, 2.7, -0.8), box(2.52, 0.12, 8.4, 0, 0.55, 0.3)], chrome);
    add([box(2.3, 0.9, 0.05, 0, 1.7, 4.31)], new THREE.MeshStandardNodeMaterial({ color: 0x1c2a33, roughness: 0.1, metalness: 0.4 })); // windscreen
    const wheels = [];
    for (const z of [3.0, -0.8, -2.6]) for (const x of [-1.15, 1.15]) wheels.push(new THREE.CylinderGeometry(0.52, 0.52, 0.4, 14).rotateZ(Math.PI / 2).translate(x, 0.52, z).toNonIndexed());
    add(wheels, dark);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.35).translate(0, 2.92, 3.4), this.barMat);
    root.add(bar);
    root.position.y = -1000; // (out of sight until called: its pipelines compile with the rest)
    scene.add(root);
    this.truck = { root, active: false, path: null, i: 0, x: 0, z: 0, heading: 0, parked: false, fire: null, t: 0 };
  }

  // A fire starts: 'car' (a wreck), 'house', 'grass'; `size` m across
  ignite(kind, x, z, size = kind === 'house' ? 9 : kind === 'grass' ? 14 : 4) {
    if (this.fires.length >= MAX_FIRES) return null;
    if (this.fires.some((f) => Math.hypot(f.x - x, f.z - z) < f.size)) return null; // (already burning)
    const fire = {
      kind, x, z, size, heat: 0, life: kind === 'car' ? rnd(70, 110) : kind === 'house' ? rnd(200, 300) : rnd(160, 260),
      t: 0, called: kind === 'grass' ? Infinity : rnd(...TRUCK_DELAY), roof: 0, spread: 0
    };
    fire.y = this.controllers.getGroundHeight(x, z, 'car');
    this.fires.push(fire);
    return fire;
  }

  // A blast (crime.js explode): a burning wreck where it went off, and the house it went off against catches
  onExplosion(x, y, z, radius) {
    if (radius < 4) return;
    this.ignite('car', x, z, 4);
    const c = this.controllers;
    for (let a = 0; a < 8; a++) {
      const hx = x + Math.cos(a * 0.785) * 4, hz = z + Math.sin(a * 0.785) * 4;
      if (c.isSolidAt(hx, hz, 3, c.getGroundHeight(hx, hz, 'car'))) {
        const f = this.ignite('house', hx, hz);
        if (f) this.crime.toast('¡Se incendió una casa!');
        break;
      }
    }
  }

  // A house somewhere 150-450 m from (x, z) for a fire (a real one of the city data, its roof's height)
  houseNear(x, z) {
    const H = this.houses, S = this.stride;
    for (let tries = 0; tries < 400; tries++) {
      const i = Math.floor(Math.random() * (H.length / S)) * S;
      const hx = H[i] / 10, hz = H[i + 1] / 10;
      const d = Math.hypot(hx - x, hz - z);
      if (d < 150 || d > 450 || H[i + 6] & 8) continue;
      return { x: hx, z: hz, roof: H[i + 5] * 3.0 };
    }
    return null;
  }

  // The bomberos set out: their truck comes in along the streets from ~300 m off and parks by the fire
  callTruck(fire) {
    const t = this.truck;
    if (t.active) return;
    const a = Math.random() * Math.PI * 2;
    const path = this.crime.route(fire.x + Math.cos(a) * 300, fire.z + Math.sin(a) * 300, fire.x, fire.z);
    if (!path || path.length < 2) return;
    // (the road graph ends at the junction nearest the fire: the last stretch is straight to it, stopping short)
    const end = path[path.length - 1];
    const ex = end.x - fire.x, ez = end.z - fire.z, ed = Math.hypot(ex, ez) || 1;
    if (ed > fire.size + 8) path.push({ x: fire.x + (ex / ed) * (fire.size + 7), z: fire.z + (ez / ed) * (fire.size + 7) });
    Object.assign(t, { active: true, path, i: 0, x: path[0].x, z: path[0].z, parked: false, fire, t: 0 });
    fire.truck = t;
  }

  /**
   * The frame: fires start, burn, spread their heat & smoke, die down (faster under the hoses); the truck drives,
   * parks & its crew sprays. `dryness` 0..1 (lot-greenery.js grassDryness: the quemas only in the dry season)
   */
  update(dt, dryness, camera) {
    this.time += dt;
    const crime = this.crime;
    const p = crime.player ? crime.player.position : camera.position;
    // a house on fire now and then; the dry season's quemas on the open country round the town
    this.timers.house -= dt;
    if (this.timers.house <= 0) {
      this.timers.house = rnd(...HOUSE_EVERY);
      const h = this.houseNear(p.x, p.z);
      if (h) {
        const f = this.ignite('house', h.x, h.z);
        if (f) {
          f.roof = h.roof;
          crime.toast(`Incendio: ${getLocationLabel(h.x, h.z)}`);
        }
      }
    }
    if (dryness > 0.6) {
      this.timers.grass -= dt;
      if (this.timers.grass <= 0) {
        this.timers.grass = rnd(...GRASS_EVERY);
        const a = Math.random() * Math.PI * 2, r = rnd(600, 1600);
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        // (out on the open country: no walls there)
        if (!this.controllers.isSolidAt(x, z, 3, this.controllers.getGroundHeight(x, z, 'car'))) this.ignite('grass', x, z);
      }
    }

    const fx = this.fx;
    let lit = 0;
    for (let k = this.fires.length - 1; k >= 0; k--) {
      const f = this.fires[k];
      f.t += dt;
      // it takes hold, burns, dies down; the hoses beat it back
      const hosed = f.truck && f.truck.parked && f.truck.t > 6 ? 1 : 0;
      const target = f.t < f.life ? 1 : 0;
      f.heat += ((target - f.heat) * dt) / (target ? 12 : 25) - hosed * dt * 0.035;
      if (f.kind === 'grass') f.spread = Math.min(f.size * 2.2, f.spread + dt * 0.12);
      if (f.heat <= 0 && f.t > 5) {
        this.fires.splice(k, 1);
        if (f.truck) f.truck.fire = null;
        continue;
      }
      if (f.t > f.called && !f.truck && Math.hypot(f.x - p.x, f.z - p.z) < 700) {
        this.callTruck(f);
        f.called = Infinity;
      }
      const d = Math.hypot(f.x - camera.position.x, f.z - camera.position.z);
      const heat = Math.max(0, f.heat);
      // flames (near) and a column of smoke (seen from afar: black from a house or a car, grey-yellow from the grass)
      if (d < 500) {
        const n = dt * f.size * 7 * heat;
        for (let q = 0; q < n || Math.random() < n - q; q++) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * (f.size * 0.45 + f.spread);
          fx.flame(f.x + Math.cos(a) * r, f.y + f.roof * Math.random() + 0.2, f.z + Math.sin(a) * r, f.size * 0.28);
        }
      }
      if (d < 3000 && Math.random() < dt * (4 + f.size * 0.6) * heat) {
        const dark = f.kind === 'grass' ? 0.35 : 0.7;
        const c = 0.62 - dark * 0.5;
        fx.puff.spawn(f.x + (Math.random() - 0.5) * f.size, f.y + f.roof + 1.5, f.z + (Math.random() - 0.5) * f.size,
          (Math.random() - 0.5) * 1.2, 2.8 + Math.random() * 2, (Math.random() - 0.5) * 1.2, 7 + Math.random() * 5,
          f.size * 0.2, f.size * 0.6, c, c * 0.98, c * (f.kind === 'grass' ? 0.85 : 0.95), -0.5, 0.25);
      }
      // the heat: standing in it hurts
      const pd = Math.hypot(f.x - p.x, f.z - p.z);
      if (pd < f.size * 0.6 + f.spread && heat > 0.3) crime.hurt(dt * 14 * heat, f.x, f.z);
      // the flicker of the nearest fires
      if (lit < MAX_LIGHTS && d < 300) {
        const l = this.lights[lit++];
        l.visible = true;
        l.position.set(f.x, f.y + f.roof + 1.5, f.z);
        l.intensity = 120 * heat * (0.75 + 0.25 * Math.sin(this.time * 17 + k) * Math.sin(this.time * 7.3));
      }
    }
    // (an unlit light is hidden: the clustered lighting takes 256 lights at most)
    for (let i = lit; i < MAX_LIGHTS; i++) this.lights[i].visible = false;
    this.updateTruck(dt);
  }

  // The truck along its path, parked by the fire with its crew hosing it, gone once the fire is out and the player away
  updateTruck(dt) {
    const t = this.truck;
    const ppl = this.people;
    ppl.begin();
    if (t.active) {
      if (!t.parked) {
        const goal = t.path[Math.min(t.i + 1, t.path.length - 1)];
        const dx = goal.x - t.x, dz = goal.z - t.z, d = Math.hypot(dx, dz);
        const step = TRUCK_SPEED * dt;
        const fire = t.fire;
        // it stops short of the fire, at the kerb
        if (!fire || (fire && Math.hypot(fire.x - t.x, fire.z - t.z) < fire.size + 9) || t.i >= t.path.length - 1) t.parked = true;
        else if (d <= step) t.i++;
        else {
          t.x += (dx / d) * step;
          t.z += (dz / d) * step;
          t.heading = Math.atan2(dx, dz);
        }
      } else t.t += dt;
      const g = this.controllers.getGroundHeight(t.x, t.z, 'car');
      t.root.position.set(t.x, g, t.z);
      t.root.rotation.y = t.heading;
      // the light bar flashing red & white
      this.barMat.color.setHex(Math.sin(this.time * 14) > 0 ? 0xff1a1a : 0xfff4f4);
      // the crew: three bomberos between the truck and the fire, facing it, the hoses' water arcing onto it
      const f = t.fire;
      if (t.parked && f) {
        const ax = f.x - t.x, az = f.z - t.z, ad = Math.hypot(ax, az) || 1;
        const ux = ax / ad, uz = az / ad;
        for (let k = 0; k < 3; k++) {
          const along = Math.min(ad - f.size * 0.5 - 2, 3 + k * 1.2), side = (k - 1) * 2.2;
          const x = t.x + ux * along - uz * side, z = t.z + uz * along + ux * side;
          ppl.place(`bombero${k}`, x, z, Math.atan2(f.x - x, f.z - z), 20, { seed: OUTFIT.bombero * OUTFIT_SEED + k * 31 + 0.5, female: false });
          if (t.t > 4 && Math.random() < dt * 30) {
            const v = 11 + Math.random() * 2;
            const tx = f.x - x + (Math.random() - 0.5) * f.size * 0.6, tz = f.z - z + (Math.random() - 0.5) * f.size * 0.6;
            const td = Math.hypot(tx, tz) || 1;
            this.fx.puff.spawn(x + (tx / td) * 0.6, g + 1.3, z + (tz / td) * 0.6, (tx / td) * v * 0.8, 5 + Math.random(), (tz / td) * v * 0.8,
              1.1, 0.12, 0.35, 0.86, 0.92, 1.0, 9.8, 0.1);
          }
        }
      }
      // done: the fire out, the truck sits a while, then leaves (once nobody's watching)
      const p = this.crime.player ? this.crime.player.position : t.root.position;
      if (!f && t.parked && (t.t > 60 || Math.hypot(p.x - t.x, p.z - t.z) > 180)) {
        t.active = false;
        t.root.position.y = -1000;
      }
    }
    ppl.end(dt);
  }

  // The fires on the minimap
  blips(out) {
    for (const f of this.fires) out.push('fire', f.x, f.z);
    return out;
  }

  // The crackle & roar of the nearest fires, for the audio's loops
  sounds(out) {
    for (const f of this.fires) if (f.heat > 0.1) out.push({ kind: 'fire', id: f, x: f.x, y: f.y + 1, z: f.z, gain: Math.min(1, f.heat) * (f.kind === 'grass' ? 0.8 : 1), range: 90 });
    return out;
  }
}

export { Fires };
