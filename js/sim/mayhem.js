import * as THREE from 'three/webgpu';

// js/sim/mayhem.js
// Arcade knock-downs for the player's car and bicycle: people (pedestrians, cyclists) thrown and tumbling to the ground,
// street furniture (lamp posts, hydrants) tipping over. Pure helpers (tested in tests/mayhem.test.cjs) plus the props'
// breaker, which hides a prop's static instances and animates a stand-in falling in its place.

const BONES = 15; // PersonRig bones (pedestrians.js BONE_COUNT): each 8 floats, quaternion, translation, scale
const GRAVITY = 9.8;
const HIP = 0.95; // a standing body's centre above its feet
const LIE = 0.16; // a lying body's centre above the ground

/**
 * Does a body of radius `r` at (x, z) touch the player's box (centre px, pz, facing `heading`, half width hw, half
 * length hl)? Returns the contact's direction away from the player's centre, or null.
 */
function boxHit(px, pz, heading, hw, hl, x, z, r) {
  const dx = x - px;
  const dz = z - pz;
  const sn = Math.sin(heading);
  const cs = Math.cos(heading);
  const along = dx * sn + dz * cs;
  const across = dx * cs - dz * sn;
  if (Math.abs(along) > hl + r || Math.abs(across) > hw + r) return null;
  const d = Math.hypot(dx, dz) || 1;
  return { nx: dx / d, nz: dz / d, along, across };
}

/**
 * Starts a body tumbling: thrown from its feet at (x, ground, z) by an impact of velocity (vx, vz) (the player's) with
 * `push` outwards along (nx, nz). `rand` gives 0..1.
 */
function startTumble(x, ground, z, vx, vz, nx, nz, rand = Math.random) {
  const speed = Math.hypot(vx, vz);
  // thrown along the hit, a little outwards, more up the faster it came
  const tvx = vx * 0.85 + nx * (1.2 + speed * 0.12);
  const tvz = vz * 0.85 + nz * (1.2 + speed * 0.12);
  const th = Math.hypot(tvx, tvz) || 1;
  return {
    t: 0,
    rest: 0,
    landed: false,
    x0: x, y0: ground + HIP, z0: z, // the pose's pivot as it stood
    px: x, py: ground + HIP, pz: z, // the pivot now
    vx: tvx, vy: 1.6 + Math.min(9, speed * 0.32), vz: tvz,
    ax: tvz / th, az: -tvx / th, // tilt axis: up x throw direction, so the head goes the way it's thrown
    angle: 0,
    angVel: 3.5 + Math.min(14, speed * 0.45) * (0.8 + rand() * 0.4),
    spin: 0,
    spinVel: (rand() - 0.5) * Math.min(10, 2 + speed * 0.4)
  };
}

/**
 * Advances a tumble by dt over ground height `ground`; returns how long it has lain still. `solidAt(x, z)` (optional)
 * tells where walls stand: the body bounces back off them instead of flying into a building.
 */
function stepTumble(f, dt, ground, solidAt = null) {
  f.t += dt;
  f.vy -= GRAVITY * dt;
  slide(f, f.vx * dt, f.vz * dt, solidAt);
  f.py += f.vy * dt;
  f.angle += f.angVel * dt;
  f.spin += f.spinVel * dt;
  // the lowest the pivot can be at this tilt: on its feet (upright) down to lying flat
  const floor = ground + LIE + (HIP - LIE) * Math.abs(Math.cos(f.angle));
  if (f.py <= floor) {
    f.py = floor;
    f.vy = f.vy < -2 ? -f.vy * 0.28 : 0;
    const k = Math.exp(-5 * dt);
    f.vx *= k;
    f.vz *= k;
    f.spinVel *= Math.exp(-4 * dt);
    f.angVel *= Math.exp(-3.5 * dt);
    f.landed = true;
  }
  if (f.landed) {
    // settle on the back or the front
    const target = Math.round((f.angle - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
    f.angle += (target - f.angle) * Math.min(1, 5 * dt);
    if (Math.hypot(f.vx, f.vz) < 0.4 && Math.abs(f.vy) < 0.1) f.rest += dt;
  }
  return f.rest;
}

/**
 * Writes into `dst` the pose `base` (solved standing or riding: per bone quaternion, translation, scale) turned as one
 * rigid body by the tumble `f`: tilted by f.angle about its axis after a turn of f.spin about the vertical, moved from
 * its pivot (x0, y0, z0) to (px, py, pz). World vertex = q·bind·s + t, so q' = R·q and t' = R·(t − p0) + p1.
 */
function tumblePose(dst, base, f, bones = BONES) {
  // R = tilt(axis, angle) · spin(up, spin)
  const ha = f.angle * 0.5;
  const sa = Math.sin(ha);
  const tx = f.ax * sa, ty = 0, tz = f.az * sa, tw = Math.cos(ha);
  const hs = f.spin * 0.5;
  const sy = Math.sin(hs), sw = Math.cos(hs);
  // (tx, ty, tz, tw) * (0, sy, 0, sw)
  const rx = tx * sw - tz * sy;
  const ry = tw * sy + ty * sw;
  const rz = tz * sw + tx * sy;
  const rw = tw * sw - ty * sy;
  for (let b = 0; b < bones; b++) {
    const o = b * 8;
    const qx = base[o], qy = base[o + 1], qz = base[o + 2], qw = base[o + 3];
    dst[o] = rw * qx + rx * qw + ry * qz - rz * qy;
    dst[o + 1] = rw * qy - rx * qz + ry * qw + rz * qx;
    dst[o + 2] = rw * qz + rx * qy - ry * qx + rz * qw;
    dst[o + 3] = rw * qw - rx * qx - ry * qy - rz * qz;
    // rotate v = t − p0 by (rx, ry, rz, rw): v + 2w(u × v) + 2u × (u × v)
    const vx = base[o + 4] - f.x0, vy = base[o + 5] - f.y0, vz = base[o + 6] - f.z0;
    const cx = ry * vz - rz * vy, cy = rz * vx - rx * vz, cz = rx * vy - ry * vx;
    const dx = ry * cz - rz * cy, dy = rz * cx - rx * cz, dz = rx * cy - ry * cx;
    dst[o + 4] = vx + 2 * (rw * cx + dx) + f.px;
    dst[o + 5] = vy + 2 * (rw * cy + dy) + f.py;
    dst[o + 6] = vz + 2 * (rw * cz + dz) + f.pz;
    dst[o + 7] = base[o + 7];
  }
}

// Moves o.px, o.pz by (dx, dz) unless that enters a wall, in which case its horizontal velocity bounces back softly
function slide(o, dx, dz, solidAt) {
  if (solidAt && (dx || dz) && solidAt(o.px + dx, o.pz + dz)) {
    o.vx *= -0.25;
    o.vz *= -0.25;
    return false;
  }
  o.px += dx;
  o.pz += dz;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Street furniture
// ---------------------------------------------------------------------------------------------------------------------

/** Pole falling over about its base: angle 0 upright .. ~π/2 lying, pushed by an impact of speed v */
function startTopple(speed, rand = Math.random) {
  return { angle: 0, angVel: 0.6 + Math.min(4.5, speed * 0.22) * (0.85 + rand() * 0.3), rest: 0, bounced: false };
}

function stepTopple(f, dt, lying = Math.PI / 2 - 0.04, tall = 6) {
  // gravity's torque on a rod pivoting at its foot: θ'' = (3g / 2L) sin θ
  f.angVel += ((3 * GRAVITY) / (2 * tall)) * Math.sin(Math.max(0.02, f.angle)) * dt;
  f.angle += f.angVel * dt;
  if (f.angle >= lying) {
    f.angle = lying;
    if (!f.bounced && f.angVel > 1.2) {
      f.angVel = -f.angVel * 0.18;
      f.bounced = true;
    } else {
      f.angVel = 0;
      f.rest += dt;
    }
  }
  return f.rest;
}

/**
 * The street furniture the player can knock over. `props`: [{ kind: 'cobra' | 'post' | 'hydrant', x, z, yaw, parts:
 * [{ mesh, index }], light? }], the parts being the prop's instances in the static InstancedMeshes (see street-details.js;
 * scene-culling.js may have split them into chunks, recorded in mesh.userData.chunked). `looks` gives each kind's
 * stand-in: { [kind]: [{ geometry, material }] } in the prop's own frame (base at the origin, +x towards the street).
 */
class PropBreaker {
  constructor(scene, props, looks) {
    this.props = props;
    this.looks = looks;
    this.cells = new Map();
    this.debris = []; // falling stand-ins; once lying still they stay put (the prop's instance stays hidden)
    this.listener = null;
    this.solidAt = null;
    this.event = { a: null, b: null, kind: 'prop', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
    this.group = new THREE.Group();
    this.group.name = 'KnockedProps';
    scene.add(this.group);
    for (const p of props) {
      const k = this.key(Math.floor(p.x / 16), Math.floor(p.z / 16));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(p);
    }
    const jetMat = new THREE.MeshStandardNodeMaterial({ color: 0xcfe8ff, roughness: 0.15, metalness: 0.0, transparent: true, opacity: 0.55 });
    this.jetGeo = new THREE.CylinderGeometry(0.05, 0.35, 1, 10, 1, true).translate(0, 0.5, 0);
    this.jetMat = jetMat;
  }

  key(ix, iz) {
    return ix * 100003 + iz;
  }

  setCollisionListener(fn) {
    this.listener = typeof fn === 'function' ? fn : null;
  }

  // Where walls stand, for props knocked flying: (x, z) => boolean
  setSolidQuery(fn) {
    this.solidAt = typeof fn === 'function' ? fn : null;
  }

  /** Knocks over whatever the player's car or bicycle runs into this frame */
  update(dt, entity, mode) {
    if (entity && (mode === 'car' || mode === 'cyclist') && entity.position.y < 1.5) {
      const heading = entity.heading || 0;
      const vx = Math.sin(heading) * (entity.speed || 0) + (entity.vx || 0);
      const vz = Math.cos(heading) * (entity.speed || 0) + (entity.vz || 0);
      const speed = Math.hypot(vx, vz);
      if (speed > 1.5) {
        const hw = mode === 'car' ? 0.9 : 0.35;
        const hl = mode === 'car' ? 2.25 : 0.9;
        const x = entity.position.x, z = entity.position.z;
        const ix = Math.floor(x / 16), iz = Math.floor(z / 16);
        for (let a = -1; a <= 1; a++) {
          for (let b = -1; b <= 1; b++) {
            const list = this.cells.get(this.key(ix + a, iz + b));
            if (!list) continue;
            for (const p of list) {
              if (p.broken) continue;
              const hit = boxHit(x, z, heading, hw, hl, p.x, p.z, p.kind === 'hydrant' ? 0.3 : 0.2);
              if (!hit) continue;
              this.knock(p, vx, vz, speed, hit);
              entity.speed *= p.kind === 'hydrant' ? 0.88 : mode === 'car' ? 0.8 : 0.45;
            }
          }
        }
      }
    }
    this.animate(dt);
  }

  knock(p, vx, vz, speed, hit) {
    p.broken = true;
    if (p.light) p.light.broken = true;
    for (const part of p.parts) hideInstance(part.mesh, part.index);
    // the stand-in falls the way the player was going
    const dir = Math.atan2(vx, vz);
    const look = this.looks[p.kind] || [];
    const root = new THREE.Group();
    root.position.set(p.x, p.ground || 0, p.z);
    const tilt = new THREE.Group();
    root.add(tilt);
    const body = new THREE.Group();
    body.rotation.y = (p.yaw || 0) - dir; // the prop's own frame inside the fall frame (falls towards +z)
    tilt.add(body);
    root.rotation.y = dir;
    for (const { geometry, material, matrix } of look) {
      const m = new THREE.Mesh(geometry, material);
      if (matrix) m.applyMatrix4(matrix);
      m.castShadow = true;
      body.add(m);
    }
    const d = {
      root, tilt, kind: p.kind, age: 0,
      fall: startTopple(speed),
      tall: p.kind === 'cobra' ? 8.4 : p.kind === 'post' ? 3.9 : 0.9,
      // hydrants are knocked off their base and thrown
      fly: p.kind === 'hydrant' ? { px: p.x, pz: p.z, vx: vx * 0.6 + hit.nx * 1.5, vy: 3 + speed * 0.12, vz: vz * 0.6 + hit.nz * 1.5, y: 0 } : null,
      jet: null
    };
    if (p.kind === 'hydrant') {
      const jet = new THREE.Mesh(this.jetGeo, this.jetMat);
      jet.position.set(p.x, (p.ground || 0) + 0.2, p.z);
      jet.scale.set(1, 7, 1);
      this.group.add(jet);
      d.jet = jet;
    }
    this.group.add(root);
    this.debris.push(d);
    if (this.listener) {
      const e = this.event;
      e.a = p;
      e.b = p.parts[0]?.mesh || p;
      e.x = p.x; e.y = 1.0; e.z = p.z;
      e.nx = -hit.nx; e.nz = -hit.nz;
      e.speed = Math.min(speed, p.kind === 'hydrant' ? 6 : 12);
      this.listener(e);
    }
  }

  animate(dt) {
    let settled = 0;
    for (const d of this.debris) {
      d.age += dt;
      if (d.done) {
        settled++;
        continue;
      }
      if (d.fly) {
        const f = d.fly;
        f.vy -= GRAVITY * dt;
        f.y = Math.max(0, f.y + f.vy * dt);
        if (f.y === 0) { f.vy = f.vy < -2 ? -f.vy * 0.3 : 0; f.vx *= Math.exp(-4 * dt); f.vz *= Math.exp(-4 * dt); }
        slide(f, f.vx * dt, f.vz * dt, this.solidAt);
        d.root.position.x = f.px;
        d.root.position.z = f.pz;
        d.root.position.y = f.y;
        d.tilt.rotation.x = Math.min(Math.PI / 2, d.tilt.rotation.x + dt * 6);
      } else if (d.fall.rest < 1) {
        stepTopple(d.fall, dt, Math.PI / 2 - 0.04, d.tall);
        d.tilt.rotation.x = d.fall.angle;
      }
      if (d.jet) {
        const flick = 1 + Math.sin(d.age * 31) * 0.06 + Math.sin(d.age * 17.3) * 0.05;
        const fade = Math.max(0, Math.min(1, (40 - d.age) / 6));
        d.jet.scale.set(flick * fade + 0.001, (7 + Math.sin(d.age * 9) * 0.6) * fade + 0.001, flick * fade + 0.001);
        d.jet.visible = fade > 0;
        if (!d.jet.visible) {
          this.group.remove(d.jet);
          d.jet = null;
        }
      }
      // lying still with no water left: nothing more to animate
      const still = d.fly ? d.fly.y === 0 && d.fly.vy === 0 && Math.hypot(d.fly.vx, d.fly.vz) < 0.05 : d.fall.rest >= 1;
      if (still && !d.jet) d.done = true;
    }
    // keep the list to the props still moving
    if (settled > 64) this.debris = this.debris.filter((d) => !d.done);
  }
}

// Hides instance `index` of a static InstancedMesh, wherever scene-culling.js moved it (mesh.userData.chunked)
function hideInstance(mesh, index) {
  let target = mesh;
  let j = index;
  const ch = mesh.userData && mesh.userData.chunked;
  if (ch) {
    target = ch.chunks[ch.where[index * 2]];
    j = ch.where[index * 2 + 1];
  }
  if (!target || j < 0) return;
  const attr = target.instanceMatrix;
  attr.array.fill(0, j * 16, j * 16 + 16);
  if (attr.addUpdateRange) attr.addUpdateRange(j * 16, 16);
  attr.needsUpdate = true;
}

export { BONES, boxHit, startTumble, stepTumble, slide, tumblePose, startTopple, stepTopple, hideInstance, PropBreaker };
