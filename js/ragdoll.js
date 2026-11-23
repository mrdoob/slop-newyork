// Ragdolls for people knocked down by vehicles. The body is the 17 joints a PersonRig poses (RAGDOLL_POINTS), held
// together by its rigid segments and by joint limits, stepped with position-based dynamics in small substeps. It lands
// on the ground (stepping off curbs, stopped by them), slides to a stop, bounces off buildings & street furniture and
// off the vehicles around it, whose bodies are height fields of their meshes (vehicleShape), and pushes back on the
// vehicle that hit it (and on any that drive over it).

const RAGDOLL_POINTS = {
  HIP_L: 0, HIP_R: 1, SPINE: 2, NECK: 3, HEAD: 4, SHOULDER_L: 5, SHOULDER_R: 6, ELBOW_L: 7, ELBOW_R: 8,
  WRIST_L: 9, WRIST_R: 10, KNEE_L: 11, KNEE_R: 12, ANKLE_L: 13, ANKLE_R: 14, TOE_L: 15, TOE_R: 16
};
const COUNT = 17;
// kg (for a 75 kg person) and m (for a 1.75 m one)
const MASS = [11, 11, 14, 3, 5, 4, 4, 2, 2, 1, 1, 5, 5, 2.5, 2.5, 0.6, 0.6];
const RADIUS = [0.1, 0.1, 0.12, 0.06, 0.1, 0.065, 0.065, 0.045, 0.045, 0.04, 0.04, 0.055, 0.055, 0.045, 0.045, 0.03, 0.03];
const P = RAGDOLL_POINTS;
// Segments that keep their length: the pelvis and chest as rigid frames, the head, arms, legs and feet
const RIGID = [
  [P.HIP_L, P.HIP_R], [P.HIP_L, P.SPINE], [P.HIP_R, P.SPINE],
  [P.SPINE, P.NECK], [P.SPINE, P.SHOULDER_L], [P.SPINE, P.SHOULDER_R], [P.NECK, P.SHOULDER_L], [P.NECK, P.SHOULDER_R],
  [P.SHOULDER_L, P.SHOULDER_R], [P.NECK, P.HEAD],
  [P.SHOULDER_L, P.ELBOW_L], [P.ELBOW_L, P.WRIST_L], [P.SHOULDER_R, P.ELBOW_R], [P.ELBOW_R, P.WRIST_R],
  [P.HIP_L, P.KNEE_L], [P.KNEE_L, P.ANKLE_L], [P.HIP_R, P.KNEE_R], [P.KNEE_R, P.ANKLE_R],
  [P.ANKLE_L, P.TOE_L], [P.ANKLE_R, P.TOE_R]
];
// Distances kept within [min, max] of their standing length: the spine's bend & twist, how far elbows and knees fold,
// the ankles' range, the head's tilt, and legs kept from passing through each other
const RANGE = [
  [P.HIP_L, P.SHOULDER_L, 0.8, 1.06], [P.HIP_R, P.SHOULDER_R, 0.8, 1.06],
  [P.HIP_L, P.SHOULDER_R, 0.84, 1.06], [P.HIP_R, P.SHOULDER_L, 0.84, 1.06],
  [P.SHOULDER_L, P.WRIST_L, 0.3, 1], [P.SHOULDER_R, P.WRIST_R, 0.3, 1],
  [P.HIP_L, P.ANKLE_L, 0.42, 1], [P.HIP_R, P.ANKLE_R, 0.42, 1],
  [P.KNEE_L, P.TOE_L, 0.86, 1.1], [P.KNEE_R, P.TOE_R, 0.86, 1.1],
  [P.SPINE, P.HEAD, 0.86, 1.02], [P.SHOULDER_L, P.HEAD, 0.78, 1.15], [P.SHOULDER_R, P.HEAD, 0.78, 1.15],
  [P.KNEE_L, P.KNEE_R, 0.6, 4], [P.ANKLE_L, P.ANKLE_R, 0.5, 6]
];
const GRAVITY = 9.81;
const SUBSTEP = 1 / 120;
const ITERATIONS = 4;
const GROUND_FRICTION = 0.7;
const VEHICLE_FRICTION = 0.45;
const RESTITUTION = 0.15;
const LIMIT_STIFFNESS = 0.5; // share of a joint limit's overshoot taken back each iteration
const JOINT_DAMPING = 2.5; // 1/s: the joints' friction (motion against the body's own)
const GROUND_DAMPING = 9; // ...and lying on the ground
const MAX_FLAIL = 14; // m/s
const SLEEP_SPEED = 0.12; // m/s: below this for SLEEP_TIME, a ragdoll stops simulating (until something hits it)
const SLEEP_TIME = 0.6;
const SETTLE_DISTANCE = 0.05; // ...as it does once its pelvis and head have moved less than this in SETTLE_TIME
const SETTLE_TIME = 0.8;
// m: how far a body's points can be from its pelvis during a frame (its reach, plus a frame's motion and pushes)
const NEAR_MARGIN = 4;
// Muscles (Ragdoll.muscles): even limp, a body's joints don't swing freely between hard stops. Each is pulled gently
// towards the neutral body posture, the relaxed pose a body floats in without gravity (NASA's, loosely: hips bent
// ~52 degrees and spread a little, knees ~47, feet relaxed ~20 down, back and neck tipped forward, upper arms ~36
// forward and ~24 out, elbows ~80), too gently to lift a limb against its own weight; and within SOFT_ZONE of a joint's
// limit its ligaments and tendons stretch, stiffening and soaking up its motion instead of stopping it dead
const TONE = 14; // 1/s^2 per radian off the relaxed pose (gravity pulls a hanging forearm back at ~70)
const TONE_DAMPING = 3; // 1/s: the muscles' resistance to the joints' motion
const SOFT_ZONE = 0.3; // rad
const SOFT_STIFFNESS = 1600; // 1/s^2 at a limit, from 0 where its zone starts
const SOFT_DAMPING = 45; // 1/s at a limit, from 0 where its zone starts
const MAX_MUSCLE_TURN = 0.2; // rad a substep
// Each joint's relaxed [flex, abduction] and the [min, max] it can't pass of each (solveLimits'; NONE where it has no
// limit), in the joint's frame (see Ragdoll.joints)
const NONE = [-Infinity, Infinity];
const JOINT = {
  spine: [0.12, 0, [-0.35, 1.15], [-0.45, 0.45]],
  neck: [0.4, 0, NONE, NONE],
  shoulder: [0.63, 0.42, NONE, NONE],
  elbow: [1.4, 0, NONE, NONE],
  hip: [0.9, 0.12, [-0.35, 2.0], [-0.25, 0.85]],
  knee: [-0.82, 0, [-2.27, 0], [-0.36, 0.36]],
  ankle: [0.78, 0, [-0.18, 1.47], [-0.3, 0.3]]
};

// Rotate point i about centre c so that unit direction a turns towards unit direction b (by share k of the angle;
// Rodrigues)
function rotatePoint(x, i, c, ax, ay, az, bx, by, bz, k = LIMIT_STIFFNESS) {
  bx = ax + (bx - ax) * k; by = ay + (by - ay) * k; bz = az + (bz - az) * k;
  const bl = Math.sqrt(bx * bx + by * by + bz * bz);
  if (bl < 1e-9) return;
  bx /= bl; by /= bl; bz /= bl;
  let kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx;
  const sin = Math.sqrt(kx * kx + ky * ky + kz * kz);
  if (sin < 1e-7) return;
  kx /= sin; ky /= sin; kz /= sin;
  const cos = ax * bx + ay * by + az * bz;
  const o = i * 3, oc = c * 3;
  const vx = x[o] - x[oc], vy = x[o + 1] - x[oc + 1], vz = x[o + 2] - x[oc + 2];
  const dot = (kx * vx + ky * vy + kz * vz) * (1 - cos);
  x[o] = x[oc] + vx * cos + (ky * vz - kz * vy) * sin + kx * dot;
  x[o + 1] = x[oc + 1] + vy * cos + (kz * vx - kx * vz) * sin + ky * dot;
  x[o + 2] = x[oc + 2] + vz * cos + (kx * vy - ky * vx) * sin + kz * dot;
}

// Turn a limb (points `group`) about its joint (point c) from direction a towards b (by `share` of the angle,
// rotatePoint), keeping their momentum: the limb and the joint then shift back together by what the turn moved them,
// mass-weighted
const _before = new Float64Array(COUNT * 3);
function rotateGroup(x, w, group, c, ax, ay, az, bx, by, bz, share = LIMIT_STIFFNESS) {
  let px = 0, py = 0, pz = 0, mass = 1 / w[c];
  for (let k = 0; k < group.length; k++) {
    const o = group[k] * 3;
    _before[o] = x[o]; _before[o + 1] = x[o + 1]; _before[o + 2] = x[o + 2];
    rotatePoint(x, group[k], c, ax, ay, az, bx, by, bz, share);
    const m = 1 / w[group[k]];
    px += (x[o] - _before[o]) * m; py += (x[o + 1] - _before[o + 1]) * m; pz += (x[o + 2] - _before[o + 2]) * m;
    mass += m;
  }
  px /= mass; py /= mass; pz /= mass;
  for (let k = 0; k <= group.length; k++) {
    const o = (k < group.length ? group[k] : c) * 3;
    x[o] -= px; x[o + 1] -= py; x[o + 2] -= pz;
  }
}
const UPPER = [P.NECK, P.HEAD, P.SHOULDER_L, P.SHOULDER_R, P.ELBOW_L, P.ELBOW_R, P.WRIST_L, P.WRIST_R];
const LEG = [[P.KNEE_L, P.ANKLE_L, P.TOE_L], [P.KNEE_R, P.ANKLE_R, P.TOE_R]];
const SHIN = [[P.ANKLE_L, P.TOE_L], [P.ANKLE_R, P.TOE_R]];
const TOE = [[P.TOE_L], [P.TOE_R]];

// An orthonormal frame (x, y, z axes in a Float64Array of 9) from a primary y axis and a hint for x
function frameYX(out, yx, yy, yz, hx, hy, hz) {
  let l = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1;
  yx /= l; yy /= l; yz /= l;
  const d = hx * yx + hy * yy + hz * yz;
  hx -= yx * d; hy -= yy * d; hz -= yz * d;
  l = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (l < 1e-8) {
    // any axis across y
    if (Math.abs(yx) < 0.9) { hx = 1 - yx * yx; hy = -yx * yy; hz = -yx * yz; } else { hx = -yy * yx; hy = 1 - yy * yy; hz = -yy * yz; }
    l = Math.sqrt(hx * hx + hy * hy + hz * hz);
  }
  hx /= l; hy /= l; hz /= l;
  out[0] = hx; out[1] = hy; out[2] = hz;
  out[3] = yx; out[4] = yy; out[5] = yz;
  out[6] = hy * yz - hz * yy; out[7] = hz * yx - hx * yz; out[8] = hx * yy - hy * yx;
  return out;
}

// Direction d (unit) clamped to a cone around frame f's -y (flex about x towards +z, abduction towards `side` x),
// written to out; returns true if it moved
function clampLimb(f, dx, dy, dz, side, flexMin, flexMax, abdMin, abdMax, out) {
  const lx = (dx * f[0] + dy * f[1] + dz * f[2]) * side;
  const ly = dx * f[3] + dy * f[4] + dz * f[5];
  const lz = dx * f[6] + dy * f[7] + dz * f[8];
  const flex = Math.atan2(lz, -ly);
  const abd = Math.asin(Math.max(-1, Math.min(1, lx)));
  const cf = Math.max(flexMin, Math.min(flexMax, flex));
  const ca = Math.max(abdMin, Math.min(abdMax, abd));
  if (cf === flex && ca === abd) return false;
  const nx = Math.sin(ca) * side, ny = -Math.cos(ca) * Math.cos(cf), nz = Math.cos(ca) * Math.sin(cf);
  out[0] = nx * f[0] + ny * f[3] + nz * f[6];
  out[1] = nx * f[1] + ny * f[4] + nz * f[7];
  out[2] = nx * f[2] + ny * f[5] + nz * f[8];
  return true;
}

// Direction d (unit) as clampLimb's angles in frame f, [flex, abduction] (out)
function limbAngles(f, dx, dy, dz, side, out) {
  const lx = (dx * f[0] + dy * f[1] + dz * f[2]) * side;
  const ly = dx * f[3] + dy * f[4] + dz * f[5];
  const lz = dx * f[6] + dy * f[7] + dz * f[8];
  out[0] = Math.atan2(lz, -ly);
  out[1] = Math.asin(Math.max(-1, Math.min(1, lx)));
  return out;
}

// ...and back: the direction at those angles in frame f
function limbDirection(f, side, flex, abd, out) {
  const nx = Math.sin(abd) * side, ny = -Math.cos(abd) * Math.cos(flex), nz = Math.cos(abd) * Math.sin(flex);
  out[0] = nx * f[0] + ny * f[3] + nz * f[6];
  out[1] = nx * f[1] + ny * f[4] + nz * f[7];
  out[2] = nx * f[2] + ny * f[5] + nz * f[8];
  return out;
}

const wrapAngle = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

// The muscles' change to a joint angle a this substep of h seconds, as it moved by `rate` since the last: the tone's
// pull towards its relaxed angle, against its motion, and within SOFT_ZONE of a limit (lo or hi) a spring stiffening up
// to it and damping that soaks up the motion into it
function muscle(a, rate, relaxed, lo, hi, h) {
  let d = (wrapAngle(relaxed - a) * TONE * h - rate * TONE_DAMPING) * h;
  const zone = Math.min(SOFT_ZONE, (hi - lo) / 3);
  const over = a - (hi - zone);
  if (over > 0) {
    const t = Math.min(1, over / zone);
    d -= over * t * SOFT_STIFFNESS * h * h + Math.max(0, rate) * Math.min(1, t * SOFT_DAMPING * h);
  }
  const under = lo + zone - a;
  if (under > 0) {
    const t = Math.min(1, under / zone);
    d += under * t * SOFT_STIFFNESS * h * h - Math.min(0, rate) * Math.min(1, t * SOFT_DAMPING * h);
  }
  return Math.max(-MAX_MUSCLE_TURN, Math.min(MAX_MUSCLE_TURN, d));
}

// The pelvis' frame in positions pos: x to the left, y up the spine, z forward
function pelvisFrame(out, pos) {
  const L = P.HIP_L * 3, R = P.HIP_R * 3, S = P.SPINE * 3;
  return frameYX(out, pos[S] - (pos[L] + pos[R]) * 0.5, pos[S + 1] - (pos[L + 1] + pos[R + 1]) * 0.5,
    pos[S + 2] - (pos[L + 2] + pos[R + 2]) * 0.5, pos[L] - pos[R], pos[L + 1] - pos[R + 1], pos[L + 2] - pos[R + 2]);
}

// A frame's x & z kept and y flipped: a cone around its +y for clampLimb & limbAngles (the spine's, the neck's)
function flipY(out, f) {
  out[0] = f[0]; out[1] = f[1]; out[2] = f[2];
  out[3] = -f[3]; out[4] = -f[4]; out[5] = -f[5];
  out[6] = f[6]; out[7] = f[7]; out[8] = f[8];
  return out;
}

const HEAD_ONLY = [P.HEAD];
const ARM = [[P.ELBOW_L, P.WRIST_L], [P.ELBOW_R, P.WRIST_R]];
const FOREARM = [[P.WRIST_L], [P.WRIST_R]];
const _f = new Float64Array(9);
const _g = new Float64Array(9);
const _n = new Float64Array(3);
const _local = { x: 0, y: 0, z: 0 };
const _pelvis = new Float64Array(9);
const _chest = new Float64Array(9);
const _limb = new Float64Array(9);
const _ang = new Float64Array(2);

class Ragdoll {
  constructor() {
    this.x = new Float64Array(COUNT * 3); // positions
    this.v = new Float64Array(COUNT * 3); // velocities
    this.p = new Float64Array(COUNT * 3); // positions at the start of the substep
    this.w = new Float64Array(COUNT); // inverse masses
    this.r = new Float64Array(COUNT); // radii
    this.rest = new Float64Array(RIGID.length);
    this.lo = new Float64Array(RANGE.length);
    this.hi = new Float64Array(RANGE.length);
    this.ground = new Float64Array(COUNT); // ground height under each point at the start of the substep
    // contacts this substep: 0 none, 1 ground, 2 vehicle, 3 wall; the normal and the surface's velocity
    this.contact = new Uint8Array(COUNT);
    this.touched = new Uint8Array(COUNT); // ...and last substep
    this.cn = new Float64Array(COUNT * 3);
    this.cv = new Float64Array(COUNT * 3);
    this.cm = new Array(COUNT).fill(null); // the vehicle touched
    this.mass = 75;
    this.asleep = false;
    this.still = 0; // seconds it has barely moved
    this.time = 0;
    this.impact = 0; // the hardest hit it took (m/s)
    this.speed = 0; // its fastest point's speed (m/s)
    this.walls = [];
    this.near = []; // the movers close enough to touch it this frame
    this.settle = new Float64Array(6); // pelvis & head where it last checked if it had settled
    this.settleTime = 0;
    this.gravity = GRAVITY;
    this.angles = new Float64Array(2 * 12); // each joint's [flex, abduction] last substep (see joints)
    this.anglesValid = false;
  }

  /**
   * Start from world positions `points` (COUNT x 3) of a body whose standing joints are `bind` (same layout, for its
   * segment lengths), all moving at (vx, vy, vz); `scale` is the person's height / 1.75 m
   */
  start(points, bind, scale, vx = 0, vy = 0, vz = 0) {
    const mass = 75 * scale * scale * scale;
    let total = 0;
    for (let i = 0; i < COUNT; i++) total += MASS[i];
    for (let i = 0; i < COUNT; i++) {
      this.w[i] = total / (MASS[i] * mass);
      this.r[i] = RADIUS[i] * scale;
      for (let k = 0; k < 3; k++) this.x[i * 3 + k] = points[i * 3 + k];
      this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    }
    const dist = (a, b, x) => Math.hypot(x[a * 3] - x[b * 3], x[a * 3 + 1] - x[b * 3 + 1], x[a * 3 + 2] - x[b * 3 + 2]);
    RIGID.forEach(([a, b], k) => { this.rest[k] = dist(a, b, bind); });
    RANGE.forEach(([a, b, lo, hi], k) => { const d = dist(a, b, bind); this.lo[k] = d * lo; this.hi[k] = d * hi; });
    this.mass = mass;
    this.asleep = false;
    this.still = 0;
    this.settleTime = 0;
    this.time = 0;
    this.impact = 0;
    this.anglesValid = false;
  }

  /**
   * Fling the limbs as a blow low on the body (a vehicle's bumper) throws it along (dx, dz) at `speed` m/s: the legs
   * are swept along with it, the arms flung back against it and up, each limb a little differently (random() in
   * [0, 1)). The body's momentum doesn't change
   */
  kick(dx, dz, speed, random = Math.random) {
    const l = Math.hypot(dx, dz);
    if (l < 1e-6 || !(speed > 0)) return;
    dx /= l; dz /= l;
    const v = this.v, w = this.w;
    let px = 0, py = 0, pz = 0, mass = 0;
    const add = (i, sx, sy, sz) => {
      const o = i * 3, m = 1 / w[i];
      v[o] += sx; v[o + 1] += sy; v[o + 2] += sz;
      px += sx * m; py += sy * m; pz += sz * m;
    };
    for (let side = 0; side < 2; side++) {
      const arm = speed * 0.35 * (0.5 + random() * 0.8), leg = speed * 0.3 * (0.6 + random() * 0.6);
      add(side ? P.ELBOW_R : P.ELBOW_L, -dx * arm * 0.5, arm * 0.4, -dz * arm * 0.5);
      add(side ? P.WRIST_R : P.WRIST_L, -dx * arm, arm * 0.8, -dz * arm);
      add(side ? P.KNEE_R : P.KNEE_L, dx * leg * 0.5, 0, dz * leg * 0.5);
      add(side ? P.ANKLE_R : P.ANKLE_L, dx * leg, leg * 0.2, dz * leg);
      add(side ? P.TOE_R : P.TOE_L, dx * leg, leg * 0.2, dz * leg);
    }
    // ...and the momentum that took back from the whole body, so that it only turns the limbs
    for (let i = 0; i < COUNT; i++) mass += 1 / w[i];
    px /= mass; py /= mass; pz /= mass;
    for (let i = 0; i < COUNT; i++) { v[i * 3] -= px; v[i * 3 + 1] -= py; v[i * 3 + 2] -= pz; }
    this.wake();
  }

  get pelvisX() { return (this.x[0] + this.x[3]) * 0.5; }
  get pelvisY() { return (this.x[1] + this.x[4]) * 0.5; }
  get pelvisZ() { return (this.x[2] + this.x[5]) * 0.5; }

  // Lying face down? (the chest's front points at the ground)
  get prone() {
    const x = this.x, S = P.SPINE * 3, N = P.NECK * 3, L = P.SHOULDER_L * 3, R = P.SHOULDER_R * 3;
    frameYX(_f, x[N] - x[S], x[N + 1] - x[S + 1], x[N + 2] - x[S + 2], x[L] - x[R], x[L + 1] - x[R + 1], x[L + 2] - x[R + 2]);
    return _f[7] < 0;
  }

  wake() {
    if (this.asleep) this.anglesValid = false;
    this.asleep = false;
    this.still = 0;
  }

  /**
   * Advance dt seconds. world: { ground(x, z), colliders(x, z, r), contact(c, x, y, z, r, out) }; movers: vehicles
   * (see Mover) that collide with it
   */
  step(dt, world, movers) {
    this.time += dt;
    if (this.asleep) {
      // woken by a vehicle reaching it
      for (let m = 0; m < movers.length; m++) if (this.touches(movers[m])) { this.wake(); break; }
      if (this.asleep) return;
    }
    // static colliders and vehicles around it, gathered once a frame
    const cx = this.pelvisX, cz = this.pelvisZ;
    const near = world.colliders ? world.colliders(cx, cz, 2.5) : null;
    this.walls.length = 0;
    if (near) for (let i = 0; i < near.length; i++) this.walls.push(near[i]);
    this.near.length = 0;
    for (let m = 0; m < movers.length; m++) {
      const mv = movers[m];
      const dx = cx - mv.x, dz = cz - mv.z, d = Math.sqrt(mv.shape.reach * mv.shape.reach + 4) + NEAR_MARGIN;
      if (dx * dx + dz * dz <= d * d) this.near.push(mv);
    }
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    const h = dt / steps;
    let fastest = 0;
    for (let s = 0; s < steps; s++) fastest = this.substep(h, world, this.near, s / steps, (s + 1) / steps);
    this.speed = fastest;
    this.still = fastest < SLEEP_SPEED ? this.still + dt : 0;
    // settled: pelvis and head about where they were a moment ago (a limb may still be twitching)
    this.settleTime += dt;
    if (this.settleTime >= SETTLE_TIME) {
      const x = this.x, c = this.settle, H = P.HEAD * 3;
      const px = this.pelvisX, py = this.pelvisY, pz = this.pelvisZ;
      const moved = Math.max(Math.hypot(px - c[0], py - c[1], pz - c[2]), Math.hypot(x[H] - c[3], x[H + 1] - c[4], x[H + 2] - c[5]));
      c[0] = px; c[1] = py; c[2] = pz; c[3] = x[H]; c[4] = x[H + 1]; c[5] = x[H + 2];
      if (moved < SETTLE_DISTANCE && this.time > SETTLE_TIME * 2) this.still = SLEEP_TIME + 1;
      this.settleTime = 0;
    }
    if (this.still > SLEEP_TIME) {
      this.asleep = true;
      this.v.fill(0);
    }
  }

  // Is any of its points inside mover m, or under one of its wheels (as it is at the end of this frame)?
  touches(m) {
    const dx = this.pelvisX - m.x, dz = this.pelvisZ - m.z;
    if (dx * dx + dz * dz > (m.shape.reach + 1.2) ** 2) return false;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3, r = this.r[i];
      moverLocal(m, 1, this.x[o], this.x[o + 1], this.x[o + 2], _local);
      if (m.shape.inside(_local.x, _local.y, _local.z, r)) return true;
      if (_local.y < 0.35 && m.shape.underWheel(_local.x, _local.z, r) && m.vx * m.vx + m.vz * m.vz > 0.25) return true;
    }
    return false;
  }

  // Is a vehicle over it (its pelvis under one's body)? It doesn't get up there
  covered(movers) {
    for (let m = 0; m < movers.length; m++) {
      const mv = movers[m];
      moverLocal(mv, 1, this.pelvisX, this.pelvisY, this.pelvisZ, _local);
      const shape = mv.shape;
      if (Math.abs(_local.x) < shape.halfAt(_local.z) + 0.3 && _local.z < shape.frontAt(_local.x) + 0.3
        && _local.z > shape.rearAt(_local.x) - 0.3) return true;
    }
    return false;
  }

  substep(h, world, movers, a0, a1) {
    const x = this.x, v = this.v, p = this.p, w = this.w;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      v[o] *= 0.999; v[o + 2] *= 0.999;
      v[o + 1] -= this.gravity * h;
      p[o] = x[o]; p[o + 1] = x[o + 1]; p[o + 2] = x[o + 2];
      this.ground[i] = world.ground(p[o], p[o + 2]);
      x[o] += v[o] * h; x[o + 1] += v[o + 1] * h; x[o + 2] += v[o + 2] * h;
      this.touched[i] = this.contact[i];
      this.contact[i] = 0;
    }
    this.muscles(h);
    for (let it = 0; it < ITERATIONS; it++) {
      this.solveSegments();
      this.solveLimits();
      this.collide(world, movers, a0, a1, it === ITERATIONS - 1);
    }
    // velocities from the motion, then friction and bounce at the contacts
    let fastest = 0;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      const ox = v[o], oy = v[o + 1], oz = v[o + 2];
      v[o] = (x[o] - p[o]) / h; v[o + 1] = (x[o + 1] - p[o + 1]) / h; v[o + 2] = (x[o + 2] - p[o + 2]) / h;
      if (this.contact[i]) {
        const nx = this.cn[o], ny = this.cn[o + 1], nz = this.cn[o + 2];
        const sx = this.cv[o], sy = this.cv[o + 1], sz = this.cv[o + 2];
        // relative velocity before (approaching: < 0) and after the push out
        const before = (ox - sx) * nx + (oy - sy) * ny + (oz - sz) * nz;
        const rx = v[o] - sx, ry = v[o + 1] - sy, rz = v[o + 2] - sz;
        // leaving the surface no faster than it came (a push out of it is not a kick), bouncing a little off what it
        // hit hard (not off the ground it lies on)
        const vn = rx * nx + ry * ny + rz * nz;
        const tn = Math.min(vn, before < -1.5 ? -before * RESTITUTION : Math.max(0, before));
        const tx = rx - nx * vn, ty = ry - ny * vn, tz = rz - nz * vn;
        // Coulomb friction against the surface, bounded by the change in normal velocity it took
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const mu = this.contact[i] === 2 ? VEHICLE_FRICTION : GROUND_FRICTION;
        const keep = tl > 1e-6 ? Math.max(0, 1 - (mu * Math.max(0, tn - before)) / tl) : 0;
        v[o] = sx + nx * tn + tx * keep;
        v[o + 1] = sy + ny * tn + ty * keep;
        v[o + 2] = sz + nz * tn + tz * keep;
        const m = this.cm[i];
        if (m) {
          // the vehicle takes the opposite of the momentum it gave the point
          const mi = 1 / w[i];
          m.jx -= mi * (v[o] - ox); m.jy -= mi * (v[o + 1] - oy); m.jz -= mi * (v[o + 2] - oz);
        }
      }
    }
    // joint friction: each point's motion against the body's own fades (faster lying on the ground)
    let mvx = 0, mvy = 0, mvz = 0, mass = 0, grounded = 0;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3, m = 1 / w[i];
      mvx += v[o] * m; mvy += v[o + 1] * m; mvz += v[o + 2] * m; mass += m;
      if (this.contact[i] === 1) grounded++;
    }
    mvx /= mass; mvy /= mass; mvz /= mass;
    const keep = Math.max(0, 1 - (grounded >= 8 ? GROUND_DAMPING : JOINT_DAMPING) * h);
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3;
      let k = keep;
      // no limb flails faster than MAX_FLAIL against the body (unless a vehicle is carrying it)
      if (this.contact[i] !== 2) {
        const rel = Math.hypot(v[o] - mvx, v[o + 1] - mvy, v[o + 2] - mvz) * keep;
        if (rel > MAX_FLAIL) k *= MAX_FLAIL / rel;
      }
      v[o] = mvx + (v[o] - mvx) * k; v[o + 1] = mvy + (v[o + 1] - mvy) * k; v[o + 2] = mvz + (v[o + 2] - mvz) * k;
      const speed = v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2];
      if (speed > fastest) fastest = speed;
    }
    return Math.sqrt(fastest);
  }

  // The muscles (see TONE), once a substep: each joint's limb turned in turn, from the spine out, by muscle()'s change
  // to its angles (which moved since the last substep by the change in this.angles)
  muscles(h) {
    this.joints(this.x, this.angles, this.anglesValid ? h : 0);
    this.anglesValid = true;
  }

  // Every joint's angles in positions pos, into ang (replacing last substep's), and with h each joint's limb turned by
  // the muscles: the spine & neck, then each shoulder & elbow, then each hip, knee & ankle (not a foot on the ground)
  joints(pos, ang, h) {
    const S = P.SPINE * 3, N = P.NECK * 3, SL = P.SHOULDER_L * 3, SR = P.SHOULDER_R * 3;
    let j = 0;
    this.joint(pos, flipY(_g, pelvisFrame(_pelvis, pos)), 1, P.SPINE, P.NECK, UPPER, j++, ang, h, JOINT.spine);
    // chest frame (the pelvis' axes), flipped for the neck's
    frameYX(_chest, pos[N] - pos[S], pos[N + 1] - pos[S + 1], pos[N + 2] - pos[S + 2], pos[SL] - pos[SR], pos[SL + 1] - pos[SR + 1], pos[SL + 2] - pos[SR + 2]);
    this.joint(pos, flipY(_g, _chest), 1, P.NECK, P.HEAD, HEAD_ONLY, j++, ang, h, JOINT.neck);
    for (let side = 0; side < 2; side++) {
      const sign = side ? -1 : 1;
      const shoulder = side ? P.SHOULDER_R : P.SHOULDER_L, elbow = side ? P.ELBOW_R : P.ELBOW_L;
      this.joint(pos, _chest, sign, shoulder, elbow, ARM[side], j++, ang, h, JOINT.shoulder);
      // the elbow's frame: y up the upper arm, x the chest's
      const os = shoulder * 3, oe = elbow * 3;
      frameYX(_limb, pos[os] - pos[oe], pos[os + 1] - pos[oe + 1], pos[os + 2] - pos[oe + 2], _chest[0], _chest[1], _chest[2]);
      this.joint(pos, _limb, sign, elbow, side ? P.WRIST_R : P.WRIST_L, FOREARM[side], j++, ang, h, JOINT.elbow);
    }
    pelvisFrame(_pelvis, pos);
    for (let side = 0; side < 2; side++) {
      const sign = side ? -1 : 1;
      const hip = side ? P.HIP_R : P.HIP_L, knee = side ? P.KNEE_R : P.KNEE_L;
      const ankle = side ? P.ANKLE_R : P.ANKLE_L, toe = side ? P.TOE_R : P.TOE_L;
      this.joint(pos, _pelvis, sign, hip, knee, LEG[side], j++, ang, h, JOINT.hip);
      // the knee's frame: y up the thigh, x the pelvis'; the ankle's: y up the shin, x the knee's
      const oh = hip * 3, ok = knee * 3, oa = ankle * 3;
      frameYX(_limb, pos[oh] - pos[ok], pos[oh + 1] - pos[ok + 1], pos[oh + 2] - pos[ok + 2], _pelvis[0], _pelvis[1], _pelvis[2]);
      this.joint(pos, _limb, sign, knee, ankle, SHIN[side], j++, ang, h, JOINT.knee);
      frameYX(_limb, pos[ok] - pos[oa], pos[ok + 1] - pos[oa + 1], pos[ok + 2] - pos[oa + 2], _limb[0], _limb[1], _limb[2]);
      const footDown = this.touched[toe] === 1 || this.touched[ankle] === 1;
      this.joint(pos, _limb, sign, ankle, toe, TOE[side], j++, ang, footDown ? 0 : h, JOINT.ankle);
    }
  }

  // Joint j of joints(): limb a -> b's angles in frame f (`side`, as clampLimb's) into ang (whose last ones give their
  // rate), and with h the limb (points `group`) turned about a by the muscles' change to them, for the joint's `spec`
  // (see JOINT)
  joint(pos, f, side, a, b, group, j, ang, h, spec) {
    const oa = a * 3, ob = b * 3;
    let dx = pos[ob] - pos[oa], dy = pos[ob + 1] - pos[oa + 1], dz = pos[ob + 2] - pos[oa + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    limbAngles(f, dx, dy, dz, side, _ang);
    const flex = _ang[0], abd = _ang[1];
    const lastFlex = ang[j * 2], lastAbd = ang[j * 2 + 1];
    ang[j * 2] = flex; ang[j * 2 + 1] = abd;
    if (!h) return;
    const flexLimits = spec[2], abdLimits = spec[3];
    const toFlex = flex + muscle(flex, wrapAngle(flex - lastFlex), spec[0], flexLimits[0], flexLimits[1], h);
    const toAbd = abd + muscle(abd, abd - lastAbd, spec[1], abdLimits[0], abdLimits[1], h);
    limbDirection(f, side, toFlex, toAbd, _n);
    rotateGroup(pos, this.w, group, a, dx, dy, dz, _n[0], _n[1], _n[2], 1);
  }

  solveSegments() {
    const x = this.x, w = this.w;
    for (let k = 0; k < RIGID.length; k++) this.fit(RIGID[k][0], RIGID[k][1], this.rest[k], this.rest[k], x, w);
    for (let k = 0; k < RANGE.length; k++) this.fit(RANGE[k][0], RANGE[k][1], this.lo[k], this.hi[k], x, w);
  }

  fit(a, b, lo, hi, x, w) {
    const oa = a * 3, ob = b * 3;
    const dx = x[ob] - x[oa], dy = x[ob + 1] - x[oa + 1], dz = x[ob + 2] - x[oa + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-9) return;
    const target = d < lo ? lo : d > hi ? hi : d;
    if (target === d) return;
    const s = (d - target) / (d * (w[a] + w[b]));
    x[oa] += dx * s * w[a]; x[oa + 1] += dy * s * w[a]; x[oa + 2] += dz * s * w[a];
    x[ob] -= dx * s * w[b]; x[ob + 1] -= dy * s * w[b]; x[ob + 2] -= dz * s * w[b];
  }

  // Joint limits as rotations of the limb beyond them: the spine's bend, the hips' cones, the knees' hinges, the
  // neck's tilt and the ankles' range
  solveLimits() {
    const x = this.x;
    const HL = P.HIP_L * 3, HR = P.HIP_R * 3, S = P.SPINE * 3, N = P.NECK * 3, H = P.HEAD * 3;
    const SL = P.SHOULDER_L * 3, SR = P.SHOULDER_R * 3;
    const mx = (x[HL] + x[HR]) * 0.5, my = (x[HL + 1] + x[HR + 1]) * 0.5, mz = (x[HL + 2] + x[HR + 2]) * 0.5;
    // pelvis frame: x to the left, y up the spine, z forward
    frameYX(_f, x[S] - mx, x[S + 1] - my, x[S + 2] - mz, x[HL] - x[HR], x[HL + 1] - x[HR + 1], x[HL + 2] - x[HR + 2]);
    // spine: bend forward to ~65 degrees, back ~20, sideways ~25 (the chest turns about the spine point)
    {
      const dx = x[N] - x[S], dy = x[N + 1] - x[S + 1], dz = x[N + 2] - x[S + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      // as a cone around the pelvis' +y: reuse clampLimb on the flipped frame
      _g[0] = _f[0]; _g[1] = _f[1]; _g[2] = _f[2];
      _g[3] = -_f[3]; _g[4] = -_f[4]; _g[5] = -_f[5];
      _g[6] = _f[6]; _g[7] = _f[7]; _g[8] = _f[8];
      if (clampLimb(_g, dx / l, dy / l, dz / l, 1, -0.35, 1.15, -0.45, 0.45, _n)) {
        const ax = dx / l, ay = dy / l, az = dz / l;
        rotateGroup(x, this.w, UPPER, P.SPINE, ax, ay, az, _n[0], _n[1], _n[2]);
      }
    }
    // hips and knees
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1;
      const hip = side === 0 ? P.HIP_L : P.HIP_R;
      const knee = side === 0 ? P.KNEE_L : P.KNEE_R;
      const ankle = side === 0 ? P.ANKLE_L : P.ANKLE_R;
      const toe = side === 0 ? P.TOE_L : P.TOE_R;
      const oh = hip * 3, ok = knee * 3, oa = ankle * 3, ot = toe * 3;
      let dx = x[ok] - x[oh], dy = x[ok + 1] - x[oh + 1], dz = x[ok + 2] - x[oh + 2];
      let l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= l; dy /= l; dz /= l;
      // the thigh: forward to ~115 degrees, back ~20, out ~50, in ~15
      if (clampLimb(_f, dx, dy, dz, sign, -0.35, 2.0, -0.25, 0.85, _n)) {
        rotateGroup(x, this.w, LEG[side], hip, dx, dy, dz, _n[0], _n[1], _n[2]);
        dx = x[ok] - x[oh]; dy = x[ok + 1] - x[oh + 1]; dz = x[ok + 2] - x[oh + 2];
        l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= l; dy /= l; dz /= l;
      }
      // the knee bends backwards only, about the thigh's own crosswise axis (the pelvis' x, square to the thigh)
      frameYX(_g, -dx, -dy, -dz, _f[0], _f[1], _f[2]);
      let sx = x[oa] - x[ok], sy = x[oa + 1] - x[ok + 1], sz = x[oa + 2] - x[ok + 2];
      l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      sx /= l; sy /= l; sz /= l;
      const across = sx * _g[0] + sy * _g[1] + sz * _g[2];
      const along = sx * _g[3] + sy * _g[4] + sz * _g[5];
      const front = sx * _g[6] + sy * _g[7] + sz * _g[8];
      // (and only so far sideways: the thigh's own twist isn't known)
      if (Math.abs(across) > 0.35 || front > 0) {
        const nf = Math.min(front, 0), na = Math.max(-0.35, Math.min(0.35, across));
        let nx = _g[0] * na + _g[3] * along + _g[6] * nf;
        let ny = _g[1] * na + _g[4] * along + _g[7] * nf;
        let nz = _g[2] * na + _g[5] * along + _g[8] * nf;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl > 1e-6) {
          nx /= nl; ny /= nl; nz /= nl;
          rotateGroup(x, this.w, SHIN[side], knee, sx, sy, sz, nx, ny, nz);
          sx = x[oa] - x[ok]; sy = x[oa + 1] - x[ok + 1]; sz = x[oa + 2] - x[ok + 2];
          l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
          sx /= l; sy /= l; sz /= l;
        }
      }
      // the foot: from ~20 degrees up to ~75 down of its standing angle, in line with the shin's hinge
      frameYX(_g, -sx, -sy, -sz, _g[0], _g[1], _g[2]);
      let fx = x[ot] - x[oa], fy = x[ot + 1] - x[oa + 1], fz = x[ot + 2] - x[oa + 2];
      l = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      fx /= l; fy /= l; fz /= l;
      // as a limb hanging off the shin's back (-y is the foot's standing direction rotated up 66 degrees)
      const fa = fx * _g[0] + fy * _g[1] + fz * _g[2];
      const fu = fx * _g[3] + fy * _g[4] + fz * _g[5];
      const ff = fx * _g[6] + fy * _g[7] + fz * _g[8];
      const pitch = Math.atan2(-fu, ff); // 0.42 standing (toes a little down of square to the shin)
      const cp = Math.max(0.1, Math.min(1.75, pitch));
      const ca = Math.max(-0.3, Math.min(0.3, fa));
      // (not with the foot on the ground, which sets its angle then)
      const footDown = this.contact[toe] === 1 || this.contact[ankle] === 1 || this.touched[toe] === 1 || this.touched[ankle] === 1;
      if ((cp !== pitch || ca !== fa) && !footDown) {
        const c = Math.sqrt(1 - ca * ca);
        const nx = _g[0] * ca + (-_g[3] * Math.sin(cp) + _g[6] * Math.cos(cp)) * c;
        const ny = _g[1] * ca + (-_g[4] * Math.sin(cp) + _g[7] * Math.cos(cp)) * c;
        const nz = _g[2] * ca + (-_g[5] * Math.sin(cp) + _g[8] * Math.cos(cp)) * c;
        rotateGroup(x, this.w, TOE[side], ankle, fx, fy, fz, nx, ny, nz);
      }
    }
    // arms stay out of the torso (a capsule from the hips to the neck)
    const tr = 0.13 / 0.12 * this.r[P.SPINE];
    for (const i of [P.ELBOW_L, P.ELBOW_R, P.WRIST_L, P.WRIST_R]) {
      const o = i * 3;
      const ax = x[N] - mx, ay = x[N + 1] - my, az = x[N + 2] - mz;
      const t = Math.max(0, Math.min(1, ((x[o] - mx) * ax + (x[o + 1] - my) * ay + (x[o + 2] - mz) * az) / (ax * ax + ay * ay + az * az)));
      const qx = x[o] - mx - ax * t, qy = x[o + 1] - my - ay * t, qz = x[o + 2] - mz - az * t;
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      const r = tr + this.r[i];
      if (d < r && d > 1e-6) {
        const s = (r - d) / d;
        x[o] += qx * s; x[o + 1] += qy * s; x[o + 2] += qz * s;
      }
    }
  }

  collide(world, movers, a0, a1, last) {
    const x = this.x, p = this.p;
    for (let i = 0; i < COUNT; i++) {
      const o = i * 3, r = this.r[i];
      // vehicles: out through the face it came in by (as each was at the start and end of this substep)
      for (let m = 0; m < movers.length; m++) {
        const mv = movers[m];
        const dx = x[o] - mv.x, dz = x[o + 2] - mv.z;
        if (dx * dx + dz * dz > mv.shape.reach * mv.shape.reach + 4) continue;
        _wheel.hit = false;
        if (!pushOutOfMover(mv, a0, a1, p[o], p[o + 1], p[o + 2], x, o, r, _n)) {
          // rolled over by a tyre: dragged along a little (and the vehicle bumps over it)
          if (_wheel.hit && last && this.contact[i] !== 2) {
            mv.wheelHits++;
            this.contact[i] = 2;
            this.cn[o] = 0; this.cn[o + 1] = 1; this.cn[o + 2] = 0;
            moverVelocity(mv, x[o], x[o + 2], this.cv, o);
            this.cv[o] *= 0.3; this.cv[o + 2] *= 0.3;
            this.cm[i] = mv;
          }
        } else {
          this.contact[i] = 2;
          this.cn[o] = _n[0]; this.cn[o + 1] = _n[1]; this.cn[o + 2] = _n[2];
          moverVelocity(mv, x[o], x[o + 2], this.cv, o);
          this.cm[i] = mv;
          if (last) {
            // how hard it was hit: the vehicle's speed where it struck (against the body's own)
            const rel = Math.hypot(this.cv[o] - this.v[o], this.cv[o + 2] - this.v[o + 2]);
            if (rel > this.impact && Math.hypot(this.cv[o], this.cv[o + 2]) > 1) this.impact = Math.min(rel, Math.hypot(this.cv[o], this.cv[o + 2]));
          }
        }
      }
      // buildings & street furniture
      for (let k = 0; k < this.walls.length; k++) {
        if (world.contact(this.walls[k], x[o], x[o + 1], x[o + 2], r, _wall)) {
          x[o] += _wall.nx * _wall.depth;
          x[o + 2] += _wall.nz * _wall.depth;
          if (this.contact[i] !== 2) {
            this.contact[i] = 3;
            this.cn[o] = _wall.nx; this.cn[o + 1] = 0; this.cn[o + 2] = _wall.nz;
            this.cv[o] = this.cv[o + 1] = this.cv[o + 2] = 0;
            this.cm[i] = null;
          }
        }
      }
      // the ground; a curb it meets below its top stops it like a wall
      let g = world.ground(x[o], x[o + 2]);
      const g0 = this.ground[i]; // where it was at the start of the substep
      if (g > g0 + 0.05 && p[o + 1] - r < g - 0.02) {
        const ddx = x[o] - p[o], ddz = x[o + 2] - p[o + 2];
        const dl = Math.sqrt(ddx * ddx + ddz * ddz);
        x[o] = p[o]; x[o + 2] = p[o + 2];
        g = g0;
        if (dl > 1e-6 && this.contact[i] !== 2) {
          this.contact[i] = 3;
          this.cn[o] = -ddx / dl; this.cn[o + 1] = 0; this.cn[o + 2] = -ddz / dl;
          this.cv[o] = this.cv[o + 1] = this.cv[o + 2] = 0;
          this.cm[i] = null;
        }
      }
      if (x[o + 1] - r < g) {
        x[o + 1] = g + r;
        if (this.contact[i] !== 2) {
          this.contact[i] = 1;
          this.cn[o] = 0; this.cn[o + 1] = 1; this.cn[o + 2] = 0;
          this.cv[o] = this.cv[o + 1] = this.cv[o + 2] = 0;
          this.cm[i] = null;
        }
      }
    }
  }
}
const _wall = { nx: 0, nz: 0, depth: 0 };
const _wheel = { hit: false };

// =====================================================================================================================
// Vehicles
// =====================================================================================================================
/**
 * A vehicle as the ragdolls see it (traffic.js fills these in each frame): where it is now, its velocity & yaw rate
 * (it was at x - vx * dt, heading - yawRate * dt at the start of the frame), its chassis' heave/pitch/roll, its shape
 * (vehicleShape) and mass; jx, jy, jz gather the momentum the bodies it hits push back with, wheelHits how often its
 * wheels rolled over one; `knocks`: it knocks down the people it drives into.
 */
function createMover() {
  return {
    x: 0, z: 0, y: 0, heading: 0, vx: 0, vz: 0, yawRate: 0, pitch: 0, roll: 0, dt: 1 / 60,
    shape: null, mass: 1600, jx: 0, jy: 0, jz: 0, ref: null, wheelHits: 0, knocks: true
  };
}

// Point (px, py, pz) in mover m's frame as it was at fraction a of this frame (x across to its left, y up, z forward)
function moverLocal(m, a, px, py, pz, out) {
  const back = (1 - a) * m.dt;
  const heading = m.heading - m.yawRate * back;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const dx = px - (m.x - m.vx * back), dz = pz - (m.z - m.vz * back), dy = py - m.y;
  let lx = dx * cos - dz * sin, lz = dx * sin + dz * cos, ly = dy;
  // undo the chassis' pitch (about x) and roll (about z)
  if (m.pitch) {
    const c = Math.cos(m.pitch), s = Math.sin(m.pitch);
    const y2 = ly * c + lz * s, z2 = -ly * s + lz * c;
    ly = y2; lz = z2;
  }
  if (m.roll) {
    const c = Math.cos(m.roll), s = Math.sin(m.roll);
    const x2 = lx * c + ly * s, y2 = -lx * s + ly * c;
    lx = x2; ly = y2;
  }
  out.x = lx; out.y = ly; out.z = lz;
  return out;
}

// Local direction to world (yaw only: the chassis' tilt is small)
function moverWorld(m, lx, ly, lz, out) {
  const sin = Math.sin(m.heading), cos = Math.cos(m.heading);
  out[0] = lx * cos + lz * sin;
  out[1] = ly;
  out[2] = -lx * sin + lz * cos;
}

function moverVelocity(m, px, pz, out, o) {
  out[o] = m.vx + m.yawRate * (pz - m.z);
  out[o + 1] = 0;
  out[o + 2] = m.vz - m.yawRate * (px - m.x);
}

const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };
// Push the point at x[o..] (radius r, at (px, py, pz) a substep ago) out of mover m; the contact normal goes to n
function pushOutOfMover(m, a0, a1, px, py, pz, x, o, r, n) {
  const shape = m.shape;
  const now = moverLocal(m, a1, x[o], x[o + 1], x[o + 2], _a);
  if (!shape.inside(now.x, now.y, now.z, r)) {
    // under a wheel: it rides over whatever lies there
    _wheel.hit = now.y < 0.35 && shape.underWheel(now.x, now.z, r);
    return false;
  }
  const was = moverLocal(m, a0, px, py, pz, _b);
  let lx = now.x, ly = now.y, lz = now.z;
  const half = shape.halfAt(lz) + r, front = shape.frontAt(lx) + r, rear = shape.rearAt(lx) - r;
  const top = shape.topAt(lx, lz) + r;
  // where it came in: over the top, or through a side, the front or the rear (else the nearest way out)
  let face;
  if (was.y >= shape.topAt(was.x, was.z) + r - 0.03) face = 0;
  else if (was.z > shape.frontAt(was.x) + r - 0.02) face = 1;
  else if (was.z < shape.rearAt(was.x) - r + 0.02) face = 2;
  else if (Math.abs(was.x) > shape.halfAt(was.z) + r - 0.02) face = was.x > 0 ? 3 : 4;
  else {
    // already inside: out the nearest side, end or (if it's just under it) the top
    const depths = [top - ly, front - lz, lz - rear, half - lx, lx + half];
    face = 1;
    for (let k = 2; k < 5; k++) if (depths[k] < depths[face]) face = k;
    if (depths[0] < Math.min(0.15, depths[face])) face = 0;
  }
  let nx = 0, ny = 0, nz = 0;
  if (face === 0 && top > shape.topAt(was.x, was.z) + r + 0.12) {
    // into a step up in the top (the roof sign's side, the windshield's foot): stopped by it, as by a wall
    const ddx = lx - was.x, ddz = lz - was.z, dl = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
    lx = was.x; lz = was.z;
    ly = Math.max(ly, shape.topAt(lx, lz) + r);
    nx = -ddx / dl; nz = -ddz / dl;
  } else if (face === 0) {
    ly = top;
    shape.normalAt(lx, lz, _n3);
    nx = _n3[0]; ny = _n3[1]; nz = _n3[2];
  } else if (face === 1) { lz = front; nz = 1; } else if (face === 2) { lz = rear; nz = -1; } else if (face === 3) { lx = half; nx = 1; } else { lx = -half; nx = -1; }
  // back to world (with the chassis' roll & pitch, at the end of the substep)
  let wx = lx, wy = ly, wz = lz;
  if (m.roll) {
    const c = Math.cos(m.roll), s = Math.sin(m.roll);
    const x2 = wx * c - wy * s, y2 = wx * s + wy * c;
    wx = x2; wy = y2;
  }
  if (m.pitch) {
    const c = Math.cos(m.pitch), s = Math.sin(m.pitch);
    const y2 = wy * c - wz * s, z2 = wy * s + wz * c;
    wy = y2; wz = z2;
  }
  const back = (1 - a1) * m.dt;
  const heading = m.heading - m.yawRate * back;
  const sin = Math.sin(heading), cos = Math.cos(heading);
  x[o] = m.x - m.vx * back + wx * cos + wz * sin;
  x[o + 1] = m.y + wy;
  x[o + 2] = m.z - m.vz * back - wx * sin + wz * cos;
  moverWorld(m, nx, ny, nz, n);
  return true;
}
const _n3 = new Float64Array(3);

/**
 * A vehicle body's shape from its mesh (local: x across, y up from the ground, z forward), as a height field on a
 * `cell` grid: its top over each cell, the outline of its footprint (half width along z, front & rear ends along x) and
 * the bottom of each crosswise row (sill, bumpers), solid in between. `wheels` are [x, z, radius, halfWidth].
 */
function vehicleShape(geometry, { cell = 0.08, wheels = [] } = {}) {
  const pos = geometry.attributes.position;
  const index = geometry.index;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const nx = Math.ceil((maxX - minX) / cell) + 1, nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const top = new Float32Array(nx * nz).fill(-Infinity);
  const rowBottom = new Float32Array(nz).fill(Infinity);
  const col = (x) => Math.max(0, Math.min(nx - 1, Math.round((x - minX) / cell)));
  const row = (z) => Math.max(0, Math.min(nz - 1, Math.round((z - minZ) / cell)));
  const mark = (c, rw, y) => {
    const k = rw * nx + c;
    if (y > top[k]) top[k] = y;
    if (y < rowBottom[rw]) rowBottom[rw] = y;
  };
  const tri = index ? index.count / 3 : pos.count / 3;
  const vi = (k) => (index ? index.getX(k) : k);
  for (let t = 0; t < tri; t++) {
    const i0 = vi(t * 3), i1 = vi(t * 3 + 1), i2 = vi(t * 3 + 2);
    const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
    const x1 = pos.getX(i1), y1 = pos.getY(i1), z1 = pos.getZ(i1);
    const x2 = pos.getX(i2), y2 = pos.getY(i2), z2 = pos.getZ(i2);
    mark(col(x0), row(z0), y0); mark(col(x1), row(z1), y1); mark(col(x2), row(z2), y2);
    const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
    if (Math.abs(det) < 1e-10) continue;
    const c0 = Math.max(0, Math.floor((Math.min(x0, x1, x2) - minX) / cell)), c1 = Math.min(nx - 1, Math.ceil((Math.max(x0, x1, x2) - minX) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(z0, z1, z2) - minZ) / cell)), r1 = Math.min(nz - 1, Math.ceil((Math.max(z0, z1, z2) - minZ) / cell));
    for (let rw = r0; rw <= r1; rw++) {
      const z = minZ + rw * cell;
      for (let c = c0; c <= c1; c++) {
        const x = minX + c * cell;
        const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det;
        const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
        mark(c, rw, l0 * y0 + l1 * y1 + l2 * y2);
      }
    }
  }
  // the outline, mirrored (bodies are symmetric) and filled in
  const half = new Float32Array(nz).fill(-1);
  const front = new Float32Array(nx).fill(-Infinity), rear = new Float32Array(nx).fill(Infinity);
  for (let rw = 0; rw < nz; rw++) {
    for (let c = 0; c < nx; c++) {
      if (top[rw * nx + c] === -Infinity) continue;
      const x = minX + c * cell, z = minZ + rw * cell;
      half[rw] = Math.max(half[rw], Math.abs(x));
    }
  }
  for (let rw = 0; rw < nz; rw++) {
    const z = minZ + rw * cell;
    for (let c = 0; c < nx; c++) {
      const x = minX + c * cell;
      if (Math.abs(x) > half[rw] + 1e-6) continue;
      // cells inside the outline the mesh left uncovered take the highest of their row's neighbours
      const k = rw * nx + c;
      const m = nx - 1 - c; // mirror
      const tm = top[rw * nx + m];
      if (tm > top[k]) top[k] = tm;
      front[c] = Math.max(front[c], z);
      rear[c] = Math.min(rear[c], z);
    }
  }
  // columns past the widest row's cells take their inner neighbour's ends
  const mid = col(0);
  for (let c = mid + 1; c < nx; c++) if (front[c] === -Infinity) { front[c] = front[c - 1]; rear[c] = rear[c - 1]; }
  for (let c = mid - 1; c >= 0; c--) if (front[c] === -Infinity) { front[c] = front[c + 1]; rear[c] = rear[c + 1]; }
  for (let rw = 0; rw < nz; rw++) {
    let last = -Infinity;
    for (let c = 0; c < nx; c++) {
      const k = rw * nx + c;
      if (Math.abs(minX + c * cell) > half[rw] + 1e-6) continue;
      if (top[k] === -Infinity) top[k] = last; else last = top[k];
    }
  }
  const reach = Math.max(Math.hypot(maxX, maxZ), Math.hypot(minX, minZ), Math.hypot(maxX, minZ), Math.hypot(minX, maxZ));
  const zFront = maxZ, zRear = minZ, xHalf = Math.max(maxX, -minX);
  const clampRow = (z) => row(Math.max(zRear, Math.min(zFront, z)));
  const shape = {
    reach,
    zFront, zRear, xHalf,
    wheels,
    halfAt: (z) => (z > zFront || z < zRear ? -1 : half[clampRow(z)]),
    frontAt: (x) => front[col(x)],
    rearAt: (x) => rear[col(x)],
    topAt: (x, z) => {
      const rw = clampRow(z);
      const hx = Math.min(Math.abs(x), half[rw]);
      const t = top[rw * nx + col(hx)];
      return t === -Infinity ? rowBottom[rw] : t;
    },
    bottomAt: (z) => rowBottom[clampRow(z)],
    normalAt: (x, z, out) => {
      const e = cell * 1.5;
      const dx = (shape.topAt(x + e, z) - shape.topAt(x - e, z)) / (2 * e);
      const dz = (shape.topAt(x, z + e) - shape.topAt(x, z - e)) / (2 * e);
      const l = Math.sqrt(dx * dx + 1 + dz * dz);
      out[0] = -dx / l; out[1] = 1 / l; out[2] = -dz / l;
      return out;
    },
    // Is a ball of radius r at (x, y, z) inside the body?
    inside: (x, y, z, r) => {
      if (z > zFront + r || z < zRear - r) return false;
      const zc = Math.max(zRear, Math.min(zFront, z));
      const h = half[clampRow(zc)];
      if (h < 0 || Math.abs(x) > h + r) return false;
      const xc = Math.max(-xHalf, Math.min(xHalf, x));
      if (z > front[col(xc)] + r || z < rear[col(xc)] - r) return false;
      if (y + r < rowBottom[clampRow(zc)]) return false;
      return y - r < shape.topAt(x, zc);
    },
    underWheel: (x, z, r) => {
      for (const [wx, wz, wr, ww] of wheels) {
        if (Math.abs(Math.abs(x) - wx) < ww + r && Math.abs(z - wz) < wr * 0.6 + r) return true;
      }
      return false;
    }
  };
  return shape;
}

export { RAGDOLL_POINTS, Ragdoll, createMover, vehicleShape, moverLocal };
