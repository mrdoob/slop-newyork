import * as THREE from 'three/webgpu';
import * as HK from './config.js';

// js/hk/pedestrians.js
// 香港街上的行人（Phase 3 補完：之前條街係「無人」的）。
//
// 行人走在**行人道**上，而行人道是由走廊推導出來的：
//   第 i 條走廊的左右兩邊各一條行人道，距中心線 offset = road.w/2 + jitter（1.0–3.0 m），
//   所以行人與車道（laneLateral 向左偏移）喺幾何上永遠唔會重疊。
//
// 效能：全部行人只有 **2 個 InstancedMesh**（身體 + 頭），每個 instance 自己一個矩陣同顏色，
// 300 人 = 2 個 draw call。行路節奏用 sin 做上下起伏，唔需要骨骼動畫。

const DEFAULT_COUNT = 300;

/** 由走廊推導行人道折線（純函數，測試可以直接用）。 */
export function buildSidewalks(roads = HK.ROADS) {
  const paths = [];
  for (const road of roads) {
    const offset = road.w / 2 + HK.SIDEWALK / 2;
    for (const side of [1, -1]) {
      const pts = [];
      for (let i = 0; i < road.pts.length; i++) {
        const a = road.pts[Math.max(0, i - 1)];
        const b = road.pts[Math.min(road.pts.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const left = HK.laneLateral(dx / len, dz / len);
        const p = road.pts[i];
        pts.push({ x: p.x + left.x * offset * side, z: p.z + left.z * offset * side });
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const len = cum[cum.length - 1];
      if (len > 20) paths.push({ road, side, pts, cum, len });
    }
  }
  return paths;
}

/** 行人道上的位置（s 為沿線距離，lateral 為再向內／外的偏移）。 */
export function walkPose(path, s, lateral = 0) {
  const t = Math.max(0, Math.min(path.len, s));
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i] < t) i++;
  const a = path.pts[i - 1];
  const b = path.pts[i];
  const segLen = path.cum[i] - path.cum[i - 1] || 1;
  const k = (t - path.cum[i - 1]) / segLen;
  const x = a.x + (b.x - a.x) * k;
  const z = a.z + (b.z - a.z) * k;
  const dx = (b.x - a.x) / segLen;
  const dz = (b.z - a.z) / segLen;
  const left = HK.laneLateral(dx, dz);
  return {
    x: x + left.x * lateral,
    z: z + left.z * lateral,
    heading: Math.atan2(dx, dz),
    dx,
    dz
  };
}

export function createHongKongPedestrians(scene, { count = DEFAULT_COUNT, seed = 1337 } = {}) {
  const paths = buildSidewalks();
  if (!paths.length) {
    return { group: new THREE.Group(), pedestrians: [], counts: { pedestrians: 0 }, update() {} };
  }

  // 可重現的偽隨機（同一條街每次載入都一樣，方便重現 bug）
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const totalLen = paths.reduce((sum, p) => sum + p.len, 0);
  const people = [];
  for (let i = 0; i < count; i++) {
    // 按街道長度加權選一條行人道
    let pick = rand() * totalLen;
    let path = paths[paths.length - 1];
    for (const candidate of paths) {
      pick -= candidate.len;
      if (pick <= 0) { path = candidate; break; }
    }
    people.push({
      path,
      s: rand() * path.len,
      dir: rand() < 0.5 ? 1 : -1,
      speed: 1.05 + rand() * 0.55,
      lateral: (rand() - 0.5) * 2.0,
      phase: rand() * Math.PI * 2,
      scale: 0.9 + rand() * 0.18,
      hue: rand()
    });
  }

  const group = new THREE.Group();
  group.name = 'HongKongPedestrians';

  const bodyMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.05 });
  const headMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9b49a, roughness: 0.75, metalness: 0.02 });
  const bodyGeo = new THREE.CapsuleGeometry(0.24, 0.92, 3, 8);
  bodyGeo.translate(0, 1.02, 0);
  const headGeo = new THREE.SphereGeometry(0.15, 8, 6);
  headGeo.translate(0, 1.72, 0);

  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, people.length);
  const heads = new THREE.InstancedMesh(headGeo, headMat, people.length);
  for (const mesh of [bodies, heads]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false; // 300 個小人投影唔值錢，關掉省一半 shadow pass
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  bodies.name = 'HKPedestrianBodies';
  heads.name = 'HKPedestrianHeads';

  // 衫的顏色：每個人一個 instanceColor（唔支援就靜靜留白色）
  const tint = new THREE.Color();
  try {
    people.forEach((p, i) => {
      const hue = p.hue;
      tint.setHSL(hue, 0.42, 0.34 + (i % 5) * 0.06);
      bodies.setColorAt(i, tint);
    });
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  } catch (error) {
    console.warn('[hk pedestrians] per-instance colour unavailable', error);
  }

  scene.add(group);

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scaleV = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let clock = 0;

  function update(dt) {
    clock += dt;
    people.forEach((p, i) => {
      p.s += p.speed * p.dir * dt;
      if (p.s > p.path.len) p.s -= p.path.len;
      if (p.s < 0) p.s += p.path.len;
      const pose = walkPose(p.path, p.s, p.lateral);
      const bob = Math.abs(Math.sin(clock * 4 + p.phase)) * 0.05;
      pos.set(pose.x, HK.KERB_HEIGHT + bob, pose.z);
      quat.setFromAxisAngle(up, pose.heading + (p.dir < 0 ? Math.PI : 0));
      scaleV.set(p.scale, p.scale, p.scale);
      matrix.compose(pos, quat, scaleV);
      bodies.setMatrixAt(i, matrix);
      heads.setMatrixAt(i, matrix);
    });
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
  }

  update(0);

  return {
    group,
    pedestrians: people,
    paths,
    counts: { pedestrians: people.length, sidewalks: paths.length },
    update
  };
}
