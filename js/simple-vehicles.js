import * as THREE from 'three/webgpu';
import { BODY_SPECS, buildCarGeometry, buildSteerableWheelGeo, createLoftedCarMaterial } from './actor-models.js';
import { createWalker, createCyclist } from './player-actors.js';

// js/simple-vehicles.js
// The player for footprint cities (GEO.buildings + GEO.infill + GEO.roadGraph + GEO.paths): on foot, on a bicycle, in a
// car or in a plane, with a chase camera; teleport() moves whichever is active. City-agnostic: buildings, roads and
// sidewalks come in through `geo`; colours and traffic side through `options`.
//
// Controls: W/S or Up/Down forward & back, A/D or Left/Right turn, Shift faster (run / sprint); plane: R/F climb & descend.
// The walker and cyclist stop at building walls; the walker steps up onto raised sidewalks (GEO.paths of kind sidewalk).
// The car stays on the ground and stops at building walls (and wherever options.blocked(x, z, fx, fz, halfLength,
// halfWidth) reports its body would hit something, e.g. other cars or people); the plane can't fly through buildings.

const WALK = { speed: 1.6, run: 5.2, back: 1.0, turn: 2.6, radius: 0.3 };
const BIKE = { len: 1.8, wid: 0.6, accel: 2.6, brake: 6, drag: 0.12, maxSpeed: 6.5, boostSpeed: 10, reverseSpeed: 1, turn: 1.9 }; // YouBike pace
const SIDEWALK_Y = 0.15, STREET_Y = 0.08; // raised sidewalks and asphalt (js/graph-roads.js)
const CAR = { len: 4.5, wid: 1.86, accel: 9, brake: 18, drag: 0.6, maxSpeed: 22, boostSpeed: 38, reverseSpeed: 7, turn: 0.55 };
const PLANE = { minSpeed: 18, cruise: 45, maxSpeed: 90, accel: 14, turnRate: 0.9, climbRate: 22, ceiling: 1500 };
const CELL = 32; // building index cell (m)
const WORLD_LIMIT = 1500; // keep vehicles over the ground plane (m from the origin)

// --- Building index: footprint rings bucketed on a grid, for point-in-footprint queries ---------------------------------
function buildIndex(geo) {
  const cells = new Map();
  const items = [];
  for (const [, outer, , top, base] of [...geo.buildings, ...(geo.infill || [])]) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < outer.length; i += 2) {
      x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i]);
      z0 = Math.min(z0, outer[i + 1]); z1 = Math.max(z1, outer[i + 1]);
    }
    const id = items.push({ ring: outer, top, base, x0, x1, z0, z1 }) - 1;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = `${cx},${cz}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(id);
      }
    }
  }
  const inRing = (x, z, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  // Buildings whose footprint contains (x, z)
  const at = (x, z) => {
    const out = [];
    for (const id of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []) {
      const b = items[id];
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && inRing(x, z, b.ring)) out.push(b);
    }
    return out;
  };
  return {
    // Is the point inside a building volume between heights y0 and y1?
    solid: (x, z, y0, y1) => at(x, z).some((b) => b.base < y1 && b.top > y0)
  };
}

// --- Ground: raised sidewalks (GEO.paths of kind 'sidewalk'), for the walker's feet and the cyclist's wheels -----------
function buildGround(geo) {
  const cells = new Map();
  const sw = (geo.pathKinds || []).indexOf('sidewalk');
  for (const [k, w, elev, pts] of geo.paths || []) {
    if (k !== sw || elev > 0) continue;
    for (let i = 0; i + 2 < pts.length; i += 2) {
      const seg = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3], w / 2];
      const r = w / 2;
      for (let cx = Math.floor((Math.min(seg[0], seg[2]) - r) / CELL); cx <= Math.floor((Math.max(seg[0], seg[2]) + r) / CELL); cx++) {
        for (let cz = Math.floor((Math.min(seg[1], seg[3]) - r) / CELL); cz <= Math.floor((Math.max(seg[1], seg[3]) + r) / CELL); cz++) {
          const key = `${cx},${cz}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(seg);
        }
      }
    }
  }
  const onSidewalk = (x, z) => (cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) || []).some(([x0, z0, x1, z1, r]) => {
    const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
    return Math.hypot(x0 + dx * t - x, z0 + dz * t - z) < r;
  });
  return { onSidewalk, height: (x, z) => (onSidewalk(x, z) ? SIDEWALK_Y : STREET_Y) };
}

// --- Models (built facing -z) -----------------------------------------------------------------------------------------
function std(colour, roughness = 0.6, metalness = 0) {
  return new THREE.MeshStandardNodeMaterial({ color: colour, roughness, metalness });
}
// Lofted sedan (actor-models.js, built facing +z) turned to face -z, with steerable & spinning wheels
function carModel(colour) {
  const spec = BODY_SPECS.sedan;
  const material = createLoftedCarMaterial(spec, colour);
  const g = new THREE.Group();
  const body = new THREE.Group();
  body.rotation.y = Math.PI;
  g.add(body);
  body.add(new THREE.Mesh(buildCarGeometry(spec, false), material));
  const wheels = [];
  for (const side of [-1, 1]) {
    const geo = buildSteerableWheelGeo(spec, side);
    for (const z of [spec.wheelZ, -spec.wheelZ]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * spec.wheelX, spec.wheelRadius, z);
      const w = new THREE.Mesh(geo, material);
      pivot.add(w);
      body.add(pivot);
      wheels.push({ pivot, w, front: z > 0 });
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, wheels, state: material.userData.carState || null, wheelRadius: spec.wheelRadius };
}
function planeModel(colour) {
  const g = new THREE.Group();
  const body = std(colour, 0.4, 0.2);
  const dark = std(0x2a3036, 0.5);
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.45, 9, 14).rotateX(Math.PI / 2), body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 14).rotateX(-Math.PI / 2), body);
  nose.position.z = -5.3;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(12, 0.15, 1.8), body);
  wing.position.set(0, -0.1, -0.8);
  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(4, 0.12, 1.1), body);
  tailWing.position.set(0, 0.1, 4);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 1.3), body);
  fin.position.set(0, 0.9, 4);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.8, 2), dark);
  canopy.position.set(0, 0.45, -2);
  const prop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 0.06), dark);
  prop.position.z = -6.15;
  g.add(fuselage, nose, wing, tailWing, fin, canopy, prop);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, prop };
}

// Spawn on the widest road link nearest `near`, in the travel lane for the traffic side
// (widthBias: how strongly wider roads win over nearer ones; minLength: shortest straight stretch, m)
function roadSpawn(geo, near, driveOnRight, { widthBias = 5, minLength = 25 } = {}) {
  const RG = geo.roadGraph;
  if (!RG || !RG.links.length) return { x: near.x, z: near.z, heading: 0 };
  const P = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
  let best = null, bestScore = Infinity;
  for (const [a, b, , w, , dir, inner] of RG.links) {
    const pts = [P(a)];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push(P(b));
    if (dir === -1) pts.reverse();
    // longest segment of the link
    let s = 0, sl = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (l > sl) { sl = l; s = i; }
    }
    if (sl < minLength || w < 6) continue;
    const mx = (pts[s][0] + pts[s + 1][0]) / 2, mz = (pts[s][1] + pts[s + 1][1]) / 2;
    const score = Math.hypot(mx - near.x, mz - near.z) - w * widthBias;
    if (score < bestScore) {
      bestScore = score;
      const dx = (pts[s + 1][0] - pts[s][0]) / sl, dz = (pts[s + 1][1] - pts[s][1]) / sl;
      const lane = dir === 0 ? (w / 4) * (driveOnRight ? 1 : -1) : 0;
      best = { x: mx - dz * lane, z: mz + dx * lane, heading: Math.atan2(-dx, -dz) };
    }
  }
  return best || { x: near.x, z: near.z, heading: 0 };
}

const GROUND_MODES = new Set(['walk', 'bike', 'car']);

class SimpleVehicles {
  constructor(scene, geo, options = {}) {
    this.geo = geo;
    this.index = buildIndex(geo);
    this.ground = buildGround(geo);
    this.keys = new Set();
    // Touch input (js/touch-controls.js calls setTouchInput / clearTouchInput): stick axes 0..1, held buttons 0 / 1
    this.touch = { forward: 0, backward: 0, left: 0, right: 0, boost: 0, up: 0, down: 0 };
    this.mode = 'orbit';
    this.driveOnRight = options.driveOnRight ?? true;
    const car = carModel(options.carColour ?? 0xd8322a);
    const plane = planeModel(options.planeColour ?? 0xe8e8e4);
    this.car = { ...car, x: 0, z: 0, heading: 0, speed: 0, steer: 0, spin: 0, braking: false };
    this.blocked = options.blocked || null;
    this.plane = { ...plane, x: 0, y: 150, z: 0, heading: 0, speed: PLANE.cruise, bank: 0, pitch: 0 };
    const spawn = roadSpawn(geo, options.spawnNear ?? { x: 0, z: 0 }, this.driveOnRight);
    Object.assign(this.car, spawn);
    const p = options.planeSpawn ?? { x: 0, y: 180, z: 900, heading: 0 };
    Object.assign(this.plane, p);
    car.group.visible = plane.group.visible = false;
    scene.add(car.group, plane.group);
    // On foot and on a bicycle: they start beside the car, on the nearest clear spot
    this.walkerModel = createWalker(scene);
    this.cyclistModel = createCyclist(scene, { frameColour: options.bikeColour });
    this.walkerModel.visible = this.cyclistModel.visible = false;
    const [wx, wz] = this._clearSpot(spawn.x, spawn.z, WALK.radius);
    this.walker = { x: wx, z: wz, heading: spawn.heading, speed: 0 };
    this.bike = { x: spawn.x, z: spawn.z, heading: spawn.heading, speed: 0, lean: 0, pedalling: false };
    this._sync();
    this._fwd = new THREE.Vector3();
    this._camGoal = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._groundFn = (owner, x, z) => this.ground.height(x, z);
    const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    window.addEventListener('keydown', (e) => {
      if (!DRIVE_KEYS.has(e.code)) return;
      this.keys.add(e.code);
      if (this.mode !== 'orbit' && e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // The active player's ground position & heading ('orbit': null)
  get active() {
    return { walk: this.walker, bike: this.bike, car: this.car, plane: this.plane }[this.mode] || null;
  }

  setMode(mode, camera) {
    const from = this.active;
    // Getting out of / onto something: on foot or on the bicycle, start where the last ground mode was
    if ((mode === 'walk' || mode === 'bike') && from && GROUND_MODES.has(this.mode) && this.mode !== mode) {
      const [x, z] = this._clearSpot(from.x, from.z, mode === 'bike' ? 0.6 : WALK.radius);
      Object.assign(mode === 'walk' ? this.walker : this.bike, { x, z, heading: from.heading, speed: 0 });
    }
    this.mode = mode;
    this.car.group.visible = mode === 'car';
    this.plane.group.visible = mode === 'plane';
    this.walkerModel.visible = mode === 'walk';
    this.cyclistModel.visible = mode === 'bike';
    if (mode === 'walk') this.walkerModel.pose(1, this.walker.x, this.walker.z, this.walker.heading, this._groundFn);
    if (mode !== 'orbit' && camera) this._follow(camera, 1, true);
  }

  // Move the active player to (x, z): the car to the nearest road, the walker & cyclist to the nearest clear spot, the
  // plane over the point at its altitude. Returns the new position, or null in orbit mode.
  teleport(x, z, camera) {
    if (this.mode === 'car') {
      Object.assign(this.car, roadSpawn(this.geo, { x, z }, this.driveOnRight, { widthBias: 0.3, minLength: 8 }), { speed: 0 });
    } else if (this.mode === 'walk' || this.mode === 'bike') {
      const [cx, cz] = this._clearSpot(x, z, this.mode === 'bike' ? 0.6 : WALK.radius);
      Object.assign(this.active, { x: cx, z: cz, speed: 0 });
    } else if (this.mode === 'plane') {
      Object.assign(this.plane, { x, z, y: Math.max(this.plane.y, 150) });
    } else return null;
    this._sync();
    if (this.mode === 'walk') this.walkerModel.pose(1, this.walker.x, this.walker.z, this.walker.heading, this._groundFn);
    if (camera) this._follow(camera, 1, true);
    return this.active;
  }

  // Lights for the time of day: 0 (day) .. 1 (night)
  setNight(f) {
    this.cyclistModel.setLight(f * 60);
  }

  get status() {
    const kmh = (v) => Math.round(Math.abs(v) * 3.6);
    if (this.mode === 'walk') return `On foot · ${kmh(this.walker.speed)} km/h`;
    if (this.mode === 'bike') return `Bicycle · ${kmh(this.bike.speed)} km/h`;
    if (this.mode === 'car') return `Car · ${kmh(this.car.speed)} km/h`;
    if (this.mode === 'plane') return `Plane · ${kmh(this.plane.speed)} km/h · ${Math.round(this.plane.y)} m`;
    return '';
  }

  setTouchInput(action, value) {
    if (action in this.touch) this.touch[action] = value;
  }

  clearTouchInput() {
    for (const k of Object.keys(this.touch)) this.touch[k] = 0;
  }

  _axis(pos, neg) {
    return (pos.some((k) => this.keys.has(k)) ? 1 : 0) - (neg.some((k) => this.keys.has(k)) ? 1 : 0);
  }

  update(dt, camera) {
    dt = Math.min(dt, 0.05);
    const t = this.touch, clamp = (v) => Math.max(-1, Math.min(1, v));
    const throttle = clamp(this._axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']) + t.forward - t.backward);
    const steer = clamp(this._axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) + t.left - t.right);
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || t.boost > 0;
    if (this.mode === 'walk') this._walk(dt, throttle, steer, boost);
    else if (this.mode === 'bike') this._ride(dt, throttle, steer, boost);
    else if (this.mode === 'car') this._driveCar(dt, throttle, steer, boost);
    else if (this.mode === 'plane') this._flyPlane(dt, throttle, steer, boost, clamp(this._axis(['KeyR'], ['KeyF']) + t.up - t.down));
    else return;
    this._sync();
    if (this.mode === 'walk') this.walkerModel.pose(dt, this.walker.x, this.walker.z, this.walker.heading, this._groundFn);
    if (this.mode === 'bike') {
      const b = this.bike;
      this.cyclistModel.pose(dt, b.x, this.ground.height(b.x, b.z), b.z, b.heading, b.speed, b.lean, b.pedalling);
    }
    this._follow(camera, dt);
  }

  _walk(dt, throttle, steer, boost) {
    const w = this.walker;
    const target = throttle > 0 ? throttle * (boost ? WALK.run : WALK.speed) : throttle * WALK.back; // touch sticks give part throttle
    w.speed += (target - w.speed) * Math.min(1, dt * 8);
    w.heading += steer * WALK.turn * dt;
    const dx = -Math.sin(w.heading) * w.speed * dt, dz = -Math.cos(w.heading) * w.speed * dt;
    // slide along walls: the full step, else its x or z part alone
    for (const [mx, mz] of [[dx, dz], [dx, 0], [0, dz]]) {
      if (this._personFits(w.x + mx, w.z + mz, WALK.radius)) { w.x += mx; w.z += mz; return; }
    }
  }

  _personFits(x, z, r) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return false;
    for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) if (this.index.solid(x + ox, z + oz, 0.2, 1.7)) return false;
    return true;
  }

  _ride(dt, throttle, steer, boost) {
    const b = this.bike;
    const top = boost ? BIKE.boostSpeed : BIKE.maxSpeed;
    b.pedalling = throttle > 0;
    if (throttle > 0) b.speed += BIKE.accel * dt;
    else if (throttle < 0) b.speed -= (b.speed > 0 ? BIKE.brake : BIKE.accel * 0.5) * dt;
    else b.speed -= Math.sign(b.speed) * Math.min(Math.abs(b.speed), (BIKE.drag + Math.abs(b.speed) * 0.02) * dt);
    b.speed = Math.max(-BIKE.reverseSpeed, Math.min(Math.max(top, b.speed - BIKE.brake * dt), b.speed));
    // steering bites with speed; the rider leans into the turn
    const grip = Math.min(1, Math.abs(b.speed) / 1.5) * Math.sign(b.speed || 1);
    b.heading += steer * BIKE.turn * grip * dt;
    const lean = steer * Math.min(1, Math.abs(b.speed) / 7) * 0.32;
    b.lean += (lean - b.lean) * Math.min(1, dt * 8);
    const nx = b.x - Math.sin(b.heading) * b.speed * dt, nz = b.z - Math.cos(b.heading) * b.speed * dt;
    if (this._bikeFits(nx, nz, b.heading) || !this._bikeFits(b.x, b.z, b.heading)) { b.x = nx; b.z = nz; }
    else b.speed *= -0.2;
  }

  _bikeFits(x, z, h) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return false;
    const s = Math.sin(h), c = Math.cos(h);
    for (const oz of [-BIKE.len / 2, 0, BIKE.len / 2]) {
      for (const ox of [-BIKE.wid / 2, BIKE.wid / 2]) if (this.index.solid(x + ox * c + oz * s, z - ox * s + oz * c, 0.2, 1.7)) return false;
    }
    if (this.blocked && this.blocked(x, z, -s, -c, BIKE.len / 2, BIKE.wid / 2)) return false;
    return true;
  }

  // Nearest spot to (x, z) where a body of radius r fits, sidewalks first, searched in rings out to 80 m
  _clearSpot(x, z, r) {
    let fallback = null;
    for (let d = 0; d <= 80; d += 1.5) {
      const n = d ? Math.max(8, Math.round((2 * Math.PI * d) / 1.5)) : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (!this._personFits(px, pz, r)) continue;
        if (this.ground.onSidewalk(px, pz)) return [px, pz];
        fallback = fallback || [px, pz];
      }
      if (fallback && d >= 6) return fallback; // no sidewalk close by: the nearest clear ground
    }
    return fallback || [x, z];
  }

  _driveCar(dt, throttle, steer, boost) {
    const c = this.car;
    const top = boost ? CAR.boostSpeed : CAR.maxSpeed;
    c.braking = (throttle < 0 && c.speed > 0.2) || (throttle > 0 && c.speed < -0.2);
    if (throttle > 0) c.speed += (c.speed < 0 ? CAR.brake : CAR.accel) * dt;
    else if (throttle < 0) c.speed -= (c.speed > 0 ? CAR.brake : CAR.accel) * dt;
    else c.speed -= Math.sign(c.speed) * Math.min(Math.abs(c.speed), (CAR.drag + Math.abs(c.speed) * 0.05) * dt);
    c.speed = Math.max(-CAR.reverseSpeed, Math.min(top, c.speed));
    c.steer += (steer * CAR.turn - c.steer) * Math.min(1, dt * 6);
    // Turning radius grows with speed: yaw rate ~ speed × steer / wheelbase, softened at high speed
    c.heading += (c.speed * Math.tan(c.steer)) / 2.7 / (1 + Math.abs(c.speed) / 25) * dt;
    const nx = c.x - Math.sin(c.heading) * c.speed * dt;
    const nz = c.z - Math.cos(c.heading) * c.speed * dt;
    // Blocked moves bounce back; if something has already moved into the car (another car turning into it), let it
    // drive free rather than lock both in place
    if (this._carFits(nx, nz, c.heading) || !this._carFits(c.x, c.z, c.heading)) { c.x = nx; c.z = nz; }
    else c.speed *= -0.25; // bump off the wall
    c.spin += (c.speed * dt) / c.wheelRadius;
  }

  _carFits(x, z, h) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return false;
    const s = Math.sin(h), c = Math.cos(h);
    for (const [ox, oz] of [[-CAR.wid / 2, -CAR.len / 2], [CAR.wid / 2, -CAR.len / 2], [-CAR.wid / 2, CAR.len / 2], [CAR.wid / 2, CAR.len / 2], [0, -CAR.len / 2]]) {
      const px = x + ox * c + oz * s, pz = z - ox * s + oz * c;
      if (this.index.solid(px, pz, 0.2, 1.6)) return false;
    }
    if (this.blocked && this.blocked(x, z, -s, -c, CAR.len / 2, CAR.wid / 2)) return false;
    return true;
  }

  _flyPlane(dt, throttle, steer, boost, climb) {
    const p = this.plane;
    const top = boost ? PLANE.maxSpeed * 1.4 : PLANE.maxSpeed;
    p.speed = Math.max(PLANE.minSpeed, Math.min(top, p.speed + throttle * PLANE.accel * dt));
    p.bank += (steer * 0.6 - p.bank) * Math.min(1, dt * 3);
    p.heading += p.bank * PLANE.turnRate * dt;
    const vy = climb * PLANE.climbRate;
    p.pitch += (Math.atan2(vy, p.speed) - p.pitch) * Math.min(1, dt * 4);
    const nx = p.x - Math.sin(p.heading) * p.speed * dt;
    const nz = p.z - Math.cos(p.heading) * p.speed * dt;
    const ny = Math.min(PLANE.ceiling, Math.max(4, p.y + vy * dt));
    if (Math.abs(nx) < WORLD_LIMIT && Math.abs(nz) < WORLD_LIMIT && !this.index.solid(nx, nz, ny - 2, ny + 2)) {
      p.x = nx;
      p.z = nz;
      p.y = ny;
    } else if (!this.index.solid(p.x, p.z, ny - 2, ny + 2)) {
      p.y = ny; // blocked ahead: hold position (turn or climb away), still allow climbing
      p.speed = PLANE.minSpeed;
    }
    p.prop.rotation.z += dt * (20 + p.speed);
  }

  _sync() {
    const c = this.car;
    c.group.position.set(c.x, 0.08, c.z);
    c.group.rotation.set(0, c.heading, 0);
    for (const w of c.wheels) {
      w.w.rotation.x = c.spin;
      w.pivot.rotation.y = w.front ? c.steer : 0;
    }
    if (c.state) c.state.value.x = c.braking || Math.abs(c.speed) < 0.2 ? 1 : 0; // brake lights
    const p = this.plane;
    p.group.position.set(p.x, p.y, p.z);
    p.group.rotation.set(p.pitch, p.heading, p.bank, 'YXZ');
  }

  _follow(camera, dt, snap = false) {
    const v = this.active;
    if (!v) return;
    const y = this.mode === 'plane' ? v.y : this.mode === 'car' ? 0 : this.ground.height(v.x, v.z);
    // [back, up, ahead, look height] behind each kind of player
    const [back, up, ahead, lookY] = { walk: [4.3, 1.95, 4, 1.55], bike: [5.5, 2.3, 6, 1.3], car: [9, 3.6, 8, 1.4], plane: [26, 7, 30, 2] }[this.mode];
    this._fwd.set(-Math.sin(v.heading), 0, -Math.cos(v.heading));
    this._camGoal.set(v.x, y + up, v.z).addScaledVector(this._fwd, -back);
    const k = snap ? 1 : 1 - Math.exp(-dt * 5);
    camera.position.lerp(this._camGoal, k);
    this._look.set(v.x, y + lookY, v.z).addScaledVector(this._fwd, ahead);
    camera.lookAt(this._look);
  }
}

export { SimpleVehicles };
