// tools/render-model.mjs
// 用 pure JS 光柵化器把車／巴士等模型畫成 PNG —— sandbox 冇瀏覽器、冇 GPU，
// 這是唯一可以「用眼」檢查 3D 模型（比例、方向、細節）的方法。
//
//   node --import ./tools/hk-boot/register.mjs tools/render-model.mjs taxi
//   node --import ./tools/hk-boot/register.mjs tools/render-model.mjs bus tram minibus
//   node --import ./tools/hk-boot/register.mjs tools/render-model.mjs taxi --views=front,side,rear,iso
//
// 輸出：tools/out/<name>-<view>.png
//
// 注意：這只是「睇形狀」的工具，唔係渲染品質參考（flat shading、冇陰影、冇材質）。
import { writeFileSync, mkdirSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { encodePng } from './png.mjs';
import { installDomStub } from './dom-stub.mjs';

// 車漆／車牌貼圖會 createElement('canvas')，所以要先裝一個最小 DOM。
installDomStub();

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const LIGHT_DIRS = [
  new THREE.Vector3(-0.45, 0.78, 0.44).normalize(),
  new THREE.Vector3(0.7, 0.35, -0.6).normalize()
];

// 用 partId 上色：同 createLoftedCarMaterial 的直觀對應，方便「用眼」檢查玻璃、燈、鉻件位置。
// （真正材質係 TSL 程序化上色，這裡只是把同一套 part 分類用實色畫出來。）
const PART_COLORS = {
  0: null, // BODY：用車漆色
  1: [96, 130, 150], // WINDOW 玻璃
  2: [26, 26, 28], // TYRE
  3: [186, 190, 196], // ALLOY
  4: [206, 210, 214], // TRIM 鉻件
  5: [150, 156, 162], // MIRROR
  6: [246, 244, 232], // SIGN
  7: [252, 246, 220], // FRONT 燈
  8: [190, 40, 36] // REAR 燈
};
const PAINT = [190, 22, 30];

function colorOf(material) {
  const m = Array.isArray(material) ? material[0] : material;
  const c = m?.color;
  if (!c) return [200, 200, 200];
  return [c.r * 255, c.g * 255, c.b * 255];
}

/** 收集世界空間三角形（flat shading 用三角形法線）。 */
function collectTriangles(root) {
  const tris = [];
  root.updateMatrixWorld(true);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh) return;
    const geometry = object.geometry;
    const position = geometry?.attributes?.position;
    if (!position) return;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    const materialColor = colorOf(object.material);
    const partAttr = geometry?.attributes?.partId;
    const triColor = (i) => {
      if (partAttr) {
        const id = Math.round(partAttr.getX(i));
        const mapped = PART_COLORS[id];
        if (mapped === undefined) return materialColor;
        if (mapped === null) return PAINT;
        return mapped;
      }
      return materialColor;
    };
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        v[k].fromBufferAttribute(position, vi).applyMatrix4(object.matrixWorld);
      }
      const partIdx = index ? index.getX(i) : i;
      tris.push({
        a: v[0].clone(), b: v[1].clone(), c: v[2].clone(),
        color: triColor(partIdx),
        partId: partAttr ? Math.round(partAttr.getX(partIdx)) : -1,
        // 物件座標（的士模型冇變換，所以世界座標 = 物件座標；仍舊明確記住）
        oa: v[0].clone(), ob: v[1].clone(), oc: v[2].clone()
      });
    }
  });
  return tris;
}

let liveryPaint = null;

function render(tris, camera, width, height) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

  const bg = [0.55, 0.62, 0.7];
  const color = new Float32Array(width * height * 3);
  const depth = new Float32Array(width * height).fill(Infinity);
  for (let i = 0; i < width * height; i++) {
    const g = bg[0] * 0.94 + (i / width) * 0.02;
    color[i * 3] = g;
    color[i * 3 + 1] = bg[1] * 0.94;
    color[i * 3 + 2] = bg[2] * 0.94;
  }

  // 地面參考格（每 0.5 m）：用來判斷車身高度同車輪貼地。
  const groundY = 0;
  const gridTris = [];
  for (let i = -12; i <= 12; i++) {
    const t = i * 0.5;
    const shade = i % 2 === 0 ? [0.42, 0.44, 0.46] : [0.46, 0.48, 0.5];
    gridTris.push({ a: new THREE.Vector3(t - 0.01, groundY, -6), b: new THREE.Vector3(t + 0.01, groundY, -6), c: new THREE.Vector3(t + 0.01, groundY, 6), color: shade.map((c) => c * 255) });
    gridTris.push({ a: new THREE.Vector3(t - 0.01, groundY, -6), b: new THREE.Vector3(t + 0.01, groundY, 6), c: new THREE.Vector3(t - 0.01, groundY, 6), color: shade.map((c) => c * 255) });
  }
  for (const tri of gridTris) tris.push(tri);

  const p = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  const screen = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];

  for (const tri of tris) {
    const verts = [tri.a, tri.b, tri.c];
    let visible = true;
    for (let k = 0; k < 3; k++) {
      p[k].set(verts[k].x, verts[k].y, verts[k].z, 1).applyMatrix4(viewProj);
      if (p[k].w <= 0.05) { visible = false; break; }
      const ndcX = p[k].x / p[k].w;
      const ndcY = p[k].y / p[k].w;
      const ndcZ = p[k].z / p[k].w;
      screen[k] = { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height, z: ndcZ };
    }
    if (!visible) continue;

    const normal = new THREE.Vector3().subVectors(tri.b, tri.a).cross(new THREE.Vector3().subVectors(tri.c, tri.a));
    if (normal.lengthSq() === 0) continue;
    normal.normalize();
    // 塗裝判斷要用「幾何原本的法線」（例如 n.z < 0 代表車尾）；雙面著色只是為了畫得亮，
    // 如果直接改 normal 就會令車尾燈／鬼面罩的判斷反轉（試過：尾燈變成空心紅框）。
    const shadeNormal = normal.clone();
    const toCamera = new THREE.Vector3().subVectors(camera.position, tri.a);
    if (shadeNormal.dot(toCamera) < 0) shadeNormal.negate();
    let light = 0.32;
    for (const dir of LIGHT_DIRS) light += 0.46 * Math.max(0, shadeNormal.dot(dir));
    light = Math.min(1.25, light);

    const minX = Math.max(0, Math.floor(Math.min(screen[0].x, screen[1].x, screen[2].x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(screen[0].x, screen[1].x, screen[2].x)));
    const minY = Math.max(0, Math.floor(Math.min(screen[0].y, screen[1].y, screen[2].y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(screen[0].y, screen[1].y, screen[2].y)));
    if (minX > maxX || minY > maxY) continue;

    const [s0, s1, s2] = screen;
    const area = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((s1.x - px) * (s2.y - py) - (s2.x - px) * (s1.y - py)) / area;
        const w1 = ((s2.x - px) * (s0.y - py) - (s0.x - px) * (s2.y - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * s0.z + w1 * s1.z + w2 * s2.z;
        const idx = y * width + x;
        if (z >= depth[idx]) continue;
        depth[idx] = z;
        let base = tri.color;
        if (liveryPaint && tri.partId >= 0) {
          // 逐像素插值物件座標 → 用真材質同一套規則上色
          const px = tri.oa.x * w0 + tri.ob.x * w1 + tri.oc.x * w2;
          const py = tri.oa.y * w0 + tri.ob.y * w1 + tri.oc.y * w2;
          const pz = tri.oa.z * w0 + tri.ob.z * w1 + tri.oc.z * w2;
          base = liveryPaint({ x: px, y: py, z: pz }, normal, tri.partId);
        }
        color[idx * 3] = Math.min(255, base[0] * light);
        color[idx * 3 + 1] = Math.min(255, base[1] * light);
        color[idx * 3 + 2] = Math.min(255, base[2] * light);
      }
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = color[i * 3];
    rgba[i * 4 + 1] = color[i * 3 + 1];
    rgba[i * 4 + 2] = color[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** 睇包圍盒：用來斷言「車頭係 +Z」這類方向問題。 */
export function measure(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  return { box, size, center: box.getCenter(new THREE.Vector3()) };
}

const VIEWS = {
  // 前方 3/4（車頭朝 +Z，所以鏡頭在 +Z 側）
  iso: { pos: [4.6, 2.6, 6.4], target: [0, 0.95, 0.2] },
  front: { pos: [0.05, 1.5, 7.4], target: [0, 1.0, 0] },
  side: { pos: [8.2, 1.7, 0.1], target: [0, 1.0, 0] },
  rear: { pos: [-0.05, 1.6, -7.4], target: [0, 1.0, 0] },
  top: { pos: [0.01, 11, 0.02], target: [0, 1, 0] },
  // 特寫：車頭（鬼面罩、燈、牌）
  nose: { pos: [2.2, 1.05, 4.3], target: [0, 0.68, 2.1] },
  // 特寫：車側（輪圈、車門證、腰線）
  wheel: { pos: [4.2, 0.55, 2.7], target: [0.6, 0.34, 1.4] },
  // 特寫：車尾（尾燈、後牌）
  tail: { pos: [-2.0, 1.1, -4.4], target: [0, 0.72, -2.2] }
};

/** 全套視圖輸出（回傳寫出的檔名）。 */
export function renderViews(name, buildObject, { views = ['iso', 'side'], width = 900, height = 600 } = {}) {
  const files = [];
  for (const view of views) {
    const object = buildObject();
    const { center, size } = measure(object);
    const spec = VIEWS[view] || VIEWS.iso;
    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 200);
    camera.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    const target = new THREE.Vector3(spec.target[0], spec.target[1], spec.target[2]);
    // 大模型（巴士 12 m）自動拉遠
    const span = Math.max(size.x, size.z, size.y);
    if (span > 6) {
      camera.position.multiplyScalar(span / 5.4);
      target.y *= 1.2;
    }
    camera.lookAt(target);
    const tris = collectTriangles(object);
    const rgba = render(tris, camera, width, height);
    const file = new URL(`${name}-${view}.png`, OUT);
    writeFileSync(file, encodePng(width, height, rgba));
    files.push({ view, file: file.pathname, size, center, triangles: tris.length });
  }
  return files;
}

// --- CLI -------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const viewsArg = args.find((a) => a.startsWith('--views='));
  const views = viewsArg ? viewsArg.split('=')[1].split(',') : ['iso', 'side', 'front', 'rear'];
  const names = args.filter((a) => !a.startsWith('--'));
  const { buildTaxi, buildDoubleDecker, buildTram, buildMinibus, buildFerry } = await import('../js/hk/vehicles.js');
  const builders = { taxi: buildTaxi, bus: buildDoubleDecker, tram: buildTram, minibus: buildMinibus, ferry: buildFerry };
  if (names.includes('taxi') || !names.length) {
    const { paintHKT } = await import('./hk-taxi-livery.mjs');
    const { HK_TAXI_SPEC } = await import('../js/hk/vehicles.js');
    liveryPaint = (p, n, partId) => paintHKT(p, n, partId, HK_TAXI_SPEC);
  }
  for (const name of names.length ? names : ['taxi']) {
    const builder = builders[name];
    if (!builder) {
      console.error(`未知模型：${name}（可用：${Object.keys(builders).join(', ')}）`);
      process.exit(1);
    }
    const files = renderViews(name, builder, { views });
    for (const f of files) {
      const s = f.size;
      console.log(`${name} ${f.view}: ${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)} m（長度沿 ${s.z >= s.x ? 'Z' : 'X'}）→ ${f.file}`);
    }
  }
}
