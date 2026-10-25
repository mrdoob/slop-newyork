// js/sim/weapons.js
// The player's arsenal, GTA-style (fists, pistol, SMG, bazooka), and the ballistics the police and the gangs share:
// fire rates, lock-on auto-aim, hit-scan rays against round bodies and boxes, blast fall-off, how often a shooter
// hits. No three.js, so node --test imports it directly (tests/weapons.test.mjs).

// rate: shots per second. damage: hit points off a 100-point body. range & blast: metres. rocket: m/s.
// spread: radians either side of the aim. start: rounds carried at the start, pickup: rounds a dropped gun gives.
const WEAPONS = {
  fists: { id: 'fists', label: 'Fists', melee: true, auto: false, rate: 2.6, damage: 20, range: 1.7, spread: 0, start: Infinity, pickup: 0 },
  pistol: { id: 'pistol', label: 'Pistol', auto: false, rate: 4.5, damage: 34, range: 70, spread: 0.018, start: 68, pickup: 34 },
  smg: { id: 'smg', label: 'SMG', auto: true, rate: 11, damage: 16, range: 55, spread: 0.05, start: 240, pickup: 90 },
  // (the cartel's: none to start with, taken off them)
  rifle: { id: 'rifle', label: 'Rifle', auto: true, rate: 8, damage: 28, range: 85, spread: 0.028, start: 0, pickup: 60 },
  bazooka: { id: 'bazooka', label: 'Bazooka', auto: false, rate: 0.9, damage: 220, range: 170, spread: 0.004, rocket: 48, blast: 8, start: 8, pickup: 4 }
};
const WEAPON_ORDER = ['fists', 'pistol', 'smg', 'rifle', 'bazooka'];
const CLICK_BUFFER = 0.15; // s: a pull of a semi-automatic trigger just before it is ready again still fires

const wrapAngle = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

class Arsenal {
  constructor(ammo = null) {
    this.ammo = {};
    for (const id of WEAPON_ORDER) this.ammo[id] = ammo && Number.isFinite(ammo[id]) ? ammo[id] : WEAPONS[id].start;
    this.current = 'pistol';
    this.cooldown = 0;
    this.held = false;
    this.queued = 0; // time left on a buffered pull
  }

  get weapon() {
    return WEAPONS[this.current];
  }

  has(id) {
    return Boolean(WEAPONS[id]) && this.ammo[id] > 0;
  }

  select(id) {
    if (!this.has(id)) return false;
    if (id !== this.current) {
      this.current = id;
      this.cooldown = Math.max(this.cooldown, 0.25); // drawing it
      this.queued = 0;
    }
    return true;
  }

  // The next (dir 1) or previous (-1) weapon with rounds left; fists always have
  cycle(dir = 1) {
    const n = WEAPON_ORDER.length;
    let i = WEAPON_ORDER.indexOf(this.current);
    for (let k = 0; k < n; k++) {
      i = (i + (dir < 0 ? n - 1 : 1)) % n;
      if (this.select(WEAPON_ORDER[i])) return WEAPON_ORDER[i];
    }
    return this.current;
  }

  add(id, rounds) {
    if (!WEAPONS[id] || !(rounds > 0)) return;
    this.ammo[id] += rounds;
  }

  // Shots fired this step (0 or 1) with the trigger `held`: automatic weapons fire while it is held, the others once
  // per pull. Out of rounds, it falls back to the next weapon that has some.
  trigger(held, dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const w = this.weapon;
    if (held && !this.held) this.queued = CLICK_BUFFER;
    else this.queued = Math.max(0, this.queued - dt);
    this.held = held;
    const wants = w.auto ? held : this.queued > 0;
    if (!wants || this.cooldown > 0) return 0;
    if (!(this.ammo[w.id] > 0)) {
      this.cycle(1);
      return 0;
    }
    this.queued = 0;
    this.cooldown = 1 / w.rate;
    if (this.ammo[w.id] !== Infinity) this.ammo[w.id]--;
    if (this.ammo[w.id] <= 0) this.ammo[w.id] = 0;
    return 1;
  }
}

/**
 * Lock-on: of `candidates` (objects with x, z), the one the shooter at (ox, oz) facing `heading` (0 faces +z) would
 * aim at within `range` metres and `cone` radians either side: the one nearest the line of fire, nearer ones first.
 * `accept(c)` (optional) filters them. Returns the candidate or null.
 */
function pickTarget(ox, oz, heading, candidates, range, cone, accept = null) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c || (accept && !accept(c))) continue;
    const dx = c.x - ox;
    const dz = c.z - oz;
    const d = Math.hypot(dx, dz);
    if (d > range || d < 0.2) continue;
    const off = Math.abs(wrapAngle(Math.atan2(dx, dz) - heading));
    if (off > cone) continue;
    const score = off / cone + (d / range) * 0.6;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// Distance along the ray (ox, oz) + t·(dx, dz) (unit direction) to the circle of radius r at (cx, cz), or -1
function rayCircle(ox, oz, dx, dz, cx, cz, r) {
  const fx = cx - ox;
  const fz = cz - oz;
  const along = fx * dx + fz * dz;
  const across2 = fx * fx + fz * fz - along * along;
  if (across2 > r * r) return -1;
  const half = Math.sqrt(r * r - across2);
  const t = along - half;
  if (t >= 0) return t;
  return along + half >= 0 ? 0 : -1; // starting inside it
}

// Distance along the ray to a box centred at (cx, cz), turned `yaw` (its length along (sin yaw, cos yaw)), of half
// width hw and half length hl, or -1 (slab test in the box's frame)
function rayBox(ox, oz, dx, dz, cx, cz, yaw, hw, hl) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const rx = ox - cx;
  const rz = oz - cz;
  // local axes: along (s, c), across (c, -s)
  const pa = rx * s + rz * c;
  const pc = rx * c - rz * s;
  const da = dx * s + dz * c;
  const dc = dx * c - dz * s;
  let t0 = 0;
  let t1 = Infinity;
  for (const [p, d, h] of [[pa, da, hl], [pc, dc, hw]]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > h) return -1;
      continue;
    }
    let a = (-h - p) / d;
    let b = (h - p) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  return t0;
}

// Overlap of two boxes on the ground (x, z, heading, hw, hl): the push that moves b out of a, as a unit normal (nx, nz)
// from a towards b and a depth, or null (separating axis test)
function boxOverlap(a, b) {
  const axes = [
    [Math.sin(a.heading), Math.cos(a.heading)], [Math.cos(a.heading), -Math.sin(a.heading)],
    [Math.sin(b.heading), Math.cos(b.heading)], [Math.cos(b.heading), -Math.sin(b.heading)]
  ];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let best = Infinity;
  let nx = 0;
  let nz = 0;
  for (const [ax, az] of axes) {
    const ra = Math.abs(ax * Math.sin(a.heading) + az * Math.cos(a.heading)) * a.hl
      + Math.abs(ax * Math.cos(a.heading) - az * Math.sin(a.heading)) * a.hw;
    const rb = Math.abs(ax * Math.sin(b.heading) + az * Math.cos(b.heading)) * b.hl
      + Math.abs(ax * Math.cos(b.heading) - az * Math.sin(b.heading)) * b.hw;
    const d = dx * ax + dz * az;
    const pen = ra + rb - Math.abs(d);
    if (pen <= 0) return null;
    if (pen < best) {
      best = pen;
      nx = d >= 0 ? ax : -ax;
      nz = d >= 0 ? az : -az;
    }
  }
  return { nx, nz, pen: best };
}

// Share of a blast's force felt at distance d from its centre (1 at the centre, 0 at the edge of its radius)
function blastFalloff(d, radius) {
  const k = clamp01(1 - d / radius);
  return k * Math.sqrt(k);
}

// How likely an aimed shot from `distance` metres hits a target moving at `speed` m/s, for a shooter of `skill` (0..1)
// with a weapon reaching `range` metres: certain up close, half as likely at half range, a fast car is hard to hit
function hitChance(distance, speed, skill, range) {
  return clamp01(skill * (1 - (distance / range) ** 2) / (1 + Math.max(0, speed) * 0.07));
}

export { WEAPONS, WEAPON_ORDER, Arsenal, pickTarget, rayCircle, rayBox, boxOverlap, blastFalloff, hitChance, wrapAngle };
