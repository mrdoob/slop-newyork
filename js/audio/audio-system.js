import { createSynthResources, createMotorVoice, setControlRate } from './audio-synthesis.js';
import { createEventResources, playEvent, createWindVoice, createRainVoice } from './audio-events.js';
import { CityAudioSources } from './audio-sources.js';
import { CityAcoustics } from './audio-acoustics.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (param, value, now, time = 0.035, immediate = false) => {
  param.cancelScheduledValues(now);
  if (immediate) param.setValueAtTime(value, now);
  else param.setTargetAtTime(value, now, time);
};

// Direct sound is muffled behind buildings; the shared reflection path keeps some diffuse sound around corners.
// All voices share one short convolution and the existing collision grid, with no mesh traversal or per-voice reverb.
class SpatialEmitter {
  constructor(context, dry, reflections, acoustics, refDistance, height = 0, directional = false) {
    this.height = height;
    this.acoustics = acoustics;
    this.nextObstruction = 0;
    this.obstruction = 0;
    this.input = context.createGain();
    this.input.gain.value = 0;
    this.filter = context.createBiquadFilter();
    setControlRate(this.filter.frequency, this.filter.detune, this.filter.Q, this.filter.gain);
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.5;
    this.panner = context.createPanner();
    setControlRate(
      this.panner.positionX, this.panner.positionY, this.panner.positionZ,
      this.panner.orientationX, this.panner.orientationY, this.panner.orientationZ
    );
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = refDistance;
    this.panner.rolloffFactor = 1.15;
    this.panner.maxDistance = 500;
    if (directional) {
      this.panner.coneInnerAngle = 120;
      this.panner.coneOuterAngle = 260;
      this.panner.coneOuterGain = 0.6;
    }
    this.direct = context.createGain();
    this.input.connect(this.filter).connect(this.panner);
    this.panner.connect(this.direct).connect(dry);
    this.panner.connect(reflections);
  }

  update(source, listener, now, range = 160, snap = false, immediate = false) {
    const y = source.y + this.height;
    const distance = Math.hypot(source.x - listener.x, y - listener.y, source.z - listener.z);
    if (snap) {
      this.panner.positionX.cancelScheduledValues(now);
      this.panner.positionY.cancelScheduledValues(now);
      this.panner.positionZ.cancelScheduledValues(now);
      this.panner.positionX.setValueAtTime(source.x, now);
      this.panner.positionY.setValueAtTime(y, now);
      this.panner.positionZ.setValueAtTime(source.z, now);
    } else {
      smooth(this.panner.positionX, source.x, now);
      smooth(this.panner.positionY, y, now);
      smooth(this.panner.positionZ, source.z, now);
    }
    if (this.panner.coneOuterAngle < 360 && Number.isFinite(source.heading)) {
      smooth(this.panner.orientationX, Math.sin(source.heading), now);
      smooth(this.panner.orientationZ, Math.cos(source.heading), now);
    }
    if (snap || now >= this.nextObstruction) {
      this.obstruction = this.acoustics.obstruction(source, listener, this.height);
      this.nextObstruction = now + 0.28 + (Math.abs(source.seed || 0) % 1) * 0.12;
    }
    const fade = clamp((range - distance) / (range * 0.3), 0, 1);
    smooth(this.input.gain, (source.gain ?? 1) * fade * fade * (3 - 2 * fade), now, 0.035, immediate);
    smooth(this.direct.gain, 1 - this.obstruction * 0.78, now, 0.12, immediate);
    const airCutoff = 1800 + 14000 * Math.exp(-distance / 70);
    smooth(this.filter.frequency, airCutoff * Math.pow(0.065, this.obstruction), now, 0.12, immediate);
    return distance;
  }

  dispose() {
    this.input.disconnect();
    this.filter.disconnect();
    this.panner.disconnect();
    this.direct.disconnect();
  }
}

class CityAudioSystem {
  constructor(simulation, { onStateChange = () => {} } = {}) {
    this.sources = new CityAudioSources(simulation);
    this.controllers = simulation.controllerManager;
    this.acoustics = new CityAcoustics(simulation.controllerManager);
    this.onStateChange = onStateChange;
    this.context = null;
    this.ready = false;
    this.disposed = false;
    this.supported = !!(globalThis.AudioContext || globalThis.webkitAudioContext);
    this.enabled = true;
    try { this.enabled = localStorage.getItem('nyc-sound') !== 'off'; } catch { /* Private browsing. */ }
    const smallDevice = navigator.hardwareConcurrency <= 4 || matchMedia('(pointer: coarse)').matches;
    this.limits = smallDevice ? { motors: 6, sirens: 1, events: 5 } : { motors: 8, sirens: 2, events: 8 };
    this.motors = new Map();
    this.sirens = new Map();
    this.events = [];
    this.states = new WeakMap();
    this.conversations = new WeakMap();
    this.listener = { x: 0, y: 0, z: 0 };
    this.haveListener = false;
    this.accumulator = 0;
    this.lastHorn = -Infinity;
    this.collisionPairs = new WeakMap();
    this.collisionSequence = 0;
    this.collisionSystems = [simulation.controllerManager, simulation.trafficSystem, simulation.propBreaker].filter(Boolean);
    this.onCollision = (impact) => this.crash(impact);
    for (const system of this.collisionSystems) system.setCollisionListener?.(this.onCollision);
    this.motorParams = { speed: 0, load: 0, verticalSpeed: 0, doppler: 1, seed: 0, rpm: 0 };
    this.windParams = { speed: 0, altitude: 0, night: 0, traffic: 0, enclosure: 0 };
    this.rainParams = { rain: 0, enclosure: 0, inCar: false };
    this.footPosition = { x: 0, y: 0, z: 0, seed: 0 };
    this.onGesture = (event) => {
      if (event.type === 'keydown' && (event.repeat || event.metaKey || event.ctrlKey || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName))) return;
      if (this.enabled) this.unlock();
    };
    this.onVisibility = () => {
      this.reset();
      if (document.hidden) this.suspend();
      else if (this.enabled && this.context) this.unlock();
    };
    // Keep gesture handlers: iOS can interrupt a previously running context, and resuming may need another tap.
    document.addEventListener('pointerdown', this.onGesture, { passive: true });
    document.addEventListener('keydown', this.onGesture);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  unlock() {
    if (!this.supported || !this.enabled || this.disposed || document.hidden) return;
    try {
      if (!this.context) this.initialize();
      if (this.context.state !== 'running') {
        this.context.resume().then(() => {
          if (!this.enabled || document.hidden || this.disposed) return this.suspend();
          this.onStateChange();
        }).catch(() => {}); // A later user gesture can retry autoplay/interruption failures.
      }
    } catch (error) {
      console.warn('[audio] Unable to initialize sound', error);
      this.supported = false;
      this.context?.close().catch(() => {});
      this.onStateChange();
    }
  }

  initialize() {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    const context = this.context = new Context({ latencyHint: 'interactive' });
    const listener = context.listener;
    setControlRate(
      listener.positionX, listener.positionY, listener.positionZ,
      listener.forwardX, listener.forwardY, listener.forwardZ,
      listener.upX, listener.upY, listener.upZ
    );
    this.resources = createEventResources(context, createSynthResources(context));
    this.mix = context.createGain();
    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.22;
    this.master = context.createGain();
    this.master.gain.value = 0;
    this.mix.connect(this.compressor).connect(this.master).connect(context.destination);
    this.reflections = context.createGain();
    this.reflections.gain.value = 0.02;
    this.reverb = context.createConvolver();
    this.reverb.normalize = false;
    this.reverb.buffer = this.resources.impulse;
    this.reflectionFilter = context.createBiquadFilter();
    setControlRate(this.reflectionFilter.frequency, this.reflectionFilter.detune, this.reflectionFilter.Q, this.reflectionFilter.gain);
    this.reflectionFilter.type = 'lowpass';
    this.reflectionFilter.frequency.value = 2400;
    this.reflectionFilter.Q.value = 0.5;
    this.reflections.connect(this.reverb).connect(this.reflectionFilter).connect(this.mix);
    this.wind = createWindVoice(context, this.resources, this.mix);
    this.rainVoice = createRainVoice(context, this.resources, this.mix);
    context.onstatechange = () => this.onStateChange();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    try { localStorage.setItem('nyc-sound', this.enabled ? 'on' : 'off'); } catch { /* Storage is optional. */ }
    if (this.enabled) this.unlock();
    else {
      this.reset();
      this.suspend();
    }
    this.onStateChange();
  }

  suspend() {
    if (!this.context || this.context.state === 'closed') return;
    // Visibility/mute can change again while suspend is pending. Reconcile after it settles so a rapid unmute
    // cannot leave an enabled system suspended merely because resume saw the old 'running' state.
    return this.context.suspend().then(() => {
      if (this.enabled && !document.hidden && !this.disposed) this.unlock();
    }).catch(() => {});
  }

  reset() {
    for (const pool of [this.motors, this.sirens]) {
      for (const slot of pool.values()) { slot.voice.dispose(); slot.emitter.dispose(); }
      pool.clear();
    }
    for (const event of this.events) { event.voice.dispose(true); event.emitter.dispose(); }
    this.events.length = 0;
    this.conversations = new WeakMap();
    this.states = new WeakMap();
    this.collisionPairs = new WeakMap();
    this.haveListener = false;
    this.accumulator = 0;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.context.currentTime);
      this.master.gain.setValueAtTime(0, this.context.currentTime);
    }
  }

  state(source, now) {
    let state = this.states.get(source.id);
    if (!state) {
      const hash = Math.sin(source.seed * 127.1 + 311.7) * 43758.5453;
      const variation = hash - Math.floor(hash);
      state = { variation, phase: source.phase, grounded: source.grounded, x: source.x, z: source.z,
        signal: now + variation, horn: now + 8 + variation * 13, stopped: 0, stepSequence: 0 };
      this.states.set(source.id, state);
    }
    return state;
  }

  updateConversations(people, now) {
    // Only the nearby pair's first member schedules speech. Shared turn state prevents overlapping replies.
    for (const source of people) {
      const pair = source.conversation;
      if (!pair || pair.a !== source.id || pair.a.conversation !== pair || pair.b.conversation !== pair) continue;
      const partner = people.find(person => person.id === pair.b && person.conversation === pair);
      if (!partner || source.speed > 0.15 || partner.speed > 0.15) continue;
      let state = this.conversations.get(pair);
      if (!state) {
        state = { reply: false, sequence: 0, next: now + 0.3 };
        this.conversations.set(pair, state);
      }
      if (now < state.next) continue;
      const speaker = state.reply ? partner : source;
      if (this.emit('talk', speaker, { intensity: 0.3, seed: speaker.seed + state.sequence, voiceSeed: speaker.seed })) {
        const voice = this.events[this.events.length - 1].voice;
        const pause = 0.35 + (Math.sin(speaker.seed * 53 + state.sequence * 17.13) * 0.5 + 0.5) * 0.75;
        state.next = voice.endTime + pause;
        state.reply = !state.reply;
        state.sequence++;
      } else {
        state.next = now + 0.5;
      }
    }
  }

  updatePool(pool, candidates, limit, now, dt, siren = false) {
    for (const slot of pool.values()) slot.selected = false;
    let count = 0;
    for (const source of candidates) {
      if (siren && !source.police) continue;
      if (++count > limit) break;
      let slot = pool.get(source.id);
      if (!slot) {
        // Retiring voices count against the budget, so rapid source changes cannot temporarily double the graph.
        if (pool.size >= limit) continue;
        const emitter = new SpatialEmitter(this.context, this.mix, this.reflections, this.acoustics,
          siren ? 9 : source.kind === 'helicopter' ? 12 : 4, siren ? 0.9 : 0, siren);
        slot = { emitter, voice: createMotorVoice(this.context, this.resources, siren ? 'siren' : source.kind, emitter.input),
          distance: 0, x: source.x, y: source.y, z: source.z, fresh: true };
        pool.set(source.id, slot);
      }
      slot.selected = true;
      slot.retire = 0;
      const jumped = Math.hypot(source.x - slot.x, source.y - slot.y, source.z - slot.z) > 35;
      const range = source.range;
      const distance = slot.emitter.update(source, this.listener, now, range, slot.fresh || jumped);
      const radial = slot.fresh || jumped ? 0 : clamp((distance - slot.distance) / dt, -60, 60);
      const params = this.motorParams;
      params.speed = source.speed;
      params.load = source.load;
      params.verticalSpeed = source.verticalSpeed;
      params.rpm = source.rpm || 0;
      params.seed = source.seed;
      params.doppler = clamp(343 / (343 + radial), 0.85, 1.18);
      slot.voice.update(params, now);
      slot.distance = distance;
      slot.x = source.x; slot.y = source.y; slot.z = source.z;
      slot.fresh = false;
    }
    for (const [id, slot] of pool) {
      if (slot.selected) continue;
      if (!slot.retire) {
        smooth(slot.emitter.input.gain, 0, now, 0.025);
        slot.retire = now + 0.12;
      } else if (now >= slot.retire) {
        slot.voice.dispose(); slot.emitter.dispose(); pool.delete(id);
      }
    }
  }

  removeEvent(index) {
    const event = this.events[index];
    event.voice.dispose(true);
    event.emitter.dispose();
    this.events.splice(index, 1);
  }

  emit(kind, source, options = {}) {
    const now = this.context.currentTime;
    const crash = kind === 'crash';
    const loud = kind === 'gun' || kind === 'explosion'; // (gunfire & blasts take their voices like crashes do)
    const severity = clamp(options.severity ?? options.intensity ?? 1, 0, 1);
    const ref = crash ? 4 + severity * 8 : kind === 'explosion' ? 30 : kind === 'gun' ? 10 : kind === 'horn' ? 8 : kind === 'talk' ? 2 : 1.8;
    const range = crash ? 50 + severity * 110 : kind === 'explosion' ? 600 : kind === 'gun' ? 300 : kind === 'horn' ? 140
      : kind === 'talk' ? 30 : kind === 'footstep' ? 22 : 35;
    if (Math.hypot(source.x - this.listener.x, source.y - this.listener.y, source.z - this.listener.z) > range) return false;
    if (crash || loud) {
      // Impacts are immediate, between the 10 Hz ambience updates. Reclaim finished events first, then let
      // a strong impact displace a quieter crash or background event without increasing the voice budget.
      for (let i = this.events.length - 1; i >= 0; i--) {
        if (now >= this.events[i].voice.endTime) this.removeEvent(i);
      }
      let crashes = 0, weakest = -1;
      for (let i = 0; i < this.events.length; i++) {
        const event = this.events[i];
        if (event.kind !== kind) continue;
        crashes++;
        if (weakest < 0 || event.severity < this.events[weakest].severity) weakest = i;
      }
      if (crashes >= Math.min(3, this.limits.events)) {
        if (severity <= this.events[weakest].severity) return false;
        this.removeEvent(weakest);
      }
      if (this.events.length >= this.limits.events) {
        const background = this.events.findIndex(event => event.kind !== 'crash' && event.kind !== 'horn' && event.kind !== 'explosion');
        if (background < 0) return false;
        this.removeEvent(background);
      }
    }
    if (this.events.length >= this.limits.events) return false;
    const emitter = new SpatialEmitter(this.context, this.mix, this.reflections, this.acoustics,
      ref, kind === 'talk' ? 1.5 : 0, kind === 'horn');
    // Do not fade away the first few milliseconds of a crash: its spatial gain and filtering are ready at onset.
    emitter.update(source, this.listener, now, range, true, crash || loud);
    const voice = playEvent(this.context, this.resources, kind, emitter.input, { seed: source.seed, ...options });
    this.events.push({ kind, voice, emitter, id: source.id, range, severity, position: { ...source }, follow: kind === 'talk' || kind === 'horn' });
    return true;
  }

  crash(impact) {
    if (!this.ready || !this.enabled || !this.haveListener || this.context?.state !== 'running' || document.hidden) return false;
    const { a, b, x, y, z, speed } = impact;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || a === b
      || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(speed) || speed < 0.8) return false;
    if (Math.hypot(x - this.listener.x, y - this.listener.y, z - this.listener.z) > 160) return false;
    const now = this.context.currentTime;
    let contacts = this.collisionPairs.get(a);
    if (!contacts) this.collisionPairs.set(a, contacts = new WeakMap());
    let contact = contacts.get(b);
    if (!contact) {
      contact = { last: -Infinity, played: -Infinity, speed: 0 };
      contacts.set(b, contact);
      let reverse = this.collisionPairs.get(b);
      if (!reverse) this.collisionPairs.set(b, reverse = new WeakMap());
      reverse.set(a, contact);
    }
    const separated = now - contact.last > 0.3;
    contact.last = now;
    // Both pair orders share the gate. Sustained rubbing stays quiet, but a substantially stronger second hit
    // or a new impact after separation can sound again; muting/reset discards this history rather than queuing it.
    if (now - contact.played < 0.18 || (!separated && speed <= Math.max(4, contact.speed * 1.8))) return false;
    const light = a.type === 'cyclist' || b.type === 'cyclist';
    const severity = clamp((speed - 0.8) / 22, 0, 1) * (light ? 0.65 : 1);
    const intensity = (0.12 + 0.88 * Math.sqrt(severity)) * (light ? 0.7 : 1);
    // The physics record is reused. emit() copies this position so the crash remains at the contact point.
    if (!this.emit('crash', { id: a, x, y, z, seed: ++this.collisionSequence }, { severity, intensity })) return false;
    contact.played = now;
    contact.speed = speed;
    return true;
  }

  // A shot, a punch, a blast or a pickup at (x, y, z) (crime.js): 'pistol' | 'smg' | 'bazooka' | 'punch' |
  // 'explosion' | 'pickup'
  gunfire(kind, x, y, z) {
    if (!this.ready || !this.enabled || !this.haveListener || this.context?.state !== 'running' || document.hidden) return false;
    const source = this.gunSource ??= { id: null, x: 0, y: 0, z: 0, seed: 0 };
    source.id = this.gunSource; source.x = x; source.y = y; source.z = z; source.seed = ++this.collisionSequence;
    if (kind === 'explosion') return this.emit('explosion', source, { severity: 1, intensity: 1 });
    if (kind === 'pickup') return this.emit('pickup', source, { intensity: 1 });
    return this.emit('gun', source, { weapon: kind, severity: kind === 'bazooka' ? 1 : kind === 'smg' ? 0.5 : 0.7, intensity: 1 });
  }

  honk(entity) {
    if (!this.ready || !this.enabled || this.context?.state !== 'running' || entity?.type !== 'car') return;
    const now = this.context.currentTime;
    if (now - this.lastHorn < 0.8) return;
    if (this.emit('horn', { id: entity, ...entity.position, heading: entity.heading, seed: 4 }, { intensity: 0.7 })) this.lastHorn = now;
  }

  update(dt, elapsed, camera, night = false) {
    if (!this.ready || !this.enabled || this.context?.state !== 'running' || document.hidden) return;
    this.accumulator += dt;
    if (this.accumulator < 0.1) return;
    dt = Math.min(this.accumulator, 0.25);
    this.accumulator %= 0.1;
    const now = this.context.currentTime;
    const position = camera.position;
    if (this.haveListener && Math.hypot(position.x - this.listener.x, position.y - this.listener.y, position.z - this.listener.z) > 60) this.reset();
    this.listener.x = position.x; this.listener.y = position.y; this.listener.z = position.z;
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const listener = this.context.listener;
    if (listener.positionX) {
      const values = [position.x, position.y, position.z, -m[8], -m[9], -m[10], m[4], m[5], m[6]];
      const params = [listener.positionX, listener.positionY, listener.positionZ, listener.forwardX, listener.forwardY,
        listener.forwardZ, listener.upX, listener.upY, listener.upZ];
      for (let i = 0; i < params.length; i++) {
        if (this.haveListener) smooth(params[i], values[i], now, 0.025);
        else params[i].setValueAtTime(values[i], now);
      }
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
    }
    this.haveListener = true;
    this.acoustics.update(this.listener, now);
    const enclosure = this.acoustics.enclosure;
    smooth(this.reflections.gain, 0.02 + enclosure * 0.22, now, 0.4);
    smooth(this.reflectionFilter.frequency, 2400 + enclosure * 3400, now, 0.4);
    smooth(this.master.gain, 0.65, now, 0.12);
    const sources = this.sources.collect(this.listener, elapsed);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (now >= event.voice.endTime) {
        this.removeEvent(i);
      } else {
        const pair = event.position.conversation;
        if (pair && (pair.a.conversation !== pair || pair.b.conversation !== pair)) {
          event.voice.dispose();
          event.follow = false; // Fade at the old position if the meeting ended or a pedestrian was recycled.
        }
        const source = event.follow && (sources.motors.find(s => s.id === event.id) || sources.people.find(s => s.id === event.id));
        if (source) Object.assign(event.position, source);
        event.emitter.update(event.position, this.listener, now, event.range);
      }
    }
    this.updatePool(this.motors, sources.motors, this.limits.motors, now, dt);
    this.updatePool(this.sirens, sources.sirens, this.limits.sirens, now, dt, true);
    for (const source of sources.people) {
      const state = this.state(source, now);
      const moved = Math.hypot(source.x - state.x, source.z - state.z);
      if (source.grounded && moved < 3 && Number.isFinite(state.phase)) {
        for (let foot = 0; foot < 2; foot++) {
          // The rig plants each foot when its phase wraps, including different stride lengths and running gaits.
          const offset = foot * 0.5;
          const planted = (source.phase + offset) % 1 < (state.phase + offset) % 1;
          if ((planted && source.speed > 0.2) || (!state.grounded && foot === 0)) {
            const position = this.footPosition;
            position.x = foot ? source.rightX : source.leftX;
            position.y = foot ? source.rightY : source.leftY;
            position.z = foot ? source.rightZ : source.leftZ;
            position.seed = source.seed;
            this.emit('footstep', position, { intensity: source.speed > 3 ? 0.65 : 0.4,
              seed: source.seed + state.stepSequence++, speed: source.speed });
          }
        }
      }
      state.phase = source.phase; state.grounded = source.grounded;
      state.x = source.x; state.z = source.z;
    }
    this.updateConversations(sources.people, now);
    for (const source of sources.signals) {
      const state = this.state(source, now);
      if (state.walk !== source.walk) {
        if (state.walk !== undefined) {
          for (let i = this.events.length - 1; i >= 0; i--) {
            const event = this.events[i];
            if (event.kind !== 'signal' || event.id !== source.id) continue;
            this.removeEvent(i);
          }
        }
        state.walk = source.walk;
        state.signal = now;
      }
      if (now + 0.12 >= state.signal) {
        const when = Math.max(now, state.signal);
        this.emit('signal', source, { walk: source.walk, intensity: 0.28, when });
        state.signal = when + (source.walk ? 0.5 : 1);
      }
    }
    for (const source of sources.motors) {
      if (source.player || source.kind === 'helicopter' || source.kind === 'cyclist') continue;
      const state = this.state(source, now);
      state.stopped = source.blocked ? state.stopped + dt : 0;
      if (state.stopped > 4 && now > state.horn && now - this.lastHorn > 3) {
        if (this.emit('horn', source, { intensity: 0.55 })) {
          state.horn = now + 18 + state.variation * 15;
          this.lastHorn = now;
        }
      }
    }
    // (the altitude over the town's floor: its slopes put the streets well over y = 0)
    const altitude = position.y - (this.controllers ? this.controllers.floorHeight(position.x, position.z) : 0);
    Object.assign(this.windParams, { speed: Math.min(sources.motion, 50), altitude, traffic: sources.traffic, night: night ? 1 : 0, enclosure });
    this.wind.update(this.windParams, now);
    const mode = this.controllers?.activeMode;
    Object.assign(this.rainParams, { enclosure, inCar: mode === 'car' || mode === 'helicopter' });
    this.rainVoice.update(this.rainParams, now);
  }

  // How hard it rains (rainIntensity, 0..1), for the rain's hiss
  setRain(intensity) {
    this.rainParams.rain = intensity;
  }

  // A thunderclap `delay` s from now (the sound of a strike `delay` × 343 m away), louder for a near one
  thunder(delay = 0, near = 0.5) {
    if (!this.ready || !this.enabled || this.context?.state !== 'running') return;
    playEvent(this.context, this.resources, 'thunder', this.mix, { when: this.context.currentTime + delay, intensity: 0.35 + 0.65 * near, seed: Math.floor(Math.random() * 1e6) });
  }

  dispose() {
    this.disposed = true;
    for (const system of this.collisionSystems) system.setCollisionListener?.(null);
    document.removeEventListener('pointerdown', this.onGesture);
    document.removeEventListener('keydown', this.onGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.reset();
    this.wind?.dispose(true);
    this.rainVoice?.dispose();
    for (const node of [this.mix, this.compressor, this.master, this.reflections, this.reverb, this.reflectionFilter]) node?.disconnect();
    if (this.context) {
      this.context.onstatechange = null;
      this.context.close().catch(() => {});
    }
  }
}

export { CityAudioSystem };
