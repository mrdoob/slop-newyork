import * as THREE from 'three/webgpu';
import * as HK from './config.js';
import { HK_TAXI_SPEC } from './vehicles.js';
import { buildCarGeometry, buildSteerableWheelGeo, createLoftedCarMaterial } from '../actor-models.js';
import { createContactShadowMaterial } from '../tsl-materials.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from '../vehicle-lights.js';

// js/hk/drive.js
// 玩家：駕駛紅的士（香港市區的士）＋ 追尾鏡頭。
//
// 這裡刻意重用紐約原版的整套「手感」設計（`js/controllers.js` 的 createCarEntity /
// updateCar），唔係自己另寫一套簡化版 —— 用戶的原話是「你看看原來的設計, 樣樣都有架人地」。
// 具體借了五樣東西：
//   1. chassisPivot：一個獨立於車輪的車廂樞軸，用彈簧-阻尼做三自由度懸掛
//      （pitch 起步後仰／剎車前傾、roll 過彎側傾、heave 上下浮沉）—— 這就是「起步同停車有 chok」；
//   2. 四條可轉向、可自轉的輪胎（buildSteerableWheelGeo），前輪跟方向盤轉、四輪按里程滾動；
//   3. 車底 contact shadow（貼地的軟影），車唔會再看落像浮在半空；
//   4. 兩盞 SpotLight 頭燈（clustered lighting），照亮前面 40 m 路面；
//   5. 由 material.userData.carState 驅動的剎車燈／指揮燈（同車流用同一個材質 uniform）。
//
// 物理本身仍是街機式（與紐約 controllers.js 同一思路，數值按香港路面重調）。

const CAR = {
  // 用戶：「車速可再快D」。巡航 36 m/s ≈ 130 km/h，Shift 加速 52 m/s ≈ 187 km/h。
  // 阻力調細（0.0008）＋ 加速度加大（15），確保真係踩得到接近上限，唔會永遠停在中速。
  maxSpeed: 36,
  boostSpeed: 52,
  reverseSpeed: 9,
  accel: 15,
  brake: 16,
  rolling: 1.4,
  drag: 0.0008,
  steerRate: 1.9, // rad/s at full lock
  steerLock: 0.52, // 前輪最大轉角（rad）
  wheelBase: 2.9
};

// 懸掛：數值直接沿用紐約玩家車（springK 68 / dampC 11.2），因為那個手感是調過的。
const SPRING = { k: 68, c: 11.2, pitchMax: 0.09, rollMax: 0.13, heaveK: 85, heaveC: 12, heaveMin: -0.07, heaveMax: 0.07 };

export function createPlayer(scene, colliders) {
  const spec = HK_TAXI_SPEC;
  const root = new THREE.Group();
  root.name = 'PlayerTaxi';

  // 車廂樞軸：只有它會 pitch / roll / heave，車輪貼住地面唔跟住跳（同原版一樣）
  const chassisPivot = new THREE.Group();
  root.add(chassisPivot);

  const paint = createLoftedCarMaterial(spec, HK.HK_TAXI_COLOR ?? 0xb5121b);
  const body = new THREE.Mesh(buildCarGeometry(spec, false), paint);
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = 'PlayerTaxiBody';
  chassisPivot.add(body);

  // --- 車輪：四條獨立輪胎（前輪可轉向）--------------------------------------------------------------
  const wheelGeoLeft = buildSteerableWheelGeo(spec, -1);
  const wheelGeoRight = buildSteerableWheelGeo(spec, 1);
  const wheels = [];
  for (const wc of [
    { side: -1, z: spec.wheelZ, isFront: true },
    { side: 1, z: spec.wheelZ, isFront: true },
    { side: -1, z: -spec.wheelZ, isFront: false },
    { side: 1, z: -spec.wheelZ, isFront: false }
  ]) {
    const steerPivot = new THREE.Group();
    steerPivot.name = wc.isFront ? 'PlayerTaxiWheelFront' : 'PlayerTaxiWheelRear';
    steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
    const tire = new THREE.Mesh(wc.side < 0 ? wheelGeoLeft : wheelGeoRight, paint);
    tire.castShadow = true;
    tire.receiveShadow = true;
    steerPivot.add(tire);
    root.add(steerPivot);
    wheels.push({ steerPivot, tire, isFront: wc.isFront });
  }

  // --- 車底軟影（contact shadow）：車「貼地」的關鍵 -------------------------------------------------
  const shadowGeo = new THREE.PlaneGeometry(spec.halfWidth?.[2]?.[1] * 2.5 || 2.2, 5.05);
  shadowGeo.rotateX(-Math.PI * 0.5);
  const carShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
  carShadow.position.y = 0.02;
  carShadow.renderOrder = 998;
  root.add(carShadow);

  // --- 頭燈（兩盞 SpotLight）＋ 由材質 uniform 控制的燈罩自發光 --------------------------------------
  const headLights = [];
  for (const side of [-1, 1]) {
    const spot = createVehicleHeadlight();
    placeVehicleHeadlight(spot, spec, side);
    spot.intensity = HEADLIGHTS.intensity;
    chassisPivot.add(spot, spot.target);
    headLights.push(spot);
  }
  const carState = paint.userData?.carState ?? null;

  scene.add(root);

  const state = {
    x: HK.SPAWN.x,
    z: HK.SPAWN.z,
    y: HK.KERB_HEIGHT,
    heading: HK.SPAWN.heading,
    speed: 0,
    steer: 0,
    steerAngle: 0,
    wheelSpin: 0,
    pitch: 0,
    pitchVel: 0,
    roll: 0,
    rollVel: 0,
    heaveY: 0,
    heaveVel: 0,
    braking: false,
    radius: 1.35
  };

  const keys = { forward: false, backward: false, left: false, right: false, boost: false, brake: false };

  /**
   * 樓宇碰撞：用**旋轉矩形（OBB）**而唔係 AABB。
   *
   * 為什麼要改：香港的樓宇是按街道方位角旋轉的（例如 30°），而 AABB 是最終包住旋轉矩形的軸對齊框 ——
   * 30° 旋轉的 20×15 m 樓，AABB 會變成 24.8×23.3 m，四個角各多出 4–5 m 的**空氣**。
   * 玩家的圓形碰撞半徑一碰到那些角就「撞牆」，但畫面裡根本冇牆 —— 這就是用戶講的「隱形建築物」。
   * 改成 OBB：先把點轉回樓宇的本地座標，再用矩形推出，最後轉回世界座標。
   */
  function collide() {
    for (const c of colliders) {
      if (state.x < c.minX - 4 || state.x > c.maxX + 4 || state.z < c.minZ - 4 || state.z > c.maxZ + 4) continue;
      if (c.rot) {
        const cos = Math.cos(-c.rot);
        const sin = Math.sin(-c.rot);
        const dx0 = state.x - c.x;
        const dz0 = state.z - c.z;
        const lx = dx0 * cos - dz0 * sin;
        const lz = dx0 * sin + dz0 * cos;
        const nx = Math.max(-c.hw, Math.min(lx, c.hw));
        const nz = Math.max(-c.hd, Math.min(lz, c.hd));
        const ddx = lx - nx;
        const ddz = lz - nz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 > state.radius * state.radius) continue;
        let px;
        let pz;
        if (d2 < 1e-8) {
          // 圓心在矩形內：沿最淺的一條邊推出去
          const pushX = c.hw - Math.abs(lx);
          const pushZ = c.hd - Math.abs(lz);
          if (pushX < pushZ) { px = Math.sign(lx || 1) * (pushX + state.radius); pz = 0; }
          else { px = 0; pz = Math.sign(lz || 1) * (pushZ + state.radius); }
        } else {
          const d = Math.sqrt(d2);
          const push = state.radius - d;
          px = (ddx / d) * push;
          pz = (ddz / d) * push;
        }
        // 本地 → 世界（旋轉回 +c.rot）
        const cosB = Math.cos(c.rot);
        const sinB = Math.sin(c.rot);
        state.x += px * cosB - pz * sinB;
        state.z += px * sinB + pz * cosB;
        state.speed *= 0.35;
        continue;
      }
      // 舊式 AABB（地標等）保持不變
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
    const prevSpeed = state.speed;
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
    state.braking = false;
    if (keys.brake) { state.speed *= Math.max(0, 1 - 4 * dt); state.braking = true; }

    // 轉向：與速度相關（靜止不能轉），並有回中
    const steerInput = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    const speedFactor = Math.min(1, Math.abs(state.speed) / 6);
    state.steer += (steerInput - state.steer) * Math.min(1, dt * 8);
    if (state.speed !== 0) {
      state.heading += state.steer * CAR.steerRate * speedFactor * dt * Math.sign(state.speed);
    }
    state.steerAngle = state.steer * CAR.steerLock;

    const prevX = state.x;
    const prevZ = state.z;
    state.x += Math.sin(state.heading) * state.speed * dt;
    state.z += Math.cos(state.heading) * state.speed * dt;
    collide();

    // --- 懸掛：三自由度彈簧-阻尼（起步後仰、剎車前傾、過彎側傾、路面浮沉）----------------------------
    const accel = (state.speed - prevSpeed) / Math.max(dt, 1e-4);
    const targetPitch = -Math.max(-1, Math.min(1, accel / CAR.accel)) * 0.055;
    const targetRoll = -state.steerAngle * (state.speed / CAR.maxSpeed) * 0.55;
    state.pitchVel += ((targetPitch - state.pitch) * SPRING.k - state.pitchVel * SPRING.c) * dt;
    state.rollVel += ((targetRoll - state.roll) * SPRING.k - state.rollVel * SPRING.c) * dt;
    state.pitch = Math.max(-SPRING.pitchMax, Math.min(SPRING.pitchMax, state.pitch + state.pitchVel * dt));
    state.roll = Math.max(-SPRING.rollMax, Math.min(SPRING.rollMax, state.roll + state.rollVel * dt));
    state.heaveVel += (-state.heaveY * SPRING.heaveK - state.heaveVel * SPRING.heaveC) * dt;
    state.heaveY = Math.max(SPRING.heaveMin, Math.min(SPRING.heaveMax, state.heaveY + state.heaveVel * dt));

    // --- 車輪：按真實滾動距離自轉，前輪跟方向盤 ------------------------------------------------------
    const forwardDist = (state.x - prevX) * Math.sin(state.heading) + (state.z - prevZ) * Math.cos(state.heading);
    const step = forwardDist / Math.max(0.05, spec.wheelRadius);
    state.wheelSpin = (state.wheelSpin + step) % (Math.PI * 2);
    for (const w of wheels) {
      w.tire.rotation.x = state.wheelSpin;
      if (w.isFront) w.steerPivot.rotation.y = state.steerAngle;
    }

    // --- 車燈：剎車燈 + 指揮燈（同車流共用 carState uniform）----------------------------------------
    if (carState) {
      carState.value.x = state.braking || (state.speed === 0 && !throttle) ? 1 : 0;
      carState.value.y = keys.left ? 1 : 0;
      carState.value.z = keys.right ? 1 : 0;
    }

    sync();
    return state;
  }

  /** 把 state 寫入 3D 物件（碰撞推開之後要即刻同步，否則車身會慢一幀）。 */
  function sync() {
    root.position.set(state.x, state.y, state.z);
    root.rotation.set(0, state.heading, 0);
    chassisPivot.rotation.x = state.pitch;
    chassisPivot.rotation.z = state.roll;
    chassisPivot.position.y = state.heaveY;
  }

  /** 被外力（例如 AI 車）推開之後，再解一次樓宇碰撞，然後同步車身。 */
  function resolve() {
    collide();
    sync();
    return state;
  }

  return { root, taxi: root, chassisPivot, body, wheels, headLights, carShadow, state, keys, update, sync, resolve, colliders, material: paint };
}

/**
 * 多個視角（用戶：「視角人地有幾個揀架，包括車箱內」）。
 *
 *   chase   追尾 —— 原來的跟車鏡頭
 *   close   近鏡 —— 貼近車尾，睇得到車頂燈箱同尾燈
 *   bonnet  車頭冚 —— 鏡頭放喺引擎蓋前緣，第一人稱睇路
 *   cockpit 車廂內 —— 鏡頭放喺司機位（香港右軚：x = −0.34），透過擋風玻璃睇路
 *
 * 兩種剛性視角（bonnet / cockpit）跟車身樞軸走，只保留很小的平滑，避免暈浪；
 * 兩種追尾視角保留原本的彈性 lerp。
 */
export const CAMERA_MODES = [
  { id: 'chase', zh: '追尾', en: 'Chase', rigid: false, dist: 9.5, height: 4.2, look: 1.6 },
  { id: 'close', zh: '近鏡', en: 'Close', rigid: false, dist: 5.2, height: 2.0, look: 1.15 },
  { id: 'bonnet', zh: '車頭冚', en: 'Bonnet', rigid: true, offset: [0, 1.16, 1.35], look: 1.0 },
  { id: 'cockpit', zh: '車廂內', en: 'Cockpit', rigid: true, offset: [-0.34, 1.22, 0.02], look: 1.02 }
];

export class ChaseCamera {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;
    this.yaw = 0;
    this.pitch = 0.16;
    this.zoom = 1;
    this.mode = 'chase';
    this.dragging = false;
    this.last = { x: 0, y: 0 };
    this.smoothed = new THREE.Vector3(HK.SPAWN.x, 6, HK.SPAWN.z - 12);
    this.lookAt = new THREE.Vector3(HK.SPAWN.x, 1.5, HK.SPAWN.z);
    this.bind();
  }

  setMode(id) {
    if (CAMERA_MODES.some((m) => m.id === id)) this.mode = id;
    return this.mode;
  }

  nextMode() {
    const i = CAMERA_MODES.findIndex((m) => m.id === this.mode);
    return this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length].id);
  }

  get modeInfo() {
    return CAMERA_MODES.find((m) => m.id === this.mode) ?? CAMERA_MODES[0];
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
    const info = this.modeInfo;
    const yaw = target.heading + this.yaw;
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const baseY = HK.KERB_HEIGHT + (target.heaveY ?? 0);

    if (info.rigid) {
      // 剛性視角：鏡頭直接綁在車身上（offset 用車身本地座標：x 左右、y 高、z 前後）
      const [ox, oy, oz] = info.offset;
      // 本地 +x 對應世界 (cos yaw, -sin yaw)（與樓宇旋轉同一個約定）
      const desired = new THREE.Vector3(
        target.x + Math.cos(yaw) * ox + fwdX * oz,
        baseY + oy + (target.pitch ?? 0) * 0.6,
        target.z - Math.sin(yaw) * ox + fwdZ * oz
      );
      this.smoothed.copy(desired);
      this.camera.position.copy(this.smoothed);
      const lookY = baseY + info.look + this.pitch * 4;
      this.camera.lookAt(new THREE.Vector3(target.x + fwdX * 14, lookY, target.z + fwdZ * 14));
      return;
    }

    const back = info.dist * this.zoom;
    const height = info.height * this.zoom + this.pitch * 10;
    const desired = new THREE.Vector3(
      target.x - Math.sin(yaw) * back,
      HK.KERB_HEIGHT + height,
      target.z - Math.cos(yaw) * back
    );
    const k = 1 - Math.pow(0.0025, dt);
    this.smoothed.lerp(desired, k);
    this.smoothed.y = Math.max(1.2, this.smoothed.y);
    this.lookAt.lerp(new THREE.Vector3(target.x, HK.KERB_HEIGHT + info.look, target.z), k);
    this.camera.position.copy(this.smoothed);
    this.camera.lookAt(this.lookAt);
  }
}
