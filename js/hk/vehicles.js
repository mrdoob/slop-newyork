import * as THREE from 'three/webgpu';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, createLoftedCarMaterial } from '../actor-models.js';

// js/hk/vehicles.js
// 香港車種：紅的士（市區的士）、雙層巴士、電車、小巴、天星小輪，以及 AI 車流用的低模。
//
// 紅的士直接重用 actor-models.js 的放樣（LoftGeometry）車體與車漆材質 —— 那套幾何是城市無關的，
// 換一個 fixedColorHex 就是香港市區的士的紅色。巴士／電車／小輪是簡單量體，但比例、顏色與窗帶照香港做。

export const HK_COLORS = {
  taxi: 0xb5121b, // 市區的士紅
  taxiRoof: 0xd9d9d9,
  kmbRed: 0xc8342c,
  kmbCream: 0xe8e2d4,
  tramGreen: 0x1f6b45,
  tramCream: 0xefe9d8,
  minibusCream: 0xf0ead8,
  minibusGreen: 0x2f7d4f,
  ferryGreen: 0x1f5f45,
  ferryWhite: 0xf2f2ee
};

const mat = (color, opts = {}) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.42, metalness: 0.25, ...opts });

function windowBand(w, h, d, y, thickness = 0.04) {
  const g = new THREE.Group();
  for (const side of [-1, 1]) {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h, thickness), mat(0x0d1a22, { roughness: 0.12, metalness: 0.6 }));
    glass.position.set(0, y, (side * d) / 2);
    g.add(glass);
  }
  return g;
}

function wheels(count, radius, width, x, zs) {
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(radius, radius, width, 14);
  geo.rotateZ(Math.PI / 2);
  const m = mat(0x14161a, { roughness: 0.85, metalness: 0.05 });
  for (const z of zs) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(geo, m);
      wheel.position.set(side * x, radius, z);
      wheel.castShadow = true;
      g.add(wheel);
    }
  }
  return g;
}

/**
 * 香港市區的士（豐田 Crown Comfort 比例）的車身規格。
 *
 * 為什麼要另開一個 spec 而唔直接用 `BODY_SPECS.taxi`：紐約那部是的士化的房車（圓潤、低頂、斜擋風玻璃），
 * 而香港紅的係一部**方正、高身、直立**的 1980 年代三箱轎車：
 *   · 車身 4.68 × 1.70 × 1.50 m，軸距 2.68 m
 *   · 近乎垂直的 A 柱、C 柱，平頂，腰線又長又直
 *   · 四角用超高橢圓（lowerRound / upperRound ≈ 5）令稜角分明
 *   · 上半身銀白、下半身紅（twoTone）
 *   · 沙板鏡（fenderMirror）—— 全車最易認的細節
 * 所有數值都寫在真人可對照的米數上，方便日後按實車微調。
 */
export const HK_TAXI_SPEC = (() => {
  const spec = {
    ...BODY_SPECS.sedan,
    name: 'hk-red-taxi',
    zFront: 2.34,
    zRear: -2.34,
    wheelRadius: 0.315,
    wheelZ: 1.34,
    wheelX: 0.735,
    archGap: 0.055,
    archFlare: 0.006,
    tuck: 0.048,
    lowerRound: 4.6,
    upperRound: 5.2,
    upperSamples: [0.5, 0.8, 1],
    stationStep: 0.2,
    halfWidth: [[2.34, 0.842], [1.34, 0.85], [0, 0.852], [-1.34, 0.85], [-2.34, 0.842]],
    sill: [[2.34, 0.3], [1.3, 0.275], [-1.3, 0.275], [-2.34, 0.305]],
    shoulder: [[2.34, 0.6], [0, 0.618], [-2.34, 0.628]],
    edge: [[2.24, 0.875], [1.6, 0.9], [0.95, 0.915], [0.6, 0.918], [-1.2, 0.925], [-1.9, 0.918], [-2.24, 0.9]],
    crown: [[2.24, 0.016], [1.0, 0.012], [0.62, 0.002], [-1.9, 0.002], [-2.24, 0.01]],
    tumble: [[2.34, 0.06], [0.95, 0.045], [-1.6, 0.04], [-2.34, 0.055]],
    nose: { halfWidth: [0.16, 0.83, 5], edge: [0.14, 0.855, 5], crown: [0.14, 0.012, 4], sill: [0.14, 0.33, 4], shoulder: [0.14, 0.6, 4] },
    tail: { halfWidth: [0.15, 0.832, 5], edge: [0.12, 0.9, 5], crown: [0.12, 0.012, 4], sill: [0.13, 0.335, 4], shoulder: [0.14, 0.61, 4] },
    cabin: {
      cowl: 0.96,
      roofFront: 0.6,
      roofRear: -1.4,
      deck: -1.86,
      roofY: [[0.6, 1.478], [-1.4, 1.478]],
      rail: [0.7, 0.7],
      inset: 0.016,
      bulge: 0.002,
      roofEdge: 0.022,
      roofCrown: 0.008,
      roofRound: 22,
      pillars: [-0.3]
    },
    doors: [0.92, -0.34, -1.06],
    handles: [-0.18, -0.94],
    headlight: [0.56, 0.63, 0.235, 0.072],
    taillight: [0.575, 0.8, 0.25, 0.082],
    grille: [0.635, 0.3, 0.055],
    intake: [0.37, 0.42, 0.042],
    plates: [0.46, 0.6],
    bumperLine: [0.72, 0.6],
    bumpers: [[0.42, 0.058], [0.46, 0.058]],
    chrome: true,
    cladding: 0,
    sign: true,
    rails: false,
    rearWiper: false,
    twoTone: 0xdfe4e6,
    doorMirrors: false, // 香港的士用沙板鏡，唔要車門鏡
    fenderMirror: { z: 1.28, y: 0.88, x: 0.7 },
    signSize: { hw0: 0.27, hw1: 0.25, h: 0.185, depth: 0.3 },
    // 香港的士塗裝：黑色橡膠泵把、鍍鉻橫間鬼面罩 + 綠色「TAXI 5 SEATS」牌、白前牌 / 黃後牌、
    // 車門車隊證、車頂白底紅字「TAXI」燈箱（全部由 TSL 材質在同一個 draw call 內畫）
    livery: 'hk-taxi',
    headlampsOn: true, // 香港的士日夜開燈（玩家車頭燈因此長着）
    hk: { badgeX: 0.155 }
  };
  // 由 sedan 展開：唔可以帶走 sedan 已計算好的曲線／玻璃艙快取，否則會畫成 sedan。
  delete spec._body;
  delete spec._layout;
  spec.lamps = [spec.headlight[1], spec.taillight[1]];
  spec.lampX = [spec.headlight[0], spec.taillight[0]];
  return spec;
})();

/** 紅的士（玩家用全細節放樣車體） */
export function buildTaxi() {
  const spec = HK_TAXI_SPEC;
  const body = new THREE.Mesh(buildCarGeometry(spec, true), createLoftedCarMaterial(spec, HK_COLORS.taxi));
  body.castShadow = true;
  body.receiveShadow = true;
  const group = new THREE.Group();
  group.add(body);
  group.name = 'HongKongUrbanTaxi';
  return group;
}

// ============================================================================
// 大型車種（巴士／電車／小巴／小輪）
// ============================================================================
// 軸向約定：**車頭 = +Z**（與車流的 `rotation.set(0, heading, 0)`、`heading = atan2(dx, dz)` 一致），
// x = 左右、y = 上。以前這幾款車用 BoxGeometry(L, H, W) 建（長度沿 X）＋車輪又排在 Z 上，
// 結果巴士在馬路上**打橫行**、車輪飛到車身兩側 5 米外。這裡全部按 +Z 重建。

/** 一個方塊：寬 w（x）、高 h（y）、長 l（z），中心放在 (x, y, z)。 */
function slab(w, h, l, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 沿車身兩側貼一條水平「窗帶」（正面 = ±X 面），長度沿 Z。 */
function sideGlass({ length, height, y, halfWidth, inset = 0.008, sides = [-1, 1] }) {
  const g = new THREE.Group();
  const glass = mat(0x101c24, { roughness: 0.1, metalness: 0.62 });
  for (const side of sides) {
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.05, height, length), glass);
    pane.position.set(side * (halfWidth + inset), y, 0);
    g.add(pane);
  }
  return g;
}

/**
 * 車輪：軸向 = X（車頭 +Z 時，車輪要橫跨左右），沿 Z 排在指定位置。
 * radius、width 用米。
 */
function roadWheels({ radius, width, halfTrack, zs, sides = [-1, 1] }) {
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(radius, radius, width, 16);
  geo.rotateZ(Math.PI / 2);
  const rubber = mat(0x14161a, { roughness: 0.88, metalness: 0.04 });
  const hubGeo = new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const hub = mat(0xb9bec4, { roughness: 0.35, metalness: 0.75 });
  for (const z of zs) {
    for (const side of sides) {
      const wheel = new THREE.Mesh(geo, rubber);
      wheel.position.set(side * halfTrack, radius, z);
      wheel.castShadow = true;
      g.add(wheel);
      const cap = new THREE.Mesh(hubGeo, hub);
      cap.position.copy(wheel.position);
      g.add(cap);
    }
  }
  return g;
}

/** 雙層巴士（12 m 三軸，紅色車身 + 奶油色裙腳 + 上下層窗帶 + 目的地牌） */
export function buildDoubleDecker() {
  const group = new THREE.Group();
  const L = 11.8; // 車長（Z）
  const W = 2.5; // 車寬（X）
  const floor = 0.36;
  const H = 4.32; // 車頂高
  const red = mat(HK_COLORS.kmbRed, { roughness: 0.38, metalness: 0.3 });
  const cream = mat(HK_COLORS.kmbCream, { roughness: 0.45, metalness: 0.2 });

  // 主車身
  group.add(slab(W, H - floor, L, red, 0, floor + (H - floor) / 2, 0));
  // 奶油色裙腳（下層底部）
  group.add(slab(W + 0.02, 0.62, L * 0.995, cream, 0, floor + 0.31, 0));
  // 上下層窗帶：下層 1.45–2.35、上層 2.75–3.65
  group.add(sideGlass({ length: L * 0.9, height: 0.86, y: 1.92, halfWidth: W / 2 }));
  group.add(sideGlass({ length: L * 0.9, height: 0.82, y: 3.2, halfWidth: W / 2 }));
  // 車頭擋風玻璃（上層），下層擋風
  const glass = mat(0x0d1a22, { roughness: 0.1, metalness: 0.6 });
  group.add(slab(W * 0.9, 0.86, 0.06, glass, 0, 3.2, L / 2 + 0.01));
  group.add(slab(W * 0.88, 0.78, 0.06, glass, 0, 1.94, L / 2 + 0.01));
  // 目的地顯示屏（發光）
  const signMat = new THREE.MeshBasicNodeMaterial({ color: 0xffb733 });
  group.add(slab(W * 0.62, 0.3, 0.05, signMat, 0, 3.95, L / 2 + 0.03));
  // 車尾窗
  group.add(slab(W * 0.84, 0.74, 0.06, glass, 0, 3.18, -L / 2 - 0.01));
  // 圓頂
  const roofGeo = new THREE.CylinderGeometry(W / 2 - 0.02, W / 2 - 0.02, L * 0.99, 14, 1, false, 0, Math.PI);
  roofGeo.rotateX(Math.PI / 2); // 圓柱軸 Y → Z（車身縱向），唔係 X
  const roof = new THREE.Mesh(roofGeo, cream);
  roof.position.set(0, H - 0.02, 0);
  roof.scale.set(1, 0.34, 1);
  group.add(roof);
  // 車門（左邊 = -X 在靠左行駛時…實際上是左邊上落客；這裡兩側都留一條深色門縫）
  for (const z of [L * 0.28, -L * 0.24]) {
    group.add(slab(0.04, 1.9, 1.05, mat(0x1a1f24, { roughness: 0.6 }), -W / 2 - 0.01, 1.5, z));
  }
  // 三軸
  group.add(roadWheels({ radius: 0.51, width: 0.34, halfTrack: W / 2 - 0.12, zs: [L * 0.34, -L * 0.26, -L * 0.4] }));
  group.name = 'HongKongDoubleDecker';
  group.userData.dimensions = { length: L, width: W, height: H };
  return group;
}

/** 香港電車（雙層、綠白、圓頂、集電弓；軌距 1.067 m） */
export function buildTram() {
  const group = new THREE.Group();
  const L = 12.6;
  const W = 2.02;
  const H = 4.42;
  const floor = 0.3;
  const green = mat(HK_COLORS.tramGreen, { roughness: 0.44, metalness: 0.22 });
  const cream = mat(HK_COLORS.tramCream, { roughness: 0.5, metalness: 0.14 });
  group.add(slab(W, H - floor, L, green, 0, floor + (H - floor) / 2, 0));
  group.add(sideGlass({ length: L * 0.93, height: 0.8, y: 3.34, halfWidth: W / 2 }));
  group.add(sideGlass({ length: L * 0.93, height: 0.86, y: 1.98, halfWidth: W / 2 }));
  group.add(slab(W + 0.02, 0.15, L * 1.001, cream, 0, 2.72, 0)); // 腰線
  group.add(slab(W + 0.02, 0.16, L * 1.001, cream, 0, 0.42, 0)); // 裙腳
  const glass = mat(0x0d1a22, { roughness: 0.1, metalness: 0.6 });
  group.add(slab(W * 0.9, 0.8, 0.05, glass, 0, 3.32, L / 2 + 0.01));
  group.add(slab(W * 0.9, 0.8, 0.05, glass, 0, 3.32, -L / 2 - 0.01));
  // 圓頂（電車的招牌弧形車頂）
  const roofGeo = new THREE.CylinderGeometry(W / 2, W / 2, L * 0.985, 16, 1, false, 0, Math.PI);
  roofGeo.rotateX(Math.PI / 2); // 圓柱軸 Y → Z（車身縱向），唔係 X
  const roof = new THREE.Mesh(roofGeo, cream);
  roof.position.y = H;
  roof.scale.set(1, 0.42, 1);
  group.add(roof);
  // 集電弓
  const poleMat = mat(0x3a3f45, { roughness: 0.5, metalness: 0.7 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.1, 8), poleMat);
  pole.position.set(0, H + 0.72, -L * 0.3);
  group.add(pole);
  group.add(slab(1.5, 0.07, 0.16, poleMat, 0, H + 1.25, -L * 0.3));
  group.add(roadWheels({ radius: 0.34, width: 0.18, halfTrack: W / 2 - 0.06, zs: [L * 0.3, -L * 0.3] }));
  group.name = 'HongKongTram';
  group.userData.dimensions = { length: L, width: W, height: H };
  return group;
}

/** 公共小巴（16 座／19 座，奶油色車身 + 綠頂 + 紅邊） */
export function buildMinibus() {
  const group = new THREE.Group();
  const L = 6.6;
  const W = 2.0;
  const H = 2.62;
  const floor = 0.28;
  const cream = mat(HK_COLORS.minibusCream, { roughness: 0.46, metalness: 0.16 });
  const green = mat(HK_COLORS.minibusGreen, { roughness: 0.5, metalness: 0.18 });
  const red = mat(0xb5231f, { roughness: 0.45, metalness: 0.2 });
  group.add(slab(W, H - floor, L, cream, 0, floor + (H - floor) / 2, 0));
  group.add(slab(W + 0.015, 0.2, L * 0.995, green, 0, H - 0.02, 0)); // 綠頂
  group.add(slab(W + 0.015, 0.13, L * 0.995, red, 0, 1.38, 0)); // 紅色腰線
  group.add(sideGlass({ length: L * 0.86, height: 0.72, y: 1.88, halfWidth: W / 2 }));
  const glass = mat(0x0d1a22, { roughness: 0.1, metalness: 0.6 });
  // 小巴的擋風玻璃很斜，這裡用前傾方塊近似
  const windscreen = new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, 0.95, 0.06), glass);
  windscreen.position.set(0, 1.82, L / 2);
  windscreen.rotation.x = -0.18;
  group.add(windscreen);
  group.add(slab(W * 0.86, 0.7, 0.06, glass, 0, 1.85, -L / 2 - 0.01));
  // 電動滑門
  group.add(slab(0.04, 1.55, 0.95, mat(0x1a1f24, { roughness: 0.6 }), -W / 2 - 0.01, 1.35, 0.35));
  group.add(roadWheels({ radius: 0.33, width: 0.24, halfTrack: W / 2 - 0.06, zs: [L * 0.32, -L * 0.3] }));
  group.name = 'HongKongMinibus';
  group.userData.dimensions = { length: L, width: W, height: H };
  return group;
}

/** 天星小輪（雙層渡輪，綠白） */
export function buildFerry() {
  const group = new THREE.Group();
  const L = 34;
  const W = 9.4;
  const hull = mat(HK_COLORS.ferryGreen, { roughness: 0.55, metalness: 0.15 });
  const white = mat(HK_COLORS.ferryWhite, { roughness: 0.6, metalness: 0.08 });
  const deck1 = slab(W, 2.9, L, hull, 0, 1.4, 0);
  group.add(deck1);
  group.add(slab(W * 0.94, 2.5, L * 0.86, white, 0, 4.0, 0));
  group.add(slab(W * 0.86, 2.2, L * 0.66, white, 0, 6.3, 0));
  // 兩層的窗帶
  group.add(sideGlass({ length: L * 0.8, height: 1.0, y: 4.1, halfWidth: (W * 0.94) / 2 }));
  group.add(sideGlass({ length: L * 0.6, height: 0.85, y: 6.35, halfWidth: (W * 0.86) / 2 }));
  // 煙囪
  for (const z of [-L * 0.16, L * 0.16]) {
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.86, 2.2, 12), hull);
    funnel.position.set(0, 8.2, z);
    group.add(funnel);
  }
  // 船頭斜台（天星小輪的雙頭設計：兩邊都係船頭）
  for (const dir of [-1, 1]) {
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.5, 2.2), white);
    ramp.position.set(0, 1.0, dir * (L / 2 + 0.6));
    group.add(ramp);
  }
  group.name = 'StarFerry';
  group.userData.dimensions = { length: L, width: W, height: 9.2 };
  return group;
}


/** AI 車流用的低模幾何與材質（每種顏色一個 InstancedMesh，免去 per-instance 屬性管線） */
export const AI_FLEET = [
  { id: 'taxi', spec: HK_TAXI_SPEC, color: HK_COLORS.taxi, geometry: () => buildCarProxyGeometry(HK_TAXI_SPEC), share: 0.46 },
  { id: 'sedan-white', spec: BODY_SPECS.sedan, color: 0xe6e6e2, geometry: () => buildCarProxyGeometry(BODY_SPECS.sedan), share: 0.22 },
  { id: 'sedan-silver', spec: BODY_SPECS.sedan, color: 0x9aa2a8, geometry: () => buildCarProxyGeometry(BODY_SPECS.sedan), share: 0.16 },
  { id: 'suv-dark', spec: BODY_SPECS.suv, color: 0x24282e, geometry: () => buildCarProxyGeometry(BODY_SPECS.suv), share: 0.16 }
];

export function createAiMaterial(entry) {
  return createLoftedCarMaterial(entry.spec, entry.color);
}
