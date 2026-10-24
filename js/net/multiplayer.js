import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from '../sim/pedestrians.js';
import {
  SEND_HZ,
  OP,
  encodeHello,
  encodeState,
  decodeServer
} from '../../shared/protocol.js';

// js/net/multiplayer.js
// Browser side of the room server (server/index.js), loaded only with ?multiplayer=1 (see main.js). Sends the active
// player's pose SEND_HZ times a second, keeps a local list of the players the server says are in view, and draws them
// INTERP_DELAY_MS in the past, interpolating between the poses it received so 10 Hz updates look smooth.
//
//   ?multiplayer=1               connect (to ws://<this host>:8787 when served from localhost)
//   &mp-server=wss://host/path   another server
//   &mp-region=nayarit           room region (default: this map's, see DEFAULT_REGION)
//   &mp-name=Lalo                display name (remembered)

const DEFAULT_REGION = 'nayarit'; // the map this checkout builds (Tepic); each city's map will name its own region
const DEFAULT_PORT = 8787;
const INTERP_DELAY_MS = 200; // two server ticks: a late packet still has a pose to blend toward
const SNAP_DISTANCE = 60; // m between updates beyond which a player teleported instead of moving
const KEEPALIVE_MS = 2000; // resend an unchanged pose this often
const MAX_REMOTE_PEOPLE = 96; // walkers + cyclists' riders drawn by the shared crowd
const LABEL_DISTANCE = 140; // m within which name tags show
const RETRY_MAX_MS = 10000;
const NAME_KEY = 'mp-name';

const _v = new THREE.Vector3();

const lerpAngle = (a, b, t) => a + ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * t;

// The node at the same child-index path in a clone as `node` is in `root`
function counterpart(root, clone, node) {
  const path = [];
  for (let n = node; n && n !== root; n = n.parent) path.unshift(n.parent.children.indexOf(n));
  let c = clone;
  for (const i of path) c = c && c.children[i];
  return c;
}

// A visual copy of a player entity's mesh sharing its geometry & materials, without its lights (dozens of remote
// headlamps would swamp the clustered light budget)
function cloneVisual(entity) {
  const copy = entity.mesh.clone(true);
  const lights = [];
  copy.traverse((o) => {
    if (o.isLight) lights.push(o);
  });
  for (const l of lights) l.removeFromParent();
  return copy;
}

class RemotePlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.mode = null;
    this.samples = []; // { t, x, y, z, heading, speed }, oldest first
    this.visual = null;
    this.rig = null;
    this.label = null;
    this.pedalPhase = 0;
    this.pose = { x: 0, y: 0, z: 0, heading: 0, speed: 0 };
  }

  push(t, s, tickMs) {
    const last = this.samples[this.samples.length - 1];
    if (last && Math.hypot(s.x - last.x, s.z - last.z) > SNAP_DISTANCE) this.samples.length = 0;
    else if (last && t - last.t > tickMs * 2.5) {
      // it stood still (the server sent nothing): start the new motion from a fresh copy, not a minutes-long glide
      this.samples.push({ ...last, t: t - tickMs });
    }
    this.samples.push({ t, x: s.x, y: s.y, z: s.z, heading: s.heading, speed: s.speed });
    if (this.samples.length > 6) this.samples.shift();
  }

  // Pose at renderTime: between the two samples around it, else held at the nearest end
  sample(renderTime) {
    const s = this.samples;
    const p = this.pose;
    if (s.length === 0) return p;
    let a = s[0];
    let b = s[0];
    if (renderTime >= s[s.length - 1].t) {
      a = b = s[s.length - 1];
    } else {
      for (let i = 1; i < s.length; i++) {
        if (s[i].t >= renderTime) {
          a = s[i - 1];
          b = s[i];
          break;
        }
      }
    }
    const t = b.t > a.t ? Math.min(1, Math.max(0, (renderTime - a.t) / (b.t - a.t))) : 1;
    p.x = a.x + (b.x - a.x) * t;
    p.y = a.y + (b.y - a.y) * t;
    p.z = a.z + (b.z - a.z) * t;
    p.heading = lerpAngle(a.heading, b.heading, t);
    p.speed = a.speed + (b.speed - a.speed) * t;
    return p;
  }
}

class Multiplayer {
  constructor({ scene, controllers, camera, url, region = DEFAULT_REGION, name = '' }) {
    this.scene = scene;
    this.controllers = controllers;
    this.camera = camera;
    this.url = url;
    this.region = region;
    this.name = name;
    this.ws = null;
    this.id = 0;
    this.room = '';
    this.roomPlayers = 0;
    this.tickMs = 100;
    this.remotes = new Map(); // id → RemotePlayer
    this.status = 'connecting';
    this.retryMs = 1000;
    this.stopped = false;
    this.lastSent = null;
    this.lastSentAt = 0;
    this.nextSendAt = 0;

    this.crowd = new PersonCrowd(MAX_REMOTE_PEOPLE, { farDistance: 40 });
    this.crowd.meshes.forEach((m) => scene.add(m));

    this.badge = document.createElement('div');
    this.badge.className = 'mp-badge';
    this.badge.setAttribute('role', 'status');
    this.labels = document.createElement('div');
    this.labels.className = 'mp-labels';
    document.body.append(this.labels);
    // under the brand panel, top left, so it never collides with the toolbar
    (document.querySelector('.hud-top-left') || document.body).append(this.badge);
    this.renderBadge();
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    this.renderBadge();
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.status = 'error';
      this.renderBadge(err.message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      ws.send(encodeHello(this.region, this.name));
      this.lastSent = null;
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return;
      const msg = decodeServer(e.data);
      if (msg) this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearRemotes();
      if (this.stopped) return;
      this.status = 'offline';
      this.renderBadge();
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    };
  }

  receive(msg) {
    if (msg.op === OP.WELCOME) {
      this.id = msg.id;
      this.room = msg.room;
      this.tickMs = 1000 / Math.max(1, msg.tickHz);
      this.status = 'online';
      this.retryMs = 1000;
      this.renderBadge();
      return;
    }
    if (msg.op === OP.ERROR) {
      // a version mismatch or a rejected region won't fix itself by retrying
      if (msg.code === 'version' || msg.code === 'region') this.stopped = true;
      this.status = 'error';
      this.renderBadge(msg.code);
      return;
    }
    const now = performance.now();
    this.roomPlayers = msg.roomPlayers;
    for (const id of msg.gone) this.removeRemote(id);
    for (const { id, name } of msg.info) {
      if (!this.remotes.has(id)) this.remotes.set(id, new RemotePlayer(id, name));
    }
    for (const s of msg.moved) {
      const r = this.remotes.get(s.id);
      if (!r) continue;
      if (r.mode !== s.mode) this.setMode(r, s.mode);
      r.push(now, s, this.tickMs);
    }
    this.renderBadge();
  }

  setMode(r, mode) {
    if (r.visual) r.visual.removeFromParent();
    r.visual = null;
    r.mode = mode;
    const entity = this.controllers.entities[mode];
    if (mode !== 'person' && entity) {
      r.visual = cloneVisual(entity);
      if (mode === 'cyclist') r.leanPivot = counterpart(entity.mesh, r.visual, entity.leanPivot);
      if (mode === 'helicopter') {
        r.mainRotor = counterpart(entity.mesh, r.visual, entity.mainRotorPivot);
        r.tailRotor = counterpart(entity.mesh, r.visual, entity.tailRotorPivot);
      }
      this.scene.add(r.visual);
    }
    if ((mode === 'person' || mode === 'cyclist') && !r.rig) {
      // every remote player keeps one look, seeded by its id
      r.rig = new PersonRig({ seed: 7.3 + r.id * 1.618, scale: 0.96 + (r.id % 7) * 0.012, girth: 0.95 + (r.id % 5) * 0.03, hair: (r.id % 4) * 0.08 });
    }
  }

  removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    if (r.visual) r.visual.removeFromParent();
    if (r.label) r.label.remove();
    this.remotes.delete(id);
  }

  clearRemotes() {
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    this.roomPlayers = 0;
  }

  // Once a frame from the main loop, after the local controllers moved
  update(dt, elapsed) {
    const now = performance.now();
    this.sendPose(now);

    const renderTime = now - INTERP_DELAY_MS;
    const cam = this.camera;
    this.crowd.begin();
    for (const r of this.remotes.values()) {
      if (!r.mode || r.samples.length === 0) continue;
      const p = r.sample(renderTime);
      const dist = Math.hypot(p.x - cam.position.x, p.z - cam.position.z);
      if (r.visual) {
        r.visual.position.set(p.x, p.y, p.z);
        r.visual.rotation.y = p.heading;
      }
      if (r.mode === 'person') {
        const air = p.y - this.controllers.getGroundHeight(p.x, p.z, 'person');
        r.rig.update(dt, p.x, p.z, p.heading, groundFor, this.controllers, air > 0.05 ? air : 0);
        this.crowd.add(r.rig, dist);
      } else if (r.mode === 'cyclist' && r.leanPivot) {
        r.pedalPhase += (p.speed / 0.35 / 3.2) * dt;
        r.rig.ride(r.leanPivot, r.pedalPhase, this.controllers.entities.cyclist.bikeFrame);
        this.crowd.add(r.rig, dist);
      } else if (r.mode === 'helicopter') {
        if (r.mainRotor) r.mainRotor.rotation.y += dt * 24.0;
        if (r.tailRotor) r.tailRotor.rotation.x += dt * 32.0;
      }
      this.placeLabel(r, p, dist);
    }
    this.crowd.end();
  }

  sendPose(now) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'online' || now < this.nextSendAt) return;
    this.nextSendAt = now + 1000 / SEND_HZ;
    const frame = encodeState(this.controllers.getActiveEntity(), this.controllers.activeMode);
    const same = this.lastSent && this.lastSent.length === frame.length && this.lastSent.every((b, i) => b === frame[i]);
    if (same && now - this.lastSentAt < KEEPALIVE_MS) return;
    ws.send(frame);
    this.lastSent = frame;
    this.lastSentAt = now;
  }

  placeLabel(r, p, dist) {
    const show = dist < LABEL_DISTANCE;
    if (show && !r.label) {
      r.label = document.createElement('div');
      r.label.className = 'mp-label';
      r.label.textContent = r.name;
      this.labels.append(r.label);
    }
    if (!r.label) return;
    const height = r.mode === 'helicopter' ? 3.6 : r.mode === 'car' ? 2.2 : 2.25;
    _v.set(p.x, p.y + height, p.z).project(this.camera);
    const visible = show && _v.z > -1 && _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
    r.label.hidden = !visible;
    if (!visible) return;
    const x = (_v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    r.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    r.label.style.opacity = String(Math.max(0.35, 1 - dist / LABEL_DISTANCE));
  }

  renderBadge(detail = '') {
    const text = {
      connecting: 'Connecting…',
      online: `Online · ${this.room} · ${this.roomPlayers} ${this.roomPlayers === 1 ? 'player' : 'players'}`,
      offline: 'Offline · reconnecting…',
      error: `Multiplayer error${detail ? `: ${detail}` : ''}`
    }[this.status];
    if (this.badge.textContent !== text) this.badge.textContent = text;
    this.badge.dataset.status = this.status;
  }
}

const groundFor = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');

// Reads ?multiplayer & friends; returns null when multiplayer is off or there is no server to reach
function multiplayerOptions(search = location.search, host = location.hostname) {
  const params = new URLSearchParams(search);
  if (!params.has('multiplayer') || params.get('multiplayer') === '0') return null;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  const url = params.get('mp-server') || (local ? `ws://${host}:${DEFAULT_PORT}` : null);
  if (!url || !/^wss?:\/\//.test(url)) return null;
  let name = params.get('mp-name') || '';
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else name = localStorage.getItem(NAME_KEY) || '';
  } catch {
    // storage blocked: the server hands out a numbered name
  }
  return { url, region: params.get('mp-region') || DEFAULT_REGION, name };
}

export { Multiplayer, RemotePlayer, multiplayerOptions, DEFAULT_REGION };
