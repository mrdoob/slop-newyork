import * as THREE from 'three/webgpu';

// js/simple-vehicles.js
// A drivable car and a flyable plane for footprint cities (GEO.buildings + GEO.roadGraph), with a chase camera.
// City-agnostic: buildings and roads come in through `geo`; colours and traffic side through `options`.
//
// Controls: W/S or Up/Down forward & back, A/D or Left/Right turn, Shift faster; plane: R/F climb & descend.
// The car stays on the ground and stops at building walls; the plane can't fly through buildings.

const CAR = { len: 4.4, wid: 1.8, accel: 9, brake: 18, drag: 0.6, maxSpeed: 22, boostSpeed: 38, reverseSpeed: 7, turn: 0.55 };
const PLANE = { minSpeed: 18, cruise: 45, maxSpeed: 90, accel: 14, turnRate: 0.9, climbRate: 22, ceiling: 1500 };
const CELL = 32; // building index cell (m)
const WORLD_LIMIT = 1500; // keep vehicles over the ground plane (m from the origin)

// --- Building index: footprint rings bucketed on a grid, for point-in-footprint queries ---------------------------------
function buildIndex(geo) {
  const cells = new Map();
  const items = [];
  for (const [, outer, , top, base] of geo.buildings) {
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

// --- Models (built facing -z) -----------------------------------------------------------------------------------------
function std(colour, roughness = 0.6, metalness = 0) {
  return new THREE.MeshStandardNodeMaterial({ color: colour, roughness, metalness });
}
function carModel(colour) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(CAR.wid, 0.7, CAR.len), std(colour, 0.35, 0.3));
  body.position.y = 0.65;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(CAR.wid * 0.9, 0.55, CAR.len * 0.5), std(0x22282e, 0.15, 0.5));
  cabin.position.set(0, 1.25, 0.2);
  g.add(body, cabin);
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 14).rotateZ(Math.PI / 2);
  const tyre = std(0x161616, 0.9);
  for (const [x, z] of [[-0.85, -1.35], [0.85, -1.35], [-0.85, 1.35], [0.85, 1.35]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.34, z);
    const w = new THREE.Mesh(wheelGeo, tyre);
    pivot.add(w);
    g.add(pivot);
    wheels.push({ pivot, w, front: z < 0 });
  }
  const lamp = (x, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.15, 0.05), new THREE.MeshBasicNodeMaterial({ color: c }));
    m.position.set(x, 0.75, z);
    g.add(m);
  };
  for (const x of [-0.6, 0.6]) { lamp(x, -CAR.len / 2 - 0.01, 0xfff6d8); lamp(x, CAR.len / 2 + 0.01, 0xc01818); }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group: g, wheels };
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
function roadSpawn(geo, near, driveOnRight) {
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
    if (sl < 25 || w < 6) continue;
    const mx = (pts[s][0] + pts[s + 1][0]) / 2, mz = (pts[s][1] + pts[s + 1][1]) / 2;
    const score = Math.hypot(mx - near.x, mz - near.z) - w * 5;
    if (score < bestScore) {
      bestScore = score;
      const dx = (pts[s + 1][0] - pts[s][0]) / sl, dz = (pts[s + 1][1] - pts[s][1]) / sl;
      const lane = dir === 0 ? (w / 4) * (driveOnRight ? 1 : -1) : 0;
      best = { x: mx - dz * lane, z: mz + dx * lane, heading: Math.atan2(-dx, -dz) };
    }
  }
  return best || { x: near.x, z: near.z, heading: 0 };
}

class SimpleVehicles {
  constructor(scene, geo, options = {}) {
    this.index = buildIndex(geo);
    this.keys = new Set();
    this.mode = 'orbit';
    const car = carModel(options.carColour ?? 0xd8322a);
    const plane = planeModel(options.planeColour ?? 0xe8e8e4);
    this.car = { ...car, x: 0, z: 0, heading: 0, speed: 0, steer: 0, spin: 0 };
    this.plane = { ...plane, x: 0, y: 150, z: 0, heading: 0, speed: PLANE.cruise, bank: 0, pitch: 0 };
    const spawn = roadSpawn(geo, options.spawnNear ?? { x: 0, z: 0 }, options.driveOnRight ?? true);
    Object.assign(this.car, spawn);
    const p = options.planeSpawn ?? { x: 0, y: 180, z: 900, heading: 0 };
    Object.assign(this.plane, p);
    car.group.visible = plane.group.visible = false;
    scene.add(car.group, plane.group);
    this._sync();
    this._fwd = new THREE.Vector3();
    this._camGoal = new THREE.Vector3();
    this._look = new THREE.Vector3();
    const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    window.addEventListener('keydown', (e) => {
      if (!DRIVE_KEYS.has(e.code)) return;
      this.keys.add(e.code);
      if (this.mode !== 'orbit' && e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  setMode(mode, camera) {
    this.mode = mode;
    this.car.group.visible = mode === 'car';
    this.plane.group.visible = mode === 'plane';
    if (mode !== 'orbit' && camera) this._follow(camera, 1, true);
  }

  get status() {
    if (this.mode === 'car') return `Car · ${Math.round(Math.abs(this.car.speed) * 3.6)} km/h`;
    if (this.mode === 'plane') return `Plane · ${Math.round(this.plane.speed * 3.6)} km/h · ${Math.round(this.plane.y)} m`;
    return '';
  }

  _axis(pos, neg) {
    return (pos.some((k) => this.keys.has(k)) ? 1 : 0) - (neg.some((k) => this.keys.has(k)) ? 1 : 0);
  }

  update(dt, camera) {
    dt = Math.min(dt, 0.05);
    const throttle = this._axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const steer = this._axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (this.mode === 'car') this._driveCar(dt, throttle, steer, boost);
    else if (this.mode === 'plane') this._flyPlane(dt, throttle, steer, boost, this._axis(['KeyR'], ['KeyF']));
    else return;
    this._sync();
    this._follow(camera, dt);
  }

  _driveCar(dt, throttle, steer, boost) {
    const c = this.car;
    const top = boost ? CAR.boostSpeed : CAR.maxSpeed;
    if (throttle > 0) c.speed += (c.speed < 0 ? CAR.brake : CAR.accel) * dt;
    else if (throttle < 0) c.speed -= (c.speed > 0 ? CAR.brake : CAR.accel) * dt;
    else c.speed -= Math.sign(c.speed) * Math.min(Math.abs(c.speed), (CAR.drag + Math.abs(c.speed) * 0.05) * dt);
    c.speed = Math.max(-CAR.reverseSpeed, Math.min(top, c.speed));
    c.steer += (steer * CAR.turn - c.steer) * Math.min(1, dt * 6);
    // Turning radius grows with speed: yaw rate ~ speed × steer / wheelbase, softened at high speed
    c.heading += (c.speed * Math.tan(c.steer)) / 2.7 / (1 + Math.abs(c.speed) / 25) * dt;
    const nx = c.x - Math.sin(c.heading) * c.speed * dt;
    const nz = c.z - Math.cos(c.heading) * c.speed * dt;
    if (this._carFits(nx, nz, c.heading)) { c.x = nx; c.z = nz; }
    else c.speed *= -0.25; // bump off the wall
    c.spin += (c.speed * dt) / 0.34;
  }

  _carFits(x, z, h) {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return false;
    const s = Math.sin(h), c = Math.cos(h);
    for (const [ox, oz] of [[-CAR.wid / 2, -CAR.len / 2], [CAR.wid / 2, -CAR.len / 2], [-CAR.wid / 2, CAR.len / 2], [CAR.wid / 2, CAR.len / 2], [0, -CAR.len / 2]]) {
      const px = x + ox * c + oz * s, pz = z - ox * s + oz * c;
      if (this.index.solid(px, pz, 0.2, 1.6)) return false;
    }
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
      w.w.rotation.x = -c.spin;
      w.pivot.rotation.y = w.front ? c.steer : 0;
    }
    const p = this.plane;
    p.group.position.set(p.x, p.y, p.z);
    p.group.rotation.set(p.pitch, p.heading, p.bank, 'YXZ');
  }

  _follow(camera, dt, snap = false) {
    const v = this.mode === 'car' ? this.car : this.plane;
    const y = this.mode === 'car' ? 0 : v.y;
    const [back, up, ahead] = this.mode === 'car' ? [9, 3.6, 8] : [26, 7, 30];
    this._fwd.set(-Math.sin(v.heading), 0, -Math.cos(v.heading));
    this._camGoal.set(v.x, y + up, v.z).addScaledVector(this._fwd, -back);
    const k = snap ? 1 : 1 - Math.exp(-dt * 5);
    camera.position.lerp(this._camGoal, k);
    this._look.set(v.x, y + (this.mode === 'car' ? 1.4 : 2), v.z).addScaledVector(this._fwd, ahead);
    camera.lookAt(this._look);
  }
}

export { SimpleVehicles };
