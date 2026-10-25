import * as THREE from 'three/webgpu';
import * as HK from './config.js';
import { buildTaxi } from './vehicles.js';

// js/hk/drive.js
// 玩家：駕駛紅的士（香港市區的士）＋ 追尾鏡頭。
// 物理是街機式（與紐約那邊的 controllers.js 同一個思路，數值按香港路面重調）：
//   · 油門／剎車／滾阻／風阻；
//   · 速度越低，轉向越弱（不會原地打轉）；
//   · 以 AABB 推出處理樓宇與地標碰撞，撞到會減速而不是穿牆。

const CAR = {
  maxSpeed: 22, // m/s ≈ 79 km/h（市區）
  boostSpeed: 30,
  reverseSpeed: 7,
  accel: 7.5,
  brake: 12,
  rolling: 1.4,
  drag: 0.0032,
  steerRate: 1.9, // rad/s at full lock
  wheelBase: 2.9
};

export function createPlayer(scene, colliders) {
  const taxi = buildTaxi();
  scene.add(taxi);

  const state = {
    x: HK.SPAWN.x,
    z: HK.SPAWN.z,
    y: HK.KERB_HEIGHT,
    heading: HK.SPAWN.heading,
    speed: 0,
    steer: 0,
    radius: 1.35
  };

  const keys = { forward: false, backward: false, left: false, right: false, boost: false, brake: false };

  function collide() {
    // 以車的圓形半徑對 AABB 推出（樓宇很多，用簡單掃描；近 30 m 內才考慮）
    for (const c of colliders) {
      if (state.x < c.minX - 3 || state.x > c.maxX + 3 || state.z < c.minZ - 3 || state.z > c.maxZ + 3) continue;
      const nx = Math.max(c.minX, Math.min(state.x, c.maxX));
      const nz = Math.max(c.minZ, Math.min(state.z, c.maxZ));
      const dx = state.x - nx;
      const dz = state.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 > state.radius * state.radius) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const push = state.radius - d;
      state.x += (dx / d) * push;
      state.z += (dz / d) * push;
      state.speed *= 0.35;
    }
  }

  function update(dt) {
    const throttle = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0);
    const top = keys.boost ? CAR.boostSpeed : CAR.maxSpeed;

    if (throttle > 0) {
      const headroom = Math.max(0, 1 - state.speed / top);
      state.speed += CAR.accel * headroom * dt;
    } else if (throttle < 0) {
      state.speed += (state.speed > 0 ? -CAR.brake : -CAR.accel * 0.6) * dt;
    } else {
      state.speed -= Math.sign(state.speed) * Math.min(Math.abs(state.speed), CAR.rolling * dt);
    }
    // 空氣阻力與上限
    state.speed -= state.speed * Math.abs(state.speed) * CAR.drag * dt;
    state.speed = Math.max(-CAR.reverseSpeed, Math.min(top, state.speed));
    if (keys.brake) state.speed *= Math.max(0, 1 - 4 * dt);

    // 轉向：與速度相關（靜止不能轉），並有回中
    const steerInput = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    const speedFactor = Math.min(1, Math.abs(state.speed) / 6);
    state.steer += (steerInput - state.steer) * Math.min(1, dt * 8);
    if (state.speed !== 0) {
      state.heading += state.steer * CAR.steerRate * speedFactor * dt * Math.sign(state.speed);
    }

    state.x += Math.sin(state.heading) * state.speed * dt;
    state.z += Math.cos(state.heading) * state.speed * dt;
    collide();

    taxi.position.set(state.x, state.y, state.z);
    taxi.rotation.set(0, state.heading, 0);
    return state;
  }

  return { taxi, state, keys, update };
}

/** 追尾鏡頭（滑鼠／觸控拖曳 orbit、滾輪縮放） */
export class ChaseCamera {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.yaw = 0;
    this.pitch = 0.16;
    this.zoom = 1;
    this.dragging = false;
    this.last = { x: 0, y: 0 };
    this.smoothed = new THREE.Vector3(HK.SPAWN.x, 6, HK.SPAWN.z - 12);
    this.lookAt = new THREE.Vector3(HK.SPAWN.x, 1.5, HK.SPAWN.z);
    this.bind();
  }

  bind() {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.last.x) * 0.005;
      this.pitch = Math.max(-0.2, Math.min(0.9, this.pitch + (e.clientY - this.last.y) * 0.003));
      this.last = { x: e.clientX, y: e.clientY };
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(type, () => { this.dragging = false; });
    }
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.55, Math.min(3.2, this.zoom * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });
  }

  update(dt, target) {
    const back = 9.5 * this.zoom;
    const height = 4.2 * this.zoom + this.pitch * 10;
    const yaw = target.heading + Math.PI + this.yaw;
    const desired = new THREE.Vector3(
      target.x + Math.sin(yaw) * back,
      HK.KERB_HEIGHT + height,
      target.z + Math.cos(yaw) * back
    );
    const k = 1 - Math.pow(0.0025, dt);
    this.smoothed.lerp(desired, k);
    this.smoothed.y = Math.max(1.2, this.smoothed.y);
    this.lookAt.lerp(new THREE.Vector3(target.x, HK.KERB_HEIGHT + 1.6, target.z), k);
    this.camera.position.copy(this.smoothed);
    this.camera.lookAt(this.lookAt);
  }
}
