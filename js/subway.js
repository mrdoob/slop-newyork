import * as THREE from 'three/webgpu';
import { SUBWAY_LINES, SUBWAY_STOPS } from './subway-lines.js';
import { blockAt } from './city-config.js';

// js/subway.js
// Down into the subway (mode 5): the nearest real station (subway-lines.js, from OpenStreetMap) built under its street as
// an enclosed island platform between its two tracks, turned along the service's real route: white tile walls with
// the station's name in the mosaic band, I-beam columns, fluorescent strips, name signs, stairs up to the street at
// both ends, and trains in and out of the tunnels on both tracks. The station is built when the player comes down and
// thrown away when they go back up (one at a time: there is only ever the one the player stands in).
//
// Station frame: x across the tracks, z along them (the route's direction), y up; the origin is on the route under
// the station's node, at street level.

const STATIONS = SUBWAY_STOPS.map(([name, x, z, services]) => ({ name, x, z, services }));
const LINES = new Map(SUBWAY_LINES.map((l) => [l.ref, l]));

const PLATFORM_LEN = 156; // a ten-car IRT / eight-car IND platform, about 150 m
const PLATFORM_HALF_W = 4.5;
const TRACK_X = 6.8; // track centres either side of the platform
const HALL_HALF_W = 9.2; // tile wall to tile wall
const PLATFORM_H = 1.1; // platform top over the rails
const CEILING = 4.4; // over the platform
const TUNNEL_LEN = 330; // beyond each end of the platform: trains disappear into the dark well inside it
const STAIR_W = 2.6;
const STAIR_LEN = 7.2; // the flight's run on the platform
const STAIR_RISE = 3.9; // up to the ceiling (the street is above the mezzanine)
const STAIR_EXIT_RISE = 2.0; // climbing this high up a flight takes the player out to the street
const CAR_LEN = 18.3; // a 60 ft car
const CARS = 8;
const TRAIN_PERIOD = 48; // seconds between trains on each track
const APPROACH = 10; // seconds braking in from the tunnel
const DWELL = 12; // seconds standing at the platform
const DEPART = 10; // seconds pulling out: the ridden train, its tail clear of the platform, hands on to the next station
const RIDE_HANDOFF = APPROACH + DWELL + DEPART;
const BOARD_REACH = 1.6; // from the platform edge (F boards from this close)

const BULLET_TEXT = { 1: '#fff', 2: '#fff', 3: '#fff', 4: '#fff', 5: '#fff', 6: '#fff', 7: '#fff', N: '#000', Q: '#000', R: '#000', W: '#000' };

// Where along a service's route a station lies: the nearest point of the route to the station's node, with the
// route's direction there and its track height (below 0 in tunnel)
function routeFrame(station, preferRef = null) {
  let best = null;
  const refs = preferRef ? [preferRef] : [...station.services];
  for (const ref of refs) {
    const line = LINES.get(ref);
    if (!line) continue;
    for (const pts of line.paths) {
      for (let i = 0; i + 5 < pts.length; i += 3) {
        const ax = pts[i], az = pts[i + 1], bx = pts[i + 3], bz = pts[i + 4];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((station.x - ax) * dx + (station.z - az) * dz) / l2));
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.hypot(px - station.x, pz - station.z);
        if (!best || d < best.d) {
          const len = Math.sqrt(l2);
          best = { d, x: px, z: pz, dirX: dx / len, dirZ: dz / len, trackY: Math.min(pts[i + 2], pts[i + 5]), line };
        }
      }
    }
    if (best && best.d < 60) break; // the station's first service runs right under it
  }
  if (!best || best.d > 120) return { x: station.x, z: station.z, dirX: 0, dirZ: -1, trackY: -9, line: LINES.get(station.services[0]) };
  return best;
}

// How far along a service's route (x, z) lies, in metres from its start (each piece of the route continues the count)
function routeDistance(line, x, z) {
  let best = Infinity, bestS = 0, base = 0;
  for (const pts of line.paths) {
    let acc = 0;
    for (let i = 0; i + 5 < pts.length; i += 3) {
      const ax = pts[i], az = pts[i + 1], dx = pts[i + 3] - ax, dz = pts[i + 4] - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (len * len)));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best) { best = d; bestS = base + acc + t * len; }
      acc += len;
    }
    base += acc + 1e5;
  }
  return bestS;
}
// The stop after `station` for service `ref`, running with the route (dir 1) or against it (-1); null at the end of
// the line in Manhattan. A station complex mapped as several nodes counts once.
function nextStop(ref, station, dir) {
  const line = LINES.get(ref);
  if (!line) return null;
  const here = routeDistance(line, station.x, station.z);
  let best = null, bestGap = Infinity;
  for (const s of STATIONS) {
    if (!s.services.includes(ref)) continue;
    const gap = (routeDistance(line, s.x, s.z) - here) * dir;
    if (gap > 120 && gap < bestGap) { bestGap = gap; best = s; }
  }
  return best;
}

// --- Textures: the station's name in the wall's mosaic band, on the hanging signs, and the service bullets -------------
function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
const SIGN_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
function nameSignTexture(station) {
  return canvasTexture(2048, 256, (ctx, w, h) => {
    ctx.fillStyle = '#0d0d0e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(0, 18, w, 6);
    let x = 60;
    // the services stopping here, as bullets, then the name
    for (const ref of station.services) {
      const line = LINES.get(ref);
      ctx.fillStyle = line ? line.color : '#808183';
      ctx.beginPath();
      ctx.arc(x + 70, h / 2 + 10, 70, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = BULLET_TEXT[ref] || '#fff';
      ctx.font = `bold 104px ${SIGN_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ref, x + 70, h / 2 + 16);
      x += 160;
    }
    ctx.fillStyle = '#f4f4f4';
    ctx.textAlign = 'left';
    let size = 120;
    ctx.font = `bold ${size}px ${SIGN_FONT}`;
    while (ctx.measureText(station.name).width > w - x - 60 && size > 50) ctx.font = `bold ${(size -= 4)}px ${SIGN_FONT}`;
    ctx.fillText(station.name, x + 20, h / 2 + 14);
  });
}
function mosaicTexture(station) {
  return canvasTexture(2048, 256, (ctx, w, h) => {
    // a border of small tiles in the service's colour around a cream field with the name in dark tile
    const color = LINES.get(station.services[0])?.color || '#2a6b4f';
    ctx.fillStyle = '#e9e1cc';
    ctx.fillRect(0, 0, w, h);
    const t = 16;
    for (let x = 0; x < w; x += t) {
      for (const y of [0, t, h - 2 * t, h - t]) {
        ctx.fillStyle = (x / t + y / t) % 2 ? color : '#c9b98f';
        ctx.fillRect(x + 1, y + 1, t - 2, t - 2);
      }
    }
    ctx.fillStyle = '#23201c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 120;
    const label = station.name.toUpperCase();
    ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
    while (ctx.measureText(label).width > w - 160 && size > 40) ctx.font = `bold ${(size -= 4)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(label, w / 2, h / 2 + 4);
  });
}
function bulletTexture(ref, color) {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#16181a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 104, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BULLET_TEXT[ref] || '#fff';
    ctx.font = `bold 150px ${SIGN_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ref, w / 2, h / 2 + 10);
  });
}

// Materials shared by every station (built once, so going down again compiles nothing new)
let MATS = null;
function materials() {
  if (MATS) return MATS;
  const std = (color, roughness = 0.6, metalness = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness });
  MATS = {
    tile: std(0xe7e2d4, 0.32),
    platform: std(0x8f8b83, 0.85),
    edge: std(0xe2b42a, 0.6),
    trackbed: std(0x1e1c1a, 0.95),
    rail: std(0x8a8580, 0.35, 0.85),
    tie: std(0x2c2621, 0.9),
    column: std(0x2f4a3f, 0.55, 0.35),
    ceiling: std(0x6a6c6a, 0.8),
    tunnel: std(0x0d0d0d, 1.0),
    step: std(0x76736d, 0.8),
    carBody: std(0xb7bcc2, 0.32, 0.75),
    carRoof: std(0x8e9297, 0.5, 0.6),
    carUnder: std(0x1b1c1e, 0.8, 0.3),
    carFloor: std(0x4a4744, 0.85),
    carCeiling: std(0xb4b6b1, 0.7),
    seat: std(0x51708f, 0.45),
    pole: std(0xc9ccd0, 0.25, 0.9),
    lamp: new THREE.MeshBasicNodeMaterial({ color: 0xfff8e8 }),
    carLamp: new THREE.MeshBasicNodeMaterial({ color: 0xc9ced2 }),
    window: new THREE.MeshBasicNodeMaterial({ color: 0xd9e6ea }),
    headlight: new THREE.MeshBasicNodeMaterial({ color: 0xfffbe6 }),
    daylight: new THREE.MeshBasicNodeMaterial({ color: 0xdce8f0 })
  };
  return MATS;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
function box(group, mat, cx, cy, cz, sx, sy, sz, shadows = true) {
  const m = new THREE.Mesh(unitBox, mat);
  m.position.set(cx, cy, cz);
  m.scale.set(sx, sy, sz);
  m.castShadow = shadows;
  m.receiveShadow = true;
  group.add(m);
  return m;
}
function instanced(group, mat, list, shadows = false) {
  const inst = new THREE.InstancedMesh(unitBox, mat, list.length);
  const dummy = new THREE.Object3D();
  list.forEach(([x, y, z, sx, sy, sz], i) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  });
  inst.castShadow = shadows;
  inst.receiveShadow = true;
  group.add(inst);
  return inst;
}

// Train frame: x across (the platform side is -x on either track, see trackToStation), z along, the head (the lead
// car's face) at z = 0 and the cars behind it toward -z, y up from the rail tops. Cars are walk-in: floors level with
// the platforms, open window bands, benches, poles, ceiling lights and three doors a side, whose leaves on the
// platform side slide away while the train stands at a station.
const CAR_GAP = 0.6;
const CAR_BODY = CAR_LEN - CAR_GAP;
const CAR_HALF_W = 1.5;
const CAR_FLOOR = PLATFORM_H;
const CAR_ROOF = CAR_FLOOR + 2.35;
const DOORS = [-6.0, 0, 6.0]; // door centres from each car's centre
const DOOR_W = 1.4;
const AISLE = 0.8; // half-width walkable between the benches
const carCentre = (c) => -c * CAR_LEN - CAR_LEN / 2;
const TRAIN_DOORS = [];
for (let c = 0; c < CARS; c++) for (const d of DOORS) TRAIN_DOORS.push(carCentre(c) + d);
const atDoor = (tz) => TRAIN_DOORS.some((d) => Math.abs(tz - d) < DOOR_W / 2 - 0.15);
const TRAIN_FRONT = -CAR_GAP / 2;
const TRAIN_REAR = -CARS * CAR_LEN + CAR_GAP / 2;

function buildTrain(line, ref) {
  const M = materials();
  const train = new THREE.Group();
  const parts = { carBody: [], carRoof: [], carUnder: [], carFloor: [], carCeiling: [], carLamp: [], seat: [], pole: [] };
  const doorsShut = []; // platform-side leaves, hidden while the doors stand open
  const wallX = CAR_HALF_W - 0.05;
  for (let c = 0; c < CARS; c++) {
    const zc = carCentre(c);
    const z0 = zc - CAR_BODY / 2, z1 = zc + CAR_BODY / 2;
    parts.carUnder.push([0, 0.6, zc, 2.6, 0.7, CAR_BODY - 1.6]);
    parts.carFloor.push([0, CAR_FLOOR - 0.06, zc, CAR_HALF_W * 2, 0.12, CAR_BODY]);
    parts.carRoof.push([0, CAR_ROOF + 0.09, zc, CAR_HALF_W * 2, 0.18, CAR_BODY]);
    parts.carCeiling.push([0, CAR_ROOF - 0.02, zc, CAR_HALF_W * 2 - 0.2, 0.04, CAR_BODY - 0.2]);
    for (const x of [-0.55, 0.55]) parts.carLamp.push([x, CAR_ROOF - 0.06, zc, 0.12, 0.03, CAR_BODY - 2]);
    // the walls between the doors: solid below the windows, pillars across the open window band, solid above
    const edges = [z0, ...DOORS.flatMap((d) => [zc + d - DOOR_W / 2, zc + d + DOOR_W / 2]), z1];
    for (const side of [-1, 1]) {
      const x = side * wallX;
      parts.carBody.push([x, CAR_ROOF - 0.25, zc, 0.1, 0.5, CAR_BODY]); // over the windows & doors
      for (let k = 0; k < edges.length; k += 2) {
        const a = edges[k], b = edges[k + 1], len = b - a, mid = (a + b) / 2;
        parts.carBody.push([x, CAR_FLOOR + 0.43, mid, 0.1, 0.86, len]);
        for (const pz of len > 3.6 ? [a + 0.12, mid, b - 0.12] : [a + 0.12, b - 0.12]) parts.carBody.push([x, CAR_FLOOR + 1.36, pz, 0.1, 1.0, 0.24]);
        // a bench along the wall, its back against it
        if (len > 1.4) {
          parts.seat.push([side * (wallX - 0.3), CAR_FLOOR + 0.44, mid, 0.5, 0.08, len - 0.5]);
          parts.seat.push([side * (wallX - 0.07), CAR_FLOOR + 0.78, mid, 0.06, 0.6, len - 0.5]);
        }
      }
      for (const d of DOORS) {
        for (const off of [-1, 1]) {
          const leaf = [x, CAR_FLOOR + 1.0, zc + d + off * DOOR_W / 4, 0.07, 2.0, DOOR_W / 2];
          if (side < 0) doorsShut.push(leaf);
          else parts.carBody.push(leaf);
          parts.pole.push([side * (wallX - 0.45), CAR_FLOOR + 1.17, zc + d + off * (DOOR_W / 2 + 0.25), 0.05, 2.34, 0.05]);
        }
      }
    }
    // car ends: a passage in the middle through to the next car; the train's front and back closed
    for (const [ze, outer] of [[z1, c === 0], [z0, c === CARS - 1]]) {
      if (outer) {
        parts.carBody.push([0, (CAR_FLOOR + CAR_ROOF) / 2 - 0.3, ze, CAR_HALF_W * 2, CAR_ROOF - CAR_FLOOR + 1.6, 0.1]);
        continue;
      }
      for (const sx of [-1, 1]) parts.carBody.push([sx * (0.45 + (CAR_HALF_W - 0.45) / 2), (CAR_FLOOR + CAR_ROOF) / 2, ze, CAR_HALF_W - 0.45, CAR_ROOF - CAR_FLOOR, 0.08]);
      parts.carBody.push([0, CAR_ROOF - 0.2, ze, 0.9, 0.4, 0.08]);
    }
  }
  for (const [name, list] of Object.entries(parts)) instanced(train, M[name], list, false);
  const doors = instanced(train, M.carBody, doorsShut, false);
  // lights in every other car (the cars' own glow besides the ceiling strips)
  for (let c = 0; c < CARS; c += 2) {
    const light = new THREE.PointLight(0xeef4ff, 5, 16, 1.4);
    light.position.set(0, CAR_FLOOR + 1.4, carCentre(c) - CAR_LEN / 2);
    train.add(light);
  }
  // The lead car's face: headlights, the cab window and the service bullet
  const faceZ = TRAIN_FRONT + 0.06;
  const bullet = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62), new THREE.MeshBasicNodeMaterial({ map: bulletTexture(ref, line?.color || '#808183') }));
  bullet.position.set(0.72, CAR_FLOOR + 1.9, faceZ + 0.01);
  train.add(bullet);
  for (const side of [-1, 1]) box(train, M.headlight, side * 1.05, CAR_FLOOR - 0.2, faceZ, 0.24, 0.16, 0.04, false);
  box(train, M.window, -0.5, CAR_FLOOR + 1.5, faceZ, 0.9, 0.9, 0.03, false);
  return { group: train, doors };
}

// Where a train's head is at time t of its cycle along a track running +z: in from the tunnel, slowing to a stop with
// its head near the platform's far end, waiting with its doors to the platform, then out into the tunnel ahead
const HEAD_STOP = PLATFORM_LEN / 2 - 6;
const HEAD_REACH = HEAD_STOP + PLATFORM_LEN / 2 + 12; // braking from a head 12 m inside the tunnel: all of it out of sight
// Pulling out as fast as it pulls in: at the hand-off the ridden train runs at the speed it arrives at the next station
const DEPART_ACCEL = HEAD_REACH / (APPROACH * DEPART);
function trainHead(t) {
  if (t < APPROACH) {
    const u = 1 - t / APPROACH;
    return HEAD_STOP - HEAD_REACH * u * u;
  }
  if (t < APPROACH + DWELL) return HEAD_STOP;
  const s = t - APPROACH - DWELL;
  return HEAD_STOP + DEPART_ACCEL * s * s; // the tail clears the platform just before the hand-off
}
// The train's speed (m/s) at time t of its cycle, for the speedometer of a rider
function trainSpeed(t) {
  if (t < APPROACH) return ((2 * HEAD_REACH) / APPROACH) * (1 - t / APPROACH);
  if (t < APPROACH + DWELL) return 0;
  return 2 * DEPART_ACCEL * (t - APPROACH - DWELL);
}

// The station, with the train on track `rideSide` (-1 west, 1 east) running `rideRef` when the player arrives on it
function buildStation(station, rideRef = null, rideSide = 0) {
  const M = materials();
  const frame = routeFrame(station, rideRef);
  const railY = Math.min(frame.trackY, -9);
  const floorY = railY + PLATFORM_H;
  const ceilY = floorY + CEILING;
  const group = new THREE.Group();
  group.name = `SubwayStation ${station.name}`;
  group.position.set(frame.x, 0, frame.z);
  const heading = Math.atan2(frame.dirX, frame.dirZ);
  group.rotation.y = heading;
  const L = PLATFORM_LEN;
  const fullLen = L + 2 * TUNNEL_LEN;

  // Platform, its yellow edges & the track beds with their rails and ties
  box(group, M.platform, 0, floorY - PLATFORM_H / 2, 0, PLATFORM_HALF_W * 2, PLATFORM_H, L);
  for (const side of [-1, 1]) box(group, M.edge, side * (PLATFORM_HALF_W - 0.3), floorY + 0.005, 0, 0.6, 0.01, L);
  for (const side of [-1, 1]) {
    const tx = side * TRACK_X;
    box(group, M.trackbed, tx, railY - 0.42, 0, (HALL_HALF_W - PLATFORM_HALF_W) * 2 + 0.2, 0.3, fullLen);
    for (const r of [-0.72, 0.72]) box(group, M.rail, tx + r, railY - 0.09, 0, 0.08, 0.18, fullLen, false);
    box(group, M.rail, tx + side * 1.45, railY - 0.02, 0, 0.12, 0.14, fullLen, false); // the third rail
  }
  const ties = [];
  for (const side of [-1, 1]) for (let z = -L / 2 - 60; z <= L / 2 + 60; z += 0.76) ties.push([side * TRACK_X, railY - 0.22, z, 2.6, 0.14, 0.24]);
  instanced(group, M.tie, ties);

  // Tile walls, the mosaic band with the station's name, the ceiling; the tunnels beyond both ends
  const mosaic = mosaicTexture(station);
  const bandMat = new THREE.MeshStandardNodeMaterial({ map: mosaic, roughness: 0.4 });
  const wallH = ceilY - (railY - 0.6);
  for (const side of [-1, 1]) {
    box(group, M.tile, side * (HALL_HALF_W + 0.15), (ceilY + railY - 0.6) / 2, 0, 0.3, wallH, L);
    for (let z = -L / 2 + 14; z < L / 2 - 10; z += 26) {
      const band = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.8), bandMat);
      band.position.set(side * HALL_HALF_W - side * 0.01, floorY + 2.75, z);
      band.rotation.y = -side * Math.PI / 2;
      group.add(band);
    }
    // tunnel walls & roof beyond the platform
    for (const end of [-1, 1]) {
      const cz = end * (L / 2 + TUNNEL_LEN / 2);
      box(group, M.tunnel, side * (HALL_HALF_W + 0.15), (ceilY + railY - 0.6) / 2, cz, 0.3, wallH, TUNNEL_LEN, false);
    }
  }
  // the ceiling, open over the top of each flight of stairs (see below)
  const flightTop = L / 2 - 4 - STAIR_LEN; // where the flights start, either end
  box(group, M.ceiling, 0, ceilY + 0.15, 0, HALL_HALF_W * 2 + 0.6, 0.3, flightTop * 2);
  for (const end of [-1, 1]) {
    const zc = end * (flightTop + L / 2 + 0.1) / 2;
    const len = L / 2 + 0.1 - flightTop;
    const sideW = HALL_HALF_W + 0.3 - STAIR_W / 2 - 0.1;
    for (const side of [-1, 1]) box(group, M.ceiling, side * (STAIR_W / 2 + 0.1 + sideW / 2), ceilY + 0.15, zc, sideW, 0.3, len);
  }
  for (const end of [-1, 1]) {
    const ez = end * (L / 2);
    box(group, M.tunnel, 0, ceilY + 0.15, end * (L / 2 + TUNNEL_LEN / 2), HALL_HALF_W * 2 + 0.6, 0.3, TUNNEL_LEN, false);
    // the platform's end wall (between the two tunnel mouths) and the far ends of the tunnels
    box(group, M.tile, 0, (floorY + ceilY) / 2, ez + end * 0.15, PLATFORM_HALF_W * 2 + 0.4, ceilY - floorY, 0.3);
    box(group, M.tunnel, 0, (ceilY + railY - 0.6) / 2, end * (L / 2 + TUNNEL_LEN), HALL_HALF_W * 2 + 0.6, wallH, 0.3, false);
    box(group, M.tunnel, 0, floorY - PLATFORM_H / 2, end * (L / 2 + TUNNEL_LEN / 2), PLATFORM_HALF_W * 2, PLATFORM_H, TUNNEL_LEN, false); // the bench wall between the tracks
  }

  // I-beam columns down both platform edges, the fluorescent strips and the hanging name signs
  const columns = [];
  for (const side of [-1, 1]) for (let z = -L / 2 + 6; z <= L / 2 - 6; z += 7.5) columns.push([side * (PLATFORM_HALF_W - 1.0), (floorY + ceilY) / 2, z, 0.26, ceilY - floorY, 0.32]);
  instanced(group, M.column, columns, true);
  const lamps = [];
  for (const x of [-2.2, 2.2, -TRACK_X, TRACK_X]) for (let z = -L / 2 + 3; z <= L / 2 - 3; z += 6) lamps.push([x, ceilY - 0.06, z, 0.16, 0.06, 3.2]);
  // dim work lights along the tunnel walls, so a ride through the dark shows its speed
  for (const side of [-1, 1]) {
    for (const end of [-1, 1]) for (let d = 12; d < TUNNEL_LEN; d += 18) lamps.push([side * (HALL_HALF_W - 0.05), railY + 2.6, end * (L / 2 + d), 0.08, 0.14, 0.5]);
  }
  instanced(group, M.lamp, lamps);
  const signMat = new THREE.MeshBasicNodeMaterial({ map: nameSignTexture(station) });
  for (let z = -L / 2 + 20; z < L / 2 - 15; z += 30) {
    for (const face of [0, Math.PI]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 0.5), signMat);
      sign.position.set(face ? -0.02 : 0.02, ceilY - 0.75, z);
      sign.rotation.y = face + Math.PI / 2;
      group.add(sign);
    }
  }
  const lights = [];
  for (let z = -L / 2 + 12; z <= L / 2 - 12; z += 22) {
    const light = new THREE.PointLight(0xfff3dc, 38, 24, 1.6);
    light.position.set(0, ceilY - 0.5, z);
    group.add(light);
    lights.push(light);
  }

  // Stairs up to the street at both ends of the platform: a flight rising toward the end wall through an opening in
  // the ceiling, daylight at the top
  const stairs = [];
  const steps = [];
  const stairSteps = 14;
  for (const end of [-1, 1]) {
    const z0 = end * (L / 2 - 4 - STAIR_LEN); // foot of the flight
    stairs.push({ z0, end });
    for (let s = 0; s < stairSteps; s++) {
      const rise = ((s + 1) / stairSteps) * STAIR_RISE;
      const zc = z0 + end * ((s + 0.5) / stairSteps) * STAIR_LEN;
      steps.push([0, floorY + rise / 2, zc, STAIR_W, rise, STAIR_LEN / stairSteps]);
    }
    // the flight's side rails, then its shaft up through the ceiling: tiled sides, daylight from the street at the top
    for (const side of [-1, 1]) box(group, M.column, side * (STAIR_W / 2 + 0.05), floorY + STAIR_RISE / 2 + 0.5, z0 + end * STAIR_LEN / 2, 0.08, STAIR_RISE + 1, STAIR_LEN, false);
    const shaftLen = L / 2 - Math.abs(z0) + 0.1;
    const shaftZ = z0 + end * shaftLen / 2;
    for (const side of [-1, 1]) box(group, M.tile, side * (STAIR_W / 2 + 0.25), ceilY + 2.2, shaftZ, 0.3, 4.4, shaftLen, false);
    box(group, M.daylight, 0, ceilY + 4.3, shaftZ, STAIR_W + 0.2, 0.1, shaftLen, false);
  }
  instanced(group, M.step, steps, true);

  // Trains: one on each track, the east one (+x) running along the route's direction, the west one against it
  const services = [...station.services].filter((r) => LINES.has(r));
  const trains = [-1, 1].map((side, i) => {
    const ref = side === rideSide && rideRef ? rideRef : services[i % Math.max(1, services.length)] || frame.line?.ref || 'S';
    const { group: t, doors } = buildTrain(LINES.get(ref), ref);
    const pivot = new THREE.Group();
    pivot.position.set(side * TRACK_X, railY, 0);
    pivot.rotation.y = side > 0 ? 0 : Math.PI; // the west train runs -z, so its -x (platform side) faces the platform too
    pivot.add(t);
    group.add(pivot);
    return { pivot, train: t, doors, ref, side, t: i * (TRAIN_PERIOD / 2) + 6 };
  });

  return { group, frame, heading, floorY, ceilY, railY, stairs, trains, lights, station };
}

function disposeStation(st) {
  st.group.removeFromParent();
  const shared = new Set(Object.values(materials()));
  st.group.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();
    else if (o.isMesh && o.geometry !== unitBox) o.geometry.dispose();
    if (o.isMesh && !shared.has(o.material)) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

// entrances: the street stairs as placed (street-details.js): [{ x, z, yaw, halfW, halfL }]
function createSubwaySystem(scene, entrances = []) {
  let current = null;
  // On a train: which one, the service, its direction along the route (1 with it: the east track) and where it calls next
  let ride = null;
  const cos = () => Math.cos(current.heading);
  const sin = () => Math.sin(current.heading);
  // world <-> station frame (the group's rotation about y)
  const toLocal = (x, z) => {
    const dx = x - current.frame.x, dz = z - current.frame.z;
    return { lx: dx * cos() - dz * sin(), lz: dx * sin() + dz * cos() };
  };
  const toWorld = (lx, lz) => ({ x: current.frame.x + lx * cos() + lz * sin(), z: current.frame.z - lx * sin() + lz * cos() });

  // The rise of a flight of stairs under (lx, lz), 0 off the stairs
  function stairRise(lx, lz) {
    if (Math.abs(lx) > STAIR_W / 2) return 0;
    for (const s of current.stairs) {
      const along = (lz - s.z0) * s.end;
      if (along > 0 && along < STAIR_LEN + 0.6) return Math.min(STAIR_RISE, (along / STAIR_LEN) * STAIR_RISE);
    }
    return 0;
  }

  // A train's frame (see buildTrain) <-> the station's: the west train's pivot is turned half round
  const trainToStation = (tr, tx, tz) => ({ lx: tr.side * (TRACK_X + tx), lz: tr.side * (tz + trainHead(tr.t)) });
  const stationToTrain = (tr, lx, lz) => ({ tx: lx * tr.side - TRACK_X, tz: lz * tr.side - trainHead(tr.t) });
  const doorsOpen = (tr) => tr.t >= APPROACH + 1 && tr.t < APPROACH + DWELL - 1.5;
  function boardAt(tr, tx, tz) {
    const dir = tr.side; // the east train (+x) runs with the route
    ride = { train: tr, ref: tr.ref, dir, next: nextStop(tr.ref, current.station, dir), tx, tz };
    const { lx, lz } = trainToStation(tr, tx, tz);
    const at = toWorld(lx, lz);
    // facing down the car, the way the train runs
    return { x: at.x, y: current.floorY, z: at.z, heading: current.heading + (tr.side > 0 ? 0 : Math.PI) };
  }

  const system = {
    get active() { return !!current; },
    get station() { return current ? current.station : null; },
    get label() {
      if (!current) return '';
      if (!ride) return current.station.name;
      const t = ride.train.t;
      if (t < APPROACH) return `${ride.ref} train arriving at ${current.station.name}`;
      if (t < APPROACH + DWELL) return `${ride.ref} train at ${current.station.name}`;
      return `${ride.ref} train to ${ride.next ? ride.next.name : current.station.name}`;
    },
    get riding() { return !!ride; },
    // The ridden train's speed in m/s (0 off a train)
    get speed() { return ride ? trainSpeed(ride.train.t) : 0; },
    // Aboard the train standing at the platform beside (x, z): stepped in through its nearest door. Returns where the
    // player now stands (world x, y, z & heading), or null if no train stands there with its doors open.
    board(x, z) {
      if (!current || ride) return null;
      const { lx, lz } = toLocal(x, z);
      for (const tr of current.trains) {
        if (!doorsOpen(tr) || Math.sign(lx) !== tr.side || Math.abs(lx) < PLATFORM_HALF_W - BOARD_REACH) continue;
        const { tz } = stationToTrain(tr, lx, lz);
        if (tz > TRAIN_FRONT || tz < TRAIN_REAR) continue;
        const door = TRAIN_DOORS.reduce((a, d) => (Math.abs(d - tz) < Math.abs(a - tz) ? d : a));
        return boardAt(tr, 0, door);
      }
      return null;
    },
    // Off onto the platform through the nearest door while the train stands at a station: where the player now
    // stands, or null between stations (the doors stay shut)
    alight() {
      if (!ride || !doorsOpen(ride.train)) return null;
      const tr = ride.train;
      const door = TRAIN_DOORS.reduce((a, d) => (Math.abs(d - ride.tz) < Math.abs(a - ride.tz) ? d : a));
      ride = null;
      const { lx, lz } = trainToStation(tr, -CAR_HALF_W - 1.7, door); // clear of the edge, where walking out boards
      const at = toWorld(lx, lz);
      return { x: at.x, y: current.floorY, z: at.z, heading: current.heading + (tr.side > 0 ? -Math.PI / 2 : Math.PI / 2) };
    },
    // The rider's place in the world, from their place in the train
    riderPose() {
      const { lx, lz } = trainToStation(ride.train, ride.tx, ride.tz);
      const at = toWorld(lx, lz);
      return { x: at.x, z: at.z };
    },
    nearestStation(x, z) {
      let best = null, bestD = Infinity;
      for (const s of STATIONS) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bestD) { bestD = d; best = s; }
      }
      return best;
    },
    // Down into the station nearest (x, z): returns where the player arrives on the platform (world x, y, z & heading)
    enter(x, z) {
      this.leave();
      const station = this.nearestStation(x, z);
      if (!station) return null;
      current = buildStation(station);
      scene.add(current.group);
      current.group.updateMatrixWorld(true); // the scene's world matrices don't update themselves (main.js)
      // at the foot of the flight nearest to where the player came down, facing along the platform
      const near = toLocal(x, z).lz >= 0 ? 1 : -1;
      const foot = current.stairs.find((s) => s.end === near) || current.stairs[0];
      const at = toWorld(0, foot.z0 - foot.end * 2.5);
      return { x: at.x, y: current.floorY, z: at.z, heading: current.heading + (foot.end > 0 ? Math.PI : 0) };
    },
    // Back up to the street: the real entrance nearest to where the player stands, or the station's own node
    leave() {
      if (!current) return null;
      const out = { x: current.station.x, z: current.station.z };
      disposeStation(current);
      current = null;
      ride = null;
      return out;
    },
    // Where the player comes out: past the end of the street stairs nearest to (x, z) (street-details.js places the
    // MTA's entrances), on the sidewalk and facing away from them
    exitPoint(x, z) {
      let best = null, bestD = Infinity;
      for (const e of entrances) {
        const d = Math.hypot(e.x - x, e.z - z);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (!best || bestD > 260) return null;
      const ux = Math.sin(best.yaw), uz = Math.cos(best.yaw); // along the stairs
      for (const end of [1, -1]) {
        const ox = best.x + ux * end * (best.halfL + 1.0), oz = best.z + uz * end * (best.halfL + 1.0);
        if (blockAt(ox, oz)) return { x: ox, z: oz, heading: Math.atan2(ux * end, uz * end) };
      }
      return { x: best.x, z: best.z, heading: null };
    },
    // The walking surface under (x, z) in the station: the platform, or a step of the stairs
    floorAt(x, z) {
      if (ride) return current.floorY; // the cars' floors are level with the platforms
      const { lx, lz } = toLocal(x, z);
      return current.floorY + stairRise(lx, lz);
    },
    // Keep the pedestrian (radius r) on the platform: off the tracks, inside the end walls, off the columns
    clamp(pos, r) {
      let alighted = false;
      if (ride) {
        // Inside the train: along the aisle and through the cars, into the doorways, and out of an open one on the
        // platform side onto the platform
        const tr = ride.train;
        const p = toLocal(pos.x, pos.z);
        let { tx, tz } = stationToTrain(tr, p.lx, p.lz);
        tz = Math.max(TRAIN_REAR + r, Math.min(TRAIN_FRONT - r, tz));
        const door = atDoor(tz);
        if (door && doorsOpen(tr) && tx < -CAR_HALF_W + 0.3) { // into an open doorway on the platform side: out
          ride = null; // stepped out: the platform takes them from here (the clamp below sets them on its edge)
          alighted = true;
        } else {
          const near = door ? CAR_HALF_W - 0.12 : AISLE;
          tx = Math.max(-near + (door ? 0 : r), Math.min(near - (door ? 0 : r), tx));
          ride.tx = tx;
          ride.tz = tz;
          const c = trainToStation(tr, tx, tz);
          const w = toWorld(c.lx, c.lz);
          pos.x = w.x;
          pos.z = w.z;
          return;
        }
      }
      const { lx, lz } = toLocal(pos.x, pos.z);
      // Walking off the platform edge through the open doors of a train standing there: aboard
      if (!alighted && Math.abs(lx) > PLATFORM_HALF_W - r) {
        for (const tr of current.trains) {
          if (tr.side !== Math.sign(lx) || !doorsOpen(tr)) continue;
          const { tz } = stationToTrain(tr, lx, lz);
          if (tz > TRAIN_FRONT || tz < TRAIN_REAR || !atDoor(tz)) continue;
          boardAt(tr, -CAR_HALF_W + 0.5, tz); // just inside, clear of the doorway (see the exit above)
          const w = this.riderPose();
          pos.x = w.x;
          pos.z = w.z;
          return;
        }
      }
      let x = Math.max(-PLATFORM_HALF_W + r, Math.min(PLATFORM_HALF_W - r, lx));
      let z = Math.max(-PLATFORM_LEN / 2 + 0.3 + r, Math.min(PLATFORM_LEN / 2 - 0.3 - r, lz));
      // the stairs' side rails: on a flight stay between them, beside it stay clear of it
      const rise = stairRise(0, z);
      if (rise > 0.05) {
        const onFlight = Math.abs(lx) < STAIR_W / 2;
        if (onFlight) x = Math.max(-STAIR_W / 2 + r, Math.min(STAIR_W / 2 - r, x));
        else x = x < 0 ? Math.min(x, -STAIR_W / 2 - 0.1 - r) : Math.max(x, STAIR_W / 2 + 0.1 + r);
      }
      const w = toWorld(x, z);
      pos.x = w.x;
      pos.z = w.z;
    },
    // Climbed far enough up a flight to come out on the street
    reachedStreet(x, z) {
      const { lx, lz } = toLocal(x, z);
      return stairRise(lx, lz) >= STAIR_EXIT_RISE;
    },
    // Keep a camera inside the station: between the walls & the ends, under the ceiling, over the platform or rails
    clampCamera(pos) {
      if (ride) {
        // inside the car with the rider
        const tr = ride.train;
        const p = toLocal(pos.x, pos.z);
        const { tx, tz } = stationToTrain(tr, p.lx, p.lz);
        const c = trainToStation(tr, Math.max(-CAR_HALF_W + 0.25, Math.min(CAR_HALF_W - 0.25, tx)), Math.max(TRAIN_REAR + 0.3, Math.min(TRAIN_FRONT - 0.3, tz)));
        const w = toWorld(c.lx, c.lz);
        pos.x = w.x;
        pos.z = w.z;
        pos.y = Math.max(current.floorY + 0.5, Math.min(current.floorY + CAR_ROOF - CAR_FLOOR - 0.15, pos.y));
        return;
      }
      const { lx, lz } = toLocal(pos.x, pos.z);
      const x = Math.max(-HALL_HALF_W + 0.35, Math.min(HALL_HALF_W - 0.35, lx));
      const reach = ride ? PLATFORM_LEN / 2 + TUNNEL_LEN - 2 : PLATFORM_LEN / 2 + 30; // a rider's camera goes into the tunnels
      const z = Math.max(-reach, Math.min(reach, lz));
      const overPlatform = Math.abs(x) < PLATFORM_HALF_W && Math.abs(z) < PLATFORM_LEN / 2;
      const w = toWorld(x, z);
      pos.x = w.x;
      pos.z = w.z;
      pos.y = Math.max((overPlatform ? current.floorY : current.railY) + 0.4, Math.min(current.ceilY - 0.3, pos.y));
    },
    // The trains run their timetables; the one the player rides carries them on: deep in the tunnel past a station it
    // pulls into the next one on its service (built in place of this one, the train coming in from its tunnel). At the
    // end of the line in Manhattan it turns back. Returns the rider's pose while riding.
    update(dt) {
      if (!current) return null;
      for (const tr of current.trains) {
        tr.t += dt;
        if (tr.t >= TRAIN_PERIOD && tr !== ride?.train) tr.t -= TRAIN_PERIOD;
      }
      let turn = 0;
      if (ride && ride.train.t >= RIDE_HANDOFF) {
        let { ref, dir, next, tx, tz } = ride;
        const before = current.heading;
        if (!next) {
          dir = -dir;
          next = current.station;
        }
        const side = dir; // with the route: the east track
        disposeStation(current);
        current = buildStation(next, ref, side);
        scene.add(current.group);
        current.group.updateMatrixWorld(true); // the scene's world matrices don't update themselves (main.js)
        const tr = current.trains.find((t) => t.side === side);
        tr.t = 0;
        ride = { train: tr, ref, dir, next: nextStop(ref, next, dir), tx, tz };
        turn = current.heading - before; // the route turns between stations: the rider turns with the train
      }
      for (const tr of current.trains) {
        tr.train.position.z = trainHead(tr.t);
        tr.train.updateMatrixWorld(true);
        tr.doors.visible = !doorsOpen(tr);
      }
      return ride ? { ...this.riderPose(), turn } : null;
    }
  };
  return system;
}

export { createSubwaySystem, routeFrame, routeDistance, nextStop, trainHead, trainSpeed, STATIONS, PLATFORM_LEN, TRAIN_PERIOD };
