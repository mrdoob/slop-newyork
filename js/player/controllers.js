import * as THREE from 'three/webgpu';
import {
  CITY,
  ISLAND_BOUNDS,
  getIslandBoundsAtZ,
  isTypingInField,
  blockAt
} from '../world/city-config.js';
import { cityUniforms, createCarPaintMaterial, createContactShadowMaterial } from '../render/tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from '../actors/actor-models.js';
import { PersonCrowd, PersonRig } from '../sim/pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from '../actors/vehicle-lights.js';

// js/player/controllers.js
// Sculpted, non-blocky GTA 6-style 3D models, animations, and physics controllers
// for Third-Person Navigation:
// 1. Person (Skinned Pedestrian: planted-footstep IK walk/run/jump, see pedestrians.js)
// 2. Car (Aerodynamic Sculpted Yellow Taxi with Sloped Windshield & Clearcoat, or whatever car was taken)
// 3. Cyclist (Sculpted Road Cyclist with Drop-Bar Frame & Aero Helmet)
// 4. Helicopter (Sightseeing Twin-Turbine Chopper)

// Spawn at the city's start (city-geodata.js frame.start: Tepic's Plaza Principal)
const START = CITY && CITY.start ? CITY.start : null;
const SPAWN_Z = START ? START.z : 0;
// A point `ahead` metres along the start heading and `right` metres to its right (heading 0 faces +z, right is -x)
function spawnAt(ahead, right, fallbackX, fallbackZ) {
  if (!START) return { x: fallbackX, z: fallbackZ, heading: 0 };
  const sx = Math.sin(START.heading), cx = Math.cos(START.heading);
  return { x: START.x + sx * ahead - cx * right, z: START.z + cx * ahead + sx * right, heading: START.heading };
}
const SPAWN = {
  person: spawnAt(2, 3.4, -11.6, SPAWN_Z + 12),
  car: spawnAt(0, 0, 3.6, SPAWN_Z + 12),
  cyclist: spawnAt(-9, 0.6, 5.2, SPAWN_Z - 8),
  helicopter: spawnAt(-60, -110, -110, SPAWN_Z - 60)
};
// HUD names of the player's characters & vehicles, in the city's language
const LABELS = { person: 'Peatón', car: 'Taxi de Tepic', cyclist: 'Ciclista', helicopter: 'Helicóptero turístico' };
const CAR_NAMES = { sedan: 'Sedán', suv: 'SUV', pickup: 'Pickup', van: 'Combi', hatch: 'Hatchback' };
const groundCollider = { type: 'ground' };

const CAR_DRIVE = {
  speed: 23.5, boostSpeed: 36, reverseSpeed: 10.5, acceleration: 14, boostAcceleration: 21,
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9
};
// The car off the ground (rideGround): gravity (m/s²), the gap (m) under its wheels from which it flies (no grip, no
// steering: smaller dips the suspension rides out), and the landing it takes without losing speed (m/s down)
const CAR_AIR = { gravity: 9.81, flying: 0.15, hardLanding: 6 };
const BICYCLE_DRIVE = {
  speed: 12.8, boostSpeed: 19, reverseSpeed: 4.5, acceleration: 9, boostAcceleration: 13.5,
  rolling: 0.08, drag: 0.004, coast: 0.2, brake: 7.5 // Backward input is scaled to 0.6, giving 4.5 m/s² braking.
};

function driveSpeed(speed, throttle, boost, dt, drive) {
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : boost ? drive.boostSpeed : drive.speed;
  const acceleration = boost ? drive.boostAcceleration : drive.acceleration;
  // Releasing boost removes the extra power; existing momentum decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');

function collisionBody(mode, radius, heading, margin = 0) {
  const car = mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = 0.86 + margin, hz = 2.18 + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

// Shared by movement and teleport clearance. World bounds reject distant boxes cheaply; the narrow phase
// uses a circle for walking/cycling/flying and all four separating axes for an oriented car rectangle.
function buildingContact(c, x, y, z, body, contact) {
  if (y + body.bottom >= c.maxY || y + body.top <= (c.minY ?? 0)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.car) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

function createTaxiDoorDecalTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffbe14';
  ctx.fillRect(0, 0, 256, 128);
  // Black taxi-rank emblem
  ctx.fillStyle = '#111317';
  ctx.beginPath();
  ctx.arc(58, 64, 42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffbe14';
  ctx.font = '900 32px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', 58, 66);
  // TAXI TEPIC typography, rank & unit number
  ctx.fillStyle = '#111317';
  ctx.textAlign = 'left';
  ctx.font = '900 26px Inter, Arial, sans-serif';
  ctx.fillText('TAXI TEPIC', 112, 42);
  ctx.font = '700 15px JetBrains Mono, monospace';
  ctx.fillText('SITIO 7 · ECO 48', 112, 68);
  ctx.font = '600 13px Inter, Arial, sans-serif';
  ctx.fillText('SERVICIO PÚBLICO', 112, 90);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Nayarit public-service plate: white, the state's name across the top, MÉXICO along the bottom
function createLicensePlateTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f4f0';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#0f6b3a';
  ctx.fillRect(6, 6, 244, 24);
  ctx.fillStyle = '#f4f4f0';
  ctx.font = '800 15px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NAYARIT', 128, 23);
  ctx.fillStyle = '#16181c';
  ctx.font = '900 48px JetBrains Mono, monospace';
  ctx.fillText('A-748-T', 128, 82);
  ctx.font = '700 13px Inter, Arial, sans-serif';
  ctx.fillText('MÉXICO', 128, 114);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = []) {
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this.activeMode = 'person'; // 'person' | 'car' | 'cyclist' | 'helicopter': on foot until getting into something (F)
    this.rotorSpin = 0; // rad/s of the helicopter's main rotor: winds up with the pilot aboard, down once parked

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      boost: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.syncOccupants();
    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC'],
      boost: ['ShiftLeft', 'ShiftRight']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.activeMode = mode;
    this.syncOccupants();
  }

  // On foot the pedestrian walks and the vehicles stand empty where they were left; in a vehicle the pedestrian rides
  // along out of sight, and only a bicycle being ridden has its rider (and helmet) on it
  syncOccupants() {
    const onFoot = this.activeMode === 'person';
    const p = this.entities.person;
    p.mesh.visible = onFoot;
    for (const m of p.crowd.meshes) m.visible = onFoot;
    const b = this.entities.cyclist;
    const riding = this.activeMode === 'cyclist';
    for (const m of b.riderCrowd.meshes) m.visible = riding;
    b.helmet.visible = riding;
  }

  // GTA-style boarding (F, main.js): the player's own vehicle the pedestrian could get into, the nearest whose body
  // is within `reach` metres; { mode, distance } or null
  ownVehicleNear(reach) {
    const p = this.entities.person.position;
    let best = null;
    // [mode, half width, half length, centre ahead of the origin]: the helicopter runs from its nose (+2.5 m) back to
    // the tail rotor (-6 m)
    for (const [mode, halfW, halfL, mid] of [['car', 0.86, 2.18, 0], ['cyclist', 0.32, 0.95, 0], ['helicopter', 1.3, 4.3, -1.8]]) {
      const e = this.entities[mode];
      if (Math.abs(e.position.y - p.y) > 2.5) continue; // (a helicopter up in the air)
      const dx = p.x - e.position.x, dz = p.z - e.position.z;
      const fx = Math.sin(e.heading), fz = Math.cos(e.heading);
      const distance = Math.hypot(Math.max(0, Math.abs(dx * fx + dz * fz - mid) - halfL), Math.max(0, Math.abs(dz * fx - dx * fz) - halfW));
      if (distance <= reach && (!best || distance < best.distance)) best = { mode, distance };
    }
    return best;
  }

  // Get in: one of the player's own vehicles where it stands, or `taken`, a car or bicycle taken from the traffic
  // (traffic.js hijack): the player's vehicle of that kind takes its place, looks and (slowed) speed
  enterVehicle(mode, taken = null) {
    if (this.activeMode !== 'person' || mode === 'person' || !this.entities[mode]) return false;
    const ent = this.entities[mode];
    if (taken) {
      if (mode === 'car') this.setCarLook(taken.bodyType, taken.paint, taken.police);
      else if (mode === 'cyclist') this.setBikeColor(taken.color);
      ent.position.set(taken.x, this.getGroundHeight(taken.x, taken.z, mode), taken.z); // just where it was
      ent.heading = taken.heading;
      this.settle(ent);
      ent.speed = Math.max(0, taken.speed) * 0.4;
    }
    this.setMode(mode);
    return true;
  }

  // Get out: the pedestrian steps out on the driver's side (left), the vehicle stays where it stopped. A helicopter
  // has to be (almost) on the ground first
  exitVehicle() {
    const mode = this.activeMode;
    if (mode === 'person') return false;
    const v = this.entities[mode];
    const ground = this.getGroundHeight(v.position.x, v.position.z, mode);
    if (mode === 'helicopter' && v.position.y - ground > 3) return false;
    if (mode === 'helicopter') v.position.y = ground + 0.25;
    this.settle(v);
    if (v.carState) v.carState.value.x = 0; // (no brake lights on a parked car)
    const side = mode === 'car' ? 1.5 : mode === 'cyclist' ? 0.75 : 2.4;
    const end = mode === 'car' ? 3.0 : mode === 'cyclist' ? 1.6 : 6.6;
    const lx = Math.cos(v.heading), lz = -Math.sin(v.heading); // left (heading 0 faces +z, left is +x)
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
    const spots = [[lx * side, lz * side], [-lx * side, -lz * side], [-fx * end, -fz * end], [fx * end, fz * end]];
    const shape = collisionBody('person', 0.48, 0, 0.05);
    const fits = (x, z) => {
      const y = this.getGroundHeight(x, z, 'person');
      return !this.nearColliders(x, z, 1).some((c) => buildingContact(c, x, y, z, shape));
    };
    const [ox, oz] = spots.find(([sx, sz]) => fits(v.position.x + sx, v.position.z + sz)) || spots[0];
    const p = this.entities.person;
    const x = v.position.x + ox, z = v.position.z + oz;
    this.setMode('person');
    this.resetInput();
    p.position.set(x, this.getGroundHeight(x, z, 'person'), z);
    p.heading = v.heading;
    this.settle(p);
    return true;
  }

  // The player's car takes the body and paint of the one it was taken from: taxi, sedan, SUV, pickup, van, hatchback
  // or police cruiser
  setCarLook(bodyType = 'taxi', paint = 0xffbe14, police = false) {
    const c = this.entities.car;
    const spec = BODY_SPECS[bodyType] || BODY_SPECS.taxi;
    const mat = createLoftedCarMaterial(spec, paint);
    const geos = (this._carGeos ??= {});
    const g = (geos[spec.name] ??= {
      body: buildCarGeometry(spec, false),
      wheels: [buildSteerableWheelGeo(spec, -1), buildSteerableWheelGeo(spec, 1)]
    });
    c.bodyMesh.geometry = g.body;
    c.bodyMesh.material = mat;
    for (const wheel of c.wheels) {
      wheel.tire.geometry = g.wheels[wheel.side < 0 ? 0 : 1];
      wheel.tire.material = mat;
      wheel.steerPivot.position.set(wheel.side * spec.wheelX, spec.wheelRadius, wheel.isFront ? spec.wheelZ : -spec.wheelZ);
    }
    for (const decal of c.taxiDecals) decal.visible = spec.name === 'taxi';
    c.plates[0].position.set(0, spec.plates[0], spec.zFront + 0.006);
    c.plates[1].position.set(0, spec.plates[1], spec.zRear - 0.006);
    c.headLights.forEach((spot, i) => placeVehicleHeadlight(spot, spec, i === 0 ? -1 : 1));
    c.carState = mat.userData.carState;
    if (c.carState) c.carState.value.set(0, 0, 0, police ? 1 : 0); // (livery: 1 = police)
    c.label = spec.name === 'taxi' ? LABELS.car : police ? 'Patrulla' : CAR_NAMES[spec.name] || 'Sedán';
    c.look = { bodyType: spec.name, paint, police: Boolean(police) };
  }

  // ...and the player's bicycle the frame colour of the one it was taken from
  setBikeColor(hex = 0x0078e8) {
    const b = this.entities.cyclist;
    const mat = createCarPaintMaterial(hex);
    for (const m of b.frameMeshes) m.material = mat;
    b.look = { color: hex };
  }

  // The player's car & bicycle left standing, for the traffic to stop behind (traffic.js setParked)
  parkedVehicles() {
    const slots = (this._parkedSlots ??= { car: { x: 0, z: 0, halfW: 0.86, halfL: 2.18 }, cyclist: { x: 0, z: 0, halfW: 0.32, halfL: 0.95 } });
    const out = (this._parked ??= []);
    out.length = 0;
    for (const mode of ['car', 'cyclist']) {
      if (mode === this.activeMode) continue;
      const e = this.entities[mode];
      slots[mode].x = e.position.x;
      slots[mode].z = e.position.z;
      out.push(slots[mode]);
    }
    return out;
  }

  // The helicopter waits on the ground, clear of the buildings, for the player to walk up and get in (back at its
  // spot near the start with `home`, so it is always found there when the game starts)
  landHelicopter(home = false) {
    const h = this.entities.helicopter;
    if (home) {
      h.position.x = SPAWN.helicopter.x;
      h.position.z = SPAWN.helicopter.z;
      h.heading = START ? START.heading + 0.62 : 0.62;
    }
    const mode = this.activeMode;
    this.activeMode = 'helicopter';
    const altitude = this.getGroundHeight(h.position.x, h.position.z, 'helicopter') + 0.25;
    const spot = this.findTeleportPosition(h.position.x, h.position.z, h.heading, altitude);
    this.activeMode = mode;
    if (spot) {
      h.position.x = spot.x;
      h.position.z = spot.z;
    }
    h.position.y = this.getGroundHeight(h.position.x, h.position.z, 'helicopter') + 0.25;
    this.settle(h);
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const floor = heli ? this.floorHeight(x, z) : 0; // (the helicopter flies up to 380 m over the town's floor)
    const altitude = heli ? Math.max(floor + 0.25, Math.min(floor + 380, savedAltitude ?? Math.max(floor + 92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude);
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode);
    }
    this.settle(ent);
    return { x: ent.position.x, z: ent.position.z };
  }

  // At rest where it stands, with no motion or pose left over (teleports, getting in & out, parking)
  settle(ent) {
    ent.speed = 0;
    if (ent.type === 'person') {
      ent.verticalVel = 0;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (ent.type === 'car') {
      this.tiltToGround(ent, 1);
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.vy = 0;
      ent.airborne = ent.flying = false;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = 1;
    } else if (ent.type === 'cyclist') {
      this.tiltToGround(ent, 1);
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
    } else {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
  }

  // Lays a car or bicycle on the slope under its wheels (the tilt eased by k of the way, 1: at once): its whole body
  // with the wheels & contact shadow; a bicycle only pitches (its rider leans it, see updateCyclist)
  tiltToGround(ent, k) {
    const car = ent.type === 'car';
    const t = this.groundTilt(ent.position.x, ent.position.z, ent.heading, car ? 1.35 : 0.55, car ? 0.8 : 0.3, (this._tilt ??= {}));
    ent.groundPitch = (ent.groundPitch || 0) + (t.pitch - (ent.groundPitch || 0)) * k;
    ent.groundRoll = car ? (ent.groundRoll || 0) + (t.roll - (ent.groundRoll || 0)) * k : 0;
    ent.mesh.rotation.order = 'YXZ';
    ent.mesh.rotation.x = ent.groundPitch;
    ent.mesh.rotation.z = ent.groundRoll;
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const shape = collisionBody(this.activeMode, radius, heading, 0.1);
    const reach = Math.max(shape.extX, shape.extZ);
    const margin = heli ? 6000 : 0;
    const entity = this.getActiveEntity();
    // Conservative body cylinders, including the taxi's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2] };
    const others = Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + margin, pz));
      px = Math.max(ISLAND_BOUNDS.minX - margin, Math.min(ISLAND_BOUNDS.maxX + margin, px));
      if (!heli && getIslandBoundsAtZ) {
        const shore = getIslandBoundsAtZ(pz);
        const west = shore.westX + 8, east = shore.eastX - 8;
        if (west > east) return null;
        px = Math.max(west, Math.min(east, px));
      }
      return { x: px, z: pz };
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(ISLAND_BOUNDS.minX, Math.min(ISLAND_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(ISLAND_BOUNDS.minZ + 30, Math.min(ISLAND_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: LABELS.person,
      mesh: root,
      shadow: pedShadow,
      crowd,
      rig,
      position: new THREE.Vector3(SPAWN.person.x, ISLAND_BOUNDS.sidewalkHeight, SPAWN.person.z),
      heading: SPAWN.person.heading,
      speed: 0,
      verticalVel: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED SCULPTED YELLOW TAXI SEDAN)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerTaxiCar';

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    const spec = BODY_SPECS.taxi;
    const taxiLoftMat = createLoftedCarMaterial(spec, 0xffbe14);

    // 1. 3D Lofted Taxi Body + Curved Windscreens + Crowned Roof + Side Mirrors + Roof Sign
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, taxiLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 2. Taxi side door emblem & unit number decals, hugging the curved front doors
    const doorDecalTex = createTaxiDoorDecalTexture();
    const doorDecalMat = new THREE.MeshStandardNodeMaterial({
      map: doorDecalTex,
      roughness: 0.24,
      metalness: 0.34,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const doorMid = (spec.doors[0] + spec.doors[1]) / 2;
    const taxiDecals = [];
    for (const side of [-1, 1]) {
      const decal = new THREE.Mesh(buildCarSidePatch(spec, side, doorMid - 0.36, doorMid + 0.36, 0.53, 0.81, 0.003), doorDecalMat);
      chassisPivot.add(decal);
      taxiDecals.push(decal);
    }

    // 3. License plates on the bumpers
    const plateTex = createLicensePlateTexture();
    const plateMat = new THREE.MeshStandardNodeMaterial({ map: plateTex, roughness: 0.28 });
    const rearPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), plateMat);
    rearPlate.position.set(0, spec.plates[1], spec.zRear - 0.006);
    chassisPivot.add(rearPlate);

    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), plateMat);
    frontPlate.position.set(0, spec.plates[0], spec.zFront + 0.006);
    chassisPivot.add(frontPlate);

    // 3b. Brake lights, CHMSL & turn signals are lit by the taxi material from its carState uniform (see updateCar)
    const carState = taxiLoftMat.userData.carState;

    // 4. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);
    this._carGeos = { taxi: { body: carBodyGeo, wheels: [leftWheelGeo, rightWheelGeo] } }; // (see setCarLook)

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, taxiLoftMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront, side: wc.side });
    }

    // 5. Soft Under-Car Contact Shadow (AO) + Clustered Dual LED Headlight SpotLights & Rear Brake PointLight
    const carShadowGeo = new THREE.PlaneGeometry(2.22, 5.05);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    this.scene.add(root);

    return {
      type: 'car',
      label: LABELS.car,
      mesh: root,
      chassisPivot,
      bodyMesh: carBodyMesh,
      taxiDecals,
      plates: [frontPlate, rearPlate],
      look: { bodyType: 'taxi', paint: 0xffbe14, police: false },
      carState,
      headLights,
      wheels,
      position: new THREE.Vector3(SPAWN.car.x, 0.0, SPAWN.car.z),
      heading: SPAWN.car.heading,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      vy: 0, // vertical speed (m/s), the ground's rise under it or its flight's
      airborne: false, // off the ground
      flying: false, // ...high enough to have lost grip & steering
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: LABELS.cyclist,
      mesh: root,
      leanPivot,
      frameMeshes: [topTube, downTube, seatTube],
      look: { color: 0x0078e8 },
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      position: new THREE.Vector3(SPAWN.cyclist.x, 0.0, SPAWN.cyclist.z),
      heading: SPAWN.cyclist.heading,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    return {
      type: 'helicopter',
      label: LABELS.helicopter,
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(SPAWN.helicopter.x, 96, SPAWN.helicopter.z),
      heading: START ? START.heading + 0.62 : 0.62,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // On a raised curb island (city-config.js BLOCKS: the real blocks, malls & plazas), not in a park
  isPointOnSidewalk(x, z) {
    const b = blockAt(x, z);
    return !!b && !(b.park > 0.6 && !b.median);
  }

  getGroundHeight(x, z, mode = 'person', fromY = undefined) {
    // the ground (ground.js): the town's floor, the hills over it & the river channels cut into it (under a bridge
    // for a body coming from `fromY` down in the channel); everyone stands on it, a walker on the curbs over the
    // town's floor (unless a hill rises above them, or it is down in a channel)
    const ground = this.terrainAt ? this.terrainAt(x, z, fromY) : 0;
    if (mode === 'person') {
      const town = this.floorHeight(x, z);
      if (ground < town - 0.01) return ground;
      return town + Math.max(this.isPointOnSidewalk(x, z) ? ISLAND_BOUNDS.sidewalkHeight : 0.0, ground - town);
    }
    return ground;
  }

  // The town's floor under (x, z) (ground.js townHeight: its slopes, 0 in the flat city), the helicopter's
  // altitudes are reckoned from
  floorHeight(x, z) {
    return this.floorAt ? this.floorAt(x, z) : 0;
  }

  // The tilt of the ground under a body reaching `along` m ahead & behind and `across` m to either side of (x, z) facing
  // `heading`, into out: { pitch, roll } for its root (Euler order YXZ: the nose up is a negative pitch, three's sense)
  groundTilt(x, z, heading, along, across, out) {
    out.pitch = out.roll = 0;
    const g = this.terrainAt;
    if (!g) return out;
    const fx = Math.sin(heading), fz = Math.cos(heading); // ahead; left is (fz, -fx)
    out.pitch = -Math.atan2(g(x + fx * along, z + fz * along) - g(x - fx * along, z - fz * along), 2 * along);
    out.roll = Math.atan2(g(x + fz * across, z - fx * across) - g(x - fz * across, z + fx * across), 2 * across);
    return out;
  }

  // Speed gained (m/s², down the slope) by a wheeled entity rolling along `heading` on the ground at (x, z)
  slopeAcceleration(x, z, heading) {
    const g = this.terrainAt;
    if (!g) return 0;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const grade = (g(x + fx * 0.5, z + fz * 0.5) - g(x - fx * 0.5, z - fz * 0.5));
    return -9.81 * grade / Math.hypot(1, grade);
  }

  // The colliders whose bounds come within `r` of (x, z), in their original order. They never move, so they are
  // bucketed once into 48 m cells (tens of thousands of buildings: testing them all every frame cost ~0.5 ms)
  // Is ground point (x, z) inside a building below `height`? (Things thrown about by knock-downs, mayhem.js)
  isSolidAt(x, z, height = 1.5, ground = 0) {
    for (const c of this.nearColliders(x, z, 0)) {
      // (only what stands between the ground there, a hill's or the street's, and `height` over it)
      if ((c.minY ?? 0) > ground + height || (c.maxY ?? Infinity) <= ground || x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
      if (!c.obb) return true;
      // the box's own frame: world = c + R_y(θ)·local, so local = R_y(−θ)·(p − c)
      const { cx, cz, hx, hz, cs, sn } = c.obb;
      const dx = x - cx, dz = z - cz;
      if (Math.abs(dx * cs - dz * sn) <= hx && Math.abs(dx * sn + dz * cs) <= hz) return true;
    }
    return false;
  }

  nearColliders(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed city (the helicopter may roam out beyond it)
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(ISLAND_BOUNDS.minX - m, Math.min(ISLAND_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + m, pos.z));
    if (this.activeMode !== 'helicopter' && getIslandBoundsAtZ) {
      const shore = getIslandBoundsAtZ(pos.z);
      const minShoreX = shore.westX + 8.0;
      const maxShoreX = shore.eastX - 8.0;
      if (pos.x < minShoreX) {
        pos.x = minShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      } else if (pos.x > maxShoreX) {
        pos.x = maxShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
    }

    const body = collisionBody(this.activeMode, radius, carEntity ? carEntity.heading : 0);
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        pos.x += nx * depth;
        pos.z += nz * depth;

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * 0.86 + Math.abs(nx * sin + nz * cos) * 2.18 : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: 0.56, // over the ground (traffic.js spawnCollisionSparks)
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt) {
    const p = this.entities.person;
    if (this.activeMode === 'person') {
      const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person');
      p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
      p.crowd.begin();
      p.crowd.add(p.rig, 0);
      p.crowd.end();
    }

    const b = this.entities.cyclist;
    if (this.activeMode !== 'cyclist') return;
    b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
    b.riderCrowd.begin();
    b.riderCrowd.add(b.riderRig, 0);
    b.riderCrowd.end();
    b.helmet.quaternion.copy(b.riderRig.headQuaternion);
    b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
  }

  // The ground at (x, z) (ground.js groundHeight: the hills over the town's floor, the river channels cut into it), for
  // where everyone stands, the town's floor alone (townHeight), and the land without the channels (landHeight) for the
  // slopes the player can't climb (a channel's banks are climbed out of, whatever their pitch). The vehicles left
  // standing are set on it (they were built at y = 0)
  setTerrain(ground, floor = null, land = null) {
    this.terrainAt = typeof ground === 'function' ? ground : null;
    this.floorAt = typeof floor === 'function' ? floor : null;
    this.landAt = typeof land === 'function' ? land : null;
    for (const mode of ['person', 'car', 'cyclist']) {
      const e = this.entities[mode];
      e.position.y = this.getGroundHeight(e.position.x, e.position.z, mode);
      this.settle(e);
    }
  }

  // The hills: on foot, by bicycle or by car the player climbs them up to its own steepest grade (rise over run: a walker
  // scrambles up 1:1, a bicycle 1:2.2, a car 1:2.5); a step up anything steeper is undone and the speed bounces back.
  // The helicopter can't sink into a hill
  keepOffHills(entity, prevX, prevZ) {
    if (!this.terrainAt || !entity) return;
    if (this.activeMode === 'helicopter') {
      const h = this.terrainAt(entity.position.x, entity.position.z);
      if (entity.position.y < h + 1.5) {
        entity.position.y = h + 1.5;
        if (entity.verticalSpeed < 0) entity.verticalSpeed = 0;
      }
      return;
    }
    const hill = this.landAt || this.terrainAt;
    const run = Math.hypot(entity.position.x - prevX, entity.position.z - prevZ);
    const rise = hill(entity.position.x, entity.position.z) - hill(prevX, prevZ);
    const grade = this.activeMode === 'person' ? 1.0 : this.activeMode === 'cyclist' ? 0.45 : 0.4;
    if (run > 1e-4 && rise > grade * run) {
      // back where it was, and down on the ground there again (unless it is in the air, a jump)
      const onGround = entity.position.y <= this.getGroundHeight(entity.position.x, entity.position.z, this.activeMode, entity.position.y) + 0.02;
      entity.position.x = prevX;
      entity.position.z = prevZ;
      if (onGround) entity.position.y = this.getGroundHeight(prevX, prevZ, this.activeMode, entity.position.y);
      if (typeof entity.speed === 'number') entity.speed *= -0.25;
      if (entity.vx) entity.vx = 0;
      if (entity.vz) entity.vz = 0;
    }
  }

  update(dt, elapsed) {
    const heli = this.entities.helicopter;
    // the rotor winds up in a few seconds with the pilot aboard and runs down once parked
    const flying = this.activeMode === 'helicopter';
    this.rotorSpin += ((flying ? 24 : 0) - this.rotorSpin) * Math.min(1, dt * (flying ? 1.6 : 0.5));
    heli.mainRotorPivot.rotation.y += dt * this.rotorSpin;
    heli.tailRotorPivot.rotation.x += dt * this.rotorSpin * 1.33;
    const active = this.getActiveEntity();
    const prevX = active ? active.position.x : 0;
    const prevZ = active ? active.position.z : 0;

    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else {
      // The pedestrian rides along (out of sight) in the vehicle it got into
      const p = this.entities.person;
      p.position.copy(active.position);
      p.heading = active.heading;
      p.speed = 0;
    }
    // A bicycle left standing leans on its kickstand
    const bike = this.entities.cyclist;
    if (this.activeMode !== 'cyclist') bike.leanPivot.rotation.z = bike.leanAngle = 0.12;

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }
    this.keepOffHills(active, prevX, prevZ);
    if (this.activeMode === 'car' && active.flying) this.tiltInAir(active, dt);
    else if (this.activeMode === 'car' || this.activeMode === 'cyclist') this.tiltToGround(active, 1 - Math.exp(-dt * 14));

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.y = e.heading;
    }
    // the walker's contact shadow lies on the slope under it
    if (this.activeMode === 'person') {
      const p = this.entities.person;
      const t = this.groundTilt(p.position.x, p.position.z, p.heading, 0.45, 0.45, (this._tilt ??= {}));
      p.shadow.rotation.set(t.pitch, 0, t.roll, 'YXZ');
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = HEADLIGHTS.intensity * beamScale;
      }
    }
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    const maxWalk = this.keys.boost ? 8.2 : 4.4;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxWalk * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxWalk * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    p.speed += (targetSpeed - p.speed) * Math.min(1, dt * 10);

    p.position.x += Math.sin(p.heading) * p.speed * dt;
    p.position.z += Math.cos(p.heading) * p.speed * dt;
    this.resolveHorizontalCollision(p.position, 0.48);

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    if (this.keys.up && p.position.y <= groundY + 0.02) {
      p.verticalVel = 5.2;
    }
    p.verticalVel -= 14.5 * dt;
    p.position.y += p.verticalVel * dt;
    if (p.position.y < groundY) {
      p.position.y = groundY;
      p.verticalVel = 0;
    }
  }

  updateCar(dt) {
    const c = this.entities.car;
    const maxSpeed = this.keys.boost ? CAR_DRIVE.boostSpeed : CAR_DRIVE.speed;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0;
    const previousSpeed = c.speed;
    // in the air the wheels push on nothing: only the air slows it
    if (c.flying) c.speed /= 1 + CAR_DRIVE.drag * Math.abs(c.speed) * dt;
    else c.speed = driveSpeed(c.speed, throttle, this.keys.boost, dt, CAR_DRIVE);
    // rolling down a slope speeds it up, up one slows it (a car standing still keeps its handbrake on)
    if (!c.flying && (throttle || Math.abs(c.speed) > 0.3)) c.speed += this.slopeAcceleration(c.position.x, c.position.z, c.heading) * dt;
    const acceleration = dt > 0 && !c.flying ? (c.speed - previousSpeed) / dt : 0;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;

    c.steerAngle += (steerInput * 0.52 - c.steerAngle) * Math.min(1, dt * 10);

    if (Math.abs(c.speed) > 0.2 && !c.flying) {
      const dirSign = c.speed >= 0 ? 1 : -1;
      const speedFactor = Math.min(1.0, Math.abs(c.speed) / 8.0);
      c.heading += c.steerAngle * 2.4 * speedFactor * dirSign * dt;
    }

    // Integrate collision yaw spin & lateral tire slip velocity with asphalt grip damping
    const tireGripDamp = Math.exp(-dt * 6.8);
    c.heading += c.angularVel * dt;
    c.angularVel *= Math.exp(-dt * 7.8);

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.position.x += (Math.sin(c.heading) * c.speed + c.vx) * dt;
    c.position.z += (Math.cos(c.heading) * c.speed + c.vz) * dt;
    c.vx *= tireGripDamp;
    c.vz *= tireGripDamp;

    this.resolveHorizontalCollision(c.position, 1.35, c);
    this.rideGround(c, dt);

    // 3-DOF Spring-Damper Chassis Suspension (Pitch, Roll & Vertical Heave)
    const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026;
    const targetRoll = -c.steerAngle * (c.speed / maxSpeed) * 0.092;
    const springK = 68.0;
    const dampC = 11.2;
    c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * springK - c.pitchVel * dampC) * dt;
    c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * springK - c.rollVel * dampC) * dt;
    c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * dt));
    c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * dt));

    c.heaveVel += (-c.heaveY * 85.0 - c.heaveVel * 12.0) * dt;
    c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * dt));
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking || (c.speed === 0 && !throttle) ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  // The car on the ground or off it. On the ground it rides the slope, its vertical speed the ground's rise under it;
  // where the ground falls away faster than gravity pulls the car down after it (over a crest at speed, off a river's
  // bank) it leaves it, keeping the speed it climbed with, and flies (without grip or steering, once clear of what the
  // suspension rides out) until it lands, the suspension taking the blow and a hard landing some of its speed.
  rideGround(c, dt) {
    const ground = this.getGroundHeight(c.position.x, c.position.z, 'car', c.position.y);
    if (!(dt > 0)) {
      c.position.y = ground;
      return;
    }
    const g = CAR_AIR.gravity;
    if (!Number.isFinite(c.vy)) c.vy = 0;
    if (!c.airborne) {
      // the ballistic path from where it was: still on the ground, or leaving it
      const free = c.position.y + (c.vy - g * dt) * dt;
      if (free <= ground) {
        c.vy = Math.max(-40, Math.min(40, (ground - c.position.y) / dt));
        c.position.y = ground;
        c.flying = false;
        return;
      }
      c.airborne = true;
    }
    c.vy -= g * dt;
    c.position.y += c.vy * dt;
    if (c.position.y > ground) {
      c.flying = c.position.y - ground > CAR_AIR.flying;
      return;
    }
    // Touchdown: what is left of its fall against the ground's own rise along its path
    const fx = Math.sin(c.heading) * c.speed + c.vx, fz = Math.cos(c.heading) * c.speed + c.vz;
    const groundRise = (this.getGroundHeight(c.position.x + fx * dt, c.position.z + fz * dt, 'car', ground) - ground) / dt;
    const impact = Math.max(0, groundRise - c.vy);
    c.position.y = ground;
    c.vy = groundRise;
    c.airborne = c.flying = false;
    c.heaveVel -= Math.min(5, impact * 0.45);
    c.pitchVel += Math.min(1.5, impact * 0.08) * (c.speed >= 0 ? 1 : -1);
    if (impact > CAR_AIR.hardLanding) c.speed *= Math.max(0.55, 1 - (impact - CAR_AIR.hardLanding) * 0.05);
  }

  // A flying car's body noses over with its path (the nose up while it climbs, down as it falls) and levels out
  tiltInAir(ent, dt) {
    const k = 1 - Math.exp(-dt * 3);
    const along = Math.max(6, Math.abs(ent.speed));
    const target = -Math.atan2(ent.vy, along) * 0.75 * (ent.speed < 0 ? -1 : 1);
    ent.groundPitch = (ent.groundPitch || 0) + (target - (ent.groundPitch || 0)) * k;
    ent.groundRoll = (ent.groundRoll || 0) * (1 - k);
    ent.mesh.rotation.order = 'YXZ';
    ent.mesh.rotation.x = ent.groundPitch;
    ent.mesh.rotation.z = ent.groundRoll;
  }

  updateCyclist(dt) {
    const b = this.entities.cyclist;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -0.6 * this.keys.backward;

    b.speed = driveSpeed(b.speed, throttle, this.keys.boost, dt, BICYCLE_DRIVE);
    if (throttle || Math.abs(b.speed) > 0.3) b.speed += this.slopeAcceleration(b.position.x, b.position.z, b.heading) * dt;

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    this.resolveHorizontalCollision(b.position, 0.65, null, b);
    b.position.y = this.getGroundHeight(b.position.x, b.position.z, 'cyclist', b.position.y);

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = this.keys.boost ? 52.0 : 32.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    // from the town's floor up to 380 m over it (the hills are kept below it by keepOffHills)
    const floor = this.floorHeight(h.position.x, h.position.z);
    if (h.position.y < floor + 0.25) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, floor + 0.25, h.position.z, 0, 1, 0, -h.verticalSpeed);
    }
    h.position.y = Math.max(floor + 0.25, Math.min(floor + 380, h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
