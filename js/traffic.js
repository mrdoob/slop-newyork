import * as THREE from 'three/webgpu';
import { buildRoadNetwork } from './road-network.js';
import { createPedestrianSystem } from './pedestrian-system.js';
import { vehicleContact, resolveVehicleContact, sweptVehicleContact } from './vehicle-physics.js';
import { createMover, vehicleShape } from './ragdoll.js';
import { signalPhase, walkSignal } from './city-config.js';
import { cityUniforms, createContactShadowMaterial, createCarFlareMaterial } from './tsl-materials.js';
import {
  HEADLIGHTS,
  placeVehicleHeadlight,
  createHeadlightPool,
  parkHeadlights,
  headlightBeamScale,
  headlightDistance
} from './vehicle-lights.js';
import { minStdRandom } from './random.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarProxyGeometry,
  buildSteerableWheelGeo,
  createCarWheelMaterial,
  createLoftedCarMaterial,
  carStyleCode,
  withCarSeed,
  buildLightbarGeometry,
  createLightbarMaterial
} from './cars.js';
import {
  BUS_SPEC,
  buildLoftedBusBodyGeometry,
  buildBusSignGeometry,
  buildBusWheelGeo,
  createBusWheelMaterial,
  createLoftedBusMaterial
} from './bus.js';

// Cars and buses follow the road graph, obey signals, yield at crossings and react to collisions.
// Vehicles replenish around the player; pedestrian-system.js manages the nearby walking population.

const NUM_CARS = 200;
const NUM_BUSES = 12;

// Intelligent Driver Model: max acceleration, comfortable braking, time headway, standstill gap; the sideways
// acceleration drivers accept in bends, which sets how fast they take each turn or lane shift; and how hard they brake
// in an emergency. At the wheel (see steer): the sideways acceleration the tyres grip up to, how far the front wheels
// turn (radians), and how fast the driver turns them at speed (rad/s, ~250°/s at the steering wheel; up to three times
// as fast at walking pace, 3.5 times as fast in a panic).
const CAR_DRIVER = { a: 2.0, b: 3.0, T: 1.2, s0: 2.0, aLat: 3.5, bMax: 8, grip: 8, lock: 0.6, steerRate: 0.3 };
const BUS_DRIVER = { a: 1.1, b: 2.5, T: 1.5, s0: 2.5, aLat: 2.0, bMax: 6, grip: 5, lock: 0.9, steerRate: 0.3 };
const LOOKAHEAD = 70; // metres a driver looks ahead for vehicles, stop lines and signals
// Dodging the player (see react): seconds ahead a driver sees a collision coming, the clearance it wants (m), how long
// it keeps up its manoeuvre after the danger has passed (s), the time step it judges the player's course at (s), how
// far across it will swerve at once (m), how much nearer the other way out must be to change its mind (m), and the
// fastest it expects the player to keep turning (rad/s)
const AVOID_NOTICE = 2.2;
const AVOID_MARGIN = 0.5;
const AVOID_HOLD = 1.0;
const AVOID_STEP = 0.1;
const AVOID_REACH = 3.6;
const AVOID_SWITCH = 1.0;
const AVOID_TURN = 1.2;
const AVOID_BRAKE = 1.5; // m/s²: braking while swerving round a player coming at it (more takes the speed it steers with)
// Crashes: the change of velocity (m/s) beyond which a hit driver stops and gathers itself, hazards on, for 4 to 7 s
// (less is a nudge it drives on from); and the tyres' grip stopping a car shoved sideways (m/s²) or spun (rad/s²)
const CRASH_SPEED = 2;
const SLIDE_FRICTION = 7.5;
const SPIN_FRICTION = 6;
const SHOVE_REACH = 6; // m: the furthest a knock carries a vehicle off its path

// Car body kinds (BODY_SPECS keys) in street & highway traffic: half-length for spacing, half-width & axle for the
// path, collision half-length & mass, and the engine voice (audio-sources.js)
const CAR_KINDS = {
  taxi: { half: 2.25, halfWidth: 0.86, axle: 1.38, halfL: 2.18, mass: 1600, engine: 'sedan' },
  sedan: { half: 2.25, halfWidth: 0.86, axle: 1.38, halfL: 2.18, mass: 1600, engine: 'sedan' },
  suv: { half: 2.3, halfWidth: 0.92, axle: 1.4, halfL: 2.22, mass: 2100, engine: 'suv' },
  minivan: { half: 2.6, halfWidth: 0.92, axle: 1.52, halfL: 2.52, mass: 2000, engine: 'sedan' },
  pickup: { half: 2.86, halfWidth: 0.96, axle: 1.92, halfL: 2.78, mass: 2400, engine: 'suv' },
  van: { half: 2.96, halfWidth: 0.95, axle: 1.8, halfL: 2.88, mass: 2700, engine: 'suv' }
};

// Retire distant actors even when looking their way: keeping them indefinitely starves upcoming streets.
// Replacements may enter the far view, but nearby visible roads and sidewalks are protected from pop-in.
const VEHICLE_RADIUS = 380;
const NEAR_RADIUS = 350;
const VEHICLE_SPAWN_DISTANCE = 250;

// 8-row LED destination sign atlas (route badge + destination) aligned with the 4-slot bus livery cycle
// (slots 0/2 = Current MTA Blue/Gold, slot 1 = Select Bus Service, slot 3 = Classic White/Blue)
function createBusDestinationTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#090b10';
  ctx.fillRect(0, 0, 512, 512);
  const routes = [
    ['M101', '3 AV / HARLEM', '#0058b8', '#ff9d1c'],
    ['M15', '+SELECT BUS / SOUTH FERRY', '#009ad6', '#46d8ff'],
    ['M42', '42 ST PIER / UN', '#0058b8', '#ff9d1c'],
    ['M1', '5 AV / HARLEM', '#0058b8', '#ff9d1c'],
    ['M7', 'COLUMBUS AV / 14 ST', '#0058b8', '#ff9d1c'],
    ['M60', '+SBS / LAGUARDIA', '#009ad6', '#46d8ff'],
    ['M4', 'MADISON AV / CLOISTERS', '#0058b8', '#ff9d1c'],
    ['M104', 'BROADWAY / TIMES SQ', '#0058b8', '#ff9d1c']
  ];
  routes.forEach(([route, dest, badgeBg, textCol], idx) => {
    const y0 = idx * 64;
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(6, y0 + 8, 500, 48);
    ctx.fillStyle = badgeBg;
    ctx.fillRect(12, y0 + 11, 126, 42);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 32px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(route, 75, y0 + 33);
    ctx.fillStyle = textCol;
    ctx.font = '800 25px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(dest, 152, y0 + 33);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Flags the first n items of an attribute for upload (static usage: once per frame, not once per render pass)
function flagRange(attr, n) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
}

// Car bodies' per-instance paint & lamp state (carState: brake, left & right turn signal, style code), uploaded only
// when a slot changes hands or its lamps change
function createCarAttributes() {
  const dirtyPaint = new Set();
  const dirtyState = new Set();
  return {
    write(mesh, slot, paint, brake, left, right, style) {
      const attrs = mesh.geometry.attributes;
      const p = attrs.paintColor.array;
      const o3 = slot * 3;
      if (p[o3] !== paint[0] || p[o3 + 1] !== paint[1] || p[o3 + 2] !== paint[2]) {
        p[o3] = paint[0];
        p[o3 + 1] = paint[1];
        p[o3 + 2] = paint[2];
        dirtyPaint.add(mesh);
      }
      const s = attrs.carState.array;
      const o4 = slot * 4;
      if (s[o4] !== brake || s[o4 + 1] !== left || s[o4 + 2] !== right || s[o4 + 3] !== style) {
        s[o4] = brake;
        s[o4 + 1] = left;
        s[o4 + 2] = right;
        s[o4 + 3] = style;
        dirtyState.add(mesh);
      }
    },
    // Flags the first n instances of mesh for upload: their matrices, and their paint & state if any changed
    upload(mesh, n) {
      flagRange(mesh.instanceMatrix, n);
      if (dirtyPaint.has(mesh)) flagRange(mesh.geometry.attributes.paintColor, n);
      if (dirtyState.has(mesh)) flagRange(mesh.geometry.attributes.carState, n);
    },
    clear() {
      dirtyPaint.clear();
      dirtyState.clear();
    }
  };
}

function createTrafficSystem(scene, sidewalks, obstacles, signalIntersections) {
  const group = new THREE.Group();
  group.name = 'ManhattanTrafficAndPedestrians';
  let collisionListener = null;
  const collisionEvent = { a: null, b: null, kind: 'vehicle', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };

  function setCollisionListener(listener) {
    collisionListener = typeof listener === 'function' ? listener : null;
  }

  // Synchronous notification: listeners must copy any fields they retain. Normal points from b toward a.
  function reportCollision(a, b, x, y, z, nx, nz, speed, kind = 'vehicle') {
    if (!collisionListener || speed <= 0.5) return;
    collisionEvent.kind = kind;
    collisionEvent.a = a; collisionEvent.b = b;
    collisionEvent.x = x; collisionEvent.y = y; collisionEvent.z = z;
    collisionEvent.nx = nx; collisionEvent.nz = nz; collisionEvent.speed = speed;
    collisionListener(collisionEvent);
  }

  const dummy = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  unitPlane.rotateX(-Math.PI * 0.5);
  const contactShadowMat = createContactShadowMaterial();

  // =========================================================================
  // 0. ROAD NETWORK
  // =========================================================================
  const network = buildRoadNetwork(sidewalks, obstacles, signalIntersections);
  const { nodes, edges, connector, curvePoint } = network;

  // Sides of an intersection (road-network.js step 9): a grid intersection's are 0 east, 1 west, 2 south, 3 north;
  // centreline junctions number their arms from 4. Where lane i of edge e meets a crosswalk, measured along the
  // crosswalk: along its road's lateral axis (x across north-south roads, z across east-west ones)
  const laneCoord = (e, i) => (e.sx + e.rx * e.lanes[i]) * e.clx + (e.sz + e.rz * e.lanes[i]) * e.clz;

  for (const n of nodes) {
    n.box = new Array(n.groupCount).fill(0); // vehicles crossing it from each road (group: on the grid avenue 0, street 1)
    n.crossing = new Array(n.sideCount).fill(0); // vehicles crossing (or about to cross) the crosswalk on each side
    n.approach = new Array(n.sideCount).fill(null); // the edge arriving over each side's crosswalk
    n.road = new Array(n.sideCount).fill(null); // an edge arriving or leaving over each side's crosswalk: the road it spans
  }
  for (const e of edges) {
    e.occ = e.lanes.map(() => []); // vehicles in each lane, sorted by position
    // e.inSide / e.outSide: the crosswalks crossed on the way into e.to / out of e.from; e.axisIndex: its group at e.to;
    // e.opposite: the oncoming edge of its road there (road-network.js)
    e.to.approach[e.inSide] = e;
    e.to.road[e.inSide] = e.from.road[e.outSide] = e;
    e.through = 0; // vehicles from e crossing e.to straight on or to the right
    e.lefts = 0; // and to the left
  }
  // Is the intersection box held by vehicles of any road but group g's?
  const boxBusy = (n, g) => {
    for (let k = 0; k < n.box.length; k++) if (k !== g && n.box[k] > 0) return true;
    return false;
  };

  // =========================================================================
  // 1. 3D LOFTED NYC YELLOW TAXIS, SEDANS, SUVS & NYPD CRUISERS (200 VEHICLES)
  // =========================================================================
  function createVehicle(bus, half, halfWidth, axle, driver, v0) {
    return {
      bus, half, halfWidth, axle, driver, v0,
      edge: null, lane: 0, s: 0, speed: 0, acc: 0, gap: Infinity, leaderSpeed: 0,
      move: null, out: 0, conn: null, cs: 0, trail: null, commit: null, claimed: false, yielding: false, yieldAt: 0,
      wait: 0, laneTimer: Math.random() * 0.5,
      dl: 0, dlv: 0, blink: 0, blinkPhase: Math.random() * 0.8,
      evade: 0, evadeSide: 0, alarm: 0, panic: false, panicAcc: 0, lastDanger: -Infinity, warning: false, shaken: 0,
      reaction: 0.6 + Math.random() * 0.4,
      x: 0, z: 0, prevX: 0, prevZ: 0, tx: 0, tz: 1, nose: 0, yaw: 0, yawRate: 0, steer: 0, delta: 0,
      pitch: 0, roll: 0, pitchVel: 0, rollVel: 0, vx: 0, vz: 0, yawOffset: 0, yawVel: 0, impactTime: 0,
      pAhead: Infinity, pRight: 0, pSpeed: 0, wheelSpin: Math.random() * Math.PI * 2
    };
  }

  // Every body kind shares one 3D wheel model, instanced separately and scaled to the kind's wheel radius
  const carWheelLeftGeo = buildSteerableWheelGeo(BODY_SPECS.sedan, -1);
  const carWheelRightGeo = buildSteerableWheelGeo(BODY_SPECS.sedan, 1);
  const carWheelStyles = new THREE.InstancedBufferAttribute(new Float32Array(NUM_CARS * 2), 1);
  carWheelLeftGeo.setAttribute('wheelStyle', carWheelStyles);
  carWheelRightGeo.setAttribute('wheelStyle', carWheelStyles);
  const carWheelMat = createCarWheelMaterial({ instanced: true });

  const taxiYellow = new THREE.Color(0xffbe14);
  const boroGreen = new THREE.Color(0x5cae3e);
  const policeWhite = new THREE.Color(0xf6f9fc);
  // NYC street fleet palettes: white/black/grey/silver dominate with TLC black cars, blue/red/green accents,
  // metallic vs solid clearcoat, chrome/blackout trim & multi-spoke wheel styles encoded in carState.w.
  const fleetStyles = {
    sedan: [
      { col: new THREE.Color(0x12151a), style: carStyleCode({ livery: 3, metallic: 0, trim: 1, wheel: 1 }) }, // TLC / Uber Black Car
      { col: new THREE.Color(0x161a20), style: carStyleCode({ livery: 3, metallic: 1, trim: 2, wheel: 2 }) }, // TLC Obsidian Blackout
      { col: new THREE.Color(0xf2f4f7), style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 0 }) }, // Alpine White Sedan
      { col: new THREE.Color(0xe6eaef), style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) }, // Pearl White Sport (black roof)
      { col: new THREE.Color(0xc8d0d8), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Liquid Silver Metallic
      { col: new THREE.Color(0x9aa2ac), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) }, // Tungsten Silver Metallic
      { col: new THREE.Color(0x52575e), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Graphite Grey Metallic
      { col: new THREE.Color(0x363b42), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Charcoal Dark Grey
      { col: new THREE.Color(0x1c2026), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Jet Black Metallic
      { col: new THREE.Color(0x1d3b6c), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Deep Navy Metallic
      { col: new THREE.Color(0x285086), style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) }, // Atlantic Blue Sport (black roof)
      { col: new THREE.Color(0x741d22), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }  // Crimson Red Metallic
    ],
    suv: [
      { col: new THREE.Color(0x101318), style: carStyleCode({ livery: 3, metallic: 0, trim: 1, wheel: 1 }) }, // Executive Black Escalade / Suburban TLC
      { col: new THREE.Color(0x171b22), style: carStyleCode({ livery: 3, metallic: 1, trim: 2, wheel: 3 }) }, // Uber Black SUV (blackout)
      { col: new THREE.Color(0xf0f3f7), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Pearl White Luxury SUV
      { col: new THREE.Color(0xe4e8ed), style: carStyleCode({ livery: 4, metallic: 0, trim: 2, wheel: 2 }) }, // Glacier White SUV (black roof)
      { col: new THREE.Color(0x3a434d), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Slate Grey Metallic SUV
      { col: new THREE.Color(0x5c636b), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Gunmetal Grey SUV
      { col: new THREE.Color(0xbec6cf), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Silver Metallic Crossover
      { col: new THREE.Color(0x181c22), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 3 }) }, // Onyx Black SUV
      { col: new THREE.Color(0x20385c), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Midnight Blue SUV
      { col: new THREE.Color(0x28382e), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) }, // Forest Green Metallic SUV
      { col: new THREE.Color(0x682024), style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) }, // Burgundy Crossover (black roof)
      { col: new THREE.Color(0x787670), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }  // Urban Putty Grey Crossover
    ],
    // Minivans: family colours plus TLC / Uber XL black
    minivan: [
      { col: new THREE.Color(0x111419), style: carStyleCode({ livery: 3, metallic: 1, trim: 1, wheel: 1 }) }, // TLC / Uber XL Black
      { col: new THREE.Color(0xf0f2f5), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Blizzard Pearl
      { col: new THREE.Color(0xaab2bb), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) }, // Celestial Silver
      { col: new THREE.Color(0x4a5058), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Modern Steel Grey
      { col: new THREE.Color(0x1a1d22), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Midnight Black
      { col: new THREE.Color(0x26354f), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }, // Obsidian Blue
      { col: new THREE.Color(0xe9ecef), style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 1 }) }, // Super White
      { col: new THREE.Color(0x5a1f24), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }  // Velvet Red
    ],
    // Pickups: black, white & silver with chrome or blackout grilles
    pickup: [
      { col: new THREE.Color(0x14171b), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Agate Black (chrome)
      { col: new THREE.Color(0xf2f3f5), style: carStyleCode({ livery: 0, metallic: 0, trim: 1, wheel: 0 }) }, // Oxford White (chrome)
      { col: new THREE.Color(0x9da4ab), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) }, // Iconic Silver
      { col: new THREE.Color(0x3d434a), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Carbonized Grey (blackout)
      { col: new THREE.Color(0x1e2f4f), style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) }, // Antimatter Blue
      { col: new THREE.Color(0x8f1a1d), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Race Red (blackout)
      { col: new THREE.Color(0xf2f3f5), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Oxford White (blackout)
      { col: new THREE.Color(0x2c3a30), style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 0 }) }  // Forest Green
    ],
    // Delivery vans: mostly fleet white, black plastic trim; never two-tone, whose black roof would cover the van's
    // cargo box (part of its glasshouse loft)
    van: [
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }, // Fleet White
      { col: new THREE.Color(0xeef0f2), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Arctic White (dark wheels)
      { col: new THREE.Color(0xb9c0c7), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 0 }) }, // Brilliant Silver
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 1 }) }, // Fleet White
      { col: new THREE.Color(0x8e959c), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Pebble Grey
      { col: new THREE.Color(0xf0f1f2), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }, // Fleet White (dark wheels)
      { col: new THREE.Color(0x15181c), style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }, // Obsidian Black
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }, // Fleet White
      { col: new THREE.Color(0x1f3354), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }, // Navy Blue
      { col: new THREE.Color(0xf4f5f6), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 1 }) }, // Fleet White
      { col: new THREE.Color(0x9b1c1f), style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) }  // Flame Red
    ]
  };
  // Of every 20 cars: 4 yellow cabs, 5 sedans, 6 SUVs, 2 delivery vans, 2 minivans & a pickup. NYPD cruisers are sedans
  // or Interceptor SUVs, green Boro cabs sedans or SUVs.
  const FLEET_MIX = ['taxi', 'sedan', 'van', 'sedan', 'suv', 'taxi', 'suv', 'minivan', 'suv', 'pickup',
    'taxi', 'sedan', 'suv', 'van', 'suv', 'taxi', 'minivan', 'sedan', 'suv', 'sedan'];

  const cars = [];
  const counts = Object.fromEntries(Object.keys(CAR_KINDS).map((kind) => [kind, 0]));
  const policeCounts = { sedan: 0, suv: 0 };

  for (let i = 0; i < NUM_CARS; i++) {
    const isPolice = (i % 50) === 6 || (i % 100) === 56;
    const isBoroTaxi = !isPolice && (i % 25) === 3;
    let bodyType = FLEET_MIX[i % FLEET_MIX.length];
    if (isPolice) bodyType = (i % 100) === 56 ? 'suv' : 'sedan';
    else if (isBoroTaxi) bodyType = i % 2 === 0 ? 'suv' : 'sedan';

    let col;
    let style;
    if (bodyType === 'taxi') {
      col = taxiYellow;
      style = carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: i % 2 });
    } else if (isPolice) {
      col = policeWhite;
      style = carStyleCode({ livery: 1, metallic: 0, trim: 2, wheel: 3 });
      policeCounts[bodyType]++;
    } else if (isBoroTaxi) {
      col = boroGreen;
      style = carStyleCode({ livery: 2, metallic: 0, trim: 0, wheel: 0 });
    } else {
      const palette = fleetStyles[bodyType];
      ({ col, style } = palette[counts[bodyType] % palette.length]);
    }
    counts[bodyType]++;

    const kind = CAR_KINDS[bodyType];
    const car = createVehicle(false, kind.half, kind.halfWidth, kind.axle, CAR_DRIVER, 10 + (i % 5) * 0.9);
    // paint as float32 values, so renderCar() can tell whether an instance slot's paint changes by comparing
    const paint = [Math.fround(col.r), Math.fround(col.g), Math.fround(col.b)];
    // (each car's own seed in the style code dresses its cabin & occupants)
    style = withCarSeed(style, i * 97 + 13);
    Object.assign(car, { isPolice, bodyType, paint, style, halfL: kind.halfL, mass: kind.mass, engine: kind.engine });
    cars.push(car);
  }

  // Per body kind: the full model (with separately instanced spinning wheels near the camera) and, beyond
  // CAR_PROXY_DISTANCE, the ~250-triangle stand-in, plus the contact shadow's footprint (width, length, centre z).
  // Instance slots are handed out every frame to the cars the camera can see (or whose shadow it may see), see
  // renderCar(). Per-instance paint & lamp / livery state the car material reads: brake lights, left (+x) & right (-x)
  // turn signals, livery (1 = NYPD).
  const bodies = {};
  for (const kind of Object.keys(CAR_KINDS)) {
    const spec = BODY_SPECS[kind];
    const n = Math.max(1, counts[kind]);
    const mat = createLoftedCarMaterial(spec);
    const lodMesh = (g) => {
      g.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      return new THREE.InstancedMesh(g, mat, n);
    };
    const halfWidth = Math.max(...spec.halfWidth.map((p) => p[1])) + spec.archFlare;
    bodies[kind] = {
      near: lodMesh(buildCarGeometry(spec, false)),
      far: lodMesh(buildCarProxyGeometry(spec)),
      shadow: [2 * halfWidth + 0.33, spec.zFront - spec.zRear + 0.55, (spec.zFront + spec.zRear) / 2]
    };
  }
  const bodyMeshes = Object.values(bodies).flatMap((b) => [b.near, b.far]);

  const carWheelLeftInst = new THREE.InstancedMesh(carWheelLeftGeo, carWheelMat, NUM_CARS * 2);
  const carWheelRightInst = new THREE.InstancedMesh(carWheelRightGeo, carWheelMat, NUM_CARS * 2);
  carWheelRightInst.userData.sharesPipelineWith = carWheelLeftInst;

  // 3D Collision Spark & Debris Particle Pool
  const MAX_SPARKS = 120;
  const sparkGeo = new THREE.BoxGeometry(0.038, 0.038, 0.26);
  const sparkMat = new THREE.MeshBasicNodeMaterial({ color: 0xffc438 });
  const sparkInst = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  const sparks = [];
  let sparkCursor = 0;
  for (let s = 0; s < MAX_SPARKS; s++) {
    sparks.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.4 });
  }
  function spawnCollisionSparks(x, y, z, nx, nz, impactSpeed) {
    const count = Math.min(24, Math.max(8, Math.floor(impactSpeed * 1.4)));
    const tx = -nz;
    const tz = nx;
    for (let k = 0; k < count; k++) {
      const sp = sparks[sparkCursor];
      sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
      const spread = (Math.random() - 0.5) * 2.2;
      const outBoost = (0.3 + Math.random() * 0.9) * Math.min(14.0, impactSpeed * 0.65);
      const tanBoost = spread * Math.min(12.0, impactSpeed * 0.55);
      sp.x = x + (Math.random() - 0.5) * 0.35;
      sp.y = y + (Math.random() - 0.5) * 0.18;
      sp.z = z + (Math.random() - 0.5) * 0.35;
      sp.vx = nx * outBoost + tx * tanBoost;
      sp.vy = 2.4 + Math.random() * 5.4;
      sp.vz = nz * outBoost + tz * tanBoost;
      sp.maxLife = 0.28 + Math.random() * 0.24;
      sp.life = sp.maxLife;
    }
  }

  // NYPD roof light bars per police-capable body kind (sedan & Interceptor SUV have different roof heights)
  const lightbarMat = createLightbarMaterial();
  const policeLightbars = {
    sedan: new THREE.InstancedMesh(buildLightbarGeometry(BODY_SPECS.sedan), lightbarMat, Math.max(1, policeCounts.sedan)),
    suv: new THREE.InstancedMesh(buildLightbarGeometry(BODY_SPECS.suv), lightbarMat, Math.max(1, policeCounts.suv))
  };
  const policeLightbarMeshes = [policeLightbars.sedan, policeLightbars.suv];
  const carShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_CARS);
  carShadowInst.renderOrder = 998;

  for (const m of bodyMeshes) m.castShadow = m.receiveShadow = true;
  for (const m of policeLightbarMeshes) m.castShadow = true;
  carWheelLeftInst.castShadow = carWheelLeftInst.receiveShadow = true;
  carWheelRightInst.castShadow = carWheelRightInst.receiveShadow = true;

  group.add(
    ...bodyMeshes,
    carWheelLeftInst,
    carWheelRightInst,
    sparkInst,
    ...policeLightbarMeshes
  );

  // =========================================================================
  // 2. CITY BUSES
  // =========================================================================
  const busBodyGeo = buildLoftedBusBodyGeometry();
  // Per-instance lamp & variant state the bus material and sign atlas read: brake, left (+x) & right (-x) turn, variant+1
  const busStates = new THREE.InstancedBufferAttribute(new Float32Array(NUM_BUSES * 4), 4);
  busBodyGeo.setAttribute('busState', busStates);
  // Destination signs above the windshield, by the front door & on the upper-right rear cap
  const busHeaderGeo = buildBusSignGeometry();
  busHeaderGeo.setAttribute('busState', busStates);

  const busBodyMat = createLoftedBusMaterial();
  const busDestTex = createBusDestinationTexture();
  const busDestMat = new THREE.MeshBasicNodeMaterial();
  {
    const { attribute, float, floor, max, mod, texture, uv, varying, vec2, vertexStage } = THREE.TSL;
    const state = attribute('busState', 'vec4');
    const vRow = varying(vertexStage(mod(floor(max(float(0.0), state.w.sub(1.0)).add(0.5)), 8.0)));
    const signUV = vec2(uv().x, uv().y.mul(0.095).add(0.015).add(float(7.0).sub(vRow).mul(0.125)));
    busDestMat.colorNode = texture(busDestTex, signUV).rgb.mul(1.25);
  }

  const busWheelMat = createBusWheelMaterial();
  const busBodyInst = new THREE.InstancedMesh(busBodyGeo, busBodyMat, NUM_BUSES);
  const busHeaderInst = new THREE.InstancedMesh(busHeaderGeo, busDestMat, NUM_BUSES);
  const busWheelLeftInst = new THREE.InstancedMesh(buildBusWheelGeo(-1), busWheelMat, NUM_BUSES * 2);
  const busWheelRightInst = new THREE.InstancedMesh(buildBusWheelGeo(1), busWheelMat, NUM_BUSES * 2);
  const busShadowInst = new THREE.InstancedMesh(unitPlane, contactShadowMat, NUM_BUSES);
  busShadowInst.renderOrder = 998;

  busBodyInst.castShadow = busBodyInst.receiveShadow = true;
  busWheelLeftInst.castShadow = busWheelLeftInst.receiveShadow = true;
  busWheelRightInst.castShadow = busWheelRightInst.receiveShadow = true;

  const buses = [];
  for (let i = 0; i < NUM_BUSES; i++) {
    const b = createVehicle(true, 6.1, 1.3, 3.6, BUS_DRIVER, 8 + (i % 3));
    Object.assign(b, { variant: i, halfL: 5.72, mass: 12000 });
    buses.push(b);
  }
  const vehicles = [...cars, ...buses];
  group.add(busBodyInst, busHeaderInst, busWheelLeftInst, busWheelRightInst);

  // =========================================================================
  // 3. PEDESTRIAN SYSTEM
  // =========================================================================
  const player = { active: false, entity: null, x: 0, z: 0, vx: 0, vz: 0, fx: 0, fz: 1, heading: 0, yawRate: 0,
    halfW: 0.86, halfL: 2.18 };
  const nearEdges = [];
  const nearSignals = [];
  // The vehicles around the focus as the people they knock down see them (ragdoll.js): the player's taxi and traffic,
  // with their bodies' shapes (from their meshes, made when first needed)
  const movers = [];
  const moverPool = [];
  const MOVER_RADIUS = 80;
  const shapes = {};
  function shapeOf(kind) {
    if (!shapes[kind]) {
      const bus = kind === 'bus';
      const spec = bus ? BUS_SPEC : BODY_SPECS[kind];
      const tyre = bus ? 0.16 : 0.12;
      shapes[kind] = vehicleShape(bus ? busBodyGeo : bodies[kind].near.geometry, {
        wheels: [[spec.wheelX, spec.wheelZ, spec.wheelRadius, tyre], [spec.wheelX, -spec.wheelZ, spec.wheelRadius, tyre]]
      });
    }
    return shapes[kind];
  }
  let playerMover = null;
  function gatherMovers(dt, playerEntity, activeMode) {
    let n = 0;
    const take = () => {
      const m = moverPool[n] || (moverPool[n] = createMover());
      n++;
      m.jx = m.jy = m.jz = 0;
      m.wheelHits = 0;
      m.dt = dt;
      return m;
    };
    playerMover = null;
    if (player.active && activeMode === 'car' && playerEntity.chassisPivot) {
      const m = playerMover = take();
      const chassis = playerEntity.chassisPivot;
      m.x = player.x; m.z = player.z; m.y = playerEntity.position.y + chassis.position.y;
      m.heading = playerEntity.heading || 0;
      m.vx = player.vx; m.vz = player.vz;
      m.yawRate = playerEntity.angularVel || 0;
      m.pitch = chassis.rotation.x; m.roll = chassis.rotation.z;
      m.shape = shapeOf('taxi');
      m.mass = 1700;
      m.ref = playerEntity;
      m.knocks = true;
    }
    for (const v of vehicles) {
      if (!v.edge || Math.abs(v.x - focusX) > MOVER_RADIUS || Math.abs(v.z - focusZ) > MOVER_RADIUS) continue;
      const m = take();
      const heading = v.yaw + v.yawOffset;
      m.x = v.x; m.z = v.z; m.y = 0;
      m.heading = heading;
      m.vx = Math.sin(heading) * v.speed + v.vx;
      m.vz = Math.cos(heading) * v.speed + v.vz;
      m.yawRate = v.yawRate + v.yawVel;
      m.pitch = v.bus ? 0 : v.pitch; m.roll = v.bus ? 0 : v.roll;
      m.shape = shapeOf(v.bus ? 'bus' : v.bodyType);
      m.mass = v.mass ?? 1600;
      m.ref = v;
      m.knocks = v.speed > 3; // drivers stop for people in their way: only one swerving (or careering) runs into them
    }
    movers.length = n;
    for (let i = 0; i < n; i++) movers[i] = moverPool[i];
  }

  // The people the player's taxi knocks down (or drives over) push back on it: it slows, and the chassis dips and bumps
  function feelFallen(playerEntity) {
    const m = playerMover;
    if (!m || m.ref !== playerEntity) return;
    const sin = Math.sin(m.heading), cos = Math.cos(m.heading);
    const along = (m.jx * sin + m.jz * cos) / m.mass;
    const across = (m.jx * cos - m.jz * sin) / m.mass;
    if (along || across || m.jy) {
      playerEntity.speed += along;
      playerEntity.vx = (playerEntity.vx || 0) + cos * across;
      playerEntity.vz = (playerEntity.vz || 0) - sin * across;
      playerEntity.pitchVel = (playerEntity.pitchVel || 0) + clamp(along * 0.8, -1.2, 1.2);
      playerEntity.heaveVel = (playerEntity.heaveVel || 0) + clamp((m.jy / m.mass) * 2, -0.6, 0.6);
    }
    if (m.wheelHits) {
      const speed = Math.abs(playerEntity.speed || 0);
      playerEntity.heaveVel = (playerEntity.heaveVel || 0) + Math.min(0.5, 0.06 * speed) * (0.6 + Math.random() * 0.4);
      playerEntity.rollVel = (playerEntity.rollVel || 0) + (Math.random() - 0.5) * Math.min(0.6, 0.08 * speed);
    }
  }

  const pedestrianSystem = createPedestrianSystem(network, {
    player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView, movers
  });
  pedestrianSystem.setHitListener((p, m) => {
    const speed = Math.hypot(m.vx, m.vz);
    const dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz) || 1;
    reportCollision(m.ref, p, p.x, 0.9, p.z, dx / d, dz / d, speed, 'pedestrian');
  });
  group.add(...pedestrianSystem.meshes);

  // Add vehicle contact shadows last + pre-allocated Clustered SpotLight / PointLight pools
  group.add(carShadowInst, busShadowInst);

  const HEADLIGHT_POOL_SIZE = 96;
  const POLICE_LIGHT_POOL_SIZE = 6;
  const MAX_LIGHT_DIST = 115;
  const MAX_LIGHT_DIST_SQ = MAX_LIGHT_DIST * MAX_LIGHT_DIST;

  const trafficLightsGroup = new THREE.Group();
  trafficLightsGroup.name = 'TrafficClusteredLights';
  group.add(trafficLightsGroup);

  const headlightPool = createHeadlightPool(trafficLightsGroup, HEADLIGHT_POOL_SIZE);

  const policeLightPool = [];
  for (let i = 0; i < POLICE_LIGHT_POOL_SIZE; i++) {
    const pt = new THREE.PointLight(0xff1828, 0, 12.0, 1.25);
    pt.position.set(0, -1000, 0);
    trafficLightsGroup.add(pt);
    policeLightPool.push(pt);
  }

  // Nothing shows until it has been placed
  const carInstances = [...bodyMeshes, carWheelLeftInst, carWheelRightInst, ...policeLightbarMeshes, carShadowInst];
  const busInstances = [busBodyInst, busHeaderInst, busWheelLeftInst, busWheelRightInst, busShadowInst];
  for (const inst of [...carInstances, ...busInstances, sparkInst]) {
    inst.frustumCulled = false;
    for (let i = 0; i < inst.count; i++) inst.setMatrixAt(i, zero);
  }

  scene.add(group);

  // =========================================================================
  // 4. WHO IS WHERE: LANE OCCUPANCY, INTERSECTIONS, VIEW, PLAYER
  // =========================================================================
  let clock = 0;
  let avePhase = 'green';
  let stPhase = 'red';
  let aveWalk = true;
  let stWalk = false;
  const phaseOf = (e) => (e.axisIndex === 0 ? avePhase : stPhase);
  let focusX = 0;
  let focusZ = 140;

  // Lane lists hold pooled { v, s } entries sorted by position s along the lane, rebuilt every frame
  const pool = [];
  let poolUsed = 0;
  const filled = [];
  function occupy(list, v, s) {
    let o = pool[poolUsed++];
    if (!o) pool.push((o = { v: null, s: 0 }));
    o.v = v;
    o.s = s;
    if (!list.length) filled.push(list);
    list.push(o);
    for (let k = list.length - 1; k > 0 && list[k - 1].s > s; k--) {
      list[k] = list[k - 1];
      list[k - 1] = o;
    }
  }

  // Half way through a lane change a vehicle still occupies the lane it is leaving (-1 left, 1 right)
  function straddle(v) {
    if (v.conn) return 0;
    if (v.dl > 0.5 && v.lane + 1 < v.edge.lanes.length) return 1;
    if (v.dl < -0.5 && v.lane > 0) return -1;
    return 0;
  }

  // A vehicle crossing an intersection, or committed to crossing it, holds it against crossing traffic and
  // pedestrians on the crosswalks it passes, and its place in the lane it heads for. The counters it raises are reset
  // next frame for just the nodes and edges touched (a few hundred out of thousands)
  const touchedNodes = [];
  const touchedEdges = [];
  const touchNode = (n) => {
    if (!n.touched) {
      n.touched = true;
      touchedNodes.push(n);
    }
    return n;
  };
  const touchEdge = (e) => {
    if (!e.touched) {
      e.touched = true;
      touchedEdges.push(e);
    }
    return e;
  };
  function claim(v) {
    if (v.claimed) return;
    v.claimed = true;
    const e = v.edge;
    const f = v.move.to;
    touchNode(e.to).box[e.axisIndex]++;
    if (!v.conn || v.cs < v.half + 2.5) e.to.crossing[e.inSide]++; // until its tail is past the crosswalk on its way in
    if (v.move.turn !== 'L') touchEdge(e).through++;
    if (!v.yielding) cross(v);
    occupy(f.occ[v.out], v, v.conn ? v.cs - v.conn.len : v.s - e.len - connector(e, v.lane, f, v.out).len);
  }

  // ...and, unless still waiting inside to turn left, the oncoming lanes and the crosswalk on its way out
  function cross(v) {
    const e = v.edge;
    if (v.move.turn === 'L') touchEdge(e).lefts++;
    touchNode(e.to).crossing[v.move.to.outSide]++;
    v.yielding = false;
  }

  function buildOccupancy() {
    for (const list of filled) list.length = 0;
    filled.length = 0;
    poolUsed = 0;
    for (const n of touchedNodes) {
      n.box.fill(0);
      n.crossing.fill(0);
      n.touched = false;
    }
    touchedNodes.length = 0;
    for (const e of touchedEdges) {
      e.through = e.lefts = 0;
      e.touched = false;
    }
    touchedEdges.length = 0;
    for (const v of vehicles) v.claimed = false;
    for (const v of vehicles) {
      const e = v.edge;
      if (!e) continue;
      if (!v.conn) {
        occupy(e.occ[v.lane], v, v.s);
        const side = straddle(v);
        if (side) occupy(e.occ[v.lane + side], v, v.s);
        if (v.commit === e.to) claim(v);
        if (v.s < v.half) touchNode(e.from).crossing[e.outSide]++; // its tail still over the crosswalk behind it
      } else {
        claim(v);
        occupy(e.occ[v.lane], v, e.len + v.cs); // until it is out of the intersection, still ahead of those behind it
      }
    }
  }

  // The camera's view, for drawing and protecting nearby spawn locations
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  let hasView = false;
  let camX = 0;
  let camY = 10;
  let camZ = 140;
  let camFwdX = 0;
  let camFwdZ = 1;
  function updateView(camera) {
    hasView = !!camera;
    if (!camera) return;
    camera.updateMatrixWorld();
    camX = camera.position.x;
    camY = camera.position.y;
    camZ = camera.position.z;
    const me = camera.matrixWorld.elements;
    camFwdX = -me[8];
    camFwdZ = -me[10];
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
  }
  // Could the camera see a sphere of radius r around ground point (x, z)? Side planes only: the near and far
  // planes depend on depth conventions, and the side planes alone already rule out everything behind the camera.
  function visible(x, z, r) {
    if (!hasView) return false;
    for (let k = 0; k < 4; k++) {
      const { normal, constant } = frustum.planes[k];
      if (normal.x * x + normal.y + normal.z * z + constant < -r) return false;
    }
    return true;
  }

  function nearView(x, z, radius, distance) {
    return hasView && Math.hypot(x - camX, camY, z - camZ) < distance && visible(x, z, radius);
  }

  // Edges and signalized intersections around the focus, to place vehicles and pedestrians on
  let nearX = Infinity;
  let nearZ = Infinity;
  function refreshNear() {
    if (Math.hypot(focusX - nearX, focusZ - nearZ) < 40) return;
    nearX = focusX;
    nearZ = focusZ;
    nearEdges.length = 0;
    nearSignals.length = 0;
    for (const e of edges) {
      const s = clamp((focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz, 0, e.len);
      const dx = e.sx + e.dx * s - focusX, dz = e.sz + e.dz * s - focusZ;
      if (dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearEdges.push(e);
    }
    for (const n of nodes) {
      const dx = n.x - focusX, dz = n.z - focusZ;
      if (n.signal && dx * dx + dz * dz < NEAR_RADIUS * NEAR_RADIUS) nearSignals.push(n);
    }
  }

  // Where the player is relative to v: metres ahead, metres to the right, and how fast it moves v's way
  function relateToPlayer(v) {
    v.pAhead = Infinity;
    if (!player.active) return;
    const dx = player.x - v.x;
    const dz = player.z - v.z;
    if (Math.abs(dx) > LOOKAHEAD + 10 || Math.abs(dz) > LOOKAHEAD + 10) return;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    v.pAhead = dx * fx + dz * fz;
    v.pRight = dz * fx - dx * fz;
    v.pSpeed = Math.max(0, player.vx * fx + player.vz * fz);
  }

  // Gap to anyone knocked down (lying, getting up or walking back to the sidewalk) ahead in v's way
  function fallenGap(v) {
    const list = pedestrianSystem.fallen;
    let gap = Infinity;
    if (!list.length) return gap;
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    for (let i = 0; i < list.length; i++) {
      const dx = list[i].x - v.x, dz = list[i].z - v.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 0 || ahead > LOOKAHEAD) continue;
      if (Math.abs(dz * fx - dx * fz) > v.halfWidth + 1.1) continue;
      gap = Math.min(gap, ahead - v.half - 1.1);
    }
    return gap;
  }

  // Gap to the player if it is ahead in the lane whose centre is `off` metres to the right of v
  function playerGap(v, off) {
    if (v.pAhead < 0 || v.pAhead > LOOKAHEAD) return Infinity;
    if (Math.abs(v.pRight - off) > v.halfWidth + player.halfW + 0.4) return Infinity;
    return v.pAhead - v.half - player.halfL;
  }

  // =========================================================================
  // 5. DRIVING
  // =========================================================================
  // The lane nearest to `lane` that move m can be made from (m.out[i] is the lane lane i leads to, or -1)
  function nearestLane(m, lane) {
    let best = -1;
    for (let i = 0; i < m.out.length; i++) {
      if (m.out[i] >= 0 && (best < 0 || Math.abs(i - lane) < Math.abs(best - lane))) best = i;
    }
    return best;
  }

  // First vehicle ahead of position s in a lane list
  function ahead(list, s, v) {
    for (const o of list) if (o.s > s && o.v !== v) return o;
    return null;
  }

  // The front-most vehicle still approaching the end of a lane: not crossing at its end yet, though maybe still coming
  // out of the intersection at its start (at s < 0)
  function leadOf(list) {
    for (let k = list.length - 1; k >= 0; k--) if (!list[k].v.conn || list[k].s < 0) return list[k];
    return null;
  }

  // Intelligent Driver Model: acceleration on a free road, and the braking term for an obstacle `gap` metres
  // (bumper to bumper) ahead moving at `speed`
  const freeAcc = (v) => v.driver.a * (1 - (v.speed / v.v0) ** 4);
  function brake(v, gap, speed, s0 = v.driver.s0, T = v.driver.T) {
    const { a, b } = v.driver;
    const desired = s0 + Math.max(0, v.speed * T + (v.speed * (v.speed - speed)) / (2 * Math.sqrt(a * b)));
    return -a * (desired / Math.max(gap, 0.1)) ** 2;
  }
  // ...and for a line d metres ahead to stop s0 short of: no time gap to keep to a line
  const stopAt = (v, d, s0 = 1) => brake(v, d, 0, s0, 0);

  // Braking for the vehicle ahead of position s in a lane list; remembers the nearest one
  function follow(v, list, s) {
    const o = ahead(list, s, v);
    if (!o) return 0;
    const gap = o.s - o.v.half - s - v.half;
    if (gap > LOOKAHEAD) return 0;
    if (gap < v.gap) {
      v.gap = gap;
      v.leaderSpeed = o.v.speed;
    }
    return brake(v, gap, o.v.speed);
  }

  // Can v, d metres before a line, still stop at it braking no harder than its driver comfortably does?
  const canStopBefore = (v, d) => freeAcc(v) + stopAt(v, d) > -v.driver.b;

  // Braking for a red (or an amber with room to stop) at the end of edge f, `d` metres ahead
  function signalAhead(v, f, d) {
    if (v.isPolice || !f.to.signal || d > LOOKAHEAD) return 0;
    const phase = phaseOf(f);
    if (phase === 'green' || (phase === 'amber' && !canStopBefore(v, d))) return 0;
    return stopAt(v, d);
  }

  // Mostly straight on, sometimes a turn (buses keep to wide roads). Routes don't follow the camera;
  // distant vehicles are recycled instead. With `fromLane`, only moves the current lane allows.
  const weights = [];
  function chooseMove(v, fromLane) {
    const e = v.edge;
    let total = 0;
    for (let k = 0; k < e.moves.length; k++) {
      const m = e.moves[k];
      let w = m.turn === 'S' ? (v.bus ? 8 : 3) : 1;
      if (v.bus && m.turn !== 'S' && m.to.lanes.length < 2) w *= 0.05;
      if (fromLane) {
        if (m.out[v.lane] < 0) w = 0;
      } else if (Math.abs(nearestLane(m, v.lane) - v.lane) * 22 > e.len - v.s) {
        w *= 0.02; // too little road left to change lanes for it
      }
      weights[k] = w;
      total += w;
    }
    let r = Math.random() * total;
    let pick = null;
    for (let k = 0; k < e.moves.length; k++) {
      if (weights[k] <= 0) continue;
      pick = e.moves[k];
      r -= weights[k];
      if (r < 0) break;
    }
    // No move from this lane (a lane the road graph couldn't lead anywhere): take any move, changing lanes for it
    if (!pick && fromLane) return chooseMove(v, false);
    return pick || e.moves[0] || null;
  }

  // Could the vehicle of lane entry o, approaching the end of edge a, still stop easily before its line? Vehicles
  // already standing can; drivers who have been waiting a while accept any gap it can still stop for comfortably.
  function canStop(o, a, impatient) {
    const sp = o.v.speed;
    if (sp < 0.5) return true;
    const d = a.len - o.s - o.v.half;
    return impatient ? canStopBefore(o.v, d) : d > (sp * sp) / 5 + sp + 3;
  }

  // A left turn waits for oncoming traffic going straight or right (approach o); vehicles not on o yet haven't picked
  // their way on, and at a red, only police and those already committed to crossing still come. Waiting at the line, v
  // also takes turns with those waiting at theirs: whoever has waited longer goes first, if it has room to go.
  function yieldOncoming(o, impatient, v = null) {
    if (!o) return false;
    if (o.through > 0) return true;
    const red = o.to.signal && phaseOf(o) === 'red';
    for (const list of o.occ) {
      const lead = leadOf(list);
      if (!lead || (lead.v.edge === o && lead.v.move.turn === 'L')) continue;
      if (red && !lead.v.isPolice) continue;
      if (!canStop(lead, o, impatient)) return true;
      const u = lead.v;
      const j = u.edge === o ? u.move.out[u.lane] : -1;
      if (v && v.wait > 0 && u.wait > v.wait && j >= 0 && o.len - lead.s - u.half < 2 && room(u.move.to, j, u)) return true;
    }
    return false;
  }

  // How far along curve c, out of two-way edge e, v can pull forward before its front corner reaches the
  // oncoming lanes (left of the centre line): where it waits for a gap to turn left
  const corner = { x: 0, z: 0, dx: 0, dz: 1 };
  function yieldPoint(v, c, e) {
    let cs = 0;
    for (; cs < c.len; cs += 0.5) {
      curvePoint(c, cs + v.half, corner);
      const x = corner.x + corner.dz * v.halfWidth;
      const z = corner.z - corner.dx * v.halfWidth;
      if ((x - e.x0) * e.rx + (z - e.z0) * e.rz < 0.3) break;
    }
    return cs - 0.5;
  }

  // At unsignalized corners, give way to the main road. Police passing a non-green signal yield to approaching
  // cross traffic as well as vehicles already in the intersection, instead of treating the light as a clear road.
  function yieldToCrossTraffic(v, n) {
    for (const a of n.in) {
      if (n.signal ? a.axisIndex === v.edge.axisIndex : a.axisIndex !== 0) continue;
      for (const list of a.occ) {
        const lead = leadOf(list);
        if (lead && !canStop(lead, a, !n.signal && v.wait > 8)) return true;
      }
    }
    return false;
  }

  // Seconds v takes to cover dist metres from now, speeding up from rest if it has to
  const timeTo = (v, dist) => dist / Math.max(v.speed, Math.sqrt((v.driver.a * dist) / 2), 0.1);

  // Do people on crosswalk `side` have the WALK? Across the avenue with the cross street's traffic, across the street
  // with the avenue's.
  function walkOn(side) {
    return side >= 2 ? stWalk : aveWalk;
  }

  // May p step off the curb onto its crosswalk? On the WALK (early in the parallel traffic's green, so red for the
  // traffic arriving over it), once no vehicle is crossing it or committed to, and none is too close to stop
  function mayCross(p) {
    const n = p.node;
    if (!walkOn(p.side) || n.crossing[p.side] > 0) return false;
    const e = n.approach[p.side];
    if (!e) return true;
    for (const list of e.occ) {
      const lead = leadOf(list);
      if (lead && !canStop(lead, e, true)) return false;
    }
    return true;
  }

  // Will anyone on crosswalk `side` of n be within reach of the lane meeting it at `coord` between t0 and t1
  // seconds from now? Unless `onIt`, so is anyone waiting at the curb to step off, however far away: on the WALK, they
  // only wait for the vehicles already holding the crosswalk.
  function pedestrianOn(n, side, coord, t0, t1, onIt = false) {
    for (const p of n.walkers) {
      if (p.side !== side || (onIt && p.waiting)) continue;
      const toGo = (coord - p.coord) * p.dir; // metres p still has to walk to get there
      const avoiding = clock < p.avoidUntil;
      // Runners may enter a lane sooner, then slow or stop before clearing it.
      const fast = Math.max(p.speed, p.v, avoiding ? p.avoidSpeed : 0);
      const slow = Math.max(0.1, avoiding ? Math.min(p.speed, p.v, p.avoidSpeed) : p.speed);
      if (p.waiting || ((toGo + 2.6) / slow > t0 && (toGo - 2.6) / fast < t1)) return true;
    }
    return false;
  }

  // ...on the crosswalk v leaves the intersection over, while v, its front bumper d metres before it, passes? Once v
  // holds that crosswalk (it isn't waiting inside to turn), people at the curb wait for it.
  const pedsOut = (v, d) => d > 0 && pedestrianOn(v.edge.to, v.move.to.outSide, laneCoord(v.move.to, v.out), timeTo(v, d), timeTo(v, d + 3 + 2 * v.half), !v.yielding);

  // Must v, pulled into the intersection to turn, wait there: for people crossing its way out (`peds`) or, turning
  // left, for oncoming traffic?
  const holdsOn = (v, peds) => peds || (v.move.turn === 'L' && yieldOncoming(v.edge.opposite, false));

  // Of two vehicles on the same road headed for the same lane, the one whose front is nearer the line goes first (by
  // the front: a bus waiting at the line goes before the cars that pull up beside it)
  const precedence = (u, s) => s + u.half;

  // Would there be room for v in lane j of edge f if everyone headed there queued bumper to bumper behind its far
  // stop line? (An empty lane always has room, however short.) Vehicles take turns for it: whoever has waited longer
  // to go there from another side, or goes first from v's own road, counts as already in.
  function room(f, j, v) {
    let free = f.len - 1;
    for (const o of f.occ[j]) if (o.v !== v && o.s - o.v.half < f.len) free -= 2 * o.v.half + o.v.driver.s0;
    for (const a of f.from.in) {
      for (const list of a.occ) {
        const o = leadOf(list);
        if (!o || o.v.claimed || !o.v.move || o.v.move.to !== f || o.v.move.out[o.v.lane] !== j) continue;
        if (a === v.edge ? precedence(o.v, o.s) > precedence(v, v.s) : o.v.wait > v.wait) free -= 2 * o.v.half + o.v.driver.s0;
      }
    }
    return free >= Math.min(2 * v.half + 0.5, f.len - 1);
  }

  // Would v, crossing into lane j of f to arrive at position vs, come alongside another vehicle headed there, cut in
  // ahead of one closing in on it, or close in on one ahead in a lane beside (which it doesn't follow)? Turning buses
  // swing wide, so where a bus turns, the lanes either side count too, and for one turning beside v from v's road, so
  // does how far apart they start turning (the outer one has further to go: side by side on f may be one behind the
  // other at the line, and the other way round).
  function alongside(f, j, v, vs, turn) {
    for (let k = Math.max(0, j - 1); k <= Math.min(f.lanes.length - 1, j + 1); k++) {
      for (const o of f.occ[k]) {
        const swing = turn && (v.bus || o.v.bus);
        if (o.v === v || (k !== j && !swing)) continue;
        let lo = o.s - vs; // how far ahead of v o is
        let hi = lo;
        if (swing && o.v.edge === v.edge) {
          const atLine = (o.v.conn ? v.edge.len + o.v.cs : o.v.s) - v.s;
          lo = Math.min(lo, atLine);
          hi = Math.max(hi, atLine);
        }
        const closing = hi < 0 ? o.v.speed - v.speed : lo > 0 && k !== j ? v.speed - o.v.speed : 0;
        const w = o.v.half + v.half + 1 + 2 * Math.max(0, closing);
        if (lo < w && hi > -w) return true;
      }
    }
    return false;
  }

  // Is a bus at the line in the lane on the outside of v's turn? A bus starting to turn swings its tail out over it.
  function besideTail(v) {
    const e = v.edge;
    const k = v.lane + (v.move.turn === 'R' ? -1 : 1);
    const o = v.move.turn !== 'S' && k >= 0 && k < e.lanes.length ? leadOf(e.occ[k]) : null;
    return !!o && o.v.bus && o.v !== v && e.len - o.s - o.v.half < 2;
  }

  // The lead of another of v's lanes that goes first into lane j of f or, turning where a bus is involved, into a lane
  // beside it (turning buses swing wide): v falls in behind it. As an entry { v, s } of f's lane: where it would be on
  // f now.
  const merger = { v: null, s: 0 };
  function mergingAhead(v, f, j) {
    const e = v.edge;
    merger.v = null;
    for (let i = 0; i < e.lanes.length; i++) {
      const o = i === v.lane ? null : leadOf(e.occ[i]);
      if (!o || o.v === v || o.v.claimed || o.v.move.to !== f || precedence(o.v, o.s) <= precedence(v, v.s)) continue;
      if (o.v.bus && besideTail(o.v)) continue; // it waits for the bus beside its tail
      const oj = o.v.move.out[o.v.lane];
      if (oj < 0 || (oj !== j && !(Math.abs(oj - j) === 1 && v.move.turn !== 'S' && (v.bus || o.v.bus)))) continue;
      const s = o.s - e.len - connector(e, o.v.lane, f, oj).len;
      if (!merger.v || s < merger.s) {
        merger.v = o.v;
        merger.s = s;
      }
    }
    return merger.v ? merger : null;
  }

  // May v, its front bumper d metres before the stop line, enter the intersection now? Sets the exit lane.
  // Once too close to stop, v is committed: it goes, and holds the intersection from then on.
  function mayEnter(v, d) {
    const e = v.edge;
    const n = e.to;
    const phase = n.signal ? phaseOf(e) : 'green';
    // Could it still stop? For a light that isn't green, also by crawling up to it, closer than it stops for lines
    const stoppable = canStopBefore(v, d) || (phase !== 'green' && v.speed * v.speed < 2 * v.driver.b * d);
    if (stoppable) v.commit = null; // could stop after all: decide afresh
    if (v.commit === n) return true;
    if (v.move.out[v.lane] < 0) {
      // missed the lane for the planned move: go wherever this lane goes instead
      if (d > 12) return false;
      v.move = chooseMove(v, true);
    }
    const m = v.move;
    const f = m.to;
    const j = m.out[v.lane];
    if (!(j >= 0 && j < f.lanes.length)) {
      if (!mayEnter.warned) {
        mayEnter.warned = true;
        console.warn('[traffic] lane leads nowhere', { lane: v.lane, lanes: e.lanes.length, out: m.out.slice(), moves: e.moves.length, x: Math.round(v.x), z: Math.round(v.z) });
      }
      return false;
    }
    if (!v.isPolice && (phase === 'red' || (phase === 'amber' && stoppable))) return false;
    if (boxBusy(n, e.axisIndex)) return false; // crossing traffic inside
    const lead = ahead(e.occ[v.lane], v.s, v);
    if (lead && lead.v.yielding) return false; // the vehicle ahead waits inside to turn: wait behind the line
    if (v.bus && besideTail(v)) return false; // its tail would swing out over that bus as it starts to turn
    // At a signal, the first in line to turn pulls into the intersection to wait there for the people crossing the
    // road it turns into (they walk on the same green): short of their crosswalk or, turning left across oncoming
    // traffic, short of the oncoming lanes until there is a gap. The light changing stops both for it at the latest.
    const c = connector(e, v.lane, f, j);
    const first = n.signal && (!v.isPolice || phase === 'green') && m.turn !== 'S' && !lead;
    const across = m.turn === 'L' && !!e.opposite;
    const wait = first ? (across ? yieldPoint(v, c, e) : c.len - 3 - v.half) : -1; // < 0: no room inside to wait
    if (m.turn === 'L' ? across && wait < 0 && yieldOncoming(e.opposite, v.wait > 8, v) : e.opposite && e.opposite.lefts > 0) return false;
    if ((n.signal ? v.isPolice && phase !== 'green' : e.axisIndex !== 0) && yieldToCrossTraffic(v, n)) return false;
    // nobody on the crosswalks while it passes over them, on the way in and on the way out, and a free place to
    // clear the intersection to, taking turns with lanes merging into it
    if (pedestrianOn(n, e.inSide, laneCoord(e, v.lane), 0, timeTo(v, d + 2.5 + 2 * v.half))) return false;
    if (wait < 0 && pedestrianOn(n, f.outSide, laneCoord(f, j), timeTo(v, d + c.len - 3), timeTo(v, d + c.len + 2 * v.half))) return false;
    const vs = v.s - e.len - c.len; // where on f it would be now
    if (!room(f, j, v) || alongside(f, j, v, vs, m.turn !== 'S') || mergingAhead(v, f, j)) return false;
    v.out = j;
    v.yielding = wait >= 0;
    v.yieldAt = wait;
    if (!stoppable) {
      v.commit = n;
      claim(v); // at once, so vehicles and pedestrians deciding later this frame know
    }
    return true;
  }

  // Overtake into an adjacent lane when it is clearly quicker (MOBIL), or work towards a lane the planned turn
  // can be made from; either only if neither v nor its new follower has to brake hard for it. Not while still
  // pulling out of an intersection or dodging the player, nor in the last 12 m before the next.
  function changeLanes(v) {
    const e = v.edge;
    if (v.conn || v.commit || v.panic) return;
    if (Math.abs(v.dl) > 0.5 || v.s < v.half || e.len - v.s - v.half < 12) return;
    let target = -1;
    if (v.move.out[v.lane] < 0) {
      const t = v.lane + Math.sign(nearestLane(v.move, v.lane) - v.lane);
      if (laneSafe(v, t, -4)) target = t;
    } else if (v.speed > 2) {
      let best = laneAcc(v, v.lane) + 0.6;
      for (let t = v.lane - 1; t <= v.lane + 1; t += 2) {
        if (t < 0 || t >= e.lanes.length || v.move.out[t] < 0 || !laneSafe(v, t, -3)) continue;
        const acc = laneAcc(v, t);
        if (acc > best) {
          best = acc;
          target = t;
        }
      }
    }
    if (target < 0) return;
    v.dl += e.lanes[v.lane] - e.lanes[target]; // same spot, now measured from the new lane's centre
    v.lane = target;
    v.trail = null;
  }

  // Can v move into lane t leaving itself and its new follower at least bSafe (negative) acceleration?
  function laneSafe(v, t, bSafe) {
    let lead = null;
    let back = null;
    for (const o of v.edge.occ[t]) {
      if (o.v === v) continue;
      if (o.s > v.s) {
        lead = o;
        break;
      }
      back = o;
    }
    if (lead) {
      const gap = lead.s - lead.v.half - v.s - v.half;
      if (gap < 1.5 || freeAcc(v) + brake(v, gap, lead.v.speed) < bSafe) return false;
    }
    if (back) {
      const f = back.v;
      const gap = v.s - v.half - back.s - f.half;
      if (gap < 1.5 || freeAcc(f) + brake(f, gap, v.speed) < bSafe) return false;
    }
    const off = v.edge.lanes[t] - v.edge.lanes[v.lane] - v.dl;
    const reach = v.half + player.halfL + 6;
    return !(Math.abs(v.pRight - off) < v.halfWidth + player.halfW + 0.4 && v.pAhead > -reach && v.pAhead < reach);
  }

  // Acceleration v would have in lane t behind the vehicle (or player) ahead there
  function laneAcc(v, t) {
    const o = ahead(v.edge.occ[t], v.s, v);
    let worst = o ? brake(v, o.s - o.v.half - v.s - v.half, o.v.speed) : 0;
    const pg = playerGap(v, v.edge.lanes[t] - v.edge.lanes[v.lane] - v.dl);
    if (pg < LOOKAHEAD) worst = Math.min(worst, brake(v, pg, v.pSpeed));
    return freeAcc(v) + worst;
  }

  // Fastest v can take curve c at without exceeding the sideways acceleration its driver accepts
  const bendSpeed = (v, c) => Math.sqrt(v.driver.aLat / Math.max(c.curv, 1e-3));

  // IDM acceleration for vehicles ahead in the lane (and, through the intersection, in the lane it leads to),
  // the stop line while v may not go, a red beyond, the player, and slowing down for turns and give-way lines
  function accelerate(v) {
    const e = v.edge;
    let worst = 0;
    let cap = Infinity;
    v.gap = Infinity;
    if (!v.conn) {
      worst = follow(v, e.occ[v.lane], v.s);
      const side = straddle(v);
      if (side) worst = Math.min(worst, follow(v, e.occ[v.lane + side], v.s));
      const d = e.len - v.s - v.half;
      if (d < LOOKAHEAD) {
        const go = mayEnter(v, d);
        const f = v.move.to;
        const j = v.move.out[v.lane];
        const c = j < 0 ? null : connector(e, v.lane, f, j);
        const vs = c ? v.s - e.len - c.len : 0; // position on f, measured from its start
        if (!go) {
          worst = Math.min(worst, stopAt(v, d));
        } else {
          worst = Math.min(worst, follow(v, f.occ[j], vs), signalAhead(v, f, f.len - vs - v.half));
          // pulling in to wait inside: slow down for that spot already if it will have to wait there
          if (v.yielding && holdsOn(v, pedsOut(v, d + c.len - 3))) worst = Math.min(worst, stopAt(v, d + v.half + v.yieldAt, 0.5));
        }
        // easing off to fall in behind a vehicle from another lane merging ahead into the same lane (unless committed:
        // then the others wait for v)
        const o = c && !v.claimed && mergingAhead(v, f, j);
        if (o) worst = Math.min(worst, Math.max(-v.driver.b, brake(v, o.s - o.v.half - vs - v.half, o.v.speed)));
        let vt = c ? bendSpeed(v, c) : Infinity;
        const cautious = e.to.signal ? v.isPolice && phaseOf(e) !== 'green' : e.axisIndex !== 0;
        if (cautious) vt = Math.min(vt, 5);
        cap = Math.sqrt(vt * vt + 5 * Math.max(0, d));
      }
    } else {
      const f = v.move.to;
      const vs = v.cs - v.conn.len;
      worst = Math.min(follow(v, f.occ[v.out], vs), follow(v, e.occ[v.lane], e.len + v.cs), signalAhead(v, f, f.len - vs - v.half));
      // someone crossing the way out: wait for them inside the intersection, short of the 2.5 m crosswalk
      const d = v.conn.len - 3 - v.cs - v.half;
      const peds = pedsOut(v, d);
      if (v.yielding && v.cs < v.yieldAt && holdsOn(v, peds)) {
        worst = Math.min(worst, stopAt(v, v.yieldAt - v.cs, 0.5)); // waiting inside to turn
      } else {
        if (v.yielding) cross(v);
        if (peds) worst = Math.min(worst, stopAt(v, d, 0.5));
      }
      cap = bendSpeed(v, v.conn);
    }
    // (a player alongside, not yet clear ahead, isn't one to follow; nor is one it is swerving round: dodge brakes then)
    const pg = v.panic && v.evadeSide ? Infinity : playerGap(v, 0);
    if (pg > 0 && pg < LOOKAHEAD) {
      worst = Math.min(worst, brake(v, pg, v.pSpeed));
      if (pg < v.gap) {
        v.gap = pg;
        v.leaderSpeed = v.pSpeed;
      }
    }
    const fg = fallenGap(v);
    if (fg < LOOKAHEAD) {
      worst = Math.min(worst, brake(v, Math.max(0, fg), 0));
      if (fg < v.gap) {
        v.gap = Math.max(0, fg);
        v.leaderSpeed = 0;
      }
    }
    const acc = Math.min(freeAcc(v) + worst, (cap - v.speed) * 2);
    v.acc = clamp(acc, -9, v.driver.a);
    // dodging the player (see dodge): braking, or flooring it (unless it must brake for something ahead)
    if (v.panic && v.panicAcc < 0) v.acc = Math.min(v.acc, v.panicAcc);
    else if (v.panic && v.panicAcc > 0 && v.acc > -v.driver.b && v.speed < 1.5 * v.v0) v.acc = Math.max(v.acc, v.panicAcc);
  }

  // Dodging the player. A driver watches the player's course (curving as the player steers) against its own over the
  // next AVOID_NOTICE seconds. If they would meet (closer than AVOID_MARGIN), it has seen the stretch of road the player
  // will sweep across while level with it, and reacts once it has seen that for its reaction time: it steers the least
  // it must, right or left of its lane, to clear that stretch (the side the road and the traffic around it leave room
  // on; on a near tie the right, away from oncoming traffic), braking as it does, or braking hard if there is no way
  // out. From behind, it floors it instead. It sounds its horn as it reacts, and re-judges every frame, so a player
  // who swerves the same way is not driven into; it keeps up its manoeuvre until the danger has passed for AVOID_HOLD.
  function react(v, dt) {
    if (!player.active || v.impactTime > 0 || clock < v.shaken) {
      calm(v);
      return;
    }
    const d = assess(v);
    if (d.time < AVOID_NOTICE) v.lastDanger = clock;
    if (!v.panic) {
      if (d.time >= AVOID_NOTICE) {
        v.alarm = 0;
        return;
      }
      v.alarm += dt;
      if (v.alarm < v.reaction) return;
      v.panic = true;
      v.warning = true;
    } else if (clock - v.lastDanger > AVOID_HOLD) {
      calm(v);
      return;
    }
    if (d.time < AVOID_NOTICE) dodge(v, d);
  }

  function calm(v) {
    v.panic = v.warning = false;
    v.evade = v.evadeSide = v.panicAcc = v.alarm = 0;
  }

  // The player's position and heading t seconds on, at its speed and turning as it is (no faster than people keep
  // turning: AVOID_TURN)
  const course = { x: 0, z: 0, fx: 0, fz: 1 };
  function predictPlayer(t, out) {
    const w = clamp(player.yawRate, -AVOID_TURN, AVOID_TURN);
    const a = w * t;
    if (Math.abs(a) < 1e-4) {
      out.x = player.x + player.vx * t;
      out.z = player.z + player.vz * t;
    } else {
      // its velocity, turning through a as it goes (heading h -> h + a), integrated
      const sin = Math.sin(a), cos = Math.cos(a);
      out.x = player.x + (player.vx * sin + player.vz * (1 - cos)) / w;
      out.z = player.z + (player.vx * (cos - 1) + player.vz * sin) / w;
    }
    const sin = Math.sin(a), cos = Math.cos(a);
    out.fx = player.fx * cos + player.fz * sin;
    out.fz = player.fz * cos - player.fx * sin;
    return out;
  }

  // How v and the player would meet, both keeping on as they go (v down its path at its speed): seconds until the
  // player would come within AVOID_MARGIN of v (Infinity if not within AVOID_NOTICE), whether at v's front half or
  // its rear, whether crossing v's way, and the stretch of road across v's path the player sweeps while level with it
  // ([lo, hi], metres right of v's path, the player's width included)
  const danger = { time: Infinity, front: true, crossing: false, lo: 0, hi: 0 };
  function assess(v) {
    danger.time = Infinity;
    if (!player.active || Math.abs(player.x - v.x) > 90 || Math.abs(player.z - v.z) > 90) return danger;
    // v's path through where it is (dl is measured from it), along (tx, tz), to the right (-tz, tx)
    const ox = v.x + v.tz * v.dl, oz = v.z - v.tx * v.dl;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k * AVOID_STEP <= AVOID_NOTICE + 1e-6; k++) {
      const t = k * AVOID_STEP;
      predictPlayer(t, course);
      const rx = course.x - ox, rz = course.z - oz;
      const along = rx * v.tx + rz * v.tz - v.speed * t;
      const across = rz * v.tx - rx * v.tz;
      // the player's half extents along and across v's path, as it is turned
      const c = Math.abs(course.fx * v.tx + course.fz * v.tz), s = Math.abs(course.fz * v.tx - course.fx * v.tz);
      if (Math.abs(along) > v.half + player.halfL * c + player.halfW * s + AVOID_MARGIN) continue;
      const half = player.halfL * s + player.halfW * c;
      lo = Math.min(lo, across - half);
      hi = Math.max(hi, across + half);
      if (danger.time === Infinity && Math.abs(across - v.dl) < half + spread(v) + AVOID_MARGIN) {
        danger.time = t;
        // (coming at v rather than catching up with it from behind)
        danger.front = player.vx * v.tx + player.vz * v.tz < v.speed;
        // the player coming across v's way rather than along it
        danger.crossing = Math.abs(player.vz * v.tx - player.vx * v.tz) > Math.abs(player.vx * v.tx + player.vz * v.tz);
      }
    }
    danger.lo = lo;
    danger.hi = hi;
    return danger;
  }

  // How far v reaches across its path either side, as it is turned (at an angle, its corners reach further)
  function spread(v) {
    return v.halfWidth * Math.cos(v.nose) + v.half * Math.abs(Math.sin(v.nose));
  }

  // Get out of the way the danger leaves (see react), the way that gets it clear soonest: each way out is how far it
  // must move across, how much of that the road and the traffic around it leave room for, and whether it can make it
  // in time; round the player's far side (across its path) only if it can. Sticking to the way it has taken unless the
  // other is clearly better (the right on a near tie), a little further than it must if it can. Braking lightly as it
  // swerves (a car can only move across as fast as it moves along: AVOID_BRAKE), hard for a player crossing its way or
  // with no way clear (edging away from the player as far as there is room then); flooring it for a player coming up
  // from behind
  function dodge(v, d) {
    const need = v.halfWidth + AVOID_MARGIN;
    // the nearest places clear of the player's stretch either side, in metres right of v's path
    const right = d.hi + need, left = d.lo - need;
    const t = Math.max(d.time, 0.5);
    // how far it can move across in that time: at about the tyres' grip, no faster than its speed lets it, after the
    // moment it takes to turn the wheel
    const steering = Math.max(0, t - 0.3);
    const reach = Math.min(0.35 * v.driver.grip * steering * steering, 0.45 * v.speed * steering);
    const middle = (d.lo + d.hi) / 2;
    let side = 0, move = 0, room = 0, best = Infinity;
    for (const s of [1, -1]) {
      const m = s > 0 ? Math.max(0, right - v.dl) : Math.max(0, v.dl - left);
      if ((middle - v.dl) * s > 0.4 && m >= reach) continue; // (the player clearly that side)
      let r = 0;
      for (const f of [1, 0.75, 0.5, 0.25]) {
        if (m * f < AVOID_REACH && clearTo(v, v.dl + s * m * f, t)) {
          r = m * f;
          break;
        }
      }
      if (r === 0 && m > 0) continue;
      const bias = v.evadeSide === s ? AVOID_SWITCH : !v.evadeSide && s > 0 ? 0.5 : 0;
      const cost = 3 * (m - r) + m + Math.max(0, m - reach) - bias;
      if (cost < best) {
        best = cost;
        side = s;
        move = m;
        room = r;
      }
    }
    v.evadeSide = side;
    const clear = side !== 0 && room >= move;
    if (!clear) {
      v.evade = v.dl + side * room;
    } else {
      const goal = side > 0 ? right : left;
      const further = goal + side * AVOID_MARGIN;
      const aim = Math.abs(further - v.dl) < AVOID_REACH && clearTo(v, further, t) ? further : goal;
      v.evade = side > 0 ? Math.max(v.dl, aim) : Math.min(v.dl, aim);
    }
    if (!d.front) v.panicAcc = 1.5 * v.driver.a;
    else v.panicAcc = clear && !d.crossing ? -AVOID_BRAKE : -v.driver.bMax;
  }

  // Could v be `target` metres right of its path for the next t seconds: its outer side on the road (with room to
  // spare for overshooting a little), and clear of the vehicles around it as they go on?
  function clearTo(v, target, t) {
    const ox = v.x + v.tz * v.dl, oz = v.z - v.tx * v.dl;
    const outer = target + Math.sign(target - v.dl || 1) * (v.halfWidth + 0.4);
    for (const a of [0, v.half, v.half + v.speed * t]) {
      if (!network.isRoadClear(ox + v.tx * a - v.tz * outer, oz + v.tz * a + v.tx * outer, 0.2)) return false;
    }
    for (const o of vehicles) {
      if (o === v || !o.edge) continue;
      const rx = o.x - ox, rz = o.z - oz;
      if (Math.abs(rx) > 60 || Math.abs(rz) > 60) continue;
      const heading = o.yaw + o.yawOffset;
      const fx = Math.sin(heading), fz = Math.cos(heading);
      const c = Math.abs(fx * v.tx + fz * v.tz), s = Math.abs(fz * v.tx - fx * v.tz);
      for (const tt of [0, t * 0.5, t]) {
        const x = rx + (fx * o.speed + o.vx) * tt, z = rz + (fz * o.speed + o.vz) * tt;
        const along = x * v.tx + z * v.tz - v.speed * tt;
        const across = z * v.tx - x * v.tz;
        if (Math.abs(along) < v.half + o.half * c + o.halfWidth * s
          && Math.abs(across - target) < v.halfWidth + o.halfWidth * c + o.half * s + 0.3) return false;
      }
    }
    return true;
  }

  // Front bumper at the stop line: cross if allowed, or if going too fast to stop; otherwise wait there
  function enter(v) {
    const e = v.edge;
    if (!mayEnter(v, 0)) {
      const j = v.move.out[v.lane];
      if (v.speed < 4 || j < 0) {
        v.s = e.len - v.half;
        v.speed = 0;
        return;
      }
      v.out = j;
      v.yielding = false;
    }
    v.cs = v.s - e.len;
    v.conn = connector(e, v.lane, v.move.to, v.out);
    claim(v); // at once, so vehicles deciding later this frame know
  }

  function leave(v) {
    v.s = v.cs - v.conn.len;
    v.edge = v.move.to;
    v.lane = v.out;
    v.trail = v.conn; // the rear axle is still on it
    v.conn = null;
    v.commit = null;
    v.move = chooseMove(v, false);
  }

  function drive(v, dt) {
    v.laneTimer -= dt;
    if (v.laneTimer <= 0) {
      v.laneTimer = 0.4 + Math.random() * 0.3;
      changeLanes(v);
    }
    accelerate(v);
    // Give the driver a moment to recover after an impact before accelerating again.
    v.impactTime = Math.max(0, v.impactTime - dt);
    if (v.impactTime > 0) v.acc = Math.min(0, v.acc);
    // after a crash: to a stop, and staying there for a while (see impact)
    if (clock < v.shaken) v.acc = Math.min(v.acc, -0.75 * v.driver.bMax);
    const speed = v.speed;
    v.speed = Math.max(0, v.speed + v.acc * dt);
    let ds = v.speed * Math.cos(v.nose) * dt; // (along its path, heading off it as it may be)
    if (v.impactTime === 0 && ds > v.gap - 0.3) {
      // never into the vehicle ahead
      ds = Math.max(0, v.gap - 0.3);
      v.speed = Math.min(v.speed, v.leaderSpeed);
    }
    v.acc = Math.max(-9, (v.speed - speed) / dt); // as driven, for the body to pitch with: none standing still
    v.wait = v.speed < 0.5 ? v.wait + dt : 0;
    if (!v.conn) {
      v.s += ds;
      if (v.s + v.half >= v.edge.len) enter(v);
    } else {
      v.cs += ds;
      if (v.cs >= v.conn.len) leave(v);
    }
    steer(v, dt);
  }

  // The driver at the wheel. It steers for the bend in its path a moment ahead (on through the intersection ahead the
  // way it plans to cross it), to head along its path, and back onto it: onto its lane centre after lane changes and
  // knocks, or right of it by however far it swerves out of the player's way (Stanley steering). It turns the front
  // wheels no faster than a person does and no further than it is comfortable with (or, in a panic, than the tyres
  // grip). The car turns only as fast as its front wheels turn it, the tyres sliding at their grip; a knock's spin
  // turns it too, the tyres scrubbing that off. Heading off its path, it drifts across it.
  const bendA = { x: 0, z: 0, dx: 0, dz: 1 };
  const bendB = { x: 0, z: 0, dx: 0, dz: 1 };
  function steer(v, dt) {
    const panic = !!v.evade;
    const wheelbase = 2 * v.axle;
    const c = v.conn ? v.cs : v.s;
    // the bend a moment ahead, as the wheel takes a while to turn: its curvature (to the left) over 2 m
    const ahead = v.axle + 0.5 * v.speed;
    previewPoint(v, c + ahead, bendA);
    previewPoint(v, c + ahead + 2, bendB);
    let bend = Math.atan2(bendB.dx, bendB.dz) - Math.atan2(bendA.dx, bendA.dz);
    bend -= Math.round(bend / (Math.PI * 2)) * Math.PI * 2;
    // ...plus how far right of its path it heads, and how far right of where it should be it is (nose and dl - evade)
    const off = v.dl - (v.evade || 0);
    const want = Math.atan((wheelbase * bend) / 2) + v.nose + Math.atan(((panic ? 3 : 1.2) * off) / (1 + v.speed));
    const lateral = panic ? v.driver.grip : 1.3 * v.driver.aLat; // the sideways acceleration it steers up to
    const most = Math.min(v.driver.lock, Math.atan((lateral * wheelbase) / Math.max(v.speed * v.speed, 1e-3)));
    const rate = v.driver.steerRate * (panic ? 3.5 : clamp(8 / Math.max(v.speed, 1), 1, 3)) * dt;
    v.delta += clamp(clamp(want, -most, most) - v.delta, -rate, rate);
    const slide = v.driver.grip / Math.max(v.speed, 0.1);
    v.yawRate = clamp((v.speed * Math.tan(v.delta)) / wheelbase, -slide, slide);
    v.yaw += (v.yawRate + v.yawVel) * dt;
    v.yaw -= Math.round(v.yaw / (Math.PI * 2)) * Math.PI * 2;
    v.yawVel -= Math.sign(v.yawVel) * Math.min(Math.abs(v.yawVel), SPIN_FRICTION * dt); // (the tyres scrubbing a spin off)
    // across its path, heading off it (nose: how far right of its path it heads)
    let nose = Math.atan2(v.tx, v.tz) - v.yaw;
    nose -= Math.round(nose / (Math.PI * 2)) * Math.PI * 2;
    v.dlv = v.speed * Math.sin(nose);
    v.dl += v.dlv * dt;
  }

  // Point and direction c metres along v's path, as pathPoint, but on through the intersection ahead the way v plans
  // to cross it
  function previewPoint(v, c, out) {
    const e = v.edge;
    const j = v.conn || c <= e.len ? -1 : v.move.out[v.lane];
    if (!(j >= 0)) return pathPoint(v, c, out);
    const k = connector(e, v.lane, v.move.to, j);
    if (c - e.len <= k.len) return curvePoint(k, c - e.len, out);
    return lanePoint(v.move.to, j, c - e.len - k.len, out);
  }

  // Point and direction at distance c along v's path: its lane, the curve through the intersection, and the
  // lane after it (or, just out of an intersection, the curve it came along)
  function lanePoint(e, i, s, out) {
    out.x = e.sx + e.dx * s + e.rx * e.lanes[i];
    out.z = e.sz + e.dz * s + e.rz * e.lanes[i];
    out.dx = e.dx;
    out.dz = e.dz;
    return out;
  }
  function pathPoint(v, c, out) {
    const e = v.edge;
    if (v.conn) {
      if (c < 0) return lanePoint(e, v.lane, e.len + c, out);
      if (c > v.conn.len) return lanePoint(v.move.to, v.out, c - v.conn.len, out);
      return curvePoint(v.conn, c, out);
    }
    if (c < 0 && v.trail) return curvePoint(v.trail, v.trail.len + c, out);
    return lanePoint(e, v.lane, c, out);
  }

  // World position from where v is along its path (dl to the right of it), the path's direction there, and how far
  // right of it v heads (nose)
  const at = { x: 0, z: 0, dx: 0, dz: 0 };
  function locate(v) {
    pathPoint(v, v.conn ? v.cs : v.s, at);
    v.tx = at.dx;
    v.tz = at.dz;
    v.x = at.x - at.dz * v.dl;
    v.z = at.z + at.dx * v.dl;
    const nose = Math.atan2(at.dx, at.dz) - v.yaw;
    v.nose = nose - Math.round(nose / (Math.PI * 2)) * Math.PI * 2;
  }

  // Move v along and across its path by (dx, dz), as far as the road allows: along within its path, across until its
  // side meets the curb (or SHOVE_REACH from its lane). Returns whether the curb stopped it
  function shove(v, dx, dz) {
    const along = dx * v.tx + dz * v.tz;
    if (v.conn) v.cs = clamp(v.cs + along, -v.half, v.conn.len - 0.01);
    else v.s = clamp(v.s + along, 0, v.edge.len - v.half);
    const to = clamp(v.dl + dz * v.tx - dx * v.tz, -SHOVE_REACH, SHOVE_REACH);
    let blocked = false;
    if (to !== v.dl && !sideOnRoad(v, to)) {
      // as far as it fits
      let lo = 0, hi = 1;
      for (let k = 0; k < 6; k++) {
        const mid = (lo + hi) / 2;
        if (sideOnRoad(v, v.dl + (to - v.dl) * mid)) lo = mid;
        else hi = mid;
      }
      v.dl += (to - v.dl) * lo;
      blocked = true;
    } else {
      v.dl = to;
    }
    locate(v);
    return blocked;
  }

  // Would v's side (the one towards `dl`) still be on the road, front and back, `dl` metres right of its path?
  const sidePoint = { x: 0, z: 0, dx: 0, dz: 0 };
  function sideOnRoad(v, dl) {
    pathPoint(v, v.conn ? v.cs : v.s, sidePoint);
    const outer = dl + Math.sign(dl - v.dl) * v.halfWidth;
    for (const a of [-0.8 * v.half, 0.8 * v.half]) {
      const x = sidePoint.x + sidePoint.dx * a - sidePoint.dz * outer;
      const z = sidePoint.z + sidePoint.dz * a + sidePoint.dx * outer;
      if (!network.isRoadClear(x, z, 0.05)) return false;
    }
    return true;
  }

  // Steering shown on the front wheels, turn signals, and body pitch & roll from acceleration & turning (the heading
  // itself is the driver's doing, see steer)
  function pose(v, dt) {
    v.steer = v.delta;

    const turn = v.move.turn;
    if (v.evade) v.blink = 0; // no time to signal a swerve
    else if (Math.abs(v.dl) > 0.3 && Math.abs(v.dlv) > 0.05) v.blink = v.dl > 0 ? -1 : 1;
    else if (turn !== 'S' && (v.conn || v.edge.len - v.s < 35)) v.blink = turn === 'R' ? 1 : -1;
    else v.blink = 0;

    v.pitchVel += ((-0.008 * v.acc - v.pitch) * 68.0 - v.pitchVel * 10.8) * dt;
    v.pitch = clamp(v.pitch + v.pitchVel * dt, -0.22, 0.22);
    v.rollVel += ((0.01 * v.speed * v.yawRate - v.roll) * 68.0 - v.rollVel * 10.8) * dt;
    v.roll = clamp(v.roll + v.rollVel * dt, -0.26, 0.26);
  }

  // Knock velocity from collisions (a sideways slide, a roll backwards) carries v along and across its path until the
  // tyres' grip stops it (SLIDE_FRICTION), or sideways, the curb does
  function knock(v, dt) {
    if (v.vx === 0 && v.vz === 0) return;
    if (shove(v, v.vx * dt, v.vz * dt)) {
      const across = v.vz * v.tx - v.vx * v.tz;
      v.vx += v.tz * across;
      v.vz -= v.tx * across;
    }
    const k = Math.hypot(v.vx, v.vz);
    const keep = Math.max(0, k - SLIDE_FRICTION * dt) / (k || 1);
    v.vx *= keep;
    v.vz *= keep;
  }

  const contactA = {}, contactB = {}, vehicleHit = {};
  const impacted = [];
  let collisionStep = 0;

  function readTrafficBody(v, body) {
    const heading = v.yaw + v.yawOffset;
    body.x = v.x; body.z = v.z;
    body.prevX = v.prevX; body.prevZ = v.prevZ;
    body.sin = Math.sin(heading); body.cos = Math.cos(heading);
    body.halfW = v.halfWidth;
    // Vehicles without their own collision size & mass count as sedans
    body.halfL = v.halfL ?? 2.18;
    body.mass = v.mass ?? 1600;
    body.vx = body.sin * v.speed + v.vx;
    body.vz = body.cos * v.speed + v.vz;
    body.angularVel = v.yawRate + v.yawVel;
  }

  function writeTrafficVelocity(v, body) {
    // Keep longitudinal momentum in the driving speed, so it does not disappear
    // with the short-lived tire slip. Traffic can be knocked backwards too.
    const hx = Math.sin(v.yaw + v.yawOffset);
    const hz = Math.cos(v.yaw + v.yawOffset);
    v.speed = Math.max(0, body.vx * hx + body.vz * hz);
    v.vx = body.vx - hx * v.speed;
    v.vz = body.vz - hz * v.speed;
    // the spin turns its heading (see steer)
    v.yawVel = body.angularVel - v.yawRate;
  }

  // A knock's toll on v, its velocity changed by dv along (nx, nz): the suspension's jolt, a moment off the throttle,
  // and after a real crash (dv over CRASH_SPEED) the driver stopping, hazards on, for 4 to 7 s (see drive, lampState)
  function impact(v, nx, nz, dv) {
    const along = nx * v.tx + nz * v.tz;
    const across = nx * v.tz - nz * v.tx;
    const kick = Math.min(10, dv);
    v.pitchVel += along * kick * 0.12;
    v.rollVel -= across * kick * 0.16;
    v.impactTime = Math.max(v.impactTime, 0.8);
    if (dv > CRASH_SPEED) v.shaken = Math.max(v.shaken, clock + 4 + Math.min(3, (dv - CRASH_SPEED) * 0.5));
  }

  // Do bodies a and b touch this frame (swept from where they were, or overlapping)? Then the contact is in vehicleHit,
  // its impulse applied to their velocities, and the speed they closed at is returned (0 just touching); else -1
  function touch(a, b) {
    if (!sweptVehicleContact(a, b, vehicleHit) && !vehicleContact(a, b, vehicleHit)) return -1;
    return resolveVehicleContact(a, b, vehicleHit);
  }

  // The sound and sparks of vehicleHit, `speed` hard, `y` up
  function crunch(a, b, y, speed) {
    const hit = vehicleHit;
    reportCollision(a, b, hit.x, y, hit.z, hit.nx, hit.nz, speed);
    if (speed > 2.2) spawnCollisionSparks(hit.x, y, hit.z, hit.nx, hit.nz, speed);
  }

  // The player (its car, bike or self) against traffic vehicle v: kept apart (the player taking the share v can't, held
  // by its path and the curb), momentum exchanged
  function collideWithPlayer(v) {
    const pe = player.entity;
    const reach = v.half + player.halfL + player.halfW;
    const prevX = pe.prevX ?? pe.position.x, prevZ = pe.prevZ ?? pe.position.z;
    const dx = pe.position.x - prevX - v.x + v.prevX;
    const dz = pe.position.z - prevZ - v.z + v.prevZ;
    if (Math.abs(pe.position.x - v.x) > reach + Math.abs(dx)
      || Math.abs(pe.position.z - v.z) > reach + Math.abs(dz)) return;
    const a = contactA, b = contactB, hit = vehicleHit;
    const heading = pe.heading || 0;
    a.x = pe.position.x; a.z = pe.position.z;
    a.prevX = prevX; a.prevZ = prevZ;
    a.sin = Math.sin(heading); a.cos = Math.cos(heading);
    a.halfW = player.halfW; a.halfL = player.halfL;
    a.mass = pe.type === 'car' ? 1700 : pe.type === 'cyclist' ? 95 : 80;
    a.vx = a.sin * (pe.speed || 0) + (pe.vx || 0);
    a.vz = a.cos * (pe.speed || 0) + (pe.vz || 0);
    a.angularVel = pe.type === 'car' ? pe.angularVel || 0 : 0;
    readTrafficBody(v, b);
    const speed = touch(a, b);
    if (speed < 0) return;
    const pShare = b.mass / (a.mass + b.mass);
    pe.position.x = hit.ax + hit.nx * hit.depth * pShare;
    pe.position.z = hit.az + hit.nz * hit.depth * pShare;
    shove(v, hit.bx - v.x - hit.nx * hit.depth * (1 - pShare), hit.bz - v.z - hit.nz * hit.depth * (1 - pShare));
    // what v's path or the curb kept it from taking
    const remainder = Math.max(0, hit.depth * (1 - pShare) + (v.x - hit.bx) * hit.nx + (v.z - hit.bz) * hit.nz);
    pe.position.x += hit.nx * remainder;
    pe.position.z += hit.nz * remainder;
    if (pe.mesh) pe.mesh.position.copy(pe.position);
    if (speed <= 0) return;

    writeTrafficVelocity(v, b);
    pe.speed = a.vx * a.sin + a.vz * a.cos;
    if (pe.type === 'car') {
      pe.vx = a.vx - a.sin * pe.speed;
      pe.vz = a.vz - a.cos * pe.speed;
      pe.angularVel = a.angularVel;
      const kick = Math.min(12, hit.impulse / a.mass);
      pe.pitchVel += (hit.nx * a.sin + hit.nz * a.cos) * kick * 0.16;
      pe.rollVel -= (hit.nx * a.cos - hit.nz * a.sin) * kick * 0.2;
      pe.heaveVel += Math.min(0.7, kick * 0.06);
    }
    impact(v, -hit.nx, -hit.nz, hit.impulse / b.mass);
    if (pe.type !== 'person') crunch(pe, v, 0.58, speed);
  }

  // Traffic against traffic. Only vehicles knocked about need pair contacts: they are queued, and so is each vehicle
  // they hit in turn, every pair met once a frame (before any instance matrices are written)
  function collideTraffic() {
    collisionStep++;
    impacted.length = 0;
    for (const v of vehicles) {
      if (v.edge && (v.impactTime > 0 || Math.abs(v.yawVel) > 0.05 || v.vx * v.vx + v.vz * v.vz > 0.04)) {
        v.contactStep = collisionStep;
        impacted.push(v);
      }
    }
    for (let i = 0; i < impacted.length; i++) {
      const v = impacted[i];
      for (const o of vehicles) {
        if (o === v || !o.edge || o.contactDone === collisionStep) continue;
        const reach = v.half + o.half + 0.5;
        const dx = v.x - o.x, dz = v.z - o.z;
        if (Math.abs(dx) > reach + Math.abs(dx - v.prevX + o.prevX)
          || Math.abs(dz) > reach + Math.abs(dz - v.prevZ + o.prevZ)) continue;
        readTrafficBody(v, contactA);
        readTrafficBody(o, contactB);
        const speed = touch(contactA, contactB);
        if (speed < 0) continue;
        const hit = vehicleHit;
        const share = contactB.mass / (contactA.mass + contactB.mass);
        shove(v, hit.ax - v.x + hit.nx * hit.depth * share, hit.az - v.z + hit.nz * hit.depth * share);
        shove(o, hit.bx - o.x - hit.nx * hit.depth * (1 - share), hit.bz - o.z - hit.nz * hit.depth * (1 - share));
        if (speed <= 0) continue;
        writeTrafficVelocity(v, contactA);
        writeTrafficVelocity(o, contactB);
        impact(v, hit.nx, hit.nz, hit.impulse / contactA.mass);
        impact(o, -hit.nx, -hit.nz, hit.impulse / contactB.mass);
        crunch(v, o, 0.56, speed);
        if (o.contactStep !== collisionStep) {
          o.contactStep = collisionStep;
          impacted.push(o);
        }
      }
      v.contactDone = collisionStep;
    }
  }

  // =========================================================================
  // 6. PLACING VEHICLES
  // =========================================================================
  // Room at s in a lane list: margin metres to the vehicles either side, and two seconds more for the one behind
  function laneClear(list, s, margin) {
    for (const o of list) if (Math.abs(o.s - s) < o.v.half + margin + (o.s < s ? 2 * o.v.speed : 0)) return false;
    return true;
  }

  function place(v, e, lane, s) {
    v.edge = e;
    v.lane = lane;
    v.s = s;
    v.conn = null;
    v.trail = null;
    v.commit = null;
    v.yielding = false;
    v.wait = 0;
    v.speed = v.v0 * 0.5;
    v.acc = 0;
    v.impactTime = 0;
    v.dl = v.dlv = 0;
    calm(v);
    v.shaken = 0;
    v.vx = v.vz = v.yawOffset = v.yawVel = v.pitch = v.pitchVel = v.roll = v.rollVel = 0;
    locate(v);
    v.prevX = v.x;
    v.prevZ = v.z;
    v.yaw = Math.atan2(v.tx, v.tz); // (placed heading down its lane)
    v.nose = v.yawRate = v.steer = v.delta = 0;
    v.move = chooseMove(v, false);
    occupy(e.occ[lane], v, s);
  }

  // Put v in a free lane around the focus. Normal replenishment protects the near view; teleports can fill it.
  function spawnVehicle(v, rMin, rMax, protectView) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const e = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      if (!e || (v.bus && e.axis !== 'ave') || e.len < 2 * v.half + 10) continue;
      const lane = Math.floor(Math.random() * e.lanes.length);
      const along = (focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz;
      const minS = Math.max(v.half + 5, along - rMax);
      const maxS = Math.min(e.len - v.half - 5, along + rMax);
      if (minS > maxS) continue;
      const s = minS + Math.random() * (maxS - minS);
      const x = e.sx + e.dx * s + e.rx * e.lanes[lane];
      const z = e.sz + e.dz * s + e.rz * e.lanes[lane];
      const d = Math.hypot(x - focusX, z - focusZ);
      if (d < rMin || d > rMax || (protectView && nearView(x, z, v.half + 4, VEHICLE_SPAWN_DISTANCE))) continue;
      if (player.active && Math.hypot(x - player.x, z - player.z) < 25) continue;
      if (!laneClear(e.occ[lane], s, v.half + 8)) continue;
      place(v, e, lane, s);
      return true;
    }
    return false;
  }

  // =========================================================================
  // 7. RENDERING
  // =========================================================================
  // Beyond CAR_PROXY_DISTANCE, cars use the ~250-triangle stand-in with built-in wheels instead of the full lofted
  // body + 4 separate wheel instances; vehicles outside the view frustum (with a margin for cast shadows and headlight
  // cones) are skipped altogether.
  const CAR_PROXY_DISTANCE = 90;
  const carAttributes = createCarAttributes();
  let dirtyWheelStyles = false;
  const litVehicles = [];
  let litVehicleCount = 0;
  let wheelCars = 0;
  let visibleCars = 0;
  const policeDrawn = { sedan: 0, suv: 0 };
  let visibleBuses = 0;
  let updates = 0;

  // Wheels roll with the distance v travelled along its heading this frame (at most about a twelfth of a turn a frame,
  // so they never seem to spin backwards)
  function spinWheels(v, sinY, cosY, radius) {
    const forwardDist = (v.x - v.prevX) * sinY + (v.z - v.prevZ) * cosY;
    const rawStep = forwardDist / radius;
    v.wheelSpin = (v.wheelSpin + Math.sign(rawStep) * Math.min(Math.abs(rawStep), 0.48)) % (Math.PI * 2);
  }

  // 3D spinning alloy wheels & tires (left & right, front & rear), exact 1:1 ground rolling, steering front wheels.
  // The wheel geometry is modelled at baseRadius (the sedan's 0.35 m car wheel), scaled to the vehicle's radius
  function placeWheels(v, i, rotY, roll, radius, halfTrack, halfBase, leftInst, rightInst, baseRadius = 0.35) {
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const scale = radius / baseRadius;
    dummy.scale.set(scale, scale, scale);
    for (let w = 0; w < 2; w++) {
      const wz = w === 0 ? halfBase : -halfBase;
      dummy.rotation.set(v.wheelSpin + w * 0.55, rotY + (w === 0 ? v.steer : 0), roll, 'YXZ');
      dummy.position.set(v.x - halfTrack * cosY + wz * sinY, radius, v.z + halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      leftInst.setMatrixAt(i * 2 + w, dummy.matrix);

      dummy.position.set(v.x + halfTrack * cosY + wz * sinY, radius, v.z - halfTrack * sinY + wz * cosY);
      dummy.updateMatrix();
      rightInst.setMatrixAt(i * 2 + w, dummy.matrix);
    }
  }

  // Lamp state for the car & bus materials: brake lights while slowing down or standing, the turn signal on the side
  // v is heading for (left = +x)
  const lamps = [0, 0, 0];
  function lampState(v) {
    const hazard = clock < v.shaken; // (after a crash, see impact)
    const blinkOn = (v.blink !== 0 || hazard) && (clock + v.blinkPhase) % 0.8 <= 0.4;
    lamps[0] = v.acc < -0.8 || v.speed < 0.3 ? 1 : 0;
    lamps[1] = blinkOn && (v.blink < 0 || hazard) ? 1 : 0;
    lamps[2] = blinkOn && (v.blink > 0 || hazard) ? 1 : 0;
    return lamps;
  }

  // Queues v for a pair of headlights from the pool (and a police light) if it is near the camera
  function considerLit(v, sinY, cosY) {
    const dxCam = v.x - camX;
    const dzCam = v.z - camZ;
    const distSq = dxCam * dxCam + dzCam * dzCam + camY * camY;
    if (distSq >= MAX_LIGHT_DIST_SQ) return;
    const effDist = headlightDistance(Math.sqrt(distSq), dxCam * camFwdX + dzCam * camFwdZ);
    if (effDist >= MAX_LIGHT_DIST) return;
    v._effDist = effDist;
    v._sinY = sinY;
    v._cosY = cosY;
    litVehicles[litVehicleCount++] = v;
  }

  function renderCar(c) {
    const rotY = c.yaw + c.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    const spec = BODY_SPECS[c.bodyType];
    spinWheels(c, sinY, cosY, spec.wheelRadius);
    if (hasView && !visible(c.x, c.z, 18)) return;

    const near = Math.hypot(c.x - focusX, c.z - focusZ) < CAR_PROXY_DISTANCE;
    const bodyInst = near ? bodies[c.bodyType].near : bodies[c.bodyType].far;
    const slot = bodyInst.count++;

    dummy.position.set(c.x, 0.0, c.z);
    dummy.rotation.set(c.pitch, rotY, c.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bodyInst.setMatrixAt(slot, dummy.matrix);
    if (c.isPolice) {
      const lb = policeLightbars[c.bodyType];
      if (lb) lb.setMatrixAt(policeDrawn[c.bodyType]++, dummy.matrix);
    }

    const L = lampState(c);
    carAttributes.write(bodyInst, slot, c.paint, L[0], L[1], L[2], c.style);

    // Soft Under-Car Contact Shadow (AO) stays flat on the asphalt, sized to the body kind
    const visIdx = visibleCars++;
    const [shadowW, shadowL, shadowZ] = bodies[c.bodyType].shadow;
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.position.set(c.x + sinY * shadowZ, 0.018, c.z + cosY * shadowZ);
    dummy.scale.set(shadowW, 1.0, shadowL);
    dummy.updateMatrix();
    carShadowInst.setMatrixAt(visIdx, dummy.matrix);
    considerLit(c, sinY, cosY);

    if (near) {
      const wi = wheelCars * 2;
      const ws = carWheelStyles.array;
      if (ws[wi] !== c.style || ws[wi + 1] !== c.style) {
        ws[wi] = ws[wi + 1] = c.style;
        dirtyWheelStyles = true;
      }
      placeWheels(c, wheelCars++, rotY, c.roll, spec.wheelRadius, spec.wheelX, spec.wheelZ, carWheelLeftInst, carWheelRightInst);
    }
  }

  function renderBus(b) {
    const rotY = b.yaw + b.yawOffset;
    const sinY = Math.sin(rotY);
    const cosY = Math.cos(rotY);
    spinWheels(b, sinY, cosY, BUS_SPEC.wheelRadius);
    if (hasView && !visible(b.x, b.z, 22)) return;

    const i = visibleBuses++;
    dummy.position.set(b.x, 0.018, b.z);
    dummy.rotation.set(0, rotY, 0, 'YXZ');
    dummy.scale.set(2.92, 1.0, 12.4);
    dummy.updateMatrix();
    busShadowInst.setMatrixAt(i, dummy.matrix);

    // Lofted Bus Body is defined in ground-relative Y (0.35m skirt to 3.23m roof fairing crown)
    dummy.position.set(b.x, 0.0, b.z);
    dummy.rotation.set(b.pitch, rotY, b.roll, 'YXZ');
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    busBodyInst.setMatrixAt(i, dummy.matrix);
    busHeaderInst.setMatrixAt(i, dummy.matrix);
    busStates.array.set(lampState(b), i * 4);
    busStates.array[i * 4 + 3] = (b.variant ?? i) + 1;
    considerLit(b, sinY, cosY);

    placeWheels(b, i, rotY, 0, BUS_SPEC.wheelRadius, BUS_SPEC.wheelX, BUS_SPEC.wheelZ, busWheelLeftInst, busWheelRightInst, BUS_SPEC.wheelRadius);
  }

  function smoothDistFade(d, start, end) {
    const t = clamp((end - d) / (end - start), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function updateTrafficLights() {
    litVehicles.length = litVehicleCount;
    if (litVehicleCount > 1) {
      litVehicles.sort((a, b) => a._effDist - b._effDist);
    }

    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = headlightBeamScale(glow);
    const tailScale = clamp(0.18 + glow * 0.66, 0.24, 1.22);

    const maxDualVehicles = HEADLIGHT_POOL_SIZE >> 1;
    const vehCutoff = litVehicleCount > maxDualVehicles
      ? Math.min(MAX_LIGHT_DIST, litVehicles[maxDualVehicles]._effDist)
      : MAX_LIGHT_DIST;
    let spotUsed = 0;
    if (beamScale > 0.001) {
      for (let i = 0; i < litVehicleCount && spotUsed + 2 <= HEADLIGHT_POOL_SIZE; i++) {
        const v = litVehicles[i];
        const fade = smoothDistFade(v._effDist, vehCutoff * 0.62, vehCutoff);
        if (fade <= 0.001) continue;
        const spec = v.bus ? BUS_SPEC : BODY_SPECS[v.bodyType];
        const fullReach = HEADLIGHTS.distance;
        let maxReach = fullReach;
        if (player.active && v.pAhead > 0 && v.pAhead < 30) {
          const latWeight = smoothDistFade(Math.abs(v.pRight), 2.2, 5.5);
          const clampedReach = Math.max(4.5, v.pAhead - player.halfL - 1.5);
          maxReach = fullReach + (clampedReach - fullReach) * latWeight;
        }

        const baseInt = (v.bus ? HEADLIGHTS.busIntensity : HEADLIGHTS.intensity) * beamScale * fade;
        // Match the body instance, including suspension and impact rotation.
        dummy.position.set(v.x, 0, v.z);
        dummy.rotation.set(v.pitch, v.yaw + v.yawOffset, v.roll, 'YXZ');
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        for (let side = -1; side <= 1; side += 2) {
          const spot = headlightPool[spotUsed++];
          placeVehicleHeadlight(spot, spec, side, dummy.matrix);
          spot.distance = maxReach;
          spot.intensity = baseInt;
        }
      }
    }
    parkHeadlights(headlightPool, spotUsed);

    // 1. NYPD emergency roof lightbar flashes (smoothly pulsing red/blue 360° PointLights on nearby patrol cruisers)
    let policeLightsUsed = 0;
    for (let i = 0; i < litVehicleCount && policeLightsUsed < POLICE_LIGHT_POOL_SIZE; i++) {
      const v = litVehicles[i];
      if (!v.isPolice || v._effDist >= 88) continue;
      const fade = smoothDistFade(v._effDist, 52, 88);
      if (fade <= 0.001) continue;
      const wave = Math.sin((clock + v.blinkPhase) * Math.PI * 6.0);
      const redPhase = wave >= 0;
      const pulse = 0.35 + 0.65 * Math.abs(wave);
      const side = redPhase ? -0.36 : 0.36;
      const pt = policeLightPool[policeLightsUsed++];
      pt.color.setHex(redPhase ? 0xff1828 : 0x1868ff);
      pt.position.set(v.x + side * v._cosY - 0.25 * v._sinY, v.bodyType === 'suv' ? 2.05 : 1.85, v.z - side * v._sinY - 0.25 * v._cosY);
      pt.distance = 12.0;
      pt.intensity = 42.0 * tailScale * fade * pulse;
    }
    for (let i = policeLightsUsed; i < POLICE_LIGHT_POOL_SIZE; i++) {
      const pt = policeLightPool[i];
      pt.intensity = 0;
      pt.position.set(0, -1000, 0);
    }
  }

  function updateSparks(dt) {
    let count = 0;
    for (let s = 0; s < MAX_SPARKS; s++) {
      const sp = sparks[s];
      if (sp.life > 0) {
        sp.life -= dt;
        sp.vy -= 22.0 * dt;
        sp.x += sp.vx * dt;
        sp.y += sp.vy * dt;
        sp.z += sp.vz * dt;
        if (sp.y < 0.03) {
          sp.y = 0.03;
          sp.vy = Math.abs(sp.vy) * 0.45;
          sp.vx *= 0.78;
          sp.vz *= 0.78;
        }
        const tLife = Math.max(0, sp.life / sp.maxLife);
        const spdXZ = Math.hypot(sp.vx, sp.vz) || 0.001;
        const yawSp = Math.atan2(sp.vx, sp.vz);
        const pitchSp = -Math.atan2(sp.vy, spdXZ);
        dummy.position.set(sp.x, sp.y, sp.z);
        dummy.rotation.set(pitchSp, yawSp, 0, 'YXZ');
        dummy.scale.set(tLife, tLife, Math.max(0.4, Math.min(2.2, spdXZ * 0.16)) * tLife);
        dummy.updateMatrix();
        sparkInst.setMatrixAt(count++, dummy.matrix);
      }
    }
    // Keep one degenerate instance for shader warm-up, then hide the empty pool and stop uploading it.
    sparkInst.visible = count > 0 || updates <= 2;
    if (count === 0 && updates <= 2) sparkInst.setMatrixAt(count++, zero);
    sparkInst.count = count;
    if (count > 0) flagRange(sparkInst.instanceMatrix, count);
  }

  // =========================================================================
  // 8. UPDATE
  // =========================================================================
  let lastFocusX = Infinity;
  let lastFocusZ = Infinity;
  let vehicleCursor = 0;

  function update(dt, elapsed, focusPos = null, playerEntity = null, activeMode = 'car', camera = null) {
    clock = elapsed;
    avePhase = signalPhase(elapsed, true);
    stPhase = signalPhase(elapsed, false);
    aveWalk = walkSignal(elapsed, true);
    stWalk = walkSignal(elapsed, false);
    focusX = focusPos ? focusPos.x : 0;
    focusZ = focusPos ? focusPos.z : 140;
    // a jump of the camera (teleport, first frame): everything far away can be placed anywhere around it
    const jump = Math.hypot(focusX - lastFocusX, focusZ - lastFocusZ) > 140;
    lastFocusX = focusX;
    lastFocusZ = focusZ;
    refreshNear();
    updateView(camera);

    player.active = Boolean(playerEntity && activeMode !== 'helicopter' && playerEntity.position.y < 2.6);
    if (playerEntity) {
      const heading = playerEntity.heading || 0;
      const speed = playerEntity.speed || 0;
      player.entity = playerEntity;
      player.x = playerEntity.position.x;
      player.z = playerEntity.position.z;
      player.fx = Math.sin(heading);
      player.fz = Math.cos(heading);
      // how fast it turns: the car's own yaw rate, or (walking, cycling) its heading's change since last frame
      let turned = heading - player.heading;
      turned -= Math.round(turned / (Math.PI * 2)) * Math.PI * 2;
      player.yawRate = playerEntity.angularVel ?? (dt > 0 ? turned / dt : 0);
      player.heading = heading;
      player.vx = player.fx * speed + (playerEntity.vx || 0);
      player.vz = player.fz * speed + (playerEntity.vz || 0);
    }
    player.halfW = activeMode === 'cyclist' ? 0.35 : activeMode === 'person' ? 0.32 : 0.86;
    player.halfL = activeMode === 'cyclist' ? 0.85 : activeMode === 'person' ? 0.32 : 2.18;

    // 1. Cars & buses
    // Limit attempted placements, not just successes, and rotate through the pool so an awkward location
    // cannot monopolize a frame. Previous-frame lane lists protect spawn spacing; rebuild before driving.
    let budget = jump ? vehicles.length : 4;
    for (let scanned = 0; scanned < vehicles.length && budget > 0; scanned++) {
      const v = vehicles[vehicleCursor];
      vehicleCursor = (vehicleCursor + 1) % vehicles.length;
      const d = v.edge ? Math.hypot(v.x - focusX, v.z - focusZ) : Infinity;
      if (d <= (jump ? NEAR_RADIUS : VEHICLE_RADIUS)) continue;
      budget--;
      spawnVehicle(v, jump ? 0 : 100, NEAR_RADIUS, !jump);
    }
    buildOccupancy();
    for (const m of bodyMeshes) m.count = 0;
    dirtyWheelStyles = false;
    litVehicleCount = 0;
    wheelCars = 0;
    visibleCars = 0;
    policeDrawn.sedan = 0;
    policeDrawn.suv = 0;
    visibleBuses = 0;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v.edge) continue;

      v.prevX = v.x;
      v.prevZ = v.z;
      relateToPlayer(v);
      react(v, dt);
      drive(v, dt);
      locate(v);
      knock(v, dt);
      pose(v, dt);
    }
    if (player.active) {
      for (const v of vehicles) if (v.edge) collideWithPlayer(v);
    }
    collideTraffic();
    for (const v of vehicles) {
      if (!v.edge) continue;
      if (v.bus) renderBus(v);
      else renderCar(v);
    }
    const hideEmpty = ++updates > 2;
    for (const m of bodyMeshes) {
      const n = m.count;
      m.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          m.setMatrixAt(0, zero);
          m.count = 1;
          flagRange(m.instanceMatrix, 1);
        }
        continue;
      }
      carAttributes.upload(m, n);
    }
    carAttributes.clear();
    const syncInst = (inst, n) => {
      inst.visible = n > 0 || !hideEmpty;
      if (n === 0) {
        if (!hideEmpty) {
          inst.setMatrixAt(0, zero);
          inst.count = 1;
          flagRange(inst.instanceMatrix, 1);
        } else {
          inst.count = 0;
        }
        return;
      }
      inst.count = n;
      flagRange(inst.instanceMatrix, n);
    };
    syncInst(carWheelLeftInst, wheelCars * 2);
    syncInst(carWheelRightInst, wheelCars * 2);
    if (dirtyWheelStyles && wheelCars > 0) flagRange(carWheelStyles, wheelCars * 2);
    syncInst(policeLightbars.sedan, policeDrawn.sedan);
    syncInst(policeLightbars.suv, policeDrawn.suv);
    syncInst(carShadowInst, visibleCars);
    syncInst(busBodyInst, visibleBuses);
    syncInst(busHeaderInst, visibleBuses);
    syncInst(busWheelLeftInst, visibleBuses * 2);
    syncInst(busWheelRightInst, visibleBuses * 2);
    syncInst(busShadowInst, visibleBuses);
    if (visibleBuses > 0) flagRange(busStates, visibleBuses);
    updateTrafficLights();

    // 2. Pedestrians (and the people knocked down)
    gatherMovers(dt, playerEntity, activeMode);
    pedestrianSystem.update(dt, elapsed, focusX, focusZ, jump, hasView, activeMode);
    feelFallen(playerEntity);

    // 3. Collision sparks, including the player's own impacts against buildings
    if (playerEntity && playerEntity.lastCollisionSpark) {
      const bs = playerEntity.lastCollisionSpark;
      spawnCollisionSparks(bs.x, bs.y, bs.z, bs.nx, bs.nz, bs.speed);
      playerEntity.lastCollisionSpark = null;
    }
    updateSparks(dt);
  }

  return {
    group,
    update,
    setCollisionListener,
    cars,
    buses,
    peds: pedestrianSystem.peds,
    fallen: pedestrianSystem.fallen,
    setWorld: pedestrianSystem.setWorld,
    network
  };
}

// ============================================================================
// AMBIENT SHORE-HIGHWAY TRAFFIC (West Side Highway, Henry Hudson Parkway, FDR Drive)
// ============================================================================
// The shore highways city-grid.js lays along both rivers are not part of the road graph, so a lighter model fills
// them: cars follow each lane's centre line and keep their distance with the IDM. Nobody changes lanes, so the order
// in a lane never changes and every car's leader is simply the next one (cyclically: cars dip below the deck at the
// end of a lane as if into an underpass and come back up at its start; West St and the FDR's lanes are joined through
// the Battery Park Underpass, lane points well below ground). Cars queue behind the player standing or
// driving in their lane. Within HWY_NEAR_LOD m of the camera they use the full model with wheels and cast shadows,
// up to HWY_MID_LOD m a wheel-less body, further out a coarse ~250-triangle lofted proxy; beyond HWY_FAR_CULL m (or well behind
// the camera) they aren't drawn.
const HWY_DRIVER = { a: 1.6, b: 2.8, T: 1.3, s0: 3.0 };
const HWY_CAR_LEN = 4.6;
const HWY_NEAR_LOD = 170;
const HWY_MID_LOD = 450;
const HWY_FAR_CULL = 1600;
const HWY_RAMP = 32; // the dip at the lane ends: 2.4 m down over this many metres
const HWY_BOX_RUN = 16; // lane segments per bounding box of the player test

function createHighwayTraffic(scene, lanes) {
  const group = new THREE.Group();
  group.name = 'HighwayTraffic';
  scene.add(group);
  const KINDS = Object.keys(CAR_KINDS);
  const PALETTES = {
    taxi: [
      { hex: 0xffbe14, style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 0 }) },
      { hex: 0xffbe14, style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 1 }) }
    ],
    sedan: [
      { hex: 0x12151a, style: carStyleCode({ livery: 3, metallic: 0, trim: 1, wheel: 1 }) },
      { hex: 0x161a20, style: carStyleCode({ livery: 3, metallic: 1, trim: 2, wheel: 2 }) },
      { hex: 0xf2f4f7, style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 0 }) },
      { hex: 0xe6eaef, style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) },
      { hex: 0xcfd6de, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
      { hex: 0x8a8f96, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) },
      { hex: 0x52575e, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) },
      { hex: 0x1c2026, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 3 }) },
      { hex: 0x1d3b6c, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
      { hex: 0x6e1f24, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
      { hex: 0x5cae3e, style: carStyleCode({ livery: 2, metallic: 0, trim: 0, wheel: 0 }) }
    ],
    suv: [
      { hex: 0x101318, style: carStyleCode({ livery: 3, metallic: 0, trim: 1, wheel: 1 }) },
      { hex: 0x16191e, style: carStyleCode({ livery: 3, metallic: 1, trim: 2, wheel: 3 }) },
      { hex: 0xf0f3f7, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
      { hex: 0xe4e8ed, style: carStyleCode({ livery: 4, metallic: 0, trim: 2, wheel: 2 }) },
      { hex: 0x3a434d, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) },
      { hex: 0xbec6cf, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
      { hex: 0x28382e, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) },
      { hex: 0x20385c, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
      { hex: 0x5b2a2a, style: carStyleCode({ livery: 4, metallic: 1, trim: 2, wheel: 2 }) },
      { hex: 0x5cae3e, style: carStyleCode({ livery: 2, metallic: 0, trim: 0, wheel: 0 }) }
    ],
    minivan: [
      { hex: 0x111419, style: carStyleCode({ livery: 3, metallic: 1, trim: 1, wheel: 1 }) },
      { hex: 0xf0f2f5, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
      { hex: 0xaab2bb, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 1 }) },
      { hex: 0x4a5058, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) },
      { hex: 0x26354f, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) },
      { hex: 0x5a1f24, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 0 }) }
    ],
    pickup: [
      { hex: 0x14171b, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
      { hex: 0xf2f3f5, style: carStyleCode({ livery: 0, metallic: 0, trim: 1, wheel: 0 }) },
      { hex: 0x9da4ab, style: carStyleCode({ livery: 0, metallic: 1, trim: 0, wheel: 2 }) },
      { hex: 0x3d434a, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) },
      { hex: 0x1e2f4f, style: carStyleCode({ livery: 0, metallic: 1, trim: 1, wheel: 1 }) },
      { hex: 0x8f1a1d, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) }
    ],
    // Vans: fleet white, silver, grey & black, black plastic trim; never two-tone (see the street palettes)
    van: [
      { hex: 0xf4f5f6, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 0 }) },
      { hex: 0xf0f1f2, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) },
      { hex: 0xf4f5f6, style: carStyleCode({ livery: 0, metallic: 0, trim: 0, wheel: 1 }) },
      { hex: 0xb9c0c7, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 0 }) },
      { hex: 0x8e959c, style: carStyleCode({ livery: 0, metallic: 0, trim: 2, wheel: 3 }) },
      { hex: 0x15181c, style: carStyleCode({ livery: 0, metallic: 1, trim: 2, wheel: 3 }) }
    ]
  };
  const rand = minStdRandom(20240917);

  // Lanes: arc length and heading at every centre-line vertex, bounds for the player test, cars every 24-74 m
  const cars = [];
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const lane of lanes) {
    const P = lane.pts;
    lane.cum = [0];
    for (let i = 1; i < P.length; i++) lane.cum.push(lane.cum[i - 1] + P[i].distanceTo(P[i - 1]));
    lane.len = lane.cum[P.length - 1];
    lane.yaw = P.map((p, i) => {
      const a = P[Math.max(0, i - 1)];
      const b = P[Math.min(P.length - 1, i + 1)];
      return Math.atan2(b.x - a.x, b.z - a.z);
    });
    // Bounds of every run of HWY_BOX_RUN segments ([x0, x1, z0, z1] after one another): the shore lanes, joined
    // through the Battery Park Underpass, span the whole island, so the player test visits just the runs nearby
    lane.box = [];
    for (let s = 0; s + 1 < P.length; s += HWY_BOX_RUN) {
      const run = P.slice(s, Math.min(P.length, s + HWY_BOX_RUN + 1));
      lane.box.push(Math.min(...run.map((p) => p.x)), Math.max(...run.map((p) => p.x)), Math.min(...run.map((p) => p.z)), Math.max(...run.map((p) => p.z)));
    }
    lane.cars = [];
    for (let u = rand() * 30; u < lane.len - 12; u += 24 + rand() * 50) {
      const h = rand();
      // Fewer vans than in town: commercial vehicles are barred from the parkways
      const kind = h < 0.2 ? 'taxi' : h < 0.56 ? 'sedan' : h < 0.82 ? 'suv' : h < 0.89 ? 'minivan' : h < 0.95 ? 'pickup' : 'van';
      const entry = PALETTES[kind][Math.floor(rand() * PALETTES[kind].length)];
      const col = new THREE.Color(entry.hex);
      const spec = BODY_SPECS[kind];
      // (float32 values, so update() can tell whether an instance slot's paint changes by comparing with the buffer)
      const car = {
        lane, kind, u, v: lane.speed, acc: 0, seg: 0,
        placed: false, x: 0, y: -1000, z: 0, yaw: 0,
        len: spec.zFront - spec.zRear, engine: CAR_KINDS[kind].engine,
        col: [Math.fround(col.r), Math.fround(col.g), Math.fround(col.b)],
        style: withCarSeed(entry.style, cars.length * 97 + 29)
      };
      lane.cars.push(car);
      cars.push(car);
      counts[kind]++;
    }
  }

  // Per body type: [near (with wheels, casts shadows), mid (wheel-less), far (lofted proxy)] instanced meshes sharing
  // the traffic's cached car material (per-instance paintColor & carState)
  const meshes = {};
  for (const kind of KINDS) {
    const spec = BODY_SPECS[kind];
    const n = Math.max(1, counts[kind]);
    meshes[kind] = [0, 1, 2].map((lod) => {
      const geo = lod === 2 ? buildCarProxyGeometry(spec) : buildCarGeometry(spec, lod === 0);
      geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const mesh = new THREE.InstancedMesh(geo, createLoftedCarMaterial(spec), n);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = lod === 0;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    });
  }

  // Night lamp flares: a soft glow on every head- and tail-lamp, at least a couple of pixels wide, so the highways read
  // as streams of white and red lights from across the river once the lamp geometry shrinks below a pixel.
  // (flareCol is rgb + an unused w: 3-component attributes get re-padded to 4 on every upload)
  const flarePos = new Float32Array(cars.length * 4 * 4); // x, y, z, size
  const flareCol = new Float32Array(cars.length * 4 * 4); // r, g, b, -
  const flareGeo = new THREE.PlaneGeometry(1, 1);
  flareGeo.setAttribute('flarePos', new THREE.InstancedBufferAttribute(flarePos, 4));
  flareGeo.setAttribute('flareCol', new THREE.InstancedBufferAttribute(flareCol, 4));
  const flares = new THREE.Mesh(flareGeo, createCarFlareMaterial());
  flares.name = 'HighwayLampFlares';
  flares.frustumCulled = false;
  flares.visible = false;
  flares.renderOrder = 2;
  group.add(flares);
  let flareCount = 0;

  // Clustered SpotLight pool for nearby highway cars (within 105 m)
  const HWY_SPOT_POOL = 28;
  const HWY_LIGHT_DIST = 105;
  const HWY_LIGHT_DIST_SQ = HWY_LIGHT_DIST * HWY_LIGHT_DIST;
  const hwyLightsGroup = new THREE.Group();
  hwyLightsGroup.name = 'HighwayClusteredLights';
  group.add(hwyLightsGroup);

  const hwySpotPool = createHeadlightPool(hwyLightsGroup, HWY_SPOT_POOL);
  const hwyLitCars = [];
  let hwyLitCount = 0;
  function addFlare(px, py, pz, size, r, g, b) {
    const o = flareCount * 4;
    flarePos[o] = px;
    flarePos[o + 1] = py;
    flarePos[o + 2] = pz;
    flarePos[o + 3] = size;
    const k = flareCount * 4;
    flareCol[k] = r;
    flareCol[k + 1] = g;
    flareCol[k + 2] = b;
    flareCount++;
  }
  const flareFacing = (f) => { const t = Math.min(1, Math.max(0, (f + 0.3) / 0.9)); return t * t * (3 - 2 * t); };

  const D = HWY_DRIVER;
  const brakeTerm = 2 * Math.sqrt(D.a * D.b);
  const ease = (x) => { const t = Math.min(1, Math.max(0, x / HWY_RAMP)); return t * t * (3 - 2 * t); };
  const easeSlope = (x) => { if (x <= 0 || x >= HWY_RAMP) return 0; const t = x / HWY_RAMP; return (6 * t * (1 - t)) / HWY_RAMP; };
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const pos = new THREE.Vector3();
  const ONE = new THREE.Vector3(1, 1, 1);
  const fwd = new THREE.Vector3();
  const carAttributes = createCarAttributes();
  let updates = 0;

  // The player's arc position and speed along `lane` if they are in it (within 2 m of the centre line and near
  // its road height, not on its underground stretches), else null
  function playerInLane(lane, pl) {
    const B = lane.box;
    const P = lane.pts;
    for (let r = 0; r < B.length; r += 4) {
      if (pl.x < B[r] - 3 || pl.x > B[r + 1] + 3 || pl.z < B[r + 2] - 3 || pl.z > B[r + 3] + 3) continue;
      const end = Math.min(P.length - 1, (r / 4 + 1) * HWY_BOX_RUN);
      for (let i = (r / 4) * HWY_BOX_RUN; i < end; i++) {
        if (P[i].y < -1 && P[i + 1].y < -1) continue;
        const ax = P[i].x, az = P[i].z;
        const sx = P[i + 1].x - ax, sz = P[i + 1].z - az;
        const horizontalLengthSq = sx * sx + sz * sz;
        if (horizontalLengthSq === 0) continue;
        const L = lane.cum[i + 1] - lane.cum[i];
        const t = ((pl.x - ax) * sx + (pl.z - az) * sz) / horizontalLengthSq;
        if (t < 0 || t > 1) continue;
        const y = P[i].y + (P[i + 1].y - P[i].y) * t;
        if (Math.abs(pl.y - y) >= 2.6) continue;
        if (Math.abs((pl.z - az) * sx - (pl.x - ax) * sz) / Math.sqrt(horizontalLengthSq) < 2.0) {
          // Convert horizontal progress to distance along the sloped lane, as with u above.
          return { u: lane.cum[i] + t * L, v: Math.max(0, ((pl.vx * sx + pl.vz * sz) / horizontalLengthSq) * L) };
        }
      }
    }
    return null;
  }

  function update(dt, camera, entity, mode) {
    // 1. Car following (IDM) in every lane, the player counting as a leader
    const pl = entity && mode !== 'helicopter' ? {
      x: entity.position.x, y: entity.position.y, z: entity.position.z,
      vx: Math.sin(entity.heading || 0) * (entity.speed || 0) + (entity.vx || 0),
      vz: Math.cos(entity.heading || 0) * (entity.speed || 0) + (entity.vz || 0)
    } : null;
    for (const lane of lanes) {
      const list = lane.cars;
      const n = list.length;
      const pIn = pl ? playerInLane(lane, pl) : null;
      for (let k = 0; k < n; k++) {
        const c = list[k];
        let gap = Infinity;
        let dv = 0;
        if (n > 1) {
          const lead = list[(k + 1) % n];
          gap = lead.u - c.u;
          if (gap < 0) gap += lane.len;
          gap -= (c.len + lead.len) / 2;
          dv = c.v - lead.v;
        }
        // The player's car counts as HWY_CAR_LEN long
        if (pIn && pIn.u > c.u) {
          const playerGap = pIn.u - c.u - (c.len + HWY_CAR_LEN) / 2;
          if (playerGap < gap) {
            gap = playerGap;
            dv = c.v - pIn.v;
          }
        }
        const sStar = D.s0 + Math.max(0, c.v * D.T + (c.v * dv) / brakeTerm);
        c.acc = Math.max(-9, D.a * (1 - (c.v / lane.speed) ** 4 - (sStar / Math.max(gap, 0.1)) ** 2));
      }
      for (const c of list) {
        c.v = Math.max(0, c.v + c.acc * dt);
        c.u += c.v * dt;
        if (c.u >= lane.len) {
          c.u -= lane.len;
          c.seg = 0;
        }
      }
    }

    // 2. Instances: LOD by distance, far cars well behind the camera skipped; lamp flares at dusk & night
    const cam = camera.position;
    camera.getWorldDirection(fwd);
    for (const kind of KINDS) for (const mesh of meshes[kind]) mesh.count = 0;
    const flaresOn = cityUniforms.uInteriorGlow.value > 0.65;
    const pxAt1m = (2 * Math.tan(((camera.fov || 55) * Math.PI) / 360)) / Math.max(360, window.innerHeight || 800);
    flareCount = 0;
    hwyLitCount = 0;
    for (const c of cars) {
      const lane = c.lane;
      const cum = lane.cum;
      while (c.seg < cum.length - 2 && cum[c.seg + 1] < c.u) c.seg++;
      const i = c.seg;
      const segLen = cum[i + 1] - cum[i];
      const t = Math.min(1, Math.max(0, (c.u - cum[i]) / segLen));
      const a = lane.pts[i];
      const b = lane.pts[i + 1];
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const toEnd = lane.len - c.u;
      const dip = c.u < toEnd ? c.u : toEnd;
      const y = a.y + (b.y - a.y) * t - 2.4 * (1 - ease(dip));
      let dYaw = lane.yaw[i + 1] - lane.yaw[i];
      if (dYaw > Math.PI) dYaw -= Math.PI * 2;
      else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
      const yaw = lane.yaw[i] + dYaw * t;
      // Keep the current world pose available to audio, including cars behind the camera.
      c.x = x;
      c.y = y;
      c.z = z;
      c.yaw = yaw;
      c.placed = true;
      const dx = x - cam.x;
      const dz = z - cam.z;
      const dy = y - cam.y;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > HWY_FAR_CULL * HWY_FAR_CULL) continue;
      const lod = d2 < HWY_NEAR_LOD * HWY_NEAR_LOD ? 0 : d2 < HWY_MID_LOD * HWY_MID_LOD ? 1 : 2;
      if (lod > 0 && dx * fwd.x + dz * fwd.z < -40) continue;
      if (y < -3.6) continue; // in the Battery Park Underpass, out of sight behind the portals' screens
      const slope = (b.y - a.y) / segLen + 2.4 * easeSlope(dip) * (c.u < toEnd ? 1 : -1);
      euler.set(-Math.atan(slope), yaw, 0);
      q.setFromEuler(euler);
      m4.compose(pos.set(x, y, z), q, ONE);
      const mesh = meshes[c.kind][lod];
      const slot = mesh.count++;
      m4.toArray(mesh.instanceMatrix.array, slot * 16);
      // Paint & brake lights (no turn signals on the highway)
      carAttributes.write(mesh, slot, c.col, c.acc < -1.2 ? 1 : 0, 0, 0, c.style);

      if (d2 < HWY_LIGHT_DIST_SQ && dip > 1) {
        const effDist = headlightDistance(Math.sqrt(d2), dx * fwd.x + dz * fwd.z);
        if (effDist < HWY_LIGHT_DIST) {
          c._effDist = effDist;
          c._mesh = mesh;
          c._slot = slot;
          hwyLitCars[hwyLitCount++] = c;
        }
      }

      // Flares (from 40 m out, full by 120 m): sprites just off the lamp faces, white at the front and red at the back,
      // brightest seen head-on / from behind, dimmed by haze
      if (!flaresOn || d2 < 1600 || dip < 1) continue;
      const d = Math.sqrt(d2);
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const facing = -(dx * sy + dz * cy) / d;
      const k = (Math.min(1, (d - 40) / 80) / (1 + (d / 2000) ** 2)) * ease(dip);
      const size = Math.max(0.6, d * pxAt1m * 3);
      const spec = BODY_SPECS[c.kind];
      for (let e = 0; e < 2; e++) {
        const front = e === 0;
        const w = k * (0.3 + 0.7 * flareFacing(front ? facing : -facing));
        const lz = front ? spec.zFront + 0.3 : spec.zRear - 0.3;
        const ly = y + (front ? spec.lamps[0] : spec.lamps[1]);
        for (let s = -1; s <= 1; s += 2) {
          const lx = s * spec.lampX[front ? 0 : 1];
          if (front) addFlare(x + lx * cy + lz * sy, ly, z - lx * sy + lz * cy, size, 4.4 * w, 4.1 * w, 3.6 * w);
          else addFlare(x + lx * cy + lz * sy, ly, z - lx * sy + lz * cy, size, 3.4 * w, 0.16 * w, 0.1 * w);
        }
      }
    }
    // Upload just the instances in use (the buffers hold every car of the kind), and nothing for empty meshes, which
    // are hidden too (an empty instanced mesh still costs a render object update in every pass). They stay visible
    // for the first couple of frames so that the shader precompile & warm-up frame (main.js) see all of them.
    const hideEmpty = ++updates > 2;
    for (const kind of KINDS) {
      for (const mesh of meshes[kind]) {
        const n = mesh.count;
        mesh.visible = n > 0 || !hideEmpty;
        if (n > 0) carAttributes.upload(mesh, n);
      }
    }
    carAttributes.clear();
    flares.visible = flareCount > 0;
    flares.count = flareCount;
    if (flareCount > 0) {
      flagRange(flareGeo.attributes.flarePos, flareCount);
      flagRange(flareGeo.attributes.flareCol, flareCount);
    }

    // Update clustered highway SpotLights (dual left/right beams for nearby cars)
    hwyLitCars.length = hwyLitCount;
    if (hwyLitCount > 1) {
      hwyLitCars.sort((a, b) => a._effDist - b._effDist);
    }
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = headlightBeamScale(glow);
    const maxHwyVeh = HWY_SPOT_POOL >> 1;
    const hwyCutoff = hwyLitCount > maxHwyVeh
      ? Math.min(HWY_LIGHT_DIST, hwyLitCars[maxHwyVeh]._effDist)
      : HWY_LIGHT_DIST;
    let spotUsed = 0;
    if (beamScale > 0.001) {
      for (let i = 0; i < hwyLitCount && spotUsed + 2 <= HWY_SPOT_POOL; i++) {
        const c = hwyLitCars[i];
        const t = clamp((hwyCutoff - c._effDist) / Math.max(1, hwyCutoff * 0.38), 0, 1);
        const fade = (t * t * (3 - 2 * t)) * ease(Math.min(c.u, c.lane.len - c.u));
        if (fade <= 0.001) continue;
        const spec = BODY_SPECS[c.kind];
        const baseInt = HEADLIGHTS.intensity * beamScale * fade;
        // Reuse the exact rendered transform, including the road slope and underpass dip.
        c._mesh.getMatrixAt(c._slot, m4);
        for (let side = -1; side <= 1; side += 2) {
          const spot = hwySpotPool[spotUsed++];
          placeVehicleHeadlight(spot, spec, side, m4);
          spot.intensity = baseInt;
        }
      }
    }
    parkHeadlights(hwySpotPool, spotUsed);
  }

  return { group, update, cars, lanes };
}

export { createTrafficSystem, createHighwayTraffic };
