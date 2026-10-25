import * as THREE from 'three/webgpu';
import * as HK from './config.js';
import { poseAt } from './config.js';
import { AI_FLEET, createAiMaterial, buildDoubleDecker, buildTram, buildMinibus, buildFerry } from './vehicles.js';

// js/hk/traffic.js
// 香港靠左行駛的車流。
//
// 車道由走廊推導，不是手擺：每條走廊按行車方向拆成兩條（單程路一條），每條再按 lanesPerWay 分線，
// 而第 i 條線的橫向位置 = 中心線 **向左** (i + 0.5) × 3.4 m（laneLateral / laneCentreOffset，見 config.js）。
// 這一條公式就是「靠左行駛」的全部語意；把 config.js 的 laneLateral 取負號，整個城市立刻變成靠右行駛。
//
// 車流用簡化 IDM（Intelligent Driver Model）：跟車時以車距決定目標速度，前車慢就跟慢。走到走廊盡頭
// 就回收去一條遠離鏡頭的車道（避免在玩家眼前憑空出現）。

const NUM_AI_CARS = 96;
const NUM_BUSES = 8;
const NUM_MINIBUSES = 10;
const NUM_TRAMS = 3;

export function createHongKongTraffic(scene) {
  const lanes = HK.buildLanes();
  const group = new THREE.Group();
  group.name = 'HongKongTraffic';
  scene.add(group);

  // --- AI 私家車／的士：每種顏色一個 InstancedMesh ------------------------------------------------
  const fleets = AI_FLEET.map((entry) => ({
    entry,
    capacity: Math.max(1, Math.round(NUM_AI_CARS * entry.share)),
    cars: [],
    mesh: null
  }));
  const cars = [];
  {
    // 依 share 分配車輛，剩餘補給的士
    let assigned = 0;
    for (let i = 0; i < NUM_AI_CARS; i++) {
      let pick = 0;
      let acc = 0;
      const r = (i * 0.6180339887) % 1;
      for (let f = 0; f < fleets.length; f++) {
        acc += fleets[f].entry.share;
        if (r <= acc) { pick = f; break; }
      }
      // 避免某車種爆容量
      while (fleets[pick].cars.length >= fleets[pick].capacity) pick = (pick + 1) % fleets.length;
      fleets[pick].cars.push({
        lane: lanes[(i * 7) % lanes.length],
        s: 0,
        speed: 8 + ((i * 13) % 7),
        length: 4.6
      });
      assigned++;
    }
    if (!assigned) throw new Error('no AI cars placed');
  }
  for (const f of fleets) {
    const geo = f.entry.geometry();
    const mesh = new THREE.InstancedMesh(geo, createAiMaterial(f.entry), f.cars.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `HKAI_${f.entry.id}`;
    group.add(mesh);
    f.mesh = mesh;
    // 讓首幀就有合理位置
    f.cars.forEach((car) => {
      if (car.lane) car.s = (car.speed * 7 + Math.random() * 60) % Math.max(1, car.lane.len);
    });
  }
  for (const f of fleets) cars.push(...f.cars);

  // --- 雙層巴士、小巴（沿最外側車道） --------------------------------------------------------
  const heavy = [];
  const trunkLanes = lanes.filter((l) => l.road.cls === 'trunk' && l.isKerbLane);
  for (let i = 0; i < NUM_BUSES; i++) {
    const mesh = buildDoubleDecker();
    scene.add(mesh);
    heavy.push({ mesh, lane: trunkLanes[(i * 3) % Math.max(1, trunkLanes.length)], s: (i * 137) % 900, speed: 9, length: 11.8, vmax: 11 });
  }
  for (let i = 0; i < NUM_MINIBUSES; i++) {
    const mesh = buildMinibus();
    scene.add(mesh);
    heavy.push({ mesh, lane: lanes[(i * 11) % lanes.length], s: (i * 211) % 700, speed: 11, length: 7.1, vmax: 13 });
  }

  // --- 電車：沿 TRAM 折線來回 ------------------------------------------------------------------
  const tramLine = withLength(HK.TRAM.map((p, i, arr) => {
    const a = arr[Math.max(0, i - 1)];
    const b = arr[Math.min(arr.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: p.x, z: p.z, dx: dx / l, dz: dz / l };
  }));
  const trams = [];
  for (let i = 0; i < NUM_TRAMS; i++) {
    const mesh = buildTram();
    scene.add(mesh);
    trams.push({ mesh, s: (i * tramLine.len) / NUM_TRAMS, speed: 6.5, dir: i % 2 === 0 ? 1 : -1, stop: 0 });
  }

  // --- 天星小輪 ----------------------------------------------------------------------------------
  const ferry = buildFerry();
  scene.add(ferry);
  const ferryState = { t: 0, dir: 1, pause: 0 };
  const ferryFrom = new THREE.Vector3(HK.FERRY.from.x, HK.WATER_LEVEL + 0.6, HK.FERRY.from.z);
  const ferryTo = new THREE.Vector3(HK.FERRY.to.x, HK.WATER_LEVEL + 0.6, HK.FERRY.to.z);

  // --- 更新 --------------------------------------------------------------------------------------
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);

  function place(obj, x, y, z, heading, roll = 0) {
    obj.position.set(x, y, z);
    obj.rotation.set(0, heading, roll);
  }

  function recycleLane(from, cameraPos, minDist) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const lane = lanes[(Math.random() * lanes.length) | 0];
      if (!cameraPos || lane.len < 40) continue;
      const p = poseAt(lane, lane.len * Math.random());
      if (Math.hypot(p.x - cameraPos.x, p.z - cameraPos.z) > minDist) return lane;
    }
    return lanes[(Math.random() * lanes.length) | 0];
  }

  function update(dt, cameraPos) {
    // AI 車
    for (const f of fleets) {
      f.cars.forEach((car, i) => {
        if (!car.lane) return;
        // 簡化 IDM：以同道最近前車的距離決定目標速度
        let gap = Infinity;
        for (const other of cars) {
          if (other === car || other.lane !== car.lane) continue;
          let d = other.s - car.s;
          if (d < 0) d += car.lane.len;
          if (d > 0 && d < gap) gap = d;
        }
        const desired = HK.followSpeed(gap, car.length, 14);
        car.speed += Math.max(-6 * dt, Math.min(3.2 * dt, desired - car.speed));
        car.speed = Math.max(0, Math.min(14, car.speed));
        car.s += car.speed * dt;
        if (car.s >= car.lane.len) {
          car.lane = recycleLane(car, cameraPos, 240);
          car.s = 0;
          car.speed = Math.max(4, car.speed * 0.6);
        }
        const p = poseAt(car.lane, car.s);
        pos.set(p.x, HK.KERB_HEIGHT, p.z);
        quat.setFromAxisAngle(up, p.heading);
        matrix.compose(pos, quat, scale);
        f.mesh.setMatrixAt(i, matrix);
      });
      f.mesh.instanceMatrix.needsUpdate = true;
    }

    // 巴士 / 小巴：同樣跟車，但只跟自己那一條車道的同伴（數量少，直接線性掃）
    for (const v of heavy) {
      if (!v.lane) continue;
      let gap = Infinity;
      for (const other of heavy) {
        if (other === v || other.lane !== v.lane) continue;
        let d = other.s - v.s;
        if (d < 0) d += v.lane.len;
        if (d > 0 && d < gap) gap = d;
      }
      const desired = HK.followSpeed(gap, v.length, v.vmax, 1.25);
      v.speed += Math.max(-5 * dt, Math.min(2.4 * dt, desired - v.speed));
      v.s += v.speed * dt;
      if (v.s >= v.lane.len) {
        v.s = 0;
        v.lane = recycleLane(v.lane, cameraPos, 260);
      }
      const p = poseAt(v.lane, v.s);
      place(v.mesh, p.x, HK.KERB_HEIGHT, p.z, p.heading);
    }

    // 電車：來回折返，終點停 4 秒
    for (const tram of trams) {
      if (tram.stop > 0) {
        tram.stop -= dt;
      } else {
        tram.s += tram.speed * tram.dir * dt;
        if (tram.s > tramLine.len) { tram.s = tramLine.len; tram.dir = -1; tram.stop = 4; }
        if (tram.s < 0) { tram.s = 0; tram.dir = 1; tram.stop = 4; }
      }
      const pose = poseAt(tramLine, tram.s);
      place(tram.mesh, pose.x, HK.KERB_HEIGHT, pose.z, pose.heading + (tram.dir < 0 ? Math.PI : 0));
    }

    // 天星小輪：來回維港
    if (ferryState.pause > 0) {
      ferryState.pause -= dt;
    } else {
      ferryState.t += (dt / (HK.FERRY.minutes * 60)) * ferryState.dir;
      if (ferryState.t >= 1) { ferryState.t = 1; ferryState.dir = -1; ferryState.pause = 20; }
      if (ferryState.t <= 0) { ferryState.t = 0; ferryState.dir = 1; ferryState.pause = 20; }
    }
    const fp = ferryFrom.clone().lerp(ferryTo, ferryState.t);
    const heading = Math.atan2(ferryTo.x - ferryFrom.x, ferryTo.z - ferryFrom.z) + (ferryState.dir < 0 ? Math.PI : 0);
    place(ferry, fp.x, fp.y, fp.z, heading);
  }

  return {
    group,
    lanes,
    cars,
    heavy,
    trams,
    ferry,
    counts: { cars: cars.length, buses: NUM_BUSES, minibuses: NUM_MINIBUSES, trams: NUM_TRAMS, lanes: lanes.length },
    update,
    /** 車道幾何（測試與除錯用） */
    laneAt: (i) => lanes[i % lanes.length]
  };
}
