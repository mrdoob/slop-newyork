import * as THREE from 'three/webgpu';
import * as HK from './config.js';
import { poseAt } from './config.js';
import { allocateFleet } from './fleet.js';
import { AI_FLEET, createAiMaterial, buildDoubleDecker, buildTram, buildMinibus, buildFerry } from './vehicles.js';

// js/hk/traffic.js
// 香港靠左行駛的車流。
//
// 車道由走廊推導，不是手擺：每條走廊按行車方向拆成兩條（單程路一條），每條再按 lanesPerWay 分線，
// 而第 i 條線的橫向位置 = 中心線 **向左** (i + 0.5) × 3.4 m（laneLateral / laneCentreOffset，見 config.js）。
// 這一條公式就是「靠左行駛」的全部語意；把 config.js 的 laneLateral 取負號，整個城市立刻變成靠右行駛。
//
// v3 改動（修正「啲車好似棋子咁跳」）：
//   · 以前車一到走廊盡頭就 `car.s = 0; car.lane = 隨機另一條` → 會喺你眼前由一條街**瞬間**跳去另一條街。
//     現在只在**自己條車道**內繞回起點（s -= len），條街唔會變。
//   · 以前巴士同私家車互不相識（各自計 gap），會互相穿過。現在所有車（私家車／巴士／小巴）放入同一張
//     per-lane 表，按 s 排序之後「下一架」就係前車，跨車種一樣會跟車。
//   · 起步位置由亂數改成每條車道平均分佈，所以一開場唔會疊在一起。
//   · 玩家（紅的士）會當成路障：後車會收油，撞到會被推開同大幅減速（以前係直接穿過去）。

const NUM_AI_CARS = 96;
const NUM_BUSES = 8;
const NUM_MINIBUSES = 10;
const NUM_TRAMS = 3;

/** 幫折線加上累積長度（電車線用；車道由 config.js 的 buildLanes 提供）。 */
function withLength(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}

/** 把一批車平均分佈在各自的車道上，回傳 lane → 車的陣列。 */
function spreadOverLanes(vehicles) {
  const byLane = new Map();
  for (const v of vehicles) {
    if (!v.lane) continue;
    const list = byLane.get(v.lane);
    if (list) list.push(v);
    else byLane.set(v.lane, [v]);
  }
  for (const [lane, list] of byLane) {
    list.sort(() => 0); // 保持原本次序（用 index 做穩定分佈）
    const step = lane.len / list.length;
    list.forEach((v, i) => {
      v.s = step * (i + 0.5);
      v.speed = Math.min(v.speed ?? 9, v.vmax ?? 14);
    });
  }
  return byLane;
}

export function createHongKongTraffic(scene) {
  const lanes = HK.buildLanes();
  const group = new THREE.Group();
  group.name = 'HongKongTraffic';
  scene.add(group);

  // --- AI 私家車／的士：每種顏色一個 InstancedMesh ------------------------------------------------
  // 容量由 allocateFleet 一次過算好，總和必定等於 NUM_AI_CARS，所以下面完全沒有「找一個未滿的車隊」
  // 這種 while 迴圈（舊寫法容量加起來只有 95，第 96 架車會無限迴圈鎖死主執行緒）。
  const capacities = allocateFleet(AI_FLEET.map((f) => f.share), NUM_AI_CARS);
  const fleets = AI_FLEET.map((entry, i) => ({ entry, capacity: capacities[i], cars: [], mesh: null }));
  let carIndex = 0;
  for (const f of fleets) {
    for (let k = 0; k < f.capacity; k++) {
      const i = carIndex++;
      f.cars.push({
        lane: lanes[(i * 7) % lanes.length],
        s: 0,
        speed: 8 + ((i * 13) % 7),
        length: 4.6,
        vmax: 14,
        kind: 'car'
      });
    }
  }
  for (const f of fleets) {
    if (!f.cars.length) continue; // 某車型分到 0 架：唔需要建 InstancedMesh
    const geo = f.entry.geometry();
    const mesh = new THREE.InstancedMesh(geo, createAiMaterial(f.entry), f.cars.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `HKAI_${f.entry.id}`;
    group.add(mesh);
    f.mesh = mesh;
  }
  const cars = fleets.flatMap((f) => f.cars);

  // --- 雙層巴士、小巴（沿最外側車道） --------------------------------------------------------
  const heavy = [];
  const trunkLanes = lanes.filter((l) => l.road.cls === 'trunk' && l.isKerbLane);
  const busLanes = trunkLanes.length ? trunkLanes : lanes.filter((l) => l.isKerbLane);
  for (let i = 0; i < NUM_BUSES; i++) {
    const mesh = buildDoubleDecker();
    scene.add(mesh);
    heavy.push({ mesh, lane: busLanes[(i * 3) % busLanes.length], s: 0, speed: 9, length: 11.8, vmax: 11, kind: 'bus' });
  }
  for (let i = 0; i < NUM_MINIBUSES; i++) {
    const mesh = buildMinibus();
    scene.add(mesh);
    heavy.push({ mesh, lane: lanes[(i * 11) % lanes.length], s: 0, speed: 11, length: 7.1, vmax: 13, kind: 'minibus' });
  }
  // 私家車、巴士、小巴**一齊**分佈：如果分開做，巴士會啱啱好疊在一架私家車上面
  spreadOverLanes([...cars, ...heavy]);

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

  // 全部會行嘅車（私家車 + 巴士 + 小巴）放埋一齊，跟車邏輯就唔會分車種
  const movers = [...cars, ...heavy];

  function place(obj, x, y, z, heading, roll = 0) {
    obj.position.set(x, y, z);
    obj.rotation.set(0, heading, roll);
  }

  /**
   * 玩家當成路障：喺同一條走廊、同一方向、前方 45 m 內就當係一架「前車」。
   * 回傳玩家前方最近的間距（Infinity = 附近冇人）。
   */
  function playerGap(lane, s, player) {
    if (!player) return Infinity;
    const p = poseAt(lane, s);
    const dx = player.x - p.x;
    const dz = player.z - p.z;
    const forward = dx * Math.sin(p.heading) + dz * Math.cos(p.heading);
    if (forward < 0) return Infinity; // 在後面：唔關事
    const lateral = Math.abs(dx * Math.cos(p.heading) - dz * Math.sin(p.heading));
    if (lateral > 4.2) return Infinity; // 唔係同一條線
    const along = Math.hypot(dx, dz);
    return along > 45 ? Infinity : along;
  }

  function update(dt, cameraPos, playerState = null) {
    // ① per-lane 排序：任何車的「前車」就是排序後的下一個（跨車種）
    const byLane = new Map();
    for (const v of movers) {
      if (!v.lane) continue;
      const list = byLane.get(v.lane);
      if (list) list.push(v);
      else byLane.set(v.lane, [v]);
    }

    for (const [lane, list] of byLane) {
      list.sort((a, b) => a.s - b.s);
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const cur = list[i];
        let gap = Infinity;
        if (n > 1) {
          const next = list[(i + 1) % n];
          gap = next.s - cur.s;
          if (gap <= 0) gap += lane.len;
        }
        const pg = playerGap(lane, cur.s, playerState);
        if (pg < gap) gap = Math.max(0, pg - 4.5);
        const desired = HK.followSpeed(gap, cur.length, cur.vmax ?? 14);
        cur.speed += Math.max(-6.5 * dt, Math.min(3.2 * dt, desired - cur.speed));
        cur.speed = Math.max(0, Math.min(cur.vmax ?? 14, cur.speed));
        const prevS = cur.s;
        cur.s += cur.speed * dt;
        // 只在自己條車道內繞返起點：唔會再「棋子跳」去第二條街。
        // 但繞圈之前要確認「起點」冇車：否則會出現兩架車疊在同一個位（實測最細間距 0.01 m）。
        if (cur.s >= lane.len) {
          const wrapped = cur.s - lane.len;
          let ahead = Infinity;
          for (const other of list) {
            if (other === cur) continue;
            const rel = other.s >= wrapped ? other.s : other.s + lane.len;
            if (rel < ahead) ahead = rel;
          }
          if (ahead === Infinity || ahead - wrapped >= cur.length + 3) {
            cur.s = wrapped;
          } else {
            cur.s = Math.min(prevS, lane.len - 0.01); // 排隊等位（下一幀再試），唔可以疊住前面
            cur.speed = 0;
          }
        }
        if (cur.s < 0) cur.s += lane.len;
      }
    }

    // ② 放置：私家車用 InstancedMesh
    for (const f of fleets) {
      if (!f.mesh) continue;
      f.cars.forEach((car, i) => {
        const p = poseAt(car.lane, car.s);
        pos.set(p.x, HK.KERB_HEIGHT, p.z);
        quat.setFromAxisAngle(up, p.heading);
        matrix.compose(pos, quat, scale);
        f.mesh.setMatrixAt(i, matrix);
      });
      f.mesh.instanceMatrix.needsUpdate = true;
    }
    // 巴士／小巴
    for (const v of heavy) {
      if (!v.lane) continue;
      const p = poseAt(v.lane, v.s);
      place(v.mesh, p.x, HK.KERB_HEIGHT, p.z, p.heading);
    }

    // ③ 電車：來回折返，終點停 4 秒
    for (const tram of trams) {
      if (tram.stop > 0) {
        tram.stop -= dt;
      } else {
        tram.s += tram.speed * tram.dir * dt;
        if (tram.s > tramLine.len) { tram.s = tramLine.len; tram.dir = -1; tram.stop = 4; }
        if (tram.s < 0) { tram.s = 0; tram.dir = 1; tram.stop = 4; }
      }
      const pose = poseAt(tramLine, tram.s);
      place(tram.mesh, pose.x, pose.y ?? HK.KERB_HEIGHT, pose.z, pose.heading + (tram.dir < 0 ? Math.PI : 0));
      tram.mesh.position.y = HK.KERB_HEIGHT;
    }

    // ④ 天星小輪：來回維港
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

  /**
   * 玩家撞車：把玩家推出車身 + 大幅減速。回傳 { hit, x, z, speed, other }。
   * （以前完全冇這一層，所以「撞車無反應」。）
   */
  function collidePlayer(player) {
    if (!player) return { hit: false };
    const reach = 3.2;
    let hit = null;
    for (const v of movers) {
      if (!v.lane) continue;
      const p = poseAt(v.lane, v.s);
      const dx = player.x - p.x;
      const dz = player.z - p.z;
      if (Math.abs(dx) > 14 || Math.abs(dz) > 14) continue;
      const d = Math.hypot(dx, dz);
      if (d > reach + (v.kind === 'car' ? 1.2 : 2.4)) continue;
      hit = { p, d, kind: v.kind };
      break;
    }
    if (!hit) return { hit: false };
    const nx = hit.d > 1e-3 ? (player.x - hit.p.x) / hit.d : 1;
    const nz = hit.d > 1e-3 ? (player.z - hit.p.z) / hit.d : 0;
    const push = reach + 0.6 - hit.d;
    player.x += nx * Math.max(0.2, push);
    player.z += nz * Math.max(0.2, push);
    player.speed *= 0.15;
    return { hit: true, kind: hit.kind };
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
    collidePlayer,
    /** 車道幾何（測試與除錯用） */
    laneAt: (i) => lanes[i % lanes.length]
  };
}
