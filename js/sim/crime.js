import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig, OUTFIT, OUTFIT_SEED } from './pedestrians.js';
import { BONES, boxHit, startTumble, stepTumble, tumblePose } from './mayhem.js';
import { WEAPONS, Arsenal, pickTarget, rayCircle, rayBox, boxOverlap, blastFalloff, hitChance, wrapAngle } from './weapons.js';
import { Wanted, POLICE, GANGS, gangTurf } from './crime-rules.js';
import { GunfireFX } from './gunfire-fx.js';
import { BODY_SPECS, buildCarGeometry, createLoftedCarMaterial, buildLightbarGeometry, createLightbarMaterial } from '../actors/actor-models.js';
import { createContactShadowMaterial } from '../render/tsl-materials.js';
import { isTypingInField } from '../world/city-config.js';

// js/sim/crime.js
// The street's crime, GTA-style, played out over the traffic and the crowds (traffic.js):
// - The player's guns (weapons.js: fists, pistol, SMG, bazooka): lock-on aim, hit-scan shots, rockets that explode,
//   and what they do to people, cars and walls (gunfire-fx.js draws it).
// - The wanted level (crime-rules.js): running people over, shooting, blowing things up or attacking the police bring
//   one to five stars, lost by staying out of the police's sight. The police come on foot (to arrest, from two stars
//   to shoot) and in patrol cars that chase the player along the road graph, ram its car and drop officers off.
// - Two gangs on their turf, who shoot back (Los Rojos at anyone who comes close), and thieves who snatch the player's
//   money and run.
// - The player's health, armour and money, pickups, and being WASTED (killed) or BUSTED (arrested): back at the
//   nearest teleport spot (main.js onRespawn).
// The people it adds are PersonRigs drawn in one crowd, dressed in their outfits (pedestrians.js OUTFIT).

const MAX_AGENTS = 24; // people on foot: police, gang members, thieves
const MAX_CRUISERS = 5;
const MAX_PICKUPS = 24;
const PARKED_Y = -1000; // where unused meshes wait (still in the scene, so their pipelines compile at load)
const BODY_R = 0.34; // m: a person's radius, to shots and to each other
const RUN = 5.4; // m/s: officers and gang members running
const THIEF_RUN = 6.3; // a thief runs faster than the player walks (4.4) and slower than it sprints (8.2)
const WALK = 1.4;
const DOWN_TIME = 3.5; // s someone knocked down but alive lies before getting up
const DEAD_TIME = 30; // s a body stays
const DESPAWN = 200; // m from the player: gone
const MUZZLE_Y = 1.38; // m: a gun held out at shoulder height
const RESPAWN_TIME = 4.2; // s on the WASTED / BUSTED screen
const COP_SIGHT = 45; // m an officer sees the player from (a patrol car: 70)
const CRUISER_SIGHT = 70;
const CRUISER = { halfW: 0.92, halfL: 2.3, mass: 1600, accel: 7.5, brake: 14, turn: 1.9 };
const NPC_GUN = { pistol: { rate: 1.1, damage: 4, range: 45, burst: 1 }, smg: { rate: 0.8, damage: 3, range: 38, burst: 4 } };
const SKILL = { cop: 0.5, gang: 0.35 };
const PICKUP_COLORS = {
  money: [0.25, 3.2, 0.6], health: [3.2, 0.35, 0.35], armor: [0.4, 1.4, 3.4],
  pistol: [3, 2.4, 0.6], smg: [3, 1.4, 0.3], bazooka: [3.2, 0.7, 0.2]
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const rand = (a, b) => a + Math.random() * (b - a);
const dummy = new THREE.Object3D();
const zero = new THREE.Matrix4().makeScale(0, 0, 0);
const tint = new THREE.Color();
const tilt = { pitch: 0, roll: 0 };

// A tiny binary heap of [cost, node] pairs, for the patrol cars' route search
class Heap {
  constructor() {
    this.items = [];
  }

  push(cost, node) {
    const a = this.items;
    a.push([cost, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }

  get size() {
    return this.items.length;
  }
}

class CrimeSystem {
  /**
   * @param {object} o - scene, controllers (player/controllers.js), traffic (traffic.js), groundHeight(x, z),
   *   solidAt(x, z), canvas (right mouse button fires), audio (CityAudioSystem, optional),
   *   onRespawn(kind 'wasted' | 'busted') puts the player back somewhere safe
   */
  constructor({ scene, controllers, traffic, groundHeight, solidAt, canvas = null, audio = null, onRespawn = null }) {
    this.scene = scene;
    this.controllers = controllers;
    this.traffic = traffic;
    this.groundAt = groundHeight;
    this.solidAt = solidAt;
    this.audio = audio;
    this.onRespawn = onRespawn;
    this.personGround = (owner, x, z) => controllers.getGroundHeight(x, z, 'person');

    this.wanted = new Wanted();
    this.arsenal = new Arsenal();
    this.health = 100;
    this.armor = 0;
    this.money = 250;
    this.state = 'play'; // 'play' | 'wasted' | 'busted'
    this.stateTime = 0;
    this.shake = 0;
    this.hurtFlash = 0; // 0..1, for the HUD's red edges
    this.toasts = []; // messages for the HUD (crime-hud.js takes them)
    this.gangAnger = GANGS.map(() => 0); // s a gang stays after the player
    this.lastHit = { x: 0, z: 0 };
    this.mouseFire = false;
    this.aimHold = 0; // s the player keeps the gun up after a shot
    this.lockTarget = null;
    this.punchT = 0;

    this.fx = new GunfireFX(scene);
    this.crowd = new PersonCrowd(MAX_AGENTS, { farDistance: 40 });
    for (const m of this.crowd.meshes) scene.add(m);
    this.agents = [];
    this.cruisers = [];
    this.rockets = [];
    this.pickups = [];
    this.candidates = []; // lock-on targets, rebuilt per shot
    this.timers = { dispatch: 0, gangs: 2, thief: rand(40, 70), health: 30, bazooka: 45 };

    this.buildGuns();
    this.buildCruisers();
    this.buildPickups();
    this.buildRoadGraph();
    this.bindInput(canvas);

    traffic.setKnockListener((kind, x, z) => {
      this.report('runOver');
      traffic.panic(x, z, 25);
    });
  }

  // =========================================================================
  // 1. MODELS: guns, patrol cars, pickups
  // =========================================================================
  buildGuns() {
    const metal = new THREE.MeshStandardNodeMaterial({ color: 0x1b1c1e, roughness: 0.4, metalness: 0.75 });
    const olive = new THREE.MeshStandardNodeMaterial({ color: 0x4d5338, roughness: 0.7, metalness: 0.2 });
    // in the hand's frame: +z along the barrel, the grip at the origin
    const pistol = new THREE.Group();
    pistol.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.035, 0.19).translate(0, 0.045, 0.06), metal),
      new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.045).translate(0, -0.01, 0), metal)
    );
    const smg = new THREE.Group();
    smg.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.07, 0.36).translate(0, 0.045, 0.1), metal),
      new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.14, 0.045).translate(0, -0.04, 0.12), metal),
      new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 0.04).translate(0, -0.01, 0), metal)
    );
    const bazooka = new THREE.Group();
    bazooka.add(
      new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.15, 12).rotateX(Math.PI / 2).translate(0, 0.12, 0.12), olive),
      new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.05).translate(0, 0.02, 0), metal)
    );
    this.playerGuns = { pistol, smg, bazooka };
    for (const g of Object.values(this.playerGuns)) {
      g.position.y = PARKED_Y;
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.scene.add(g);
    }
    // everyone else's guns: one instanced draw
    const parts = [
      new THREE.BoxGeometry(0.04, 0.05, 0.3).translate(0, 0.045, 0.08),
      new THREE.BoxGeometry(0.03, 0.1, 0.045).translate(0, -0.01, 0)
    ];
    const geo = new THREE.BufferGeometry();
    const pos = [];
    const nor = [];
    for (const p of parts) {
      const g = p.toNonIndexed();
      pos.push(...g.attributes.position.array);
      nor.push(...g.attributes.normal.array);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    this.npcGuns = new THREE.InstancedMesh(geo, metal, MAX_AGENTS);
    this.npcGuns.name = 'CrimeGuns';
    this.npcGuns.frustumCulled = false;
    this.npcGuns.castShadow = true;
    this.npcGuns.count = 1;
    this.npcGuns.setMatrixAt(0, zero);
    this.scene.add(this.npcGuns);
  }

  buildCruisers() {
    const spec = BODY_SPECS.sedan;
    // (a paint of its own: the material cache shares a colour's material, and the player's stolen cruiser sets its
    // brake lights on the one it gets)
    const mat = createLoftedCarMaterial(spec, 0xf6f9fd);
    if (mat.userData.carState) mat.userData.carState.value.set(0, 0, 0, 1); // police livery
    this.burnt = new THREE.MeshStandardNodeMaterial({ color: 0x1d1b1a, roughness: 0.95, metalness: 0.1 });
    const body = buildCarGeometry(spec, true);
    const bar = buildLightbarGeometry(spec);
    const barMat = createLightbarMaterial();
    const shadowGeo = new THREE.PlaneGeometry(2.3, 5.2).rotateX(-Math.PI / 2);
    const shadowMat = createContactShadowMaterial();
    for (let i = 0; i < MAX_CRUISERS + 1; i++) {
      const root = new THREE.Group();
      root.name = 'PoliceCruiser';
      const tiltPivot = new THREE.Group();
      root.add(tiltPivot);
      // the last one is never driven: a burnt-out wreck parked out of sight, so that material compiles at load too
      const bodyMesh = new THREE.Mesh(body, i === MAX_CRUISERS ? this.burnt : mat);
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;
      const lightbar = new THREE.Mesh(bar, barMat);
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.position.y = 0.02;
      shadow.renderOrder = 998;
      tiltPivot.add(bodyMesh, lightbar);
      root.add(shadow);
      root.position.y = PARKED_Y;
      this.scene.add(root);
      if (i === MAX_CRUISERS) continue;
      this.cruisers.push({
        active: false, mesh: root, tiltPivot, bodyMesh, lightbar, paint: mat,
        x: 0, y: 0, z: 0, heading: 0, speed: 0, vx: 0, vz: 0, halfW: CRUISER.halfW, halfL: CRUISER.halfL,
        mass: CRUISER.mass, type: 'car', police: true, hp: 100, wreck: 0, state: 'chase', path: null, pathI: 0,
        replan: 0, stuckT: 0, checkX: 0, checkZ: 0, reverseT: 0, deployed: false, life: 0, pitch: 0, roll: 0,
        position: new THREE.Vector3() // (for the audio: crashes & sirens)
      });
    }
  }

  buildPickups() {
    const mat = new THREE.MeshBasicNodeMaterial();
    this.pickupMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.28, 0), mat, MAX_PICKUPS);
    this.pickupMesh.name = 'Pickups';
    this.pickupMesh.frustumCulled = false;
    for (let i = 0; i < MAX_PICKUPS; i++) {
      this.pickupMesh.setMatrixAt(i, zero);
      this.pickupMesh.setColorAt(i, tint.setRGB(1, 1, 1));
    }
    this.pickupMesh.count = 1;
    this.scene.add(this.pickupMesh);
  }

  // The road graph as an undirected weighted graph, bucketed for nearest-node lookups: the patrol cars' map
  buildRoadGraph() {
    const { nodes, edges } = this.traffic.network;
    this.nodes = nodes;
    const index = new Map(nodes.map((n, i) => [n, i]));
    this.links = nodes.map(() => []);
    for (const e of edges) {
      const a = index.get(e.from), b = index.get(e.to);
      if (a === undefined || b === undefined || a === b) continue;
      const cost = Math.hypot(e.to.x - e.from.x, e.to.z - e.from.z);
      if (!this.links[a].some((l) => l[0] === b)) this.links[a].push([b, cost]);
      if (!this.links[b].some((l) => l[0] === a)) this.links[b].push([a, cost]);
    }
    this.nodeCells = new Map();
    nodes.forEach((n, i) => {
      if (!this.links[i].length) return;
      const k = `${Math.floor(n.x / 80)},${Math.floor(n.z / 80)}`;
      (this.nodeCells.get(k) || this.nodeCells.set(k, []).get(k)).push(i);
    });
  }

  // The nearest intersection to (x, z) that can be driven to straight (no building in between), else the nearest
  nearestNode(x, z) {
    const cx = Math.floor(x / 80), cz = Math.floor(z / 80);
    let best = -1;
    let bestD = Infinity;
    let seen = -1;
    let seenD = Infinity;
    for (let r = 0; r <= 3 && seen < 0; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iz = cz - r; iz <= cz + r; iz++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
          for (const i of this.nodeCells.get(`${ix},${iz}`) || []) {
            const n = this.nodes[i];
            const d = (n.x - x) ** 2 + (n.z - z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
            if (d < seenD && d < 160 * 160 && this.clearLine(x, z, n.x, n.z)) {
              seenD = d;
              seen = i;
            }
          }
        }
      }
    }
    return seen >= 0 ? seen : best;
  }

  // The intersections a patrol car drives through from (x0, z0) to (x1, z1): A* over the road graph, or null
  route(x0, z0, x1, z1) {
    const s = this.nearestNode(x0, z0), g = this.nearestNode(x1, z1);
    if (s < 0 || g < 0) return null;
    if (s === g) return [this.nodes[g]];
    const goal = this.nodes[g];
    const cost = new Map([[s, 0]]);
    const from = new Map();
    const open = new Heap();
    open.push(0, s);
    let expanded = 0;
    while (open.size && expanded < 4000) {
      const [, i] = open.pop();
      if (i === g) break;
      expanded++;
      const base = cost.get(i);
      for (const [j, w] of this.links[i]) {
        const c = base + w;
        if (c >= (cost.get(j) ?? Infinity)) continue;
        cost.set(j, c);
        from.set(j, i);
        const n = this.nodes[j];
        open.push(c + Math.hypot(n.x - goal.x, n.z - goal.z), j);
      }
    }
    if (!from.has(g)) return null;
    const path = [];
    for (let i = g; i !== undefined; i = from.get(i)) path.push(this.nodes[i]);
    return path.reverse();
  }

  // =========================================================================
  // 2. INPUT: fire (right mouse button, X; touch & gamepad through controllers.keys.fire), weapons 1-4, R to cycle
  // =========================================================================
  bindInput(canvas) {
    if (canvas) {
      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 2) this.mouseFire = true;
      });
    }
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.mouseFire = false;
    });
    window.addEventListener('blur', () => { this.mouseFire = false; });
    window.addEventListener('keydown', (e) => {
      if (isTypingInField(e) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const pick = { Digit1: 'fists', Digit2: 'pistol', Digit3: 'smg', Digit4: 'bazooka' }[e.code];
      if (pick) this.selectWeapon(pick);
      else if (e.code === 'KeyR') this.cycleWeapon(e.shiftKey ? -1 : 1);
    });
  }

  selectWeapon(id) {
    if (this.arsenal.select(id)) return true;
    this.toast(`No ${WEAPONS[id].label.toLowerCase()} rounds`);
    return false;
  }

  cycleWeapon(dir = 1) {
    this.arsenal.cycle(dir);
  }

  toast(text) {
    this.toasts.push(text);
    if (this.toasts.length > 4) this.toasts.shift();
  }

  // =========================================================================
  // 3. THE FRAME
  // =========================================================================
  update(dt, elapsed, camera) {
    const c = this.controllers;
    const mode = c.activeMode;
    const pe = c.getActiveEntity();
    this.camera = camera;
    this.player = pe;
    this.mode = mode;
    this.px = pe.position.x;
    this.pz = pe.position.z;
    const heading = pe.heading || 0;
    const speed = pe.speed || 0;
    this.pvx = Math.sin(heading) * speed + (pe.vx || 0);
    this.pvz = Math.cos(heading) * speed + (pe.vz || 0);
    this.pspeed = Math.hypot(this.pvx, this.pvz);
    // (on the street: not flying, nor up on a roof)
    this.onStreet = mode !== 'helicopter' && pe.position.y - this.groundAt(this.px, this.pz) < 2.6;

    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.6);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (let g = 0; g < this.gangAnger.length; g++) this.gangAnger[g] = Math.max(0, this.gangAnger[g] - dt);

    if (this.state !== 'play') this.updateDown(dt);
    else this.updatePlayer(dt, elapsed);

    this.updateRockets(dt);
    this.crowd.begin();
    this.gunCount = 0;
    for (let i = this.agents.length - 1; i >= 0; i--) this.updateAgent(this.agents[i], dt);
    this.crowd.end();
    this.npcGuns.count = Math.max(1, this.gunCount);
    if (!this.gunCount) this.npcGuns.setMatrixAt(0, zero);
    this.npcGuns.instanceMatrix.needsUpdate = true;
    for (const cr of this.cruisers) if (cr.active) this.updateCruiser(cr, dt);
    this.collideCruisers();
    this.updatePickups(dt, elapsed);

    // the police see the player: the stars stay
    let seen = false;
    for (const a of this.agents) {
      if (a.kind === 'cop' && !a.fallen && a.state !== 'leave' && Math.hypot(a.x - this.px, a.z - this.pz) < COP_SIGHT) seen = true;
    }
    for (const cr of this.cruisers) {
      if (cr.active && !cr.wreck && Math.hypot(cr.x - this.px, cr.z - this.pz) < CRUISER_SIGHT) seen = true;
    }
    if (this.state === 'play') this.wanted.update(dt, seen);
    this.dispatch(dt);
    this.fx.update(dt);
  }

  // The camera shaken by nearby blasts (after the camera system has placed it)
  shakeCamera(camera) {
    if (this.shake <= 0.001) return;
    const s = this.shake * this.shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.position.z += (Math.random() - 0.5) * s;
  }

  // The player's vehicles and the patrol cars, for the traffic to stop behind (traffic.js setParked)
  addObstacles(list) {
    for (const cr of this.cruisers) if (cr.active) list.push(cr);
    return list;
  }

  // Patrol cars for the audio's sirens (audio-sources.js)
  sirenSources() {
    return this.cruisers;
  }

  // =========================================================================
  // 4. THE PLAYER: firing, aiming, getting hurt
  // =========================================================================
  updatePlayer(dt, elapsed) {
    const c = this.controllers;
    const p = c.entities.person;
    const held = Boolean(c.keys.fire) || this.mouseFire;
    const w = this.arsenal.weapon;
    // what this weapon can do from here: no guns from the helicopter, no fists or bazooka from a car or a bicycle
    const usable = this.mode === 'person' || (this.mode !== 'helicopter' && !w.melee && !w.rocket);
    const shots = this.arsenal.trigger(held && usable && this.onStreet, dt);
    if (held && usable) this.aimHold = w.melee ? 0.2 : 0.7;
    else this.aimHold = Math.max(0, this.aimHold - dt);

    // lock-on while the trigger is held
    if (held && usable && !w.melee) {
      const range = w.range * (this.mode === 'person' ? 1 : 0.7);
      this.lockTarget = this.findTarget(this.px, this.pz, this.player.heading, range, this.mode === 'person' ? 0.6 : 0.3);
    } else if (!held) {
      this.lockTarget = null;
    }
    // on foot the player turns to face what it aims at
    if (this.mode === 'person' && this.lockTarget && held) {
      const want = Math.atan2(this.lockTarget.x - this.px, this.lockTarget.z - this.pz);
      p.heading += clamp(wrapAngle(want - p.heading), -8 * dt, 8 * dt);
    }
    if (shots) this.playerFire(w);

    // the arms: raised while aiming, a jab for a punch
    const rig = p.rig;
    this.punchT = Math.max(0, this.punchT - dt);
    const aimWant = this.mode === 'person' ? (w.melee ? (this.punchT > 0 ? 1 : 0) : this.aimHold > 0 ? 1 : 0) : 0;
    rig.aim += (aimWant - rig.aim) * Math.min(1, dt * (aimWant ? 14 : 6));
    rig.aimYaw = this.lockTarget && this.mode === 'person' ? Math.atan2(this.lockTarget.x - this.px, this.lockTarget.z - this.pz) : p.heading;
    rig.aimBoth = w.id === 'smg' || w.id === 'bazooka';
    this.placePlayerGun(w);
  }

  // The gun in the player's hand (when on foot): along the arm, pointing down when it isn't aiming
  placePlayerGun(w) {
    const p = this.controllers.entities.person;
    for (const [id, g] of Object.entries(this.playerGuns)) {
      const show = this.mode === 'person' && id === w.id && this.state === 'play';
      if (!show) {
        g.position.y = PARKED_Y;
        continue;
      }
      g.position.copy(p.rig.handPosition);
      g.rotation.set((1 - p.rig.aim) * 1.25, p.rig.aimYaw, 0, 'YXZ');
    }
  }

  // The best target to lock on to ahead: the police, gangs and thieves first, then patrol cars, then passers-by
  findTarget(x, z, heading, range, cone) {
    const list = this.candidates;
    list.length = 0;
    for (const a of this.agents) if (!a.fallen) list.push(a);
    const person = pickTarget(x, z, heading, list, range, cone);
    if (person) return person;
    list.length = 0;
    for (const cr of this.cruisers) if (cr.active && !cr.wreck) list.push(cr);
    const car = pickTarget(x, z, heading, list, range, cone);
    if (car) return car;
    list.length = 0;
    for (const ped of this.traffic.peds) {
      if (ped.placed && !ped.fallen && Math.abs(ped.x - x) < range && Math.abs(ped.z - z) < range) list.push(ped);
    }
    return pickTarget(x, z, heading, list, range, cone);
  }

  // Where the player's shots leave from: the hand on foot, the driver's window in a vehicle
  muzzle(out) {
    const pe = this.player;
    if (this.mode === 'person') {
      const h = this.controllers.entities.person.rig;
      out.x = h.handPosition.x + Math.sin(h.aimYaw) * 0.3;
      out.y = h.handPosition.y + 0.05;
      out.z = h.handPosition.z + Math.cos(h.aimYaw) * 0.3;
    } else {
      const ahead = this.mode === 'car' ? 0.4 : 0.3;
      out.x = pe.position.x + Math.sin(pe.heading) * ahead + Math.cos(pe.heading) * 0.95;
      out.y = pe.position.y + (this.mode === 'car' ? 1.15 : 1.35);
      out.z = pe.position.z + Math.cos(pe.heading) * ahead - Math.sin(pe.heading) * 0.95;
    }
    return out;
  }

  playerFire(w) {
    const pe = this.player;
    if (w.melee) {
      this.punch();
      return;
    }
    const m = this.muzzle(this._muzzle ??= { x: 0, y: 0, z: 0 });
    const t = this.lockTarget;
    let yaw = t ? Math.atan2(t.x - m.x, t.z - m.z) : pe.heading;
    yaw += (Math.random() - 0.5) * 2 * w.spread;
    this.fx.muzzle(m.x, m.y, m.z, yaw, Boolean(w.rocket));
    this.audio?.gunfire?.(w.id, m.x, m.y, m.z);
    this.traffic.panic(m.x, m.z, w.rocket ? 45 : 35);
    if (this.copNear(m.x, m.z, 40)) this.report('gunfire');
    if (w.rocket) {
      const r = this.fx.launchRocket(m.x, m.y, m.z, yaw, 0);
      if (r) this.rockets.push({ r, x: m.x, y: m.y, z: m.z, dx: Math.sin(yaw), dz: Math.cos(yaw), t: 0 });
      return;
    }
    // aimed at a target's chest (a person's hit is at 1.2 m over its feet), else level
    let ty = m.y;
    if (t) ty = (t.y ?? this.groundAt(t.x, t.z)) + (t.mesh ? 0.9 : 1.2);
    this.hitScan(m.x, m.y, m.z, yaw, ty, w, true);
  }

  // A shot from (ox, oy, oz) along `yaw`, sloping towards height ty at the end: the first thing in its way takes it
  hitScan(ox, oy, oz, yaw, ty, w, byPlayer) {
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    let best = w.range;
    let kind = 'none';
    let target = null;
    // walls, every 0.8 m
    for (let t = 0.6; t < best; t += 0.8) {
      if (this.solidAt(ox + dx * t, oz + dz * t)) {
        best = t;
        kind = 'wall';
        break;
      }
    }
    for (const a of this.agents) {
      if (a.fallen) continue;
      const t = rayCircle(ox, oz, dx, dz, a.x, a.z, BODY_R);
      if (t >= 0 && t < best) {
        best = t;
        kind = 'agent';
        target = a;
      }
    }
    for (const cr of this.cruisers) {
      if (!cr.active) continue;
      const t = rayBox(ox, oz, dx, dz, cr.x, cr.z, cr.heading, cr.halfW, cr.halfL);
      if (t >= 0 && t < best) {
        best = t;
        kind = 'cruiser';
        target = cr;
      }
    }
    const street = this.traffic.rayHit(ox, oz, dx, dz, best);
    if (street) {
      best = street.t;
      kind = street.kind;
      target = street.target;
    }
    const ex = ox + dx * best, ez = oz + dz * best;
    const slope = (ty - oy) / Math.max(1, best);
    let ey = kind === 'none' || kind === 'wall' ? oy + slope * best : 0;
    if (kind === 'agent' || kind === 'ped') ey = this.groundAt(ex, ez) + 1.2;
    else if (kind === 'cruiser' || kind === 'vehicle') ey = this.groundAt(ex, ez) + 0.85;
    this.fx.tracer(ox, oy, oz, ex, ey, ez);

    if (kind === 'wall') this.fx.impact(ex, ey, ez, 'dust', -dx, -dz);
    else if (kind === 'agent') {
      this.fx.impact(ex, ey, ez, 'blood', dx, dz);
      this.damageAgent(target, w.damage, dx, dz, byPlayer);
    } else if (kind === 'cruiser') {
      this.fx.impact(ex, ey, ez, 'metal', -dx, -dz);
      this.damageCruiser(target, w.damage * 0.22, byPlayer);
    } else if (kind === 'ped') {
      this.fx.impact(ex, ey, ez, 'blood', dx, dz);
      this.traffic.shootPed(target, dx, dz, 3.5);
      if (byPlayer) this.report('shootPed');
    } else if (kind === 'vehicle') {
      this.fx.impact(ex, ey, ez, 'metal', -dx, -dz);
      this.traffic.shootVehicle(target, ex, ey, ez, dx, dz);
      if (byPlayer) this.report('shootCar', this.copNear(ex, ez, 50));
    }
  }

  // A punch at whoever stands within reach in front
  punch() {
    const p = this.controllers.entities.person;
    this.punchT = 0.18;
    const reach = WEAPONS.fists.range;
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    let best = null;
    let bestD = reach;
    const consider = (o) => {
      const dx = o.x - this.px, dz = o.z - this.pz;
      const d = Math.hypot(dx, dz);
      if (d > bestD || (dx * fx + dz * fz) < d * 0.45) return;
      best = o;
      bestD = d;
    };
    for (const a of this.agents) if (!a.fallen) consider(a);
    for (const ped of this.traffic.peds) {
      if (ped.placed && !ped.fallen && Math.abs(ped.x - this.px) < 3 && Math.abs(ped.z - this.pz) < 3) consider(ped);
    }
    if (!best) return;
    const d = Math.max(0.01, bestD);
    const nx = (best.x - this.px) / d, nz = (best.z - this.pz) / d;
    this.audio?.gunfire?.('punch', best.x, this.groundAt(best.x, best.z) + 1.2, best.z);
    if (this.agents.includes(best)) {
      this.damageAgent(best, WEAPONS.fists.damage, nx, nz, true, 2.5);
    } else {
      this.traffic.shootPed(best, nx, nz, 2.2);
      this.report('punch', this.copNear(this.px, this.pz, 30));
    }
  }

  // The player hurt by `amount` (from the direction of (fromX, fromZ)): armour first, a vehicle takes some of it
  hurt(amount, fromX = this.px, fromZ = this.pz) {
    if (this.state !== 'play' || amount <= 0) return;
    if (this.mode !== 'person') amount *= 0.55;
    const absorbed = Math.min(this.armor, amount * 0.75);
    this.armor -= absorbed;
    this.health -= amount - absorbed;
    this.hurtFlash = Math.min(1, this.hurtFlash + 0.25 + amount * 0.03);
    this.lastHit.x = fromX;
    this.lastHit.z = fromZ;
    if (this.health <= 0) this.down('wasted');
  }

  report(kind, witnessed = true) {
    if (this.state !== 'play') return;
    const gained = this.wanted.report(kind, witnessed);
    if (gained > 0 && this.wanted.stars === 1) this.toast('The police are after you');
  }

  copNear(x, z, r) {
    for (const a of this.agents) {
      if (a.kind === 'cop' && !a.fallen && Math.hypot(a.x - x, a.z - z) < r) return true;
    }
    for (const cr of this.cruisers) {
      if (cr.active && !cr.wreck && Math.hypot(cr.x - x, cr.z - z) < r) return true;
    }
    return false;
  }

  // =========================================================================
  // 5. WASTED & BUSTED
  // =========================================================================
  down(kind) {
    if (this.state !== 'play') return;
    this.state = kind;
    this.stateTime = 0;
    this.lockTarget = null;
    this.controllers.resetInput();
    this.health = Math.max(0, this.health);
    // killed on foot: the player's body falls like anyone's
    const p = this.controllers.entities.person;
    if (kind === 'wasted' && this.mode === 'person') {
      const d = Math.hypot(this.px - this.lastHit.x, this.pz - this.lastHit.z) || 1;
      const nx = (this.px - this.lastHit.x) / d, nz = (this.pz - this.lastHit.z) / d;
      this.playerBase = this.playerBase || new Float32Array(BONES * 8);
      this.playerBase.set(p.rig.pose.subarray(0, BONES * 8));
      this.playerFall = startTumble(this.px, this.groundAt(this.px, this.pz), this.pz, nx * 2, nz * 2, nx, nz);
    } else {
      this.playerFall = null;
    }
  }

  updateDown(dt) {
    this.stateTime += dt;
    this.controllers.resetInput();
    const p = this.controllers.entities.person;
    p.rig.aim = 0;
    this.placePlayerGun(this.arsenal.weapon);
    if (this.playerFall && this.mode === 'person') {
      const f = this.playerFall;
      stepTumble(f, dt, this.groundAt(f.px, f.pz), this.solidAt);
      tumblePose(p.rig.pose, this.playerBase, f);
      p.crowd.begin();
      p.crowd.add(p.rig, 0);
      p.crowd.end();
    }
    if (this.stateTime < RESPAWN_TIME) return;
    const kind = this.state;
    this.state = 'play';
    this.playerFall = null;
    p.rig.placed = false; // stands up afresh where it is put
    this.health = 100;
    this.armor = kind === 'busted' ? 0 : this.armor;
    if (kind === 'wasted') {
      const fee = Math.min(this.money, 100);
      this.money -= fee;
      this.toast(fee ? `Hospital bill: $${fee}` : 'Back on your feet');
    } else {
      // arrested: the guns are taken, and a bribe
      const fee = Math.min(this.money, 150);
      this.money -= fee;
      this.arsenal = new Arsenal({ pistol: 17, smg: 0, bazooka: 0 });
      this.toast(`Your guns were taken${fee ? `, and $${fee}` : ''}`);
    }
    this.wanted.clear();
    for (const a of this.agents) if (a.kind === 'cop') a.state = 'leave';
    for (const cr of this.cruisers) if (cr.active) this.removeCruiser(cr);
    this.onRespawn?.(kind);
  }

  // =========================================================================
  // 6. ROCKETS & EXPLOSIONS
  // =========================================================================
  updateRockets(dt) {
    const w = WEAPONS.bazooka;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const k = this.rockets[i];
      k.t += dt;
      const step = w.rocket * dt;
      let hit = k.t > w.range / w.rocket;
      let travelled = 0;
      // in 1 m steps so it can't skip through a wall or a car
      while (!hit && travelled < step) {
        const s = Math.min(1, step - travelled);
        travelled += s;
        k.x += k.dx * s;
        k.z += k.dz * s;
        if (this.solidAt(k.x, k.z) || k.y < this.groundAt(k.x, k.z) + 0.15) hit = true;
        for (const a of this.agents) if (!hit && !a.fallen && Math.hypot(a.x - k.x, a.z - k.z) < 0.6) hit = true;
        for (const cr of this.cruisers) {
          if (!hit && cr.active && rayBox(k.x, k.z, k.dx, k.dz, cr.x, cr.z, cr.heading, cr.halfW, cr.halfL) === 0) hit = true;
        }
        if (!hit) {
          const street = this.traffic.rayHit(k.x - k.dx * 0.5, k.z - k.dz * 0.5, k.dx, k.dz, 0.6);
          if (street) hit = true;
        }
      }
      if (hit) {
        this.fx.dropRocket(k.r);
        this.rockets.splice(i, 1);
        this.explode(k.x, Math.max(k.y, this.groundAt(k.x, k.z) + 0.4), k.z, w.blast, w.damage, true);
      } else {
        this.fx.placeRocket(k.r, k.x, k.y, k.z, Math.atan2(k.dx, k.dz), 0);
      }
    }
  }

  // An explosion at (x, y, z) of `radius` m: fire & smoke, people thrown, cars shoved, patrol cars and the player hurt
  explode(x, y, z, radius, damage, byPlayer) {
    this.fx.explosion(x, y, z, radius);
    this.audio?.gunfire?.('explosion', x, y, z);
    const near = Math.hypot(this.camera ? this.camera.position.x - x : 0, this.camera ? this.camera.position.z - z : 0);
    this.shake = Math.min(1.6, this.shake + clamp(1.6 - near / 40, 0, 1.6));
    const thrown = this.traffic.blast(x, z, radius * 1.4, 24);
    this.traffic.panic(x, z, 70);
    if (byPlayer) this.report(thrown > 0 ? 'shootPed' : 'explosion');
    if (byPlayer && thrown > 1) this.report('explosion');
    for (const a of [...this.agents]) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d > radius * 1.4) continue;
      const k = blastFalloff(d, radius * 1.4);
      const nx = d > 0.01 ? (a.x - x) / d : 1, nz = d > 0.01 ? (a.z - z) / d : 0;
      this.damageAgent(a, damage * k, nx, nz, byPlayer, 22 * k);
    }
    for (const cr of this.cruisers) {
      if (!cr.active) continue;
      const d = Math.hypot(cr.x - x, cr.z - z);
      if (d > radius + cr.halfL) continue;
      const k = blastFalloff(Math.max(0, d - cr.halfW), radius);
      const nx = d > 0.01 ? (cr.x - x) / d : 1, nz = d > 0.01 ? (cr.z - z) / d : 0;
      cr.vx += nx * 14 * k;
      cr.vz += nz * 14 * k;
      if (!cr.wreck) this.damageCruiser(cr, damage * k, byPlayer);
    }
    // the player
    const pd = Math.hypot(this.px - x, this.pz - z);
    if (pd < radius * 1.3 && this.state === 'play') {
      const k = blastFalloff(pd, radius * 1.3);
      this.hurt(95 * k, x, z);
      const pe = this.player;
      if (this.mode === 'car' && pe) {
        pe.vx = (pe.vx || 0) + (this.px - x) / Math.max(pd, 0.5) * 12 * k;
        pe.vz = (pe.vz || 0) + (this.pz - z) / Math.max(pd, 0.5) * 12 * k;
        pe.rollVel = (pe.rollVel || 0) + 6 * k;
        pe.heaveVel = (pe.heaveVel || 0) + 3 * k;
      }
    }
  }

  // =========================================================================
  // 7. PEOPLE: police on foot, gangs, thieves
  // =========================================================================
  spawnAgent(kind, x, z, { gang = -1, weapon = null } = {}) {
    if (this.agents.length >= MAX_AGENTS) return null;
    const outfit = kind === 'cop' ? OUTFIT.police : kind === 'thief' ? OUTFIT.thief : GANGS[gang].outfit;
    const rig = new PersonRig({
      seed: outfit * OUTFIT_SEED + Math.floor(Math.random() * 997) + 0.5,
      scale: rand(0.95, 1.06), girth: rand(0.95, 1.12), hair: rand(0, 0.25), armSwing: rand(0.9, 1.1)
    });
    const a = {
      kind, gang, rig, x, z, heading: Math.atan2(this.px - x, this.pz - z), speed: 0, hp: kind === 'cop' ? 100 : 80,
      fallen: null, fallBase: null, dead: false, state: kind === 'thief' ? 'approach' : kind === 'gang' ? 'idle' : 'chase',
      t: 0, weapon, cooldown: rand(0.5, 1.5), burst: 0, homeX: x, homeZ: z, money: 0, arrest: 0, idleYaw: Math.random() * 6.28,
      wanderT: rand(2, 6), los: false, losT: 0, stepT: 0
    };
    this.agents.push(a);
    return a;
  }

  removeAgent(a) {
    const i = this.agents.indexOf(a);
    if (i >= 0) this.agents.splice(i, 1);
  }

  // Someone hurt: `damage` hit points, knocked along (nx, nz) at `throwSpeed` m/s if it brings them down
  damageAgent(a, damage, nx, nz, byPlayer, throwSpeed = 3) {
    if (a.dead) return;
    a.hp -= damage;
    const killed = a.hp <= 0;
    if (byPlayer) {
      if (a.kind === 'cop') this.report(killed ? 'killCop' : damage > 15 ? 'shootCop' : 'hitCop');
      if (a.kind === 'gang') this.gangAnger[a.gang] = 90;
    }
    if (a.kind === 'cop' && byPlayer && this.wanted.stars === 0) this.report('hitCop');
    if (!killed && throwSpeed < 6) {
      // a flinch: shot but still standing
      a.stepT = 0.25;
      if (a.kind === 'thief' && a.state === 'approach') a.state = 'leave';
      return;
    }
    this.knockAgent(a, nx * throwSpeed, nz * throwSpeed, nx, nz);
    if (killed) this.kill(a);
  }

  knockAgent(a, vx, vz, nx, nz) {
    if (a.fallen) return;
    a.rig.update(1 / 60, a.x, a.z, a.heading, this.personGround, a, 0, true);
    a.fallBase = a.fallBase || new Float32Array(BONES * 8);
    a.fallBase.set(a.rig.pose.subarray(0, BONES * 8));
    a.fallen = startTumble(a.x, this.personGround(a, a.x, a.z), a.z, vx, vz, nx, nz);
    a.rig.aim = 0;
  }

  kill(a) {
    a.dead = true;
    a.hp = 0;
    // what they leave behind
    if (a.kind === 'thief' && a.money > 0) {
      this.drop('money', a.x, a.z, a.money);
      this.toast('Get your money back!');
      a.money = 0;
    } else if (a.kind === 'cop' && Math.random() < 0.7) {
      this.drop(a.weapon === 'smg' ? 'smg' : 'pistol', a.x, a.z);
    } else if (a.kind === 'gang') {
      if (Math.random() < 0.6) this.drop(a.weapon === 'smg' ? 'smg' : 'pistol', a.x, a.z);
      if (Math.random() < 0.7) this.drop('money', a.x + 0.6, a.z, Math.round(rand(15, 70)));
    }
  }

  updateAgent(a, dt) {
    const dx = this.px - a.x, dz = this.pz - a.z;
    const dist = Math.hypot(dx, dz);
    a.t += dt;
    if (dist > DESPAWN || (a.dead && a.fallen && a.fallen.rest > DEAD_TIME)) {
      this.removeAgent(a);
      return;
    }
    if (a.fallen) {
      const f = a.fallen;
      const g = this.personGround(a, f.px, f.pz);
      const rest = stepTumble(f, dt, g, this.solidAt);
      a.x = f.px;
      a.z = f.pz;
      if (!a.dead && rest > DOWN_TIME) {
        // back on their feet, and angry
        a.fallen = null;
        a.rig.reset(a.x, a.z, a.heading, this.personGround, a);
        if (a.kind === 'thief' && a.state === 'approach') a.state = 'leave';
        if (a.kind === 'gang') this.gangAnger[a.gang] = Math.max(this.gangAnger[a.gang], 60);
      } else {
        tumblePose(a.rig.pose, a.fallBase, f);
        this.crowd.add(a.rig, dist);
        return;
      }
    }

    // run over by the player
    if (this.onStreet && (this.mode === 'car' || this.mode === 'cyclist') && this.pspeed > 2.2) {
      const hw = this.mode === 'car' ? 0.86 : 0.35, hl = this.mode === 'car' ? 2.18 : 0.85;
      const hit = boxHit(this.px, this.pz, this.player.heading, hw, hl, a.x, a.z, 0.3);
      if (hit) {
        const dmg = this.pspeed * (this.mode === 'car' ? 7 : 2.5);
        this.audio?.crash?.({ a: this.player, b: a, x: a.x, y: this.groundAt(a.x, a.z) + 1, z: a.z, speed: this.pspeed });
        a.hp -= dmg;
        this.knockAgent(a, this.pvx, this.pvz, hit.nx, hit.nz);
        if (a.kind === 'cop') this.report(a.hp <= 0 ? 'killCop' : 'hitCop');
        else this.report('runOver');
        if (a.kind === 'gang') this.gangAnger[a.gang] = 90;
        if (a.hp <= 0) this.kill(a);
        this.crowd.add(a.rig, dist);
        return;
      }
    }

    let goalYaw = a.heading;
    let speed = 0;
    let aim = 0;
    a.stepT = Math.max(0, a.stepT - dt);
    a.cooldown -= dt;
    // a clear line of sight to the player, checked a few times a second
    a.losT -= dt;
    if (a.losT <= 0) {
      a.losT = 0.3 + Math.random() * 0.2;
      a.los = dist < 60 && this.clearLine(a.x, a.z, this.px, this.pz);
    }
    const toPlayer = Math.atan2(dx, dz);
    const playing = this.state === 'play';

    if (a.kind === 'cop') {
      const stars = this.wanted.stars;
      if (!playing || stars === 0 || a.state === 'leave') {
        a.state = playing && stars > 0 ? 'chase' : 'leave';
        if (this.state === 'busted') {
          goalYaw = toPlayer; // standing over the arrested player
        } else {
          goalYaw = Math.atan2(-dx, -dz);
          speed = WALK;
          if (dist > 70 || a.t > 60) {
            this.removeAgent(a);
            return;
          }
        }
      } else {
        const gun = POLICE.shoots[stars] ? NPC_GUN[a.weapon || 'pistol'] : null;
        goalYaw = toPlayer;
        if (gun && a.los && dist < gun.range && dist > 2.2) {
          aim = 1;
          speed = dist > 16 ? RUN * 0.55 : 0;
          if (a.stepT <= 0) this.npcShoot(a, gun, SKILL.cop, dist, dt);
        } else {
          speed = dist > 1.2 ? RUN : 0;
        }
        // an arrest: close enough to grab a player on foot (or in a car that has stopped)
        const grab = this.mode === 'person' ? dist < 1.5 && this.pspeed < 3.5 : dist < 3.6 && this.pspeed < 1.5 && this.mode !== 'helicopter';
        a.arrest = grab ? a.arrest + dt : Math.max(0, a.arrest - dt);
        if (a.arrest > (this.mode === 'person' ? 1.1 : 2.2)) {
          this.toast('Busted!');
          this.down('busted');
        }
      }
    } else if (a.kind === 'gang') {
      const g = GANGS[a.gang];
      const provoked = this.gangAnger[a.gang] > 0;
      const near = dist < 15 && this.onStreet;
      const hostile = playing && (provoked || (g.hostile && near));
      if (hostile && a.los && dist < 34) {
        goalYaw = toPlayer;
        aim = 1;
        speed = dist > 22 ? RUN * 0.7 : 0;
        if (a.stepT <= 0) this.npcShoot(a, NPC_GUN[a.weapon || 'pistol'], SKILL.gang, dist, dt);
      } else if (hostile && dist < 60) {
        goalYaw = toPlayer;
        speed = RUN * 0.8;
      } else {
        // hanging about their corner: facing their friends, now and then a few steps
        a.wanderT -= dt;
        const hx = a.homeX - a.x, hz = a.homeZ - a.z;
        if (Math.hypot(hx, hz) > 2.5) {
          goalYaw = Math.atan2(hx, hz);
          speed = WALK;
        } else {
          goalYaw = a.idleYaw;
          if (a.wanderT <= 0) {
            a.wanderT = rand(3, 8);
            a.idleYaw = Math.atan2(a.homeX - a.x + rand(-1, 1), a.homeZ - a.z + rand(-1, 1)) + rand(-0.6, 0.6);
          }
          if (dist < 12 && !hostile) goalYaw = toPlayer; // eyeing the player
        }
      }
    } else if (a.kind === 'thief') {
      if (a.state === 'approach' && (!playing || this.mode !== 'person' || a.t > 30)) a.state = 'leave';
      if (a.state === 'approach') {
        goalYaw = toPlayer;
        speed = dist > 6 ? THIEF_RUN : 3.2;
        if (dist < 1.1 && playing) {
          const take = Math.min(this.money, Math.round(20 + this.money * 0.15));
          if (take > 0) {
            this.money -= take;
            a.money = take;
            this.toast(`A thief took $${take}! Catch the thief`);
          }
          a.state = 'flee';
          a.t = 0;
        }
      } else if (a.state === 'flee') {
        goalYaw = Math.atan2(-dx, -dz);
        speed = THIEF_RUN;
        if (dist > 140 || a.t > 45) {
          if (a.money) this.toast('The thief got away');
          this.removeAgent(a);
          return;
        }
      } else {
        goalYaw = Math.atan2(-dx, -dz);
        speed = WALK * 1.4;
        if (dist > 60 || a.t > 40) {
          this.removeAgent(a);
          return;
        }
      }
    }

    if (a.stepT > 0) speed *= 0.3;
    this.walkAgent(a, goalYaw, speed, dt);
    // keep clear of the player on foot
    if (this.mode === 'person' && dist < 0.75 && dist > 0.01) {
      a.x -= (dx / dist) * (0.75 - dist);
      a.z -= (dz / dist) * (0.75 - dist);
    }
    const rig = a.rig;
    rig.aim += (aim - rig.aim) * Math.min(1, dt * 8);
    rig.aimYaw = a.heading;
    rig.aimBoth = a.weapon === 'smg';
    const draw = dist < 140;
    rig.update(dt, a.x, a.z, a.heading, this.personGround, a, 0, draw);
    if (!draw) return;
    this.crowd.add(rig, dist);
    if (a.weapon && rig.aim > 0.05 && this.gunCount < MAX_AGENTS) {
      dummy.position.copy(rig.handPosition);
      dummy.rotation.set((1 - rig.aim) * 1.25, rig.aimYaw, 0, 'YXZ');
      dummy.scale.set(1, 1, a.weapon === 'smg' ? 1.3 : 0.75);
      dummy.updateMatrix();
      this.npcGuns.setMatrixAt(this.gunCount++, dummy.matrix);
    }
  }

  // Turns a towards `goalYaw` and walks it `speed` m/s, around walls (the first clear heading either side)
  walkAgent(a, goalYaw, speed, dt) {
    a.heading += clamp(wrapAngle(goalYaw - a.heading), -7 * dt, 7 * dt);
    a.speed = speed;
    if (speed <= 0) return;
    const step = speed * dt;
    for (const veer of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4]) {
      const h = a.heading + veer;
      const nx = a.x + Math.sin(h) * step;
      const nz = a.z + Math.cos(h) * step;
      if (this.solidAt(nx + Math.sin(h) * 0.4, nz + Math.cos(h) * 0.4)) continue;
      a.x = nx;
      a.z = nz;
      if (veer) a.heading += veer * Math.min(1, dt * 4);
      return;
    }
  }

  // Can one see from (x0, z0) to (x1, z1) past the buildings? (every 2.5 m)
  clearLine(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(d / 2.5);
    for (let i = 1; i < n; i++) {
      if (this.solidAt(x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n)) return false;
    }
    return true;
  }

  // Someone on foot firing at the player: in bursts for an SMG, hitting by distance, the player's speed and their skill
  npcShoot(a, gun, skill, dist, dt) {
    if (a.cooldown > 0 || this.state !== 'play') return;
    if (gun.burst > 1) {
      a.burst = a.burst > 0 ? a.burst - 1 : gun.burst - 1;
      a.cooldown = a.burst > 0 ? 0.11 : 1 / gun.rate + rand(0.2, 0.9);
    } else {
      a.cooldown = 1 / gun.rate + rand(0, 0.6);
    }
    const yaw = a.heading;
    const hx = a.rig.handPosition.x + Math.sin(yaw) * 0.3;
    const hy = a.rig.handPosition.y + 0.05;
    const hz = a.rig.handPosition.z + Math.cos(yaw) * 0.3;
    this.fx.muzzle(hx, hy, hz, yaw);
    this.audio?.gunfire?.(a.weapon || 'pistol', hx, hy, hz);
    const hits = Math.random() < hitChance(dist, this.pspeed, skill, gun.range);
    const py = this.player.position.y + (this.mode === 'person' ? 1.2 : 0.9);
    if (hits) {
      this.fx.tracer(hx, hy, hz, this.px, py, this.pz);
      this.fx.impact(this.px, py, this.pz, this.mode === 'person' ? 'blood' : 'metal', -Math.sin(yaw), -Math.cos(yaw));
      this.hurt(gun.damage, a.x, a.z);
    } else {
      // a miss: past the player, into whatever is behind
      const miss = rand(0.8, 2.2) * (Math.random() < 0.5 ? -1 : 1);
      const ex = this.px + Math.cos(yaw) * miss + Math.sin(yaw) * 6;
      const ez = this.pz - Math.sin(yaw) * miss + Math.cos(yaw) * 6;
      this.fx.tracer(hx, hy, hz, ex, py + rand(-0.6, 0.6), ez);
    }
    this.traffic.panic(a.x, a.z, 30);
  }

  // =========================================================================
  // 8. PATROL CARS
  // =========================================================================
  spawnCruiser() {
    const cr = this.cruisers.find((c) => !c.active);
    if (!cr) return null;
    const s = this.traffic.roadSpot(this.px, this.pz, 70, 160);
    if (!s) return null;
    Object.assign(cr, {
      active: true, x: s.x, z: s.z, heading: Math.atan2(this.px - s.x, this.pz - s.z), speed: 6, vx: 0, vz: 0, hp: 100,
      wreck: 0, state: 'chase', path: null, pathI: 0, replan: 0, stuckT: 0, checkX: s.x, checkZ: s.z, reverseT: 0,
      deployed: false, life: 0, pitch: 0, roll: 0, lift: 0, vy: 0, stuckCount: 0, slowT: 0, startX: s.x, startZ: s.z
    });
    cr.bodyMesh.material = cr.paint;
    cr.lightbar.visible = true;
    return cr;
  }

  removeCruiser(cr) {
    cr.active = false;
    cr.mesh.position.y = PARKED_Y;
    cr.position.set(0, PARKED_Y, 0);
    cr.path = null;
  }

  damageCruiser(cr, damage, byPlayer) {
    if (cr.wreck) return;
    cr.hp -= damage;
    if (byPlayer) this.report('shootCop', damage > 10 || this.wanted.stars === 0);
    if (cr.hp > 0) return;
    // blown up: a burning wreck for a while
    cr.wreck = 20;
    cr.speed = 0;
    cr.bodyMesh.material = this.burnt;
    cr.lightbar.visible = false;
    if (byPlayer) this.report('killCop');
    this.explode(cr.x, cr.y + 0.8, cr.z, 7, 120, byPlayer);
    cr.vy = 6;
  }

  updateCruiser(cr, dt) {
    cr.life += dt;
    const dx = this.px - cr.x, dz = this.pz - cr.z;
    const dist = Math.hypot(dx, dz);
    if (cr.wreck) {
      cr.wreck -= dt;
      cr.speed = 0;
      if (Math.random() < dt * 14) this.fx.flame(cr.x + rand(-0.8, 0.8), cr.y + 1, cr.z + rand(-1.5, 1.5), 1.1);
      if (Math.random() < dt * 8) this.fx.smoke(cr.x, cr.y + 1.6, cr.z, 2.6, 0.9);
      if (cr.wreck <= 0 || dist > DESPAWN) this.removeCruiser(cr);
      else this.moveCruiser(cr, dt, 0);
      return;
    }
    const stars = this.wanted.stars;
    if (stars === 0 || this.state !== 'play') cr.state = 'leave';
    if (cr.state === 'leave' && (dist > 90 || cr.life > 90)) {
      this.removeCruiser(cr);
      return;
    }
    if (dist > 280 || (cr.stuckCount > 3 && dist > 30)) {
      // left far behind, or hopelessly stuck: it comes round again closer (out of sight)
      this.removeCruiser(cr);
      return;
    }

    // where to: straight at the player when it can be seen, else along the roads
    let tx = this.px, tz = this.pz;
    if (cr.state === 'leave') {
      tx = cr.x + Math.sin(cr.heading) * 40;
      tz = cr.z + Math.cos(cr.heading) * 40;
    } else {
      cr.replan -= dt;
      const direct = dist < 55 && this.clearLine(cr.x, cr.z, this.px, this.pz);
      if (direct) {
        const lead = Math.min(1.2, dist / 18);
        tx = this.px + this.pvx * lead;
        tz = this.pz + this.pvz * lead;
      } else {
        // a new route when the player has moved on from where the last one led (or it ran out, or the car got stuck)
        if (!cr.path || (cr.replan <= 0 && Math.hypot(this.px - cr.goalX, this.pz - cr.goalZ) > 25)) {
          cr.path = this.route(cr.x, cr.z, this.px, this.pz);
          // (without the intersections it is already past: on the way from the first to the second)
          while (cr.path && cr.path.length > 1 &&
            Math.hypot(cr.path[1].x - cr.x, cr.path[1].z - cr.z) < Math.hypot(cr.path[1].x - cr.path[0].x, cr.path[1].z - cr.path[0].z)) {
            cr.path.shift();
          }
          cr.pathI = 0;
          cr.startX = cr.x;
          cr.startZ = cr.z;
          cr.goalX = this.px;
          cr.goalZ = this.pz;
          cr.replan = 3;
        }
        if (cr.path && this.pursue(cr, 10 + Math.abs(cr.speed) * 0.6)) {
          tx = this._aim.x;
          tz = this._aim.z;
        }
      }
    }
    // overtaking: something slow ahead in its way (a car or bus queued at a light), it pulls out round it
    if (cr.state === 'chase' || cr.state === 'leave') {
      const pass = this.blockerAhead(cr);
      if (pass) {
        const side = cr.passSide || 1; // (left first: the oncoming lane)
        const lx = Math.cos(cr.heading) * side, lz = -Math.sin(cr.heading) * side;
        if (this.solidAt(cr.x + lx * 3.2 + Math.sin(cr.heading) * 5, cr.z + lz * 3.2 + Math.cos(cr.heading) * 5)) cr.passSide = -side;
        tx = cr.x + Math.sin(cr.heading) * 12 + lx * 3.4 * pass;
        tz = cr.z + Math.cos(cr.heading) * 12 + lz * 3.4 * pass;
      }
    }
    let want = POLICE.speed[stars] || 13;
    // stop near a player on foot and send the officers out
    cr.slowT = Math.abs(cr.speed) < 1.5 ? (cr.slowT || 0) + dt : 0;
    if (cr.state === 'chase' && this.mode === 'person' && (dist < 15 || (dist < 35 && cr.slowT > 1.5))) {
      if (dist < 15) want = 0;
      if (!cr.deployed && Math.abs(cr.speed) < 1.5) {
        cr.deployed = true;
        this.deployOfficers(cr);
      }
    }
    if (cr.state === 'chase' && this.mode !== 'person' && dist > 15) cr.deployed = false;
    this.moveCruiser(cr, dt, want, tx, tz);
  }

  // Pure pursuit along a patrol car's route (where it was when it planned, then the intersections): the point `look`
  // m on along the street from the nearest point of the leg it is on, into this._aim. False at the route's end.
  pursue(cr, look) {
    const path = cr.path;
    const aim = (this._aim ??= { x: 0, z: 0 });
    for (;;) {
      if (cr.pathI >= path.length) return false;
      const a = cr.pathI === 0 ? { x: cr.startX, z: cr.startZ } : path[cr.pathI - 1];
      const b = path[cr.pathI];
      const lx = b.x - a.x, lz = b.z - a.z;
      const len = Math.hypot(lx, lz);
      if (len < 0.5) {
        cr.pathI++;
        continue;
      }
      const t = ((cr.x - a.x) * lx + (cr.z - a.z) * lz) / len;
      const rest = len - t;
      if (rest < 4 && cr.pathI < path.length - 1) {
        cr.pathI++; // round the corner onto the next leg
        continue;
      }
      if (rest >= look || cr.pathI === path.length - 1) {
        const k = Math.min(len, Math.max(0, t) + look) / len;
        aim.x = a.x + lx * k;
        aim.z = a.z + lz * k;
        return cr.pathI < path.length - 1 || rest > 6;
      }
      // the corner is nearer than the lookahead: aim past it, along the next leg
      const c = path[cr.pathI + 1];
      const nx = c.x - b.x, nz = c.z - b.z;
      const nl = Math.hypot(nx, nz) || 1;
      const over = Math.min(nl, look - rest);
      aim.x = b.x + nx / nl * over;
      aim.z = b.z + nz / nl * over;
      return true;
    }
  }

  // How much a slow vehicle of the traffic stands in a patrol car's way within 14 m ahead (0 none .. 1 dead ahead)
  blockerAhead(cr) {
    const fx = Math.sin(cr.heading), fz = Math.cos(cr.heading);
    let worst = 0;
    for (const list of [this.traffic.cars, this.traffic.buses]) {
      for (const v of list) {
        if (!v.edge || v.speed > Math.max(4, Math.abs(cr.speed) * 0.6)) continue;
        const dx = v.x - cr.x, dz = v.z - cr.z;
        if (Math.abs(dx) > 22 || Math.abs(dz) > 22) continue;
        const ahead = dx * fx + dz * fz - v.half;
        const across = Math.abs(dx * fz - dz * fx);
        if (ahead < 0 || ahead > 14 || across > v.halfWidth + cr.halfW + 0.5) continue;
        worst = Math.max(worst, 1 - across / (v.halfWidth + cr.halfW + 0.5) * 0.5);
      }
    }
    return worst;
  }

  deployOfficers(cr) {
    const stars = this.wanted.stars;
    const cops = this.agents.reduce((n, a) => n + (a.kind === 'cop' && !a.fallen ? 1 : 0), 0);
    for (const side of [1, -1]) {
      if (cops >= POLICE.foot[stars] + 3) break;
      const lx = Math.cos(cr.heading) * side * 1.6, lz = -Math.sin(cr.heading) * side * 1.6;
      if (this.solidAt(cr.x + lx, cr.z + lz)) continue;
      this.spawnAgent('cop', cr.x + lx, cr.z + lz, { weapon: POLICE.weapon[stars] || 'pistol' });
    }
  }

  // Drives a patrol car towards (tx, tz) at up to `want` m/s: steering with the speed it has, feeling ahead for walls,
  // backing out when stuck
  moveCruiser(cr, dt, want, tx = cr.x, tz = cr.z) {
    let steer = 0;
    if (want > 0) {
      const desired = Math.atan2(tx - cr.x, tz - cr.z);
      steer = wrapAngle(desired - cr.heading);
      // whiskers: a wall ahead turns it towards the clearer side
      const look = 3 + Math.abs(cr.speed) * 0.45;
      const probe = (a) => this.solidAt(cr.x + Math.sin(cr.heading + a) * look, cr.z + Math.cos(cr.heading + a) * look);
      if (probe(0)) {
        const l = probe(0.6), r = probe(-0.6);
        if (!l && r) steer = 1;
        else if (l && !r) steer = -1;
        else steer = steer >= 0 ? 1 : -1;
        want *= 0.4;
      }
      want *= 1 - Math.min(0.7, Math.abs(steer) / 1.5);
    }
    // stuck (barely moved in 2 s while trying to go): back up a little the other way
    cr.stuckT += dt;
    if (cr.stuckT > 2) {
      if (want > 3 && Math.hypot(cr.x - cr.checkX, cr.z - cr.checkZ) < 2.5 && cr.reverseT <= 0) {
        cr.reverseT = 1.3;
        cr.stuckCount = (cr.stuckCount || 0) + 1;
        cr.path = null;
      } else if (Math.hypot(cr.x - cr.checkX, cr.z - cr.checkZ) > 12) {
        cr.stuckCount = 0;
      }
      cr.stuckT = 0;
      cr.checkX = cr.x;
      cr.checkZ = cr.z;
    }
    if (cr.reverseT > 0) {
      cr.reverseT -= dt;
      want = -5;
      steer = -Math.sign(steer || 1);
    }
    const accel = want > cr.speed ? (cr.speed < 0 ? CRUISER.brake : CRUISER.accel) : CRUISER.brake;
    cr.speed += clamp(want - cr.speed, -accel * dt, accel * dt);
    const grip = clamp(Math.abs(cr.speed) / 5, 0, 1) * Math.sign(cr.speed || 1);
    cr.heading += clamp(steer, -1, 1) * CRUISER.turn * grip * dt;

    const ox = cr.x, oz = cr.z;
    cr.x += Math.sin(cr.heading) * cr.speed * dt + cr.vx * dt;
    cr.z += Math.cos(cr.heading) * cr.speed * dt + cr.vz * dt;
    const k = Math.exp(-4 * dt);
    cr.vx *= k;
    cr.vz *= k;
    // its bumpers against the buildings
    const way = cr.speed >= 0 ? 1 : -1;
    const bx = cr.x + Math.sin(cr.heading) * cr.halfL * way, bz = cr.z + Math.cos(cr.heading) * cr.halfL * way;
    if (this.solidAt(bx, bz) || this.solidAt(cr.x, cr.z)) {
      cr.x = ox;
      cr.z = oz;
      if (Math.abs(cr.speed) > 6) this.traffic.sparks(bx, cr.y + 0.6, bz, -Math.sin(cr.heading) * way, -Math.cos(cr.heading) * way, Math.abs(cr.speed));
      cr.speed *= -0.2;
      cr.vx = cr.vz = 0;
    }
    if (!cr.wreck) {
      // (they shove the traffic aside as if they weighed three times as much: a chase doesn't wait in line)
      cr.mass = CRUISER.mass * 3;
      this.traffic.bumpBody(cr);
      cr.mass = CRUISER.mass;
      this.traffic.knockBox(cr.x, cr.z, cr.heading, cr.halfW, cr.halfL,
        Math.sin(cr.heading) * cr.speed + cr.vx, Math.cos(cr.heading) * cr.speed + cr.vz);
      // patrol cars knock down the gangs and thieves in their way, not their own
      if (Math.abs(cr.speed) > 3) {
        for (const a of this.agents) {
          if (a.kind === 'cop' || a.fallen) continue;
          const hit = boxHit(cr.x, cr.z, cr.heading, cr.halfW, cr.halfL, a.x, a.z, 0.3);
          if (!hit) continue;
          a.hp -= Math.abs(cr.speed) * 6;
          this.knockAgent(a, Math.sin(cr.heading) * cr.speed, Math.cos(cr.heading) * cr.speed, hit.nx, hit.nz);
          if (a.hp <= 0) this.kill(a);
        }
      }
    }

    // on the ground, tilted with it
    cr.y = this.groundAt(cr.x, cr.z);
    if (cr.vy) {
      cr.vy -= 9.8 * dt;
      cr.lift = Math.max(0, (cr.lift || 0) + cr.vy * dt);
      if (cr.lift === 0) cr.vy = 0;
    }
    this.controllers.groundTilt(cr.x, cr.z, cr.heading, 1.4, 0.8, tilt);
    cr.pitch += (tilt.pitch - cr.pitch) * Math.min(1, dt * 10);
    cr.roll += (tilt.roll - cr.roll) * Math.min(1, dt * 10);
    cr.mesh.position.set(cr.x, cr.y + (cr.lift || 0), cr.z);
    cr.mesh.rotation.y = cr.heading;
    cr.tiltPivot.rotation.set(cr.pitch, 0, cr.roll + (cr.wreck ? 0.05 : 0), 'YXZ');
    cr.position.set(cr.x, cr.y + 0.7, cr.z);
  }

  // Patrol cars against the player and each other
  collideCruisers() {
    const pe = this.player;
    const box = this._playerBox ??= { x: 0, z: 0, heading: 0, hw: 0, hl: 0 };
    const sizes = { car: [0.86, 2.18], cyclist: [0.35, 0.85], person: [0.32, 0.32] };
    const size = sizes[this.mode];
    for (const cr of this.cruisers) {
      if (!cr.active) continue;
      cr.hw = cr.halfW;
      cr.hl = cr.halfL;
      if (size && this.onStreet) {
        box.x = pe.position.x;
        box.z = pe.position.z;
        box.heading = pe.heading;
        box.hw = size[0];
        box.hl = size[1];
        const hit = boxOverlap(cr, box);
        if (hit) {
          const pm = this.mode === 'car' ? 1300 : this.mode === 'cyclist' ? 95 : 75;
          const share = cr.mass / (cr.mass + pm); // the player's share of the push
          pe.position.x += hit.nx * hit.pen * share;
          pe.position.z += hit.nz * hit.pen * share;
          cr.x -= hit.nx * hit.pen * (1 - share);
          cr.z -= hit.nz * hit.pen * (1 - share);
          const cvx = Math.sin(cr.heading) * cr.speed + cr.vx, cvz = Math.cos(cr.heading) * cr.speed + cr.vz;
          const approach = (cvx - this.pvx) * hit.nx + (cvz - this.pvz) * hit.nz;
          if (approach > 0.5) {
            if (this.mode === 'car') {
              pe.vx = (pe.vx || 0) + hit.nx * approach * share * 0.7;
              pe.vz = (pe.vz || 0) + hit.nz * approach * share * 0.7;
              pe.angularVel = (pe.angularVel || 0) + (Math.random() - 0.5) * approach * 0.15;
              pe.rollVel = (pe.rollVel || 0) + approach * 0.2;
              pe.speed *= 0.8;
            }
            cr.speed *= 0.6;
            cr.vx -= hit.nx * approach * (1 - share) * 0.5;
            cr.vz -= hit.nz * approach * (1 - share) * 0.5;
            this.audio?.crash?.({ a: cr, b: pe, x: pe.position.x - hit.nx * size[0], y: pe.position.y + 0.6, z: pe.position.z - hit.nz * size[0], speed: approach });
            if (approach > 2) this.traffic.sparks(pe.position.x - hit.nx * size[0], pe.position.y + 0.6, pe.position.z - hit.nz * size[0], hit.nx, hit.nz, approach);
            // a car ramming the player hurts it: badly on foot
            if (this.mode === 'person' && approach > 3) this.hurt(approach * 3.5, cr.x, cr.z);
            else if (approach > 7) this.hurt((approach - 7) * 1.5, cr.x, cr.z);
          }
        }
      }
      for (const o of this.cruisers) {
        if (o === cr || !o.active) continue;
        o.hw = o.halfW;
        o.hl = o.halfL;
        const hit = boxOverlap(cr, o);
        if (!hit) continue;
        o.x += hit.nx * hit.pen * 0.5;
        o.z += hit.nz * hit.pen * 0.5;
        cr.x -= hit.nx * hit.pen * 0.5;
        cr.z -= hit.nz * hit.pen * 0.5;
      }
    }
  }

  // =========================================================================
  // 9. WHO TURNS UP: the police for the stars, gangs on their turf, thieves, pickups
  // =========================================================================
  dispatch(dt) {
    const t = this.timers;
    const stars = this.state === 'play' ? this.wanted.stars : 0;
    t.dispatch -= dt;
    if (t.dispatch <= 0 && stars > 0) {
      t.dispatch = 1.2;
      let cops = 0;
      for (const a of this.agents) if (a.kind === 'cop' && !a.fallen && a.state !== 'leave') cops++;
      let cars = 0;
      for (const cr of this.cruisers) if (cr.active && !cr.wreck && cr.state === 'chase') cars++;
      if (cops < POLICE.foot[stars] && this.mode !== 'helicopter') {
        const s = this.traffic.sidewalkSpot(this.px, this.pz, 35, 75);
        if (s) this.spawnAgent('cop', s.x, s.z, { weapon: POLICE.weapon[stars] || 'pistol' });
      } else if (cars < POLICE.cruisers[stars]) {
        this.spawnCruiser();
      }
    }

    // gangs: a group on the corner when the player is on their turf
    t.gangs -= dt;
    if (t.gangs <= 0) {
      t.gangs = 2.5;
      const turf = gangTurf(this.px, this.pz);
      let members = 0;
      for (const a of this.agents) if (a.kind === 'gang' && !a.dead) members++;
      if (turf >= 0 && members < 8 && this.agents.length < MAX_AGENTS - 6 && this.mode !== 'helicopter') {
        const s = this.traffic.sidewalkSpot(this.px, this.pz, 45, 95);
        if (s && gangTurf(s.x, s.z) === turf) {
          const n = 3 + Math.floor(Math.random() * 2);
          const cx = s.x, cz = s.z;
          for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2;
            let x = cx + Math.cos(ang) * 1.2, z = cz + Math.sin(ang) * 1.2;
            if (this.solidAt(x, z)) {
              x = cx;
              z = cz;
            }
            const g = GANGS[turf];
            const a = this.spawnAgent('gang', x, z, { gang: turf, weapon: Math.random() < 0.5 ? g.weapon : 'pistol' });
            if (a) {
              a.homeX = cx;
              a.homeZ = cz;
              a.idleYaw = Math.atan2(cx - x, cz - z);
            }
          }
          if (this.lastTurf !== turf) this.toast(`${GANGS[turf].name} turf`);
          this.lastTurf = turf;
        }
      } else if (turf < 0) {
        this.lastTurf = -1;
      }
    }

    // a thief now and then, after a player on foot with money on it
    t.thief -= dt;
    if (t.thief <= 0) {
      t.thief = rand(50, 100);
      const busy = this.agents.some((a) => a.kind === 'thief');
      if (!busy && this.mode === 'person' && this.money >= 30 && stars <= 1 && this.state === 'play') {
        const s = this.traffic.sidewalkSpot(this.px, this.pz, 22, 45);
        if (s) this.spawnAgent('thief', s.x, s.z);
      }
    }

    // health & armour, and a bazooka when it has run dry, lying about on the sidewalks
    t.health -= dt;
    if (t.health <= 0) {
      t.health = 40;
      const kind = this.health < 70 ? 'health' : this.armor < 50 ? 'armor' : null;
      if (kind && this.pickups.filter((p) => p.kind === kind).length < 2) {
        const s = this.traffic.sidewalkSpot(this.px, this.pz, 25, 80);
        if (s) this.drop(kind, s.x, s.z, kind === 'health' ? 50 : 50, 240);
      }
    }
    t.bazooka -= dt;
    if (t.bazooka <= 0) {
      t.bazooka = 70;
      if (!this.arsenal.has('bazooka') && !this.pickups.some((p) => p.kind === 'bazooka')) {
        const s = this.traffic.sidewalkSpot(this.px, this.pz, 30, 90);
        if (s) this.drop('bazooka', s.x, s.z, 0, 300);
      }
    }
  }

  // =========================================================================
  // 10. PICKUPS
  // =========================================================================
  drop(kind, x, z, amount = 0, life = 90) {
    if (this.pickups.length >= MAX_PICKUPS) this.pickups.shift();
    this.pickups.push({ kind, x, z, y: this.groundAt(x, z), amount, life });
  }

  updatePickups(dt, elapsed) {
    const mesh = this.pickupMesh;
    let n = 0;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.pickups.splice(i, 1);
        continue;
      }
      if (this.state === 'play' && this.mode !== 'helicopter' && Math.hypot(p.x - this.px, p.z - this.pz) < 1.5) {
        this.collect(p);
        this.pickups.splice(i, 1);
      }
    }
    for (const p of this.pickups) {
      dummy.position.set(p.x, p.y + 0.75 + Math.sin(elapsed * 2.4 + p.x) * 0.12, p.z);
      dummy.rotation.set(0, elapsed * 2, 0);
      dummy.scale.setScalar(p.kind === 'money' ? 0.8 : 1.1);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      const c = PICKUP_COLORS[p.kind];
      mesh.setColorAt(n, tint.setRGB(c[0], c[1], c[2]));
      n++;
    }
    mesh.count = Math.max(1, n);
    if (!n) mesh.setMatrixAt(0, zero);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  collect(p) {
    this.audio?.gunfire?.('pickup', p.x, p.y + 1, p.z);
    if (p.kind === 'money') {
      this.money += p.amount;
      this.toast(`+$${p.amount}`);
    } else if (p.kind === 'health') {
      this.health = Math.min(100, this.health + p.amount);
      this.toast('Health');
    } else if (p.kind === 'armor') {
      this.armor = Math.min(100, this.armor + p.amount);
      this.toast('Armor');
    } else {
      const w = WEAPONS[p.kind];
      const had = this.arsenal.has(w.id);
      this.arsenal.add(w.id, w.pickup);
      if (!had && w.id !== 'fists') this.arsenal.select(w.id);
      this.toast(`${w.label} +${w.pickup}`);
    }
  }

  // Positions on the minimap: { kind: 'cop' | 'cruiser' | 'gang' | 'thief' | <pickup kind>, x, z } (reused)
  blips(out = (this._blips ??= [])) {
    out.length = 0;
    for (const a of this.agents) if (!a.dead) out.push(a.kind === 'gang' ? (a.gang ? 'verdes' : 'rojos') : a.kind, a.x, a.z);
    for (const cr of this.cruisers) if (cr.active && !cr.wreck) out.push('cruiser', cr.x, cr.z);
    for (const p of this.pickups) out.push(p.kind, p.x, p.z);
    return out;
  }
}

export { CrimeSystem };
