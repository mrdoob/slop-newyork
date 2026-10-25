// js/player/stats.js
// What the player's body adds to the crime system's health & money (sim/crime.js), GTA-style: stamina, which sprinting
// on foot or on a bicycle runs down; the health lost in the player's own crashes and when traffic drives into them on
// foot; the cash in the wallet of someone the player knocks over; the hospital a wasted player wakes up at. No three.js
// here, so node --test imports it directly (tests/stats.test.mjs).

const MAX_STAMINA = 100;
// per s of sprinting: ~9 s flat out on foot, ~14 s standing on the pedals
const STAMINA_DRAIN = { person: 11, cyclist: 7 };
const STAMINA_DELAY = 0.8; // s after a sprint before the breath comes back
const STAMINA_RECOVER = 18; // per s: empty to full in ~6 s
const WINDED_UNTIL = 35; // once the stamina runs out, no sprinting until it is back to this

const CRASH_GRACE = 0.35; // s after a crash in which another hurts nothing (one crash reports several contacts)
const PERSON_MASS = 75; // kg (traffic.js MASS.person)

/**
 * Health lost on foot to a vehicle of `mass` kg driving into the player at `speed` m/s (its velocity along the
 * contact, so running into a stopped car hurts nothing): harmless at a nudge, a car at 30 km/h takes ~40, at 50 km/h
 * ~75, at 65 km/h it kills. The blow is shared by the masses: a bicycle hurts about half as much as a car.
 */
function struckDamage(speed, mass) {
  if (!(speed > 2.5)) return 0;
  const share = mass / (mass + PERSON_MASS);
  return (speed - 2.5) * 7 * share;
}

/**
 * How hard what the player ran into is, for crash damage: walls, the ground and vehicles 1 (a bus more), bicycles,
 * motorcycles and street furniture much less, people nothing (a car hardly feels a pedestrian). `kind` is the
 * collision event's ('building', 'ground', 'vehicle'), `other` its body b.
 */
function hardness(kind, other) {
  if (kind === 'building' || kind === 'ground') return 1;
  if (!other || typeof other !== 'object') return 0;
  if (other.bus) return 1.4;
  if (other.bike || other.moto || other.bodyType === 'bike' || other.bodyType === 'moto') return 0.25;
  if (other.bodyType) return 1;
  if (other.rig) return 0; // a pedestrian
  return 0.35; // a lamp post, a hydrant
}

/**
 * Health lost in a crash at `speed` m/s (the approach speed) of the player in `mode` against something of `hard`ness
 * (hardness above), before the crime system takes its share off for being inside a vehicle (crime.js hurt: 0.55): a
 * car's cage shrugs off anything under ~40 km/h; a cyclist is hurt from ~16 km/h, a motorcyclist from ~25 km/h; a
 * helicopter dropped onto the ground hurts from 5 m/s down.
 */
function crashDamage(mode, speed, hard, kind = '') {
  if (!(hard > 0) || !(speed > 0)) return 0;
  if (mode === 'car') return Math.max(0, speed - 11) * 4 * hard;
  if (mode === 'cyclist') return Math.max(0, speed - 4.5) * 9 * hard;
  if (mode === 'moto') return Math.max(0, speed - 7) * 7 * hard;
  if (mode === 'helicopter') return Math.max(0, speed - 5) * (kind === 'ground' ? 16 : 5) * hard;
  return 0;
}

/** The cash in a knocked-over person's wallet: $5 to $120 in fives, mostly small (`rand` gives 0..1) */
function walletAmount(rand = Math.random) {
  const r = rand();
  return 5 + Math.round((r * r * 115) / 5) * 5;
}

/** The nearest of `places` ({ x, z }) to (x, z), or null */
function nearest(places, x, z) {
  let best = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

class Stamina {
  constructor() {
    this.value = MAX_STAMINA;
    this.winded = false; // out of breath: no sprinting until WINDED_UNTIL
    this.sinceSprint = Infinity;
  }

  /** May the player sprint now (shift on foot or on a bicycle)? */
  get canSprint() {
    return !this.winded;
  }

  /** Advances by dt; `sprinting` is the mode ('person' | 'cyclist') the player is sprinting in, or null */
  update(dt, sprinting = null) {
    const drain = sprinting && this.canSprint ? STAMINA_DRAIN[sprinting] || 0 : 0;
    if (drain > 0) {
      this.value = Math.max(0, this.value - drain * dt);
      this.sinceSprint = 0;
      if (this.value <= 0) this.winded = true;
    } else {
      this.sinceSprint += dt;
      if (this.sinceSprint >= STAMINA_DELAY) this.value = Math.min(MAX_STAMINA, this.value + STAMINA_RECOVER * dt);
    }
    if (this.winded && this.value >= WINDED_UNTIL) this.winded = false;
  }

  /** Back to full (waking up at the hospital) */
  reset() {
    this.value = MAX_STAMINA;
    this.winded = false;
    this.sinceSprint = Infinity;
  }
}

export { Stamina, struckDamage, hardness, crashDamage, walletAmount, nearest, MAX_STAMINA, WINDED_UNTIL, CRASH_GRACE };
