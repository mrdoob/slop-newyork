import { blockAt } from './city-config.js';
import { createPedestrianRoutes } from './pedestrian-routes.js';
import { PersonCrowd, PersonRig, PEDESTRIAN_DIVE_DURATION } from './pedestrians.js';

// Local pedestrian population: connected walks, curb queues, conversations, keeping out of each other's way and player
// avoidance.
// Traffic supplies crossing permissions and view checks; this system owns the crowd and its animation.
const NUM_PEDS = 340;
const PED_RADIUS = 320;
const NEAR_RADIUS = 350;
const PED_SPAWN_DISTANCE = 150;
const PED_AVOID_INTERVAL = 0.12;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function createPedestrianSystem(network, { player, nearEdges, nearSignals, mayCross, walkOn, visible, nearView }) {
  let clock = 0;
  let focusX = 0, focusZ = 140;
  let hasView = false;
  let pedRange = 0;
  let pedCursor = 0;
  let mode = '';
  let frame = 0;

  for (const n of network.nodes) {
    n.walkers = []; // pedestrians on its crosswalks
    n.curb = []; // pedestrians at or approaching its curbs
  }

  // One instanced draw per level of detail; every pedestrian has a PersonRig that plants its footsteps on the
  // sidewalk (no sliding), with their own build, height, sex, hair, clothes and gait
  const pedCrowd = new PersonCrowd(NUM_PEDS);
  const hash = (i, salt) => {
    const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const peds = [];
  for (let i = 0; i < NUM_PEDS; i++) {
    const female = hash(i, 1) < 0.48;
    const hairRoll = hash(i, 2);
    peds.push({
      placed: false,
      crossesStreets: i % 6 === 0, // some start near crossings; everyone can use them along their route
      x: 0,
      z: 0,
      ax: 0, // track: start, direction, length; position along it and walking direction
      az: 0,
      ux: 0,
      uz: 1,
      len: 1,
      t: 0,
      dir: 1,
      node: null, // the intersection of its crosswalk, which side of it, where along it
      side: 0,
      coord: 0,
      line: 0, // its line over the crosswalk, off the centre line
      waiting: false,
      walkDelay: 0.2 + hash(i, 8) * 1.3,
      walkAt: -1,
      speed: 1.22 + (i % 5) * 0.1 + hash(i, 3) * 0.08, // preferred walking speed
      v: 0, // current speed, easing up to it and down to stops
      pause: 0,
      route: null,
      nextRoute: null,
      nextLeg: 0,
      goalX: 0,
      goalZ: 0,
      goalTime: 0,
      restTime: 0,
      socialTime: 0,
      conversation: null,
      avoidUntil: 0,
      avoidCheck: 0,
      avoidSpeed: 0,
      avoidT: 0,
      resumeDir: 0,
      dodge: 0,
      dodgeTarget: 0,
      shift: 0, // off its walking line, passing someone (as dodge: to the track's right), and where it is heading
      shiftTarget: 0,
      blocked: 0, // seconds stood behind someone or something standing in its way
      steerAt: 0, // when it may next choose a side to pass on
      steerRoom: Infinity, // the room & speed limit its last look ahead found
      steerCap: Infinity,
      index: i,
      diveStart: -Infinity,
      diveHeading: 0,
      diveT: 0,
      rig: new PersonRig({
        seed: i * 1.6180339 + 0.13,
        female,
        scale: (female ? 0.91 : 0.97) + hash(i, 4) * 0.1,
        girth: 0.9 + hash(i, 5) * 0.24,
        hair: female ? (hairRoll < 0.68 ? 1 : 0.3 + hairRoll * 0.25) : hairRoll < 0.08 ? 1 : hairRoll * 0.35,
        armSwing: 0.75 + hash(i, 6) * 0.5,
        stride: 0.94 + hash(i, 7) * 0.12
      })
    });
  }

  const KERB = 1.6; // how far along a crosswalk track pedestrians wait to cross (the curb is 2 m along)
  const pedRoutes = createPedestrianRoutes(network, blockAt);
  const track = { ax: 0, az: 0, ux: 0, uz: 1, len: 1, node: null, side: 0, line: 0, route: null };

  function sidewalkTrack(e) {
    const choices = pedRoutes.along(e);
    if (!choices.length) return false;
    const route = choices[Math.floor(Math.random() * choices.length)];
    Object.assign(track, route, { route });
    return true;
  }

  function crosswalkTrack(n) {
    const choices = pedRoutes.across(n);
    if (!choices.length) return false;
    const route = choices[Math.floor(Math.random() * choices.length)];
    Object.assign(track, route, { route });
    return true;
  }

  // Who is at (or just past) the curbs of each intersection's crosswalks, for whoever comes up behind to queue
  const QUEUE_GAP = 0.62; // m from one person standing in a queue to the next
  const curbNodes = [];
  const curbProgress = (p) => (p.dir > 0 ? p.t : p.len - p.t); // m along its way over (the curb it waits at is KERB)
  function nextCrossingLeg(p) {
    const route = p.nextRoute;
    if (!route) return null;
    for (let i = p.nextLeg; i < route.length; i++) {
      if (route[i].track.node) return route[i];
    }
    return null;
  }
  function atCurb(p) {
    const crossing = p.node ? null : nextCrossingLeg(p);
    const n = p.node || crossing?.track.node;
    if (!n || (p.node && curbProgress(p) > KERB + 0.5) || p._curbNode === n) return;
    if (!n.curb.length) curbNodes.push(n);
    n.curb.push(p);
    p._curbNode = n;
  }
  function gatherCurbs() {
    for (const n of curbNodes) {
      for (let i = 0; i < n.curb.length; i++) n.curb[i]._curbNode = null;
      n.curb.length = 0;
    }
    curbNodes.length = 0;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (p.placed) atCurb(p);
    }
  }

  // Sidewalks to spawn on are picked by how much of them lies around the focus (each road once, as both edges of a
  // two-way road share its sidewalks), so short blocks and two-way streets get no more than their share of people
  const spawnWeights = [];
  let spawnTotal = 0, spawnCount = -1, spawnFirst = null, spawnLast = null;
  function spawnEdge() {
    if (nearEdges.length !== spawnCount || nearEdges[0] !== spawnFirst || nearEdges[nearEdges.length - 1] !== spawnLast) {
      spawnCount = nearEdges.length;
      spawnFirst = nearEdges[0];
      spawnLast = nearEdges[nearEdges.length - 1];
      spawnWeights.length = 0;
      spawnTotal = 0;
      for (const e of nearEdges) {
        // the length of e within NEAR_RADIUS of the focus
        const s = (focusX - e.sx) * e.dx + (focusZ - e.sz) * e.dz;
        const ox = e.sx + e.dx * s - focusX, oz = e.sz + e.dz * s - focusZ;
        const half = Math.sqrt(Math.max(0, NEAR_RADIUS * NEAR_RADIUS - ox * ox - oz * oz));
        spawnTotal += Math.max(0, Math.min(e.len, s + half) - Math.max(0, s - half)) * pedRoutes.share(e);
        spawnWeights.push(spawnTotal);
      }
    }
    const r = Math.random() * spawnTotal;
    let lo = 0, hi = spawnWeights.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spawnWeights[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return nearEdges[lo];
  }
  // People within r of (x, z) (from the neighbour grid)
  function crowdAt(x, z, r) {
    let count = 0;
    const cx = gridCol(x), cz = gridRow(z);
    for (let gz = Math.max(0, cz - 1); gz <= Math.min(GRID_N - 1, cz + 1); gz++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(GRID_N - 1, cx + 1); gx++) {
        for (let k = gridHead[gz * GRID_N + gx]; k >= 0; k = gridNext[k]) {
          const q = peds[k];
          if ((q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < r * r) count++;
        }
      }
    }
    return count;
  }

  // Try crosswalks first for crossing pedestrians, then fall back to sidewalks if no suitable crossing fits.
  function spawnPed(p, rMin, rMax, protectView) {
    const rMinSq = rMin * rMin, rMaxSq = rMax * rMax, gapSq = QUEUE_GAP * QUEUE_GAP;
    for (let attempt = 0; attempt < 10; attempt++) {
      const crosswalk = p.crossesStreets && nearSignals.length > 0 && attempt < 5;
      const ok = crosswalk
        ? crosswalkTrack(nearSignals[Math.floor(Math.random() * nearSignals.length)])
        : nearEdges.length > 0 && sidewalkTrack(spawnEdge());
      if (!ok) continue;
      const along = (focusX - track.ax) * track.ux + (focusZ - track.az) * track.uz;
      const minT = Math.max(0, along - rMax), maxT = Math.min(track.len, along + rMax);
      if (minT > maxT) continue;
      const t = crosswalk ? (Math.random() < 0.5 ? Math.random() * KERB : track.len - Math.random() * KERB) : minT + Math.random() * (maxT - minT);
      const x = track.ax + track.ux * t;
      const z = track.az + track.uz * t;
      const dx = x - focusX, dz = z - focusZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < rMinSq || d2 > rMaxSq || (protectView && nearView(x, z, 2, PED_SPAWN_DISTANCE))) continue;
      if (player.active && (x - player.x) * (x - player.x) + (z - player.z) * (z - player.z) < 100) continue;
      if (!crosswalk && crowdAt(x, z, 4) >= 2) continue;
      if (crosswalk) {
        let crowded = false;
        const curb = track.node.curb;
        for (let i = 0; i < curb.length; i++) {
          const q = curb[i];
          if ((q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < gapSq) { crowded = true; break; }
        }
        if (crowded) continue;
      }
      if (p.conversation) endConversation(p.conversation);
      Object.assign(p, track);
      p.t = t;
      p.dir = t < track.len * 0.5 ? 1 : -1;
      p.x = x;
      p.z = z;
      p.v = crosswalk ? 0 : p.speed;
      p.pause = 0;
      p.waiting = false;
      p.walkAt = -1;
      p.avoidUntil = 0;
      p.resumeDir = 0;
      p.dodge = p.dodgeTarget = 0;
      p.shift = p.shiftTarget = 0;
      p.blocked = 0;
      p.steerAt = 0;
      p.steerRoom = p.steerCap = Infinity;
      p.diveStart = -Infinity;
      p.avoidCheck = clock + Math.random() * PED_AVOID_INTERVAL;
      p.nextRoute = null;
      p.nextLeg = 0;
      p.goalTime = 0;
      p.restTime = clock + 25 + Math.random() * 45;
      p.socialTime = clock + 5 + Math.random() * 15;
      p._curbNode = null;
      p.rig.placed = false; // stands afresh where it now is
      p.placed = true;
      gridAdd(p); // later spawns this frame must see it
      if (crosswalk) atCurb(p);
      return true;
    }
    return false;
  }

  // Continue through validated sidewalk corners. Crossing tracks retain their curb queues and right of way;
  // only a dead end needs a turnaround. Goals guide local choices without a city-wide path search.
  const PED_ACCEL = 1.3; // m/s^2 setting off
  const PED_BRAKE = 1.6; // m/s^2 easing to a stop
  const TURN_TIME = 0.85; // s turning round at the end of the track
  const PED_ESCAPE_SPEED = 5;
  const PED_ESCAPE_ACCEL = 9;
  const PED_ESCAPE_BRAKE = 6;
  const PED_LOOKAHEAD = 1.5;
  const PED_DIVE_DISTANCE = 1.9;
  const PED_DODGE_SPEED = PED_DIVE_DISTANCE / 0.5;

  // Limit an escape to the current validated track, respecting curbs and people in either direction.
  // Only threatened pedestrians do this local scan, at most once every 120 ms.
  function escapeRoom(p, dir) {
    let room = dir > 0 ? p.len - p.t : p.t;
    const s = dir > 0 ? p.t : p.len - p.t;
    if (p.node && s <= KERB + 1e-6 && !mayCross(p)) room = Math.min(room, Math.max(0, KERB - s));
    for (const q of peds) {
      if (q === p || !q.placed) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const forward = (dx * p.ux + dz * p.uz) * dir;
      if (forward <= 0 || forward > Math.min(room + QUEUE_GAP, 6)) continue;
      const side = dx * p.uz - dz * p.ux;
      if (Math.abs(side) < QUEUE_GAP) room = Math.min(room, Math.max(0, forward - Math.sqrt(QUEUE_GAP * QUEUE_GAP - side * side)));
    }
    return room;
  }

  // Sweep the pedestrian against the player's oriented footprint. Short linear segments account for braking,
  // acceleration and track ends without missing fast vehicles between samples or allocating temporary vectors.
  function playerContactTime(p, speed, room, emergency = true, dodgeTarget = p.dodgeTarget, diving = false) {
    const dir = speed < 0 ? -1 : speed > 0 ? 1 : p.dir;
    let v = diving ? speed : dir === p.dir ? p.v * p.dir : 0;
    let moved = 0;
    let side = p.dodge;
    const dx = p.x - player.x, dz = p.z - player.z;
    let x = dx * player.fz - dz * player.fx, z = dx * player.fx + dz * player.fz;
    const ux = p.ux * player.fz - p.uz * player.fx, uz = p.ux * player.fx + p.uz * player.fz;
    const vx = player.vx * player.fz - player.vz * player.fx, vz = player.vx * player.fx + player.vz * player.fz;
    const sideways = dodgeTarget !== p.dodge;
    const diveX = Math.abs(sideways ? uz : ux), diveZ = Math.abs(sideways ? ux : uz);
    // A prone pedestrian is longer than a standing one; project that body into the car's frame too.
    const halfW = player.halfW + (diving ? diveX + 0.4 * diveZ : 0.45);
    const halfL = player.halfL + (diving ? diveZ + 0.4 * diveX : 0.45);
    const acceleration = emergency ? PED_ESCAPE_ACCEL : PED_ACCEL;
    const braking = emergency ? PED_ESCAPE_BRAKE : 2 * PED_BRAKE;
    const step = 0.25;
    for (let time = 0; time < PED_LOOKAHEAD; time += step) {
      const rate = Math.abs(speed) > Math.abs(v) ? acceleration : braking;
      const nextV = diving ? speed : v + clamp(speed - v, -rate * step, rate * step);
      const distance = Math.min(room - moved, Math.abs((v + nextV) * 0.5 * step));
      moved += distance;
      const sideStep = clamp(dodgeTarget - side, -(diving || dodgeTarget ? PED_DODGE_SPEED : 1.8) * step, (diving || dodgeTarget ? PED_DODGE_SPEED : 1.8) * step);
      side += sideStep;
      const sx = ux * dir * distance + uz * sideStep - vx * step;
      const sz = uz * dir * distance - ux * sideStep - vz * step;
      let enter = 0, exit = 1;
      for (let axis = 0; axis < 2; axis++) {
        const pos = axis ? z : x, delta = axis ? sz : sx;
        const extent = axis ? halfL : halfW;
        if (Math.abs(delta) < 1e-6) {
          if (Math.abs(pos) > extent) { exit = -1; break; }
        } else {
          const a = (-extent - pos) / delta, b = (extent - pos) / delta;
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (enter <= exit) return time + enter * step;
      x += sx; z += sz; v = nextV;
    }
    return Infinity;
  }

  function turnPed(p, dir) {
    p.walkAt = -1;
    p.dir = dir;
    p.v = 0;
    p.nextRoute = null;
    p.nextLeg = 0;
    p.waiting = false;
  }

  function dodgeClear(p, offset, diving = false) {
    // Reserve space for the outstretched body as well as its centre when landing.
    const end = offset + (diving ? Math.sign(offset - p.dodge) * 0.9 : 0);
    if (!pedRoutes.canDodge(p, end + p.shift)) return false;
    const dx = p.uz * (end - p.dodge), dz = -p.ux * (end - p.dodge);
    const lengthSq = dx * dx + dz * dz;
    for (const q of peds) {
      if (q === p || !q.placed) continue;
      const t = clamp(((q.x - p.x) * dx + (q.z - p.z) * dz) / lengthSq, 0, 1);
      if ((p.x + dx * t - q.x) ** 2 + (p.z + dz * t - q.z) ** 2 < QUEUE_GAP ** 2) return false;
    }
    return true;
  }

  function avoidPlayer(p) {
    // Commit to the landing and get-up; steering or walking during this pose would slide across the ground.
    if (clock - p.diveStart < PEDESTRIAN_DIVE_DURATION) return;
    // Stay off the walking line until the approaching vehicle has passed; returning is swept too.
    if (p.dodgeTarget && clock >= p.avoidUntil) {
      if ((!p.dodge || dodgeClear(p, 0)) && (!pedRange || playerContactTime(p, 0, 0, true, 0) === Infinity)) p.dodgeTarget = 0;
      else p.avoidUntil = clock + 0.6;
    }
    // A retreat is temporary: once clear, turn back toward the original destination instead of walking into
    // the people behind. Corner transitions below discard this old direction along with the escape boundary.
    if (p.resumeDir && (clock >= p.avoidUntil || !pedRange)) {
      if (p.dir !== p.resumeDir) {
        turnPed(p, p.resumeDir);
        p.pause = TURN_TIME;
      }
      p.resumeDir = 0;
      p.avoidCheck = 0;
    }
    if (!pedRange) { if (!p.dodgeTarget) p.avoidUntil = 0; return; }
    const dx = p.x - player.x, dz = p.z - player.z;
    if (dx * dx + dz * dz > pedRange * pedRange || clock < p.avoidCheck) return;
    p.avoidCheck = clock + PED_AVOID_INTERVAL;
    // A standing or creeping vehicle is walked round (steer), not run from
    if (clock >= p.avoidUntil && player.vx * player.vx + player.vz * player.vz < SLOW_PLAYER * SLOW_PLAYER) return;
    const ahead = p.dir > 0 ? p.len - p.t : p.t;
    const dodging = p.dodge !== 0 || p.dodgeTarget !== 0;
    const normalSpeed = dodging || p.pause > 0 || p.conversation || p.waiting ? 0 : p.speed;
    const normalRoom = p.node && curbProgress(p) <= KERB + 1e-6 && !mayCross(p) ? Math.max(0, KERB - curbProgress(p)) : ahead;
    const avoiding = clock < p.avoidUntil;
    const escapeAhead = Math.max(0, Math.min(ahead, (p.avoidT - p.t) * p.dir));
    const contact = playerContactTime(p, p.dir * normalSpeed, normalRoom, false);
    if (contact === Infinity
      && (!avoiding || playerContactTime(p, p.dir * p.avoidSpeed, escapeAhead) === Infinity)) return;

    const forward = escapeRoom(p, p.dir);
    const stop = playerContactTime(p, 0, forward);
    const inRoad = p.node && p.t > 2 && p.t < p.len - 2;
    let dir = p.dir, speed = 0, room = forward, best = stop, dodgeTarget = p.dodgeTarget;
    if (!dodging && ((inRoad && player.vx * player.vx + player.vz * player.vz > 1) || stop !== Infinity)) {
      speed = PED_ESCAPE_SPEED;
      best = playerContactTime(p, dir * speed, forward);
      // Corner connectors need their pending route; only full sidewalk/crosswalk tracks can turn around.
      if (p.node || p.route?.edge) {
        const back = escapeRoom(p, -dir);
        const retreat = playerContactTime(p, -dir * speed, back);
        if (retreat > best + (avoiding ? 0.2 : 0)
          || (!avoiding && retreat === Infinity && inRoad && ahead > p.len * 0.5)) {
          dir = -dir; room = back; best = retreat;
        }
      }
      if (stop > best) { dir = p.dir; speed = 0; room = forward; best = stop; }
    }
    if (!inRoad && player.vx * player.vx + player.vz * player.vz > 4 && best !== Infinity) {
      for (const offset of [p.dodge - PED_DIVE_DISTANCE, p.dodge + PED_DIVE_DISTANCE]) {
        if (!dodgeClear(p, offset, true)) continue;
        const escape = playerContactTime(p, 0, 0, true, offset, true);
        if (escape > best + 0.1) {
          best = escape; dodgeTarget = offset; dir = p.dir; speed = 0; room = 0;
        }
      }
    }
    const sideDive = Math.abs(dodgeTarget - p.dodgeTarget) > 0.5;
    const diveT = p.t + dir * PED_DIVE_DISTANCE;
    const flatLanding = !p.node || (Math.abs(diveT - 2) > 1 && Math.abs(diveT - (p.len - 2)) > 1);
    // In a crosswalk, dive along the checked escape route when the car is close. Include the prone body in
    // the room check and predict the stop at the landing, rather than assuming they keep running afterwards.
    const forwardDive = !dodging && !sideDive && contact < 1 && speed > 0 && room >= PED_DIVE_DISTANCE + 0.9 && flatLanding
      && player.vx * player.vx + player.vz * player.vz > 4
      && playerContactTime(p, dir * PED_DODGE_SPEED, PED_DIVE_DISTANCE, true, dodgeTarget, true) === Infinity;
    if (sideDive || forwardDive) {
      p.diveStart = clock;
      p.diveT = forwardDive ? diveT : p.t;
      const side = Math.sign(dodgeTarget - p.dodge);
      p.diveHeading = forwardDive ? Math.atan2(p.ux * dir, p.uz * dir) : Math.atan2(p.uz * side, -p.ux * side);
      speed = 0;
    }
    p.dodgeTarget = dodgeTarget;
    if (p.conversation) endConversation(p.conversation);
    if (!p.resumeDir) p.resumeDir = p.dir;
    if (dir !== p.dir) turnPed(p, dir);
    p.pause = 0;
    p.avoidSpeed = speed;
    p.avoidT = p.t + dir * room;
    p.avoidUntil = Math.max(clock + 0.6, p.diveStart + PEDESTRIAN_DIVE_DURATION);
    p.restTime = Math.max(p.restTime, clock + 5);
    p.socialTime = Math.max(p.socialTime, clock + 5);
  }

  // ---- Keeping out of each other's way --------------------------------------------------------------------------
  // Everyone placed sits in a 5 m grid around the focus (linked lists in typed arrays), rebuilt every frame. A walker
  // looks a few metres ahead along its track for whoever is in its path: other people, the player on foot, or the
  // player's car or bicycle while it stands or creeps (moving faster, it is run from instead: avoidPlayer). It passes
  // on whichever side is clear, stepping off its walking line (on the sidewalk only where the sidewalk is free; out of
  // the stripes on a crosswalk, or right round a car standing on it), slowing until it is clear; it follows a slower
  // walker it can't pass, and waits behind someone standing in its way, turning back after a few seconds if they stay.
  // Walkers meeting each give way, half the room each, keeping right unless already passing the other way.
  const GRID = 5;
  const GRID_N = 150; // cells a side: everyone within NEAR_RADIUS (and some) of the focus
  const gridHead = new Int32Array(GRID_N * GRID_N); // first person in each cell, -1 for none
  const gridNext = new Int32Array(NUM_PEDS); // the next person in the same cell
  let gridX0 = 0, gridZ0 = 0; // the grid's corner
  const gridCol = (x) => Math.floor((x - gridX0) / GRID);
  const gridRow = (z) => Math.floor((z - gridZ0) / GRID);
  function gridAdd(p) {
    const cx = gridCol(p.x), cz = gridRow(p.z);
    if (cx < 0 || cz < 0 || cx >= GRID_N || cz >= GRID_N) return;
    const c = cz * GRID_N + cx;
    gridNext[p.index] = gridHead[c];
    gridHead[c] = p.index;
  }
  function rebuildGrid() {
    gridX0 = focusX - GRID_N * GRID * 0.5;
    gridZ0 = focusZ - GRID_N * GRID * 0.5;
    gridHead.fill(-1);
    for (let i = 0; i < peds.length; i++) if (peds[i].placed) gridAdd(peds[i]);
  }

  const BODY = QUEUE_GAP; // centre to centre, two people passing each other
  const SHIFT_RATE = 0.75; // m/s stepping sideways while walking
  const LINE_SHIFT = 1.3; // how far a walker strays from its line on a sidewalk (the other line is 1.1 m away)
  const STRIPE_SHIFT = 0.8; // ... within the stripes of a crosswalk
  const ROUND_CAR = 3.8; // ... on a crosswalk, walking round a car standing across it
  const SLOW_PLAYER = 1.5; // m/s: a player vehicle slower than this is walked round, not run from
  const BLOCKED_TURN = 3; // s waiting behind someone standing still before turning back
  // Who is around the walker in its own frame (f metres ahead, l to its right): the band of l its centre must keep out
  // of, over a stretch of f
  const MAX_NEAR = 48;
  const nearL0 = new Float64Array(MAX_NEAR), nearL1 = new Float64Array(MAX_NEAR);
  const nearF0 = new Float64Array(MAX_NEAR), nearF1 = new Float64Array(MAX_NEAR);
  let nearCount = 0;
  const probe = { ax: 0, az: 0, ux: 0, uz: 1, t: 0, x: 0, z: 0 };
  let steerRoom = Infinity, steerCap = Infinity;

  // Is lateral position l (to the walker's right) clear of everyone but `skip` from f0 to f1 ahead, and on the way there?
  function laneFree(l, f0, f1, skip) {
    for (let k = 0; k < nearCount; k++) {
      if (k === skip || nearF1[k] < f0 || nearF0[k] > f1) continue;
      const lo = nearL0[k], hi = nearL1[k];
      if (l > lo && l < hi) return false;
      // stepping across to l: nobody beside the walker in between
      if (nearF0[k] < 0.8 && nearF1[k] > -0.6 && Math.min(0, l) < hi && Math.max(0, l) > lo) return false;
    }
    return true;
  }

  // May the walker stand at offset `shift` (track units) about `ahead` metres on? Within its bounds, and on the
  // sidewalk (the crosswalk's road surface is open)
  function shiftFits(p, shift, ahead, wide) {
    const limit = p.node ? (wide ? ROUND_CAR : STRIPE_SHIFT) : wide ? 2.6 : LINE_SHIFT;
    if (Math.abs(shift + p.dodge) > limit) return false;
    if (p.node) return true;
    probe.ax = p.ax; probe.az = p.az; probe.ux = p.ux; probe.uz = p.uz;
    probe.t = clamp(p.t + p.dir * ahead, 0, p.len);
    probe.x = p.ax + p.ux * probe.t + p.uz * (p.dodge + p.shift);
    probe.z = p.az + p.uz * probe.t - p.ux * (p.dodge + p.shift);
    return pedRoutes.canDodge(probe, shift + p.dodge);
  }

  // Are p & q bound for the same crosswalk, the same way? (q, standing, is then queuing ahead of p, not in its way)
  function sameQueue(p, q) {
    if (!q._curbNode || q._curbNode !== p._curbNode) return false;
    const a = p.node ? null : nextCrossingLeg(p), b = q.node ? null : nextCrossingLeg(q);
    const ta = p.node ? p : a?.track, tb = q.node ? q : b?.track;
    return !!ta && !!tb && ta.side === tb.side && (p.node ? p.dir : a.dir) === (q.node ? q.dir : b.dir);
  }

  function steer(p, dt, ahead) {
    steerRoom = steerCap = Infinity;
    const fx = p.ux * p.dir, fz = p.uz * p.dir, rx = -fz, rz = fx;
    const look = Math.min(GRID, 3 + p.speed * 1.4); // (within the 3 x 3 grid cells around)
    nearCount = 0;
    // The first one in the way: its entry, how far ahead (centre to centre; a footprint counts from its face), how fast
    // it moves the walker's way, and what it is (0 a walker, 1 someone queuing ahead of it, 2 the player, 3 someone
    // waiting to cross elsewhere, who lets it through)
    let block = -1, blockF = Infinity, blockV = 0, blockKind = 0, blockFacing = false;
    const cx = gridCol(p.x), cz = gridRow(p.z);
    for (let gz = Math.max(0, cz - 1); gz <= Math.min(GRID_N - 1, cz + 1); gz++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(GRID_N - 1, cx + 1); gx++) {
        for (let k = gridHead[gz * GRID_N + gx]; k >= 0 && nearCount < MAX_NEAR; k = gridNext[k]) {
          const q = peds[k];
          if (q === p) continue;
          const ox = q.x - p.x, oz = q.z - p.z;
          const f = ox * fx + oz * fz;
          if (f < -1.2 || f > look) continue;
          const l = ox * rx + oz * rz;
          if (l > 2.8 || l < -2.8) continue;
          const i = nearCount++;
          nearL0[i] = l - BODY; nearL1[i] = l + BODY; nearF0[i] = f - 0.3; nearF1[i] = f + 0.3;
          if (f > 0 && l > -BODY && l < BODY && f < blockF) {
            block = i; blockF = f;
            const heading = q.dir * (q.ux * fx + q.uz * fz);
            blockV = q.v * heading;
            // coming the other way, or stopped facing the walker but about to (not resting, talking or queuing)
            blockFacing = heading < -0.5 && !(q.pause > 0) && !q.conversation && !q.waiting;
            blockKind = q.v >= 0.3 ? 0 : sameQueue(p, q) ? 1 : q.waiting || (q.node && curbProgress(q) <= KERB + 0.5) ? 3 : 0;
          }
        }
      }
    }
    // The player: on foot like anyone else; a standing or creeping vehicle as its footprint
    if (player.active && nearCount < MAX_NEAR && (mode === 'person' || player.vx * player.vx + player.vz * player.vz < SLOW_PLAYER * SLOW_PLAYER)) {
      const ox = player.x - p.x, oz = player.z - p.z;
      const f = ox * fx + oz * fz, l = ox * rx + oz * rz;
      // the footprint's half extents in the walker's frame (its forward & right half vectors projected), plus the
      // walker's own half width
      const hfx = player.fx * player.halfL, hfz = player.fz * player.halfL;
      const hrx = -player.fz * player.halfW, hrz = player.fx * player.halfW;
      const ef = Math.abs(hfx * fx + hfz * fz) + Math.abs(hrx * fx + hrz * fz);
      const el = Math.abs(hfx * rx + hfz * rz) + Math.abs(hrx * rx + hrz * rz) + 0.35;
      if (f + ef > -1.2 && f - ef < look && Math.abs(l) < el + 2.8) {
        const i = nearCount++;
        nearL0[i] = l - el; nearL1[i] = l + el; nearF0[i] = f - ef - 0.3; nearF1[i] = f + ef + 0.3;
        const face = f - ef + 0.3; // as far as a person would be, centre to centre, standing against the face
        if (f + ef > 0 && l > -el && l < el && face < blockF) {
          block = i; blockF = Math.max(0.3, face); blockKind = 2; blockFacing = false;
          blockV = player.vx * fx + player.vz * fz;
        }
      }
    }

    // Nobody in the way: drift back onto the walking line once it is clear (and before the end of the track, to
    // round the corner on it)
    if (block < 0) {
      p.blocked = 0;
      if (p.shiftTarget !== 0 && (ahead < 2.5 || laneFree(p.shift * p.dir, -0.6, 2.5, -1))) p.shiftTarget = 0;
      return;
    }
    const oncoming = blockKind === 0 && (blockV < -0.3 || blockFacing);
    // Queuing at the curb, or following a walker going (nearly) as fast
    if (blockKind === 1 || (blockKind === 0 && blockV > p.speed * 0.8)) {
      p.blocked = 0;
      steerRoom = Math.max(0, blockF - QUEUE_GAP);
      if (blockKind === 0) steerCap = blockV;
      return;
    }
    // Pass. Keep the side already chosen while it stays clear, else choose one, at most every 0.4 s as the sidewalk
    // has to be checked
    const lo = nearL0[block], hi = nearL1[block], centre = (lo + hi) * 0.5;
    let target = (p.shiftTarget - p.shift) * -p.dir; // where the walker is stepping to, from where it is, to its right
    if (!((target <= lo || target >= hi) && laneFree(target, 0, blockF + 1.2, block))) {
      target = NaN;
      if (oncoming) {
        // Meeting: each makes half the room, on the side both agree on as each sees the other at the same distance to
        // its right: keep to the right unless already passing the other way. Never switch sides: a walker that can't
        // step far enough steps as far as it can (the other keeps stepping until they are clear), slowing down
        const want = centre < 0.05 ? (centre + BODY) * 0.5 + 0.05 : (centre - BODY) * 0.5 - 0.05;
        if (clock >= p.steerAt) {
          p.steerAt = clock + 0.4;
          let step = 0;
          for (const part of [1, 0.6, 0.3]) {
            if (shiftFits(p, p.shift - p.dir * want * part, Math.min(blockF, 2), false)) { step = want * part; break; }
          }
          p.shiftTarget = p.shift - p.dir * step;
        }
        // close in only as fast as the two of them stepping aside make the room (the other may be stuck: edge on)
        p.blocked = 0;
        const clearIn = Math.max(0.05, (BODY - Math.abs(centre)) / (2 * SHIFT_RATE));
        steerCap = Math.max(p.speed * 0.3, (blockF - 0.3) / clearIn + blockV);
        return;
      }
      // Overtaking or going round someone standing: on whichever side is nearer and clear, the left if about even
      const right = hi + 0.05, left = lo - 0.05;
      if (clock >= p.steerAt) {
        p.steerAt = clock + 0.4;
        const wide = blockKind === 2 && mode !== 'person';
        for (const l of right < -left - 0.3 ? [right, left] : [left, right]) {
          const shift = p.shift - p.dir * l;
          if (laneFree(l, 0, blockF + 1.2, block) && shiftFits(p, shift, Math.min(blockF, 2), wide)) {
            target = l;
            p.shiftTarget = shift;
            break;
          }
        }
      }
      if (target !== target && blockKind === 3) {
        // people waiting to cross elsewhere let a walker through: it edges by them, as far right as it may
        const limit = p.node ? STRIPE_SHIFT : LINE_SHIFT * 0.5;
        p.shiftTarget = clamp(p.shift - p.dir * right, -limit, limit);
        steerCap = p.speed * 0.5;
        p.blocked = 0;
        return;
      }
    }
    if (target === target) {
      // Passing: close in only as fast as the step aside clears them (an oncoming walker steps aside as well)
      p.blocked = 0;
      const exit = target > 0 ? hi : -lo;
      const clearIn = exit / (oncoming ? 2 * SHIFT_RATE : SHIFT_RATE);
      steerCap = Math.max(0, (blockF - 0.45) / Math.max(clearIn, 0.05) + blockV);
      return;
    }
    // Stuck behind them: a slower walker is followed; someone (or something) standing is waited for, then turned from
    steerRoom = Math.max(0, blockF - 0.75);
    if (blockV > 0.2) {
      p.blocked = 0;
      steerCap = blockV;
      return;
    }
    p.blocked += dt;
    const canTurn = !p.node ? !!p.route?.edge : curbProgress(p) <= KERB + 0.2;
    if (p.blocked > BLOCKED_TURN && canTurn) {
      p.blocked = 0;
      p.shiftTarget = 0;
      turnPed(p, -p.dir);
      p.pause = TURN_TIME;
      steerRoom = 0;
    }
  }

  // A crossing with a long queue at its curb puts people off: they take another way if there is one
  function queuePenalty(path) {
    for (let i = 0; i < path.length; i++) {
      const track = path[i].track;
      if (!track.node) continue;
      let queued = 0;
      for (const q of track.node.curb) {
        const leg = q.node ? null : nextCrossingLeg(q);
        if (!q.node && !leg) continue;
        if ((q.node ? q.side : leg.track.side) === track.side && (q.node ? q.dir : leg.dir) === path[i].dir) queued++;
      }
      return queued > 4 ? (queued - 4) * 0.6 : 0;
    }
    return 0;
  }

  // Is the player's vehicle about to drive over p's crosswalk? Nobody steps off in front of it, even on the WALK: its
  // centre line crosses the crosswalk's within the next 4 s, anywhere between the curbs
  function playerComing(p) {
    if (!pedRange) return false;
    const vx = player.vx, vz = player.vz;
    if (vx * vx + vz * vz < 4) return false;
    const denom = vx * p.uz - vz * p.ux;
    if (Math.abs(denom) < 1e-6) return false;
    const ox = p.ax - player.x, oz = p.az - player.z;
    const time = (ox * p.uz - oz * p.ux) / denom; // when the vehicle reaches the crosswalk's line
    const along = (ox * vz - vx * oz) / denom; // where along the track it crosses it
    return time > -0.5 && time < 4 && along > -player.halfL - 1 && along < p.len + player.halfL + 1;
  }

  const walkedNodes = [];
  function walk(p, dt) {
    const avoiding = clock < p.avoidUntil;
    const diving = clock - p.diveStart < PEDESTRIAN_DIVE_DURATION;
    const dodging = p.dodge !== 0 || p.dodgeTarget !== 0;
    const brake = avoiding ? PED_ESCAPE_BRAKE : PED_BRAKE;
    if (p.pause > 0) p.pause = Math.max(0, p.pause - dt);
    const ahead = p.dir > 0 ? p.len - p.t : p.t;
    const gdx = p.x - p.goalX, gdz = p.z - p.goalZ;
    if (clock >= p.goalTime || gdx * gdx + gdz * gdz < 625) {
      const destination = nearEdges[Math.floor(Math.random() * nearEdges.length)];
      p.goalX = destination ? destination.sx + destination.dx * destination.len * 0.5 : p.x;
      p.goalZ = destination ? destination.sz + destination.dz * destination.len * 0.5 : p.z;
      p.goalTime = clock + 120 + Math.random() * 180;
    }
    if (!p.nextRoute && p.route && ahead < 4) {
      p.nextRoute = pedRoutes.next(p.route, p.dir, p.goalX, p.goalZ, queuePenalty);
      p.nextLeg = 0;
      if (!p.node && p.nextRoute) atCurb(p);
    }
    // (stopping for a moment on its walking line, away from anyone)
    if (!p.node && p.route?.edge && p.t > 6 && p.t < p.len - 6 && clock >= p.restTime && p.shift === 0 && p.shiftTarget === 0
      && crowdAt(p.x, p.z, 1.2) <= 1) {
      p.pause = 1.5 + Math.random() * 3;
      p.restTime = clock + 35 + Math.random() * 55;
    }
    let vMax = avoiding ? p.avoidSpeed : p.pause > 0 || p.conversation ? 0 : p.speed;
    if (dodging || diving) p.v = vMax = 0;
    if (!p.nextRoute) vMax = Math.min(vMax, Math.sqrt(2 * brake * ahead));
    let room = Infinity;
    if (!p.node && p.nextRoute) {
      // A queue can reach back onto the sidewalk. Keep clear before entering its track, including short corner
      // segments; actual separation matters where the approach meets the crossing at an angle.
      const crossing = nextCrossingLeg(p);
      if (crossing) {
        const entranceX = crossing.track.ax + (crossing.dir < 0 ? crossing.track.ux * crossing.track.len : 0);
        const entranceZ = crossing.track.az + (crossing.dir < 0 ? crossing.track.uz * crossing.track.len : 0);
        let leader = null, nearestSq = Infinity;
        for (const q of crossing.track.node.curb) {
          const next = q.node ? null : nextCrossingLeg(q);
          const queued = q.node ? q : next?.track;
          if (!queued || queued.node !== crossing.track.node || queued.side !== crossing.track.side || (q.node ? q.dir : next.dir) !== crossing.dir || Math.abs(queued.line - crossing.track.line) > 0.55) continue;
          const edx = q.x - entranceX, edz = q.z - entranceZ;
          const distSq = edx * edx + edz * edz;
          if (!q.node && distSq < nearestSq) { leader = q; nearestSq = distSq; }
          if (q === p) continue;
          const dx = q.x - p.x, dz = q.z - p.z;
          const forward = (dx * p.ux + dz * p.uz) * p.dir;
          const lateral2 = Math.max(0, dx * dx + dz * dz - forward * forward);
          if (forward >= 0 && lateral2 < QUEUE_GAP * QUEUE_GAP) {
            room = Math.min(room, Math.max(0, forward - Math.sqrt(QUEUE_GAP * QUEUE_GAP - lateral2)));
          }
        }
        if (leader && leader !== p) {
          // The closest arrival merges first. Keep other approaches outside its remaining walking lines,
          // so perpendicular queues cannot trap each other at the entrance after WALK turns green.
          const yieldToLine = (line) => {
            const side = (p.x - line.ax) * line.uz - (p.z - line.az) * line.ux;
            const toward = (p.ux * line.uz - p.uz * line.ux) * p.dir;
            if (side * toward < 0) room = Math.min(room, Math.max(0, (Math.abs(side) - QUEUE_GAP - 0.01) / Math.abs(toward)));
          };
          yieldToLine(leader);
          for (let i = leader.nextLeg; i < leader.nextRoute.length; i++) {
            yieldToLine(leader.nextRoute[i].track);
            if (leader.nextRoute[i].track.node) break;
          }
        }
      }
    }
    let canCross = true;
    if (p.node) {
      // room to walk before standing: up to the curb unless p may cross, and up to the back of whoever is ahead
      const s = curbProgress(p);
      if (s <= KERB + 1e-6) {
        const walk = walkOn(p.side);
        if (!walk) p.walkAt = -1;
        else if (p.walkAt < 0) p.walkAt = clock + p.walkDelay;
        // React to WALK independently of the queue or vehicles still clearing the crossing.
        canCross = walk && (avoiding || clock >= p.walkAt) && mayCross(p) && !playerComing(p);
      }
      room = s <= KERB + 1e-6 && !canCross ? Math.max(0, KERB - s) : Infinity;
      for (const q of p.node.curb) {
        if (q === p || q.node !== p.node || q.side !== p.side || q.dir !== p.dir || Math.abs(q.line - p.line) > 0.55) continue;
        const gap = curbProgress(q) - s;
        if (gap > 0) room = Math.min(room, Math.max(0, gap - QUEUE_GAP));
      }
    }
    if (avoiding) room = Math.min(room, Math.max(0, (p.avoidT - p.t) * p.dir));
    // Keep out of other people's way (and the player's), except escaping a vehicle or queuing at the curb (the queue
    // keeps its own spacing)
    if (!avoiding && !dodging && !diving && vMax > 0 && !(p.node && curbProgress(p) <= KERB + 0.5)) {
      // (beyond 70 m, a third of them a frame, holding the room they found, less the ground covered since)
      const fdx = p.x - focusX, fdz = p.z - focusZ;
      if (fdx * fdx + fdz * fdz < 4900 || (frame + p.index) % 3 === 0) {
        steer(p, dt, ahead);
        p.steerRoom = steerRoom;
        p.steerCap = steerCap;
      } else {
        p.steerRoom = Math.max(0, p.steerRoom - p.v * dt);
      }
      room = Math.min(room, p.steerRoom);
      vMax = Math.min(vMax, p.steerCap);
    } else {
      p.steerRoom = p.steerCap = Infinity;
      if (vMax === 0) p.blocked = 0;
    }
    vMax = Math.min(vMax, Math.sqrt(2 * brake * room));
    p.v += clamp(vMax - p.v, -(avoiding ? brake : 2 * brake) * dt, (avoiding ? PED_ESCAPE_ACCEL : PED_ACCEL) * dt);
    const movement = diving ? Math.min(Math.abs(p.diveT - p.t), PED_DODGE_SPEED * dt) : Math.min(p.v * dt, room);
    if (p.v * dt > room) p.v = 0;
    let t = p.t + p.dir * movement;
    const reachesCurb = !!p.node && curbProgress(p) <= KERB + 1e-6 && (p.dir > 0 ? t : p.len - t) >= KERB - 1e-6;
    p.waiting = !diving && reachesCurb && !canCross;
    if (p.waiting) {
      t = p.dir > 0 ? Math.min(t, KERB) : Math.max(t, p.len - KERB);
      p.v = 0;
    }
    if (!dodging && !diving && (p.dir > 0 ? t >= p.len : t <= 0)) {
      t = p.dir > 0 ? p.len : 0;
      if (p.nextRoute) {
        p.avoidUntil = 0;
        p.resumeDir = 0;
        p.avoidCheck = 0;
        const leg = p.nextRoute[p.nextLeg++];
        // stay where it is sideways: the part of its offset that lies across the new track
        if (p.shift !== 0) {
          p.shift *= p.uz * leg.track.uz + p.ux * leg.track.ux;
          p.shiftTarget = p.shift;
        }
        Object.assign(p, leg.track);
        p.route = leg.track;
        p.walkAt = -1;
        p.dir = leg.dir;
        t = p.dir > 0 ? 0 : p.len;
        p.t = t;
        if (p.node) atCurb(p); // later arrivals this frame must see the newly occupied entrance
        if (p.nextLeg === p.nextRoute.length) p.nextRoute = null;
      } else if (!avoiding) {
        p.dir = -p.dir;
        p.walkAt = -1;
        p.v = 0;
        p.pause = TURN_TIME;
      }
    }
    p.t = t;
    const dodgeStep = (diving || p.dodgeTarget ? PED_DODGE_SPEED : 1.8) * dt;
    p.dodge += clamp(p.dodgeTarget - p.dodge, -dodgeStep, dodgeStep);
    if (!dodging && !diving) {
      const shiftStep = (p.v > 0.2 ? SHIFT_RATE : 0.4) * dt;
      p.shift += clamp(p.shiftTarget - p.shift, -shiftStep, shiftStep);
    }
    const side = p.dodge + p.shift;
    p.x = p.ax + p.ux * t + p.uz * side;
    p.z = p.az + p.uz * t - p.ux * side;
    if (p.node && ((t > KERB && t < p.len - KERB) || (p.waiting && walkOn(p.side)))) {
      p.coord = p.side >= 2 ? p.x : p.z;
      if (!p.node.walkers.length) walkedNodes.push(p.node);
      p.node.walkers.push(p);
    }
  }

  function endConversation(conversation) {
    conversation.a.conversation = null;
    conversation.a.socialTime = clock + 30 + Math.random() * 60;
    conversation.b.conversation = null;
    conversation.b.socialTime = clock + 30 + Math.random() * 60;
    conversation.remaining = 0;
  }

  const meetingCells = new Map();
  const usedMeetingCells = [];
  const meetingCellPool = [];
  const meetingKey = (ix, iz) => ((ix + 16384) << 15) | ((iz + 16384) & 0x7fff);
  let nextMeeting = 0;
  function meet(dt) {
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const conversation = p.conversation;
      if (!conversation || conversation.a !== p) continue;
      conversation.remaining -= dt;
      if (conversation.remaining <= 0) endConversation(conversation);
    }
    if (clock < nextMeeting) return;
    nextMeeting = clock + 1;
    for (let i = 0; i < usedMeetingCells.length; i++) {
      const list = usedMeetingCells[i];
      list.length = 0;
      meetingCellPool.push(list);
    }
    usedMeetingCells.length = 0;
    meetingCells.clear();
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      if (!p.placed || p.node || !p.route?.edge || p.conversation || clock < p.socialTime || p.t < 6 || p.t > p.len - 6) continue;
      const ix = Math.floor(p.x * 0.5), iz = Math.floor(p.z * 0.5);
      let partner = null;
      for (let dx = -1; dx <= 1 && !partner; dx++) {
        for (let dz = -1; dz <= 1 && !partner; dz++) {
          const list = meetingCells.get(meetingKey(ix + dx, iz + dz));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const q = list[k];
            if (q.conversation || p.route.block !== q.route.block) continue;
            const mdx = p.x - q.x, mdz = p.z - q.z;
            const distSq = mdx * mdx + mdz * mdz;
            if (distSq < 0.5625 || distSq > 4 || Math.random() > 0.15) continue;
            partner = q;
            break;
          }
        }
      }
      if (partner) {
        p.conversation = partner.conversation = { a: p, b: partner, remaining: 6 + Math.random() * 6 };
        p.v = partner.v = 0;
      } else {
        const key = meetingKey(ix, iz);
        let list = meetingCells.get(key);
        if (!list) {
          list = meetingCellPool.pop() || [];
          meetingCells.set(key, list);
          usedMeetingCells.push(list);
        }
        list.push(p);
      }
    }
  }

  // Walking surface around a pedestrian: sidewalks are 0.22 m above the road, and crosswalk tracks start and end
  // with 2 m of sidewalk (the rig steps down and up the curbs)
  const SIDEWALK_Y = 0.22;
  const CROSSWALK_Y = 0.012;
  function pedGround(p, x, z) {
    if (!p.node) return SIDEWALK_Y;
    const t = (x - p.ax) * p.ux + (z - p.az) * p.uz;
    return t > 2 && t < p.len - 2 ? CROSSWALK_Y : SIDEWALK_Y;
  }

  // Visible people (and hidden ones within footstep/turn range) advance their gait; only those the camera may see
  // solve their bone transforms and are drawn, the far ones with the light LOD. Walkers also begin turning towards
  // the next leg of their route over its last metre so the body rounds corners instead of swinging about on the spot.
  function renderPed(p, dt) {
    const draw = !hasView || visible(p.x, p.z, 7);
    const diveTime = clock - p.diveStart;
    const diving = diveTime < PEDESTRIAN_DIVE_DURATION;
    const dx = p.x - focusX, dz = p.z - focusZ;
    const distSq = dx * dx + dz * dz;
    if (!draw && !diving && distSq > 2500) {
      p.rig.placed = false;
      return;
    }
    const partner = p.conversation && (p.conversation.a === p ? p.conversation.b : p.conversation.a);
    const sideStep = p.dodgeTarget - p.dodge;
    let fx = p.ux * p.dir, fz = p.uz * p.dir;
    const ahead = p.dir > 0 ? p.len - p.t : p.t, leg = p.nextRoute?.[p.nextLeg];
    if (leg && ahead < 1 && p.v >= 0.3) {
      const nx = leg.track.ux * leg.dir, nz = leg.track.uz * leg.dir;
      if (fx * nx + fz * nz >= -0.9) {
        const w = 0.5 * (1 - ahead);
        fx += (nx - fx) * w;
        fz += (nz - fz) * w;
      }
    }
    const passing = p.shiftTarget - p.shift;
    if (p.v > 0.3 && Math.abs(passing) > 0.02) {
      // stepping aside while walking: face along the way it moves
      const lateral = Math.sign(passing) * SHIFT_RATE / p.v;
      fx += p.uz * lateral;
      fz -= p.ux * lateral;
    }
    const heading = diving ? p.diveHeading : partner ? Math.atan2(partner.x - p.x, partner.z - p.z)
      : Math.abs(sideStep) > 0.01 ? Math.atan2(p.uz * Math.sign(sideStep), -p.ux * Math.sign(sideStep))
      : Math.atan2(fx, fz);
    p.rig.update(dt, p.x, p.z, heading, pedGround, p, 0, draw, diving ? diveTime : -1);
    if (!draw) return;
    pedCrowd.add(p.rig, Math.sqrt(distSq));
  }

  function update(dt, elapsed, x, z, jump, view, activeMode) {
    clock = elapsed;
    focusX = x;
    focusZ = z;
    hasView = view;
    mode = activeMode;
    frame++;
    pedRange = player.active && (activeMode === 'car' || activeMode === 'cyclist') && player.entity.position.y > -1
      ? Math.sqrt(player.vx * player.vx + player.vz * player.vz) * PED_LOOKAHEAD + player.halfL + 6 : 0;
    rebuildGrid();

    for (const n of walkedNodes) n.walkers.length = 0;
    walkedNodes.length = 0;
    let pedBudget = jump ? NUM_PEDS : 6;
    const keepRadius = jump ? NEAR_RADIUS : PED_RADIUS;
    const keepRadiusSq = keepRadius * keepRadius;
    for (let scanned = 0; scanned < NUM_PEDS && pedBudget > 0; scanned++) {
      const p = peds[pedCursor];
      pedCursor = (pedCursor + 1) % NUM_PEDS;
      if (p.placed) {
        const dx = p.x - focusX, dz = p.z - focusZ;
        if (dx * dx + dz * dz <= keepRadiusSq) continue;
      }
      pedBudget--;
      spawnPed(p, jump ? 0 : 60, jump ? NEAR_RADIUS : 280, !jump);
    }
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (p.placed) avoidPlayer(p);
    }
    meet(dt);
    gatherCurbs();
    pedCrowd.begin();
    for (let i = 0; i < NUM_PEDS; i++) {
      const p = peds[i];
      if (!p.placed) continue;
      walk(p, dt);
      renderPed(p, dt);
    }
    pedCrowd.end();
  }

  return { peds, meshes: pedCrowd.meshes, update };
}

export { createPedestrianSystem };
