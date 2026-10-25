// js/player/vehicle-damage.js
// Crash damage to the player's car: what each impact does to the body's four sides and to the engine up front, the
// power and steering it leaves the car (drivetrain.js), and the dents pressed into the body's mesh. Plain numbers
// and typed arrays, no three.js, so node --test runs it (tests/vehicle-damage.test.mjs).
//
// An impact is the sudden change in the car's velocity a crash causes (m/s): a few m/s is a scrape, ~15 m/s
// (a 55 km/h hit on a wall) crushes that side in, and a couple of those leave the engine dead.

const MIN_IMPACT = 3.5; // m/s of sudden velocity change below which nothing bends (kerbs, a person, a light shove)
const FULL_IMPACT = 15; // m/s for a full-severity hit
const MAX_DENTS = 14;
const MAX_CRUSH = 0.42; // m any point of the body can be pushed in, all dents together

function createDamage() {
  return { front: 0, rear: 0, left: 0, right: 0, engine: 0, pull: 0, dents: [], camber: [0, 0, 0, 0], version: 0 };
}

/**
 * An impact `dv` m/s hard from local direction (dirX, dirZ) (the car's frame: +z ahead, +x to its left, pointing from
 * the car's centre to where it was hit) on a body halfW × halfL m. Returns the hit's severity 0..1 (0: nothing bent).
 */
function applyImpact(dmg, dirX, dirZ, dv, halfW = 0.86, halfL = 2.18) {
  if (!(dv > MIN_IMPACT)) return 0;
  const len = Math.hypot(dirX, dirZ);
  if (!len) return 0;
  dirX /= len; dirZ /= len;
  const severity = Math.min(1, (dv - MIN_IMPACT) / (FULL_IMPACT - MIN_IMPACT));
  // where the direction leaves the body's box: an end or a side
  const t = Math.min(Math.abs(dirX) > 1e-6 ? halfW / Math.abs(dirX) : Infinity, Math.abs(dirZ) > 1e-6 ? halfL / Math.abs(dirZ) : Infinity);
  const x = dirX * t, z = dirZ * t;
  const end = Math.abs(z) >= halfL - 1e-6;
  const zone = end ? (z > 0 ? 'front' : 'rear') : (x > 0 ? 'left' : 'right');
  dmg[zone] = Math.min(1, dmg[zone] + severity * 0.55);
  // The engine sits up front: a nose hit wrecks it fastest, anything else shakes it
  dmg.engine = Math.min(1, dmg.engine + severity * (zone === 'front' ? 0.42 : zone === 'rear' ? 0.08 : 0.12));
  // A hit on a front corner bends the steering: the car pulls to that side (rad of steering)
  if (z > halfL * 0.35) dmg.pull = Math.max(-0.06, Math.min(0.06, dmg.pull + Math.sign(x) * severity * 0.025));
  // ...and knocks that wheel out of true (camber, rad): front-left, front-right, rear-left, rear-right
  if (severity > 0.35 && Math.abs(z) > halfL * 0.35) {
    const wheel = (z > 0 ? 0 : 2) + (x > 0 ? 0 : 1);
    dmg.camber[wheel] = Math.max(-0.16, Math.min(0.16, dmg.camber[wheel] + (x > 0 ? 1 : -1) * severity * 0.07));
  }
  addDent(dmg, x, z, -dirX, -dirZ, severity);
  dmg.version++;
  return severity;
}

// A dent at the body's surface point (x, z) (at bumper / door height), pressed in along (inX, inZ)
function addDent(dmg, x, z, inX, inZ, severity) {
  const dent = { x, y: 0.62, z, nx: inX, nz: inZ, depth: 0.05 + severity * 0.26, radius: 0.5 + severity * 0.55 };
  // A hit near an old dent deepens it; once the list is full, the new one merges into the nearest
  let nearest = null, best = Infinity;
  for (const d of dmg.dents) {
    const dist = Math.hypot(d.x - x, d.z - z);
    if (dist < best) { best = dist; nearest = d; }
  }
  if (nearest && (best < nearest.radius * 0.45 || dmg.dents.length >= MAX_DENTS)) {
    nearest.depth = Math.min(MAX_CRUSH, nearest.depth + dent.depth * 0.7);
    nearest.radius = Math.max(nearest.radius, dent.radius);
    return;
  }
  dmg.dents.push(dent);
}

// What the engine still delivers (0 dead .. 1 healthy): it loses power as it is damaged and stops at the end
function enginePower(dmg) {
  return !dmg ? 1 : dmg.engine >= 1 ? 0 : 1 - 0.55 * dmg.engine;
}

// The body's overall condition 0 (wrecked) .. 1 (like new), for the HUD
function condition(dmg) {
  if (!dmg) return 1;
  return Math.max(0, 1 - (dmg.engine * 0.5 + (dmg.front + dmg.rear + dmg.left + dmg.right) * 0.125));
}

/**
 * Presses the dents into a body mesh: `base` positions & normals (xyz per vertex, the undamaged car) into `pos` &
 * `nrm`. Each vertex moves by a function of where it started only, so vertices shared along seams stay together.
 * Crushed metal wrinkles: the push ripples and the normals are roughened where it bent.
 */
function deformBody(basePos, baseNrm, pos, nrm, dents) {
  const n = basePos.length;
  for (let i = 0; i < n; i += 3) {
    const x = basePos[i], y = basePos[i + 1], z = basePos[i + 2];
    let dx = 0, dy = 0, dz = 0, bend = 0;
    for (let k = 0; k < dents.length; k++) {
      const d = dents[k];
      const ex = (x - d.x) / d.radius, ey = (y - d.y) / (d.radius * 1.1), ez = (z - d.z) / d.radius;
      const q = ex * ex + ey * ey + ez * ez;
      if (q >= 1) continue;
      const w = (1 - q) * (1 - q);
      const ripple = 0.72 + 0.28 * Math.sin(x * 17.0 + y * 23.0) * Math.sin(z * 19.0 - y * 11.0);
      const push = d.depth * w * ripple;
      dx += d.nx * push;
      dz += d.nz * push;
      dy -= push * 0.18; // a crushed panel sags too
      bend += w * d.depth;
    }
    const m = Math.hypot(dx, dy, dz);
    if (m > MAX_CRUSH) {
      const k = MAX_CRUSH / m;
      dx *= k; dy *= k; dz *= k;
    }
    pos[i] = x + dx; pos[i + 1] = y + dy; pos[i + 2] = z + dz;
    const nx = baseNrm[i], ny = baseNrm[i + 1], nz = baseNrm[i + 2];
    if (bend > 0) {
      const r = Math.min(0.9, bend * 5.5);
      const ax = nx + r * Math.sin(y * 31.0 + z * 7.0), ay = ny + r * Math.sin(x * 29.0 + z * 13.0), az = nz + r * Math.sin(x * 11.0 + y * 37.0);
      const l = Math.hypot(ax, ay, az) || 1;
      nrm[i] = ax / l; nrm[i + 1] = ay / l; nrm[i + 2] = az / l;
    } else {
      nrm[i] = nx; nrm[i + 1] = ny; nrm[i + 2] = nz;
    }
  }
}

export { MIN_IMPACT, FULL_IMPACT, createDamage, applyImpact, enginePower, condition, deformBody };
