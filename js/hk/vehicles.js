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

/** 紅的士（玩家用全細節放樣車體） */
export function buildTaxi() {
  const spec = BODY_SPECS.taxi;
  const body = new THREE.Mesh(buildCarGeometry(spec, true), createLoftedCarMaterial(spec, HK_COLORS.taxi));
  body.castShadow = true;
  body.receiveShadow = true;
  const group = new THREE.Group();
  group.add(body);
  group.name = 'HongKongUrbanTaxi';
  return group;
}

/** 雙層巴士（12 m 三軸，上層窗帶 + 下層窗帶 + 目的地牌） */
export function buildDoubleDecker() {
  const group = new THREE.Group();
  const L = 11.8;
  const W = 2.5;
  const H = 4.35;
  const body = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), mat(HK_COLORS.kmbRed, { roughness: 0.4 }));
  body.position.y = H / 2 + 0.32;
  body.castShadow = true;
  group.add(body);
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(L, 0.7, W + 0.02), mat(HK_COLORS.kmbCream));
  skirt.position.y = 0.67;
  group.add(skirt);
  group.add(windowBand(L, 0.95, W, 3.35));
  group.add(windowBand(L, 1.05, W, 1.95));
  // 車頭擋風玻璃與目的地顯示屏
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.25, W * 0.86), mat(0x0b1418, { roughness: 0.1, metalness: 0.6 }));
  screen.position.set(L / 2 + 0.01, 2.65, 0);
  group.add(screen);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.34, 1.5), new THREE.MeshBasicNodeMaterial({ color: 0xffb733 }));
  sign.position.set(L / 2 + 0.03, 3.75, 0);
  group.add(sign);
  group.add(wheels(4, 0.5, 0.32, W / 2 - 0.06, [L * 0.34, -L * 0.28, -L * 0.4]));
  group.name = 'HongKongDoubleDecker';
  return group;
}

/** 香港電車（雙層、綠白色、圓頂、集電弓） */
export function buildTram() {
  const group = new THREE.Group();
  const L = 12.6;
  const W = 2.05;
  const H = 4.5;
  const body = new THREE.Mesh(new THREE.BoxGeometry(L, H * 0.82, W), mat(HK_COLORS.tramGreen, { roughness: 0.45, metalness: 0.15 }));
  body.position.y = H * 0.41 + 0.34;
  body.castShadow = true;
  group.add(body);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(W / 2, W / 2, L * 0.98, 12, 1, false, 0, Math.PI), mat(HK_COLORS.tramCream));
  roof.rotation.z = Math.PI / 2;
  roof.rotation.y = Math.PI / 2;
  roof.position.y = H * 0.82 + 0.3;
  group.add(roof);
  group.add(windowBand(L * 0.96, 0.8, W + 0.01, 3.4));
  group.add(windowBand(L * 0.96, 0.9, W + 0.01, 2.05));
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(L * 1.001, 0.16, W + 0.02), mat(HK_COLORS.tramCream));
  stripe.position.y = 2.75;
  group.add(stripe);
  group.add(wheels(3, 0.34, 0.2, W / 2 - 0.1, [L * 0.3, -L * 0.3]));
  group.name = 'HongKongTram';
  return group;
}

/** 公共小巴（16 座，奶油色車身綠頂） */
export function buildMinibus() {
  const group = new THREE.Group();
  const L = 7.1;
  const W = 2.0;
  const H = 2.35;
  const body = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), mat(HK_COLORS.minibusCream, { roughness: 0.46 }));
  body.position.y = H / 2 + 0.28;
  body.castShadow = true;
  group.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(L * 0.99, 0.18, W + 0.02), mat(HK_COLORS.minibusGreen));
  roof.position.y = H + 0.28;
  group.add(roof);
  group.add(windowBand(L, 0.72, W, 1.85));
  group.add(wheels(2, 0.34, 0.24, W / 2 - 0.05, [L * 0.32, -L * 0.32]));
  group.name = 'HongKongMinibus';
  return group;
}

/** 天星小輪（維港渡輪） */
export function buildFerry() {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(30, 3.2, 9), mat(HK_COLORS.ferryGreen, { roughness: 0.55 }));
  hull.position.y = 0.6;
  group.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(26, 2.6, 8), mat(HK_COLORS.ferryWhite, { roughness: 0.6 }));
  deck.position.y = 3.4;
  group.add(deck);
  const top = new THREE.Mesh(new THREE.BoxGeometry(20, 2.2, 7.4), mat(HK_COLORS.ferryWhite, { roughness: 0.6 }));
  top.position.y = 5.8;
  group.add(top);
  for (const z of [-2.4, 2.4]) {
    const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 2.2, 10), mat(HK_COLORS.ferryGreen));
    funnel.position.set(-5, 8, z);
    group.add(funnel);
  }
  group.name = 'StarFerry';
  return group;
}

/** AI 車流用的低模幾何與材質（每種顏色一個 InstancedMesh，免去 per-instance 屬性管線） */
export const AI_FLEET = [
  { id: 'taxi', spec: BODY_SPECS.taxi, color: HK_COLORS.taxi, geometry: () => buildCarProxyGeometry(BODY_SPECS.taxi), share: 0.46 },
  { id: 'sedan-white', spec: BODY_SPECS.sedan, color: 0xe6e6e2, geometry: () => buildCarProxyGeometry(BODY_SPECS.sedan), share: 0.22 },
  { id: 'sedan-silver', spec: BODY_SPECS.sedan, color: 0x9aa2a8, geometry: () => buildCarProxyGeometry(BODY_SPECS.sedan), share: 0.16 },
  { id: 'suv-dark', spec: BODY_SPECS.suv, color: 0x24282e, geometry: () => buildCarProxyGeometry(BODY_SPECS.suv), share: 0.16 }
];

export function createAiMaterial(entry) {
  return createLoftedCarMaterial(entry.spec, entry.color);
}
