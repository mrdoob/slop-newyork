import * as THREE from 'three/webgpu';
import * as HK from './config.js';

// js/hk/pedestrians.js
// 香港街上的行人（Phase 3 補完：之前條街係「無人」的）。
//
// 行人走在**行人道**上，而行人道是由走廊推導出來的：
//   第 i 條走廊的左右兩邊各一條行人道，距中心線 offset = road.w/2 + jitter（1.0–3.0 m），
//   所以行人與車道（laneLateral 向左偏移）喺幾何上永遠唔會重疊。
//
// **重用紐約的人物資產**（不是由零開始）：
//   js/pedestrians.js 已經有完整的人體模型 —— buildPersonGeometry()（loft 出嚟的身體、頭髮、鞋）、
//   PersonRig（兩段骨骼的近 IK 步態：腳掌落地、腳跟腳尖、轉向、跑步）同 PersonCrowd
//   （GPU skinning + 程序化衣服，全部人只佔 **2 個 draw call**：近 LOD 同遠 LOD）。
//   香港這邊只負責「行邊條路、幾快、幾時轉彎」，其餘全部交給紐約那套。
//
//   係動態 import：如果那個模組載入失敗（CDN、WebGL2 冇 storage buffer…），
//   會自動退回一個「膠囊人」的簡化版，唔會令整個世界開唔到機。

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

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * @param {THREE.Scene} scene
 * @param {{count?: number, seed?: number, persons?: object|null}} options
 *        persons = { PersonCrowd, PersonRig }（測試或預先載入時可以直接傳入）
 */
export async function createHongKongPedestrians(scene, { count = DEFAULT_COUNT, seed = 1337, persons = null } = {}) {
  const paths = buildSidewalks();
  const group = new THREE.Group();
  group.name = 'HongKongPedestrians';
  scene.add(group);

  if (!paths.length) {
    return { group, pedestrians: [], counts: { pedestrians: 0, sidewalks: 0, model: 'none' }, update() {} };
  }

  const rand = makeRng(seed);
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
    const female = rand() < 0.5;
    people.push({
      path,
      s: rand() * path.len,
      dir: rand() < 0.5 ? 1 : -1,
      speed: 1.05 + rand() * 0.55,
      lateral: (rand() - 0.5) * 2.0,
      scale: (female ? 0.92 : 0.97) + rand() * 0.12,
      female,
      girth: 0.92 + rand() * 0.22,
      hair: rand(),
      armSwing: 0.85 + rand() * 0.3,
      stride: 0.9 + rand() * 0.25,
      seed: Math.floor(rand() * 9973),
      hue: rand(),
      x: 0,
      z: 0,
      heading: 0
    });
  }

  // --- 首選：紐約的人物系統 ---------------------------------------------------------------
  let crowd = null;
  let model = 'capsule';
  let personsApi = persons;
  if (!personsApi) {
    try {
      personsApi = await import('../pedestrians.js');
    } catch (error) {
      console.warn('[hk pedestrians] 紐約人物模型載入失敗，改用簡化版', error);
      personsApi = null;
    }
  }
  if (personsApi?.PersonCrowd && personsApi?.PersonRig) {
    try {
      const { PersonCrowd, PersonRig } = personsApi;
      crowd = new PersonCrowd(count, { farDistance: 45, castShadow: false });
      for (const mesh of crowd.meshes) group.add(mesh);
      for (const p of people) {
        p.rig = new PersonRig({
          seed: p.seed,
          scale: p.scale,
          female: p.female,
          girth: p.girth,
          hair: p.hair,
          armSwing: p.armSwing,
          stride: p.stride
        });
      }
      model = 'nyc-person';
    } catch (error) {
      console.warn('[hk pedestrians] PersonCrowd 建立失敗，改用簡化版', error);
      crowd = null;
      for (const p of people) delete p.rig;
    }
  }

  // --- 後備：膠囊人（2 個 InstancedMesh）--------------------------------------------------
  let bodies = null;
  let heads = null;
  if (!crowd) {
    const bodyMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.05 });
    const headMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9b49a, roughness: 0.75, metalness: 0.02 });
    const bodyGeo = new THREE.CapsuleGeometry(0.24, 0.92, 3, 8);
    bodyGeo.translate(0, 1.02, 0);
    const headGeo = new THREE.SphereGeometry(0.15, 8, 6);
    headGeo.translate(0, 1.72, 0);
    bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, people.length);
    heads = new THREE.InstancedMesh(headGeo, headMat, people.length);
    for (const mesh of [bodies, heads]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    bodies.name = 'HKPedestrianBodies';
    heads.name = 'HKPedestrianHeads';
    const tint = new THREE.Color();
    try {
      people.forEach((p, i) => {
        tint.setHSL(p.hue, 0.42, 0.34 + (i % 5) * 0.06);
        bodies.setColorAt(i, tint);
      });
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    } catch { /* 冇 instanceColor 就用白色 */ }
  }

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scaleV = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  // 紐約的 rig 需要一個 ground(owner, x, z) 函數：香港的行人全部走在同一高度的行人道上
  const ground = () => HK.KERB_HEIGHT;

  function advance(p, dt) {
    p.s += p.speed * p.dir * dt;
    if (p.s > p.path.len) p.s -= p.path.len;
    if (p.s < 0) p.s += p.path.len;
    const pose = walkPose(p.path, p.s, p.lateral);
    p.x = pose.x;
    p.z = pose.z;
    p.heading = pose.heading + (p.dir < 0 ? Math.PI : 0);
    return pose;
  }

  function update(dt = 0.016, cameraPos = null) {
    if (crowd) {
      crowd.begin();
      for (const p of people) {
        advance(p, dt);
        p.rig.update(dt, p.x, p.z, p.heading, ground, null, 0, true);
        const distance = cameraPos ? Math.hypot(p.x - cameraPos.x, p.z - cameraPos.z) : 0;
        crowd.add(p.rig, distance);
      }
      crowd.end();
      return;
    }
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      advance(p, dt);
      pos.set(p.x, HK.KERB_HEIGHT, p.z);
      quat.setFromAxisAngle(up, p.heading);
      scaleV.set(p.scale, p.scale, p.scale);
      matrix.compose(pos, quat, scaleV);
      bodies.setMatrixAt(i, matrix);
      heads.setMatrixAt(i, matrix);
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
  }

  update(0);

  return {
    group,
    pedestrians: people,
    paths,
    meshes: crowd ? crowd.meshes : [bodies, heads],
    counts: { pedestrians: people.length, sidewalks: paths.length, model },
    update
  };
}
