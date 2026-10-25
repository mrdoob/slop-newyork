// js/player/stats.js
// The player's health, stamina and money, GTA-style: hits from traffic and hard crashes cost health, which comes back
// by itself (quickly up to half, slowly beyond); sprinting on foot or on a bicycle runs the stamina down; the people the
// player knocks over drop their wallets (sim/pickups.js). At no health the player is "wasted" and wakes up at the
// nearest hospital, which keeps part of the money. No three.js here, so node --test imports it directly
// (tests/stats.test.mjs). Money is in Mexican pesos.

const MAX_HEALTH = 100;
const REGEN_DELAY = 5; // s unhurt before health starts coming back
const REGEN_FAST = 3; // per s up to REGEN_CAP (GTA V refills half the bar by itself)
const REGEN_CAP = 50;
const REGEN_SLOW = 0.5; // per s above it: about 100 s from half to full
const HURT_GRACE = 0.35; // s after a hit in which another does nothing (one crash reports several contacts)

const MAX_STAMINA = 100;
// per s of sprinting: ~9 s flat out on foot, ~14 s standing on the pedals
const STAMINA_DRAIN = { person: 11, cyclist: 7 };
const STAMINA_DELAY = 0.8; // s after a sprint before the breath comes back
const STAMINA_RECOVER = 18; // per s: empty to full in ~6 s
const WINDED_UNTIL = 35; // once the stamina runs out, no sprinting until it is back to this

const START_MONEY = 500;
const HOSPITAL_BILL = 1000; // the most the hospital keeps (it takes what there is, GTA III's $100 in today's pesos)
const WASTED_TIME = 4; // s on the "wasted" screen before waking up at the hospital

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
 * (hardness above): a car's cage shrugs off anything under ~40 km/h; a cyclist is hurt from ~16 km/h; a helicopter
 * dropped onto the ground hurts from 5 m/s down.
 */
function crashDamage(mode, speed, hard, kind = '') {
  if (!(hard > 0) || !(speed > 0)) return 0;
  if (mode === 'car') return Math.max(0, speed - 11) * 2.2 * hard;
  if (mode === 'cyclist') return Math.max(0, speed - 4.5) * 5 * hard;
  if (mode === 'helicopter') return Math.max(0, speed - 5) * (kind === 'ground' ? 9 : 3) * hard;
  return 0;
}

/** The cash in a knocked-over person's wallet: $20 to $500 in tens, mostly small (`rand` gives 0..1) */
function walletAmount(rand = Math.random) {
  const r = rand();
  return 20 + Math.round((r * r * 480) / 10) * 10;
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

class PlayerStats {
  constructor({ money = START_MONEY } = {}) {
    this.health = MAX_HEALTH;
    this.stamina = MAX_STAMINA;
    this.money = Number.isFinite(money) ? Math.max(0, Math.round(money)) : START_MONEY;
    this.winded = false; // out of breath: no sprinting until WINDED_UNTIL
    this.sinceHurt = Infinity; // s since the last hit
    this.sinceSprint = Infinity;
    this.wasted = 0; // s left on the wasted screen, 0 alive
    this.lastBill = 0;
  }

  get alive() {
    return this.wasted <= 0 && this.health > 0;
  }

  /** May the player sprint now (shift on foot or on a bicycle)? */
  get canSprint() {
    return this.alive && !this.winded;
  }

  /** Takes `amount` health; returns the health actually lost. At none the player is wasted. */
  hurt(amount) {
    if (!this.alive || !(amount > 0) || this.sinceHurt < HURT_GRACE) return 0;
    const lost = Math.min(this.health, amount);
    this.health -= lost;
    this.sinceHurt = 0;
    if (this.health <= 0) {
      this.health = 0;
      this.wasted = WASTED_TIME;
    }
    return lost;
  }

  earn(amount) {
    if (amount > 0) this.money += Math.round(amount);
  }

  /**
   * Advances by dt; `sprinting` is the mode ('person' | 'cyclist') the player is sprinting in, or null. Returns
   * 'respawn' once the wasted screen is over (the caller takes the player to the hospital and calls respawn()).
   */
  update(dt, sprinting = null) {
    if (this.wasted > 0) {
      this.wasted -= dt;
      return this.wasted <= 0 ? 'respawn' : null;
    }
    this.sinceHurt += dt;
    if (this.sinceHurt >= REGEN_DELAY && this.health < MAX_HEALTH) {
      const rate = this.health < REGEN_CAP ? REGEN_FAST : REGEN_SLOW;
      this.health = Math.min(MAX_HEALTH, this.health + rate * dt);
    }
    const drain = sprinting && this.canSprint ? STAMINA_DRAIN[sprinting] || 0 : 0;
    if (drain > 0) {
      this.stamina = Math.max(0, this.stamina - drain * dt);
      this.sinceSprint = 0;
      if (this.stamina <= 0) this.winded = true;
    } else {
      this.sinceSprint += dt;
      if (this.sinceSprint >= STAMINA_DELAY) this.stamina = Math.min(MAX_STAMINA, this.stamina + STAMINA_RECOVER * dt);
    }
    if (this.winded && this.stamina >= WINDED_UNTIL) this.winded = false;
    return null;
  }

  /** Back on its feet at the hospital: full health and breath, less the bill (returned) */
  respawn() {
    const bill = Math.min(this.money, HOSPITAL_BILL);
    this.money -= bill;
    this.lastBill = bill;
    this.health = MAX_HEALTH;
    this.stamina = MAX_STAMINA;
    this.winded = false;
    this.wasted = 0;
    this.sinceHurt = Infinity;
    return bill;
  }
}

export {
  PlayerStats, struckDamage, hardness, crashDamage, walletAmount, nearest,
  MAX_HEALTH, MAX_STAMINA, REGEN_CAP, START_MONEY, HOSPITAL_BILL, WASTED_TIME, WINDED_UNTIL
};
