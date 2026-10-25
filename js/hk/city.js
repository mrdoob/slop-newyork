import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCurtainWallMaterial, createPreWarBuildingMaterial, createFacadeBoxes, WALL_KINDS } from '../tsl-materials.js';
import * as HK from './config.js';
import { buildRoadMarkings, dedupe } from './markings.js';

// js/hk/city.js
// 香港城市場景：維港水面、填海陸地與海堤、道路走廊（路面＋行人道＋路緣）、行車標線、沿街樓宇、地標、街燈、電車軌。
//
// 幾何全部由 js/hk-geodata.js 推導 —— 沒有一棟樓、一條線是手擺的。樓宇立面直接用紐約那邊已經寫好的
// boxLocal facade 材質（createFacadeBoxes + createCurtainWallMaterial / createPreWarBuildingMaterial），
// 所以窗戶是「真實米數」的（2.8 m 一間、3.8 m 一層），不會因為樓高 30 m 或 250 m 而被拉長。

const Y = {
  water: HK.WATER_LEVEL,
  land: 0,
  footway: HK.KERB_HEIGHT,
  asphalt: HK.KERB_HEIGHT + 0.005,
  paint: HK.KERB_HEIGHT + 0.02,
  rail: HK.KERB_HEIGHT + 0.025
};

// --- 幾何工具 ---------------------------------------------------------------------------------------------

/** 沿折線的連續帶狀面（含斜接法線，轉彎不會斷開）。 */
function ribbon(inputPts, width, y, { uAlong = 8, skirt = 0, normalSign = 1 } = {}) {
  const pts = dedupe(inputPts);
  const n = pts.length;
  if (n < 2) return null;
  const pos = [];
  const uv = [];
  const idx = [];
  const left = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    left.push({ x: dz * normalSign, z: -dx * normalSign });
  }
  let along = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) along += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const l = left[i];
    const half = width / 2;
    pos.push(pts[i].x + l.x * half, y, pts[i].z + l.z * half);
    pos.push(pts[i].x - l.x * half, y, pts[i].z - l.z * half);
    uv.push(0, along / uAlong, 1, along / uAlong);
  }
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (!skirt) return geo;
  // 路緣石：沿兩側加垂直裙邊
  const skirtPos = [];
  const skirtUv = [];
  const skirtIdx = [];
  let base = 0;
  for (const side of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const l = left[i];
      const half = (width / 2) * side;
      skirtPos.push(pts[i].x + l.x * half, y, pts[i].z + l.z * half);
      skirtPos.push(pts[i].x + l.x * half, y - skirt, pts[i].z + l.z * half);
      const v = i * 0.5;
      skirtUv.push(0, v, 1, v);
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = base + i * 2;
      skirtIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += n * 2;
  }
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3));
  skirtGeo.setAttribute('uv', new THREE.Float32BufferAttribute(skirtUv, 2));
  skirtGeo.setIndex(skirtIdx);
  skirtGeo.computeVertexNormals();
  return { top: geo, skirt: skirtGeo };
}

// --- 水面與陸地 -------------------------------------------------------------------------------------------

function buildHarbour(group) {
  const waterMat = new THREE.MeshStandardNodeMaterial({ color: 0x0b2f3d, roughness: 0.05, metalness: 0.72 });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = Y.water;
  water.receiveShadow = false;
  water.name = 'VictoriaHarbour';
  group.add(water);

  const landMat = new THREE.MeshStandardNodeMaterial({ color: 0x53514a, roughness: 0.94, metalness: 0.02 });
  const quayMat = new THREE.MeshStandardNodeMaterial({ color: 0x6f6a60, roughness: 0.9, metalness: 0.04 });
  const slabs = [];
  const quays = [];
  // 用真實海岸線（地政總署陸地邊界，見 js/hk-coastline.js）而唔係手繪的三塊「雲」：
  // 之前中環、尖沙咀、紅磡灣的海岸線全部係直線，水面同陸地的交界一眼就假。
  const buildSlab = (rings) => {
    const geos = [];
    for (const ring of rings) {
      const shape = new THREE.Shape();
      ring.forEach((p, i) => {
        // Shape 在 XY 平面；rotated -90° 之後 world z = −y，所以這裡要餵 −z
        if (i === 0) shape.moveTo(p.x, -p.z);
        else shape.lineTo(p.x, -p.z);
      });
      const geo = new THREE.ExtrudeGeometry(shape, { depth: -Y.water, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, Y.water, 0);
      geos.push(geo);
    }
    return geos;
  };
  // 遠景（新界、大嶼山、離島）：只鋪一條低矮的陸地，主要用來擋住「海到天邊」的假象
  const farRings = (HK.COAST?.territory || []).map((ring) => ring.filter((_, i) => i % 2 === 0));
  if (farRings.length) {
    const far = new THREE.Mesh(mergeGeometries(buildSlab(farRings)), landMat);
    far.receiveShadow = false;
    far.name = 'HongKongTerritory';
    group.add(far);
  }
  const nearRings = HK.COAST?.land?.length ? HK.COAST.land : HK.LAND.map((l) => l.pts);
  slabs.push(...buildSlab(nearRings));
  for (const l of HK.LAND) quays.push({ id: l.id, zh: l.zh });
  const land = new THREE.Mesh(mergeGeometries(slabs), landMat);
  land.receiveShadow = true;
  land.name = 'HongKongLand';
  group.add(land);
  return { water, land, quays };
}

// --- 道路 -------------------------------------------------------------------------------------------------

function buildRoads(group) {
  const footwayGeos = [];
  const asphaltGeos = [];
  for (const road of HK.ROADS) {
    const footway = ribbon(road.pts, road.w + HK.SIDEWALK * 2, Y.footway, { uAlong: 10, skirt: HK.KERB_HEIGHT });
    if (footway) {
      footwayGeos.push(footway.top, footway.skirt);
    }
    const asphalt = ribbon(road.pts, road.w, Y.asphalt, { uAlong: 12 });
    if (asphalt) asphaltGeos.push(asphalt);
  }
  const footwayMat = new THREE.MeshStandardNodeMaterial({ color: 0x8d8779, roughness: 0.92, metalness: 0.0 });
  const asphaltMat = new THREE.MeshStandardNodeMaterial({ color: 0x25272a, roughness: 0.85, metalness: 0.03 });
  const footways = new THREE.Mesh(mergeGeometries(footwayGeos), footwayMat);
  footways.receiveShadow = true;
  footways.name = 'HongKongFootways';
  const asphalt = new THREE.Mesh(mergeGeometries(asphaltGeos), asphaltMat);
  asphalt.receiveShadow = true;
  asphalt.name = 'HongKongRoads';
  group.add(footways, asphalt);

  // 標線：一次過寫入單一 typed array（見 markings.js），香港靠左行駛，左右以行車方向為準。
  // 舊寫法為每條虛線段開一個 BufferGeometry 再 merge，香港走廊是一萬三千個，會鎖死主執行緒。
  const marks = buildRoadMarkings(HK.ROADS, { laneWidth: HK.LANE_WIDTH, y: Y.paint });
  const paintGeo = new THREE.BufferGeometry();
  paintGeo.setAttribute('position', new THREE.BufferAttribute(marks.positions, 3));
  paintGeo.setIndex(new THREE.BufferAttribute(marks.indices, 1));
  paintGeo.computeVertexNormals();
  const paintMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e6dc, roughness: 0.6, metalness: 0.0 });
  paintMat.polygonOffset = true;
  paintMat.polygonOffsetFactor = -1;
  const paint = new THREE.Mesh(paintGeo, paintMat);
  paint.name = 'HongKongRoadPaint';
  group.add(paint);
  return { footways, asphalt, paint };
}

// --- 樓宇 -------------------------------------------------------------------------------------------------

function buildBuildings(group) {
  const towers = [];
  const midRise = [];
  for (const b of HK.BUILDINGS) {
    const street = WALL_KINDS.shop;
    const entry = WALL_KINDS.entry;
    const side = WALL_KINDS.lotLine;
    // 本地 +X 沿街，所以臨街面是 ±Z；兩側是鄰地，背面是後巷
    const faces = [side, side, street, entry];
    const rec = { x: b.x, y: b.h / 2, z: b.z, w: b.w, h: b.h, d: b.d, ry: -b.rot, tone: 0.72, faces };
    const isTower = b.tower === 1 || (b.tower === undefined && b.h >= 120);
    (isTower ? towers : midRise).push(rec);
  }
  const curtain = createCurtainWallMaterial({
    boxLocal: true,
    glassTint: 0x1b3546,
    frameTint: 0x2c3a43,
    windowWidth: 2.6,
    floorHeight: 3.6,
    litProbability: 0.42,
    warmth: 0.5,
    reflectivity: 0.9,
    seed: 2
  });
  const prewar = createPreWarBuildingMaterial({
    boxLocal: true,
    stoneColor: 0xb9b1a2,
    trimColor: 0xd8d2c4,
    windowWidth: 2.4,
    floorHeight: 3.2,
    litProbability: 0.36,
    warmth: 0.72,
    cornerPier: 0.6,
    seed: 5
  });
  const towerMesh = createFacadeBoxes(curtain, towers);
  towerMesh.castShadow = true;
  towerMesh.receiveShadow = true;
  towerMesh.name = 'HongKongTowers';
  const midMesh = createFacadeBoxes(prewar, midRise);
  midMesh.castShadow = true;
  midMesh.receiveShadow = true;
  midMesh.name = 'HongKongMidRise';
  group.add(towerMesh, midMesh);
  return { towerMesh, midMesh, count: towers.length + midRise.length };
}

// --- 地標 -------------------------------------------------------------------------------------------------

function buildLandmarks(group, tallSet) {
  const meshes = [];
  const crownMat = new THREE.MeshStandardNodeMaterial({ color: 0xdfe8f2, roughness: 0.2, metalness: 0.8 });

  // 地標唔再用「淨色盒」：塔樓用帷幕牆、civic / 會堂用戰前石牆，同沿街樓宇同一套 TSL 立面，
  // 所以窗戶是真實米數的，唔會出現一塊冇材質的灰色大方塊（用家原話：「亦無材質」）。
  const curtain = createCurtainWallMaterial({
    boxLocal: true, glassTint: 0x254a63, frameTint: 0x39474f,
    windowWidth: 2.4, floorHeight: 3.8, litProbability: 0.5, warmth: 0.45, reflectivity: 0.95, seed: 11
  });
  const stone = createPreWarBuildingMaterial({
    boxLocal: true, stoneColor: 0xc9c0ad, trimColor: 0xe0d9c8,
    windowWidth: 2.6, floorHeight: 3.6, litProbability: 0.3, warmth: 0.6, cornerPier: 0.8, seed: 13
  });

  const towerRecords = [];
  const civicRecords = [];
  for (const lm of HK.LANDMARKS) {
    const isCivic = lm.kind === 'civic' || lm.kind === 'hall' || lm.kind === 'pier';
    const faces = [WALL_KINDS.lotLine, WALL_KINDS.lotLine, WALL_KINDS.shop, WALL_KINDS.entry];
    const rec = { x: lm.x, y: lm.h / 2 + Y.land, z: lm.z, w: lm.w, h: lm.h, d: lm.d, ry: 0, tone: isCivic ? 0.95 : 0.8, faces };
    (isCivic ? civicRecords : towerRecords).push(rec);
  }
  if (towerRecords.length) {
    const mesh = createFacadeBoxes(curtain, towerRecords);
    mesh.name = 'HKLMTowers';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes.push(mesh);
    tallSet.push(mesh);
  }
  if (civicRecords.length) {
    const mesh = createFacadeBoxes(stone, civicRecords);
    mesh.name = 'HKLMCivic';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    meshes.push(mesh);
    tallSet.push(mesh);
  }

  // 天台冠／桅杆：ICC、國金、中銀、中環廣場的輪廓記憶點
  const crowns = [];
  const crownGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
  for (const lm of HK.LANDMARKS) {
    if (lm.h <= 150) continue;
    const c = crownGeo.clone();
    c.scale(lm.w * 0.16, lm.h * 0.06, lm.w * 0.16);
    c.translate(lm.x, lm.h + (lm.h * 0.06) / 2, lm.z);
    crowns.push(c);
  }
  if (crowns.length) {
    const crown = new THREE.Mesh(mergeGeometries(crowns), crownMat);
    crown.name = 'HKLMCrowns';
    group.add(crown);
    meshes.push(crown);
  }
  return meshes;
}

// --- 街燈、電車軌 -----------------------------------------------------------------------------------------

function buildStreetFurniture(group) {
  const poles = [];
  const heads = [];
  for (const road of HK.ROADS) {
    let side = 1;
    for (let s = 18; s < road.len - 12; s += 34) {
      const p = HK.alongRoad(road, s);
      const left = HK.laneLateral(p.dx, p.dz);
      const off = road.w / 2 + HK.SIDEWALK - 1.1;
      poles.push({ x: p.x + left.x * off * side, z: p.z + left.z * off * side, y: 4.2 });
      heads.push({ x: p.x + left.x * off * side, z: p.z + left.z * off * side, y: 8.35 });
      side = -side;
    }
  }
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 8.4, 6);
  const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.5 });
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, poles.length);
  const m = new THREE.Matrix4();
  poles.forEach((p, i) => poleMesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  poleMesh.castShadow = true;
  group.add(poleMesh);

  const headGeo = new THREE.BoxGeometry(0.9, 0.16, 0.34);
  const headMat = new THREE.MeshBasicNodeMaterial({ color: 0xfff0c8 });
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, heads.length);
  heads.forEach((p, i) => headMesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  group.add(headMesh);

  // 電車軌：兩條 1,435 mm 軌距的鋼軌
  const railMat = new THREE.MeshStandardNodeMaterial({ color: 0x8b8f94, roughness: 0.28, metalness: 0.9 });
  const tramRails = [];
  for (const off of [0.72, -0.72]) {
    const pts = HK.TRAM.map((p, i) => {
      const a = HK.TRAM[Math.max(0, i - 1)];
      const b = HK.TRAM[Math.min(HK.TRAM.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: p.x + (dz / len) * off, z: p.z - (dx / len) * off };
    });
    const geo = ribbon(pts, 0.13, Y.rail);
    if (geo) tramRails.push(geo);
  }
  const railMesh = new THREE.Mesh(mergeGeometries(tramRails), railMat);
  railMesh.name = 'HongKongTramRails';
  group.add(railMesh);

  return { lampHeads: headMesh, lampHeadMat: headMat, lampCount: heads.length };
}

// --- 組裝 -------------------------------------------------------------------------------------------------

export async function buildHongKongCity(scene, { onProgress = async () => {} } = {}) {
  const group = new THREE.Group();
  group.name = 'HongKongCity';
  scene.add(group);

  await onProgress('海岸線與維港水面…');
  const harbour = buildHarbour(group);
  await onProgress('道路、行人道與標線…');
  const roads = buildRoads(group);
  await onProgress('沿街樓宇…');
  const buildings = buildBuildings(group);
  await onProgress('地標與街道家具…');
  const tallSet = [];
  const landmarks = buildLandmarks(group, tallSet);
  const furniture = buildStreetFurniture(group);

  // 玩家碰撞：樓宇與地標的 AABB（只做粗略阻擋，夠用於駕駛）
  const colliders = [];
  for (const b of HK.BUILDINGS) {
    const c = Math.abs(Math.cos(b.rot));
    const s = Math.abs(Math.sin(b.rot));
    const hx = (b.w * c + b.d * s) / 2;
    const hz = (b.w * s + b.d * c) / 2;
    colliders.push({ minX: b.x - hx, maxX: b.x + hx, minZ: b.z - hz, maxZ: b.z + hz, minY: 0, maxY: b.h });
  }
  for (const lm of HK.LANDMARKS) {
    colliders.push({ minX: lm.x - lm.w / 2, maxX: lm.x + lm.w / 2, minZ: lm.z - lm.d / 2, maxZ: lm.z + lm.d / 2, minY: 0, maxY: lm.h });
  }

  return {
    group,
    colliders,
    // landmarks 數的是**地標數量**（不是 mesh 數）：塔樓／civic 合併成 2 個 facade mesh + 1 個冠
    counts: { buildings: buildings.count, landmarks: HK.LANDMARKS.length, landmarkMeshes: landmarks.length, lamps: furniture.lampCount, roads: HK.ROADS.length },
    setNight(night) {
      // 街燈燈頭在夜間才亮（MeshBasic 不看光照，但可以整體調暗）
      furniture.lampHeads.visible = night > 0.15;
    }
  };
}
