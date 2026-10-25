// tests/hk-vehicles.test.mjs
// 香港車種的「形狀／方向」測試。
//
// 為什麼要有：用戶報告「我仍見到打橫行既巴士」。根因是車流的朝向約定是 **車頭 = +Z**
// （`place()` 用 rotation.y = heading、heading = atan2(dx, dz)），但巴士／電車／小巴是用
// BoxGeometry(L, H, W) 建的（長度沿 X），所以整架車被轉了 90°，在馬路上打橫行。
// 這些測試把「長邊一定要沿 Z」釘死，以後任何人再寫一條沿 X 的車身都會即刻見到紅燈。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const threePath = new URL('../node_modules/three/package.json', import.meta.url);
const skip = existsSync(threePath) ? false : 'three is not installed (npm install three@0.186.1 --no-save)';

// 用 hk-boot 的 loader（three/webgpu → three，並提供冇 GPU 的 renderer shim）＋最小 DOM。
async function loadVehicles() {
  const { installDomStub } = await import('../tools/dom-stub.mjs');
  installDomStub();
  const THREE = await import('three');
  const vehicles = await import('../js/hk/vehicles.js');
  return { THREE, vehicles };
}

function measure(THREE, object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  return {
    size: box.getSize(new THREE.Vector3()),
    min: box.min.clone(),
    max: box.max.clone(),
    center: box.getCenter(new THREE.Vector3())
  };
}

test('大型車種：車身長邊一定沿 Z（車頭 = +Z），唔會再打橫行', { skip }, async () => {
  const { THREE, vehicles } = await loadVehicles();
  const cases = [
    ['雙層巴士', vehicles.buildDoubleDecker, 11.8, 4.2],
    ['電車', vehicles.buildTram, 12.6, 4.2],
    ['小巴', vehicles.buildMinibus, 6.6, 2.4],
    ['天星小輪', vehicles.buildFerry, 37, 8]
  ];
  for (const [name, build, expectedLength, minHeight] of cases) {
    const object = build();
    const { size, min } = measure(THREE, object);
    const isBoat = name.includes('小輪');
    assert.ok(size.z > size.x * 2, `${name}：長度應該沿 Z（x ${size.x.toFixed(2)} vs z ${size.z.toFixed(2)}）`);
    assert.ok(Math.abs(size.z - expectedLength) < 1.2, `${name}：車長 ${size.z.toFixed(2)} m，預期 ${expectedLength} m`);
    assert.ok(size.y > minHeight, `${name}：高度 ${size.y.toFixed(2)} m 太矮`);
    assert.ok(size.x < 12, `${name}：闊度 ${size.x.toFixed(2)} m 唔合理（車輪跑到車身外？）`);
    if (!isBoat) assert.ok(min.y > -0.05 && min.y < 0.1, `${name}：車底應該貼住地面（min.y = ${min.y.toFixed(2)}）`);
  }
});

test('大型車種：車輪在車身兩側、沿 Z 排在軸距上（唔會飛出 5 米外）', { skip }, async () => {
  const { THREE, vehicles } = await loadVehicles();
  for (const [name, build] of [['巴士', vehicles.buildDoubleDecker], ['電車', vehicles.buildTram], ['小巴', vehicles.buildMinibus]]) {
    const object = build();
    object.updateMatrixWorld(true);
    const wheels = [];
    object.traverse((child) => {
      if (child.isMesh && child.geometry?.type === 'CylinderGeometry' && child.geometry.parameters.height < 0.5 && child.geometry.parameters.height > 0.1) {
        const box = new THREE.Box3().setFromObject(child);
        wheels.push(box.getCenter(new THREE.Vector3()));
      }
    });
    assert.ok(wheels.length >= 4, `${name}：應該最少 4 個車輪，實際 ${wheels.length}`);
    const { size } = measure(THREE, object);
    for (const w of wheels) {
      assert.ok(Math.abs(w.x) <= size.x / 2 + 0.02, `${name}：車輪 x = ${w.x.toFixed(2)} 飛出車身`);
      assert.ok(Math.abs(w.z) <= size.z / 2 + 0.02, `${name}：車輪 z = ${w.z.toFixed(2)} 飛出車長`);
      assert.ok(w.y < size.y * 0.35, `${name}：車輪 y = ${w.y.toFixed(2)} 太高（應該在底部）`);
    }
  }
});

test('香港紅的：車身尺寸、四門比例、沙板鏡、車頂牌都對得返實車', { skip }, async () => {
  const { THREE, vehicles } = await loadVehicles();
  const spec = vehicles.HK_TAXI_SPEC;
  // 實車（豐田 Crown Comfort）：4.69 × 1.70 × 1.50 m，軸距 2.69 m
  assert.ok(Math.abs(spec.zFront - spec.zRear - 4.69) < 0.12, `車長 ${(spec.zFront - spec.zRear).toFixed(2)} m`);
  assert.ok(Math.abs(spec.wheelZ * 2 - 2.69) < 0.1, `軸距 ${(spec.wheelZ * 2).toFixed(2)} m`);
  assert.equal(spec.name, 'hk-red-taxi', '唔可以再叫 taxi（nyc）');
  assert.ok(spec.twoTone, '上半身要銀白（雙色車身）');
  assert.ok(spec.fenderMirror, '一定要有沙板鏡（香港的士最易認的特徵）');
  assert.ok(spec.signSize && spec.signSize.h > 0.15, '車頂「的士」牌要比紐約 medallion 燈箱大');

  const taxi = vehicles.buildTaxi();
  const { size, min } = measure(THREE, taxi);
  assert.ok(Math.abs(size.z - 4.69) < 0.25, `模型車長 ${size.z.toFixed(2)} m`);
  assert.ok(Math.abs(size.x - 1.70) < 0.3, `模型車闊 ${size.x.toFixed(2)} m`);
  assert.ok(size.y > 1.55 && size.y < 1.95, `模型車高 ${size.y.toFixed(2)} m（含車頂牌）`);
  assert.ok(Math.abs(min.y) < 0.05, `車輪要貼地（min.y = ${min.y.toFixed(3)}）`);

  // 沙板鏡：整車是一條合併幾何，所以要由頂點找 —— 鉻件（partId 9）而且在前軸上方、
  // 車身兩側外面（|x| > 0.75、z > 0.9、y 0.9–1.4）。
  const body = taxi.children.find((child) => child.isMesh);
  const position = body.geometry.attributes.position;
  const partId = body.geometry.attributes.partId;
  let chrome = 0;
  let mirrorVertices = 0;
  for (let i = 0; i < position.count; i++) {
    if (Math.round(partId.getX(i)) !== 9) continue;
    chrome += 1;
    const x = Math.abs(position.getX(i));
    const y = position.getY(i);
    const z = position.getZ(i);
    if (x > 0.75 && y > 0.85 && y < 1.45 && z > 0.9) mirrorVertices += 1;
  }
  assert.ok(chrome > 40, `鉻件太少（${chrome} 個頂點）`);
  assert.ok(mirrorVertices > 20, `搵唔到沙板鏡（只有 ${mirrorVertices} 個鉻件頂點在前軸上方）`);

  // 高度分佈：車頂比引擎蓋高 > 0.4 m（三箱房車的比例）
  const hoodTop = spec.edge.find(([z]) => Math.abs(z - 1.6) < 1e-6)?.[1] ?? 0.9;
  const roofY = Math.max(...spec.cabin.roofY.map(([, y]) => y));
  assert.ok(roofY - hoodTop > 0.45, `車頂 ${roofY} vs 引擎蓋 ${hoodTop}：太高／太矮`);
});

test('車流用的士低模都用香港的士 spec（唔會混入紐約車）', { skip }, async () => {
  const { vehicles } = await loadVehicles();
  const taxiEntry = vehicles.AI_FLEET.find((entry) => entry.id === 'taxi');
  assert.ok(taxiEntry, 'AI 車隊要有 taxi');
  assert.equal(taxiEntry.spec.name, 'hk-red-taxi');
  assert.equal(taxiEntry.color, vehicles.HK_COLORS.taxi);
});

test('香港的士塗裝：鬼面罩、綠牌、燈、車牌、雙色車身都畫對位置', { skip }, async () => {
  const { paintHKT } = await import('../tools/hk-taxi-livery.mjs');
  const { HK_TAXI_SPEC: spec } = await import('../js/hk/vehicles.js');
  const front = { x: 0, y: 0, z: 1 };
  const side = { x: 1, y: 0, z: 0 };
  const rear = { x: 0, y: 0, z: -1 };
  const up = { x: 0, y: 1, z: 0 };
  const near = (rgb, [r, g, b], tol = 26) => Math.abs(rgb[0] - r) <= tol && Math.abs(rgb[1] - g) <= tol && Math.abs(rgb[2] - b) <= tol;
  const [grY, grW, grH] = spec.grille;
  const [hlX, hlY, hlW, hlH] = spec.headlight;
  const [tlX, tlY, tlW, tlH] = spec.taillight;
  const [plateF, plateR] = spec.plates;
  const paint = (p, n, id) => paintHKT(p, n, id, spec);

  // 車身主色是紅色（香港市區的士）
  assert.ok(near(paint({ x: 0.2, y: 0.55, z: 1.6 }, side, 0), [181, 18, 27]), '側面車身要是紅色');
  // 鬼面罩中心：黑；鉻橫間：淺
  const grilleCentre = paint({ x: 0, y: grY, z: spec.zFront - 0.02 }, front, 0);
  assert.ok(grilleCentre[0] < 80 && grilleCentre[1] < 80, `鬼面罩要是深色（${grilleCentre}）`);
  const slats = Array.from({ length: 16 }, (_, i) => i * 0.002).map((dy) => paint({ x: 0, y: grY + dy, z: spec.zFront - 0.02 }, front, 0));
  assert.ok(slats.some((c) => c[0] > 120), '鬼面罩要有鉻橫間（至少一條淺色）');
  // 綠色「TAXI 5 SEATS」牌：綠底 + 白字
  const badgePixels = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      badgePixels.push(paint({ x: -spec.hk.badgeX - 0.045 + i * 0.008, y: grY - 0.032 + j * 0.005, z: spec.zFront - 0.02 }, front, 0));
    }
  }
  assert.ok(badgePixels.some((c) => near(c, [13, 148, 80], 45)), '綠牌要有綠色底');
  assert.ok(badgePixels.some((c) => near(c, [234, 246, 238], 40)), '綠牌要有白字');
  // 頭燈清玻璃、外側琥珀轉向燈
  assert.ok(paint({ x: hlX - hlW * 0.2, y: hlY, z: spec.zFront - 0.02 }, front, 0)[0] > 150, '頭燈要是淺色燈罩');
  assert.ok(near(paint({ x: hlX + hlW * 0.8, y: hlY, z: spec.zFront - 0.02 }, front, 0), [201, 128, 43], 60), '外側要係琥珀轉向燈');
  // 尾燈：深紅燈罩 + 白倒車燈 + 琥珀
  assert.ok(paint({ x: tlX, y: tlY, z: spec.zRear + 0.02 }, rear, 0)[0] < 170, '尾燈要是深紅');
  assert.ok(paint({ x: tlX - tlW * 0.72, y: tlY, z: spec.zRear + 0.02 }, rear, 0)[0] > 200, '要有白色倒車燈');
  // 前白牌 / 後黃牌
  const plateFrontPixels = [-0.13, -0.08, 0, 0.08, 0.13].map((x) => paint({ x, y: plateF, z: spec.zFront - 0.02 }, front, 0));
  assert.ok(plateFrontPixels.some((c) => c[0] > 220 && c[1] > 220), '前牌要是白底');
  assert.ok(plateFrontPixels.some((c) => c[0] < 60), '前牌要有黑字');
  const plateRearPixels = [-0.13, -0.08, 0, 0.08, 0.13].map((x) => paint({ x, y: plateR, z: spec.zRear + 0.02 }, rear, 0));
  assert.ok(plateRearPixels.some((c) => near(c, [240, 196, 25], 60)), '後牌要是黃底');
  assert.ok(plateRearPixels.some((c) => c[0] < 60), '後牌要有黑字');
  // 雙色車身：車頂銀白、側窗深色
  assert.ok(paint({ x: 0, y: spec.cabin.roofY[0][1] - 0.02, z: 0 }, up, 1)[0] > 190, '車頂要是銀白');
  assert.ok(paint({ x: spec.cabin.rail[0], y: 1.18, z: 0.1 }, side, 1)[0] < 70, '側窗要是深色玻璃');
  // 車頂 TAXI 燈箱：白底 + 紅字
  const signPixels = [-0.2, -0.1, 0, 0.1, 0.2].map((x) => paint({ x, y: spec.cabin.roofY[0][1] + 0.115, z: -0.2 }, up, 6));
  assert.ok(signPixels.some((c) => c[0] > 230 && c[1] > 220), '燈箱要有白底');
  assert.ok(signPixels.some((c) => c[0] > 150 && c[1] < 90), '燈箱要有紅色字');
});

test('HK 塗裝只套用在香港的士（紐約車唔會被改色）', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/actor-models.js', import.meta.url), 'utf8');
  assert.match(source, /const isHK = spec\.livery === 'hk-taxi'/, '材質要用 livery 標記判斷');
  assert.match(source, /if \(spec\.sign && !isHK\)/, '紐約的士徽章要排除香港的士');
  for (const marker of ['0d9450', 'f0c419', 'f4f6f6', '17191c', '0x7f121c']) {
    assert.ok(source.includes(marker), `香港塗裝缺少顏色 ${marker}`);
  }
  // 紐約的黃牌貼圖只可以用在非香港車輛
  assert.match(source, /if \(!isHK\) \{\s*body = mix\(body, color\(0xf2b718\), plates\);/, '紐約車牌要留給非香港車輛');
});

test('香港紅的：獨立車牌板、車門把手、油缸蓋都是真幾何件（唔係貼圖）', { skip }, async () => {
  const { buildTaxi } = await import('../js/hk/vehicles.js');
  const { HK_TAXI_SPEC: spec } = await import('../js/hk/vehicles.js');
  const { paintHKT, HK_PART } = await import('../tools/hk-taxi-livery.mjs');
  const taxi = buildTaxi();
  const body = taxi.children.find((c) => c.isMesh);
  assert.ok(body, '有的士車身 mesh');
  const ids = body.geometry.attributes.partId.array;
  const count = (id) => ids.reduce((n, v) => n + (Math.round(v) === id ? 1 : 0), 0);

  // 車牌件的頂點一定存在，而且前後各一塊（z 分別大於 zFront、小於 zRear）
  assert.ok(count(HK_PART.PLATE) > 0, '要有獨立車牌幾何件（partId 10）');
  const pos = body.geometry.attributes.position.array;
  let frontVerts = 0;
  let rearVerts = 0;
  for (let i = 0; i < ids.length; i++) {
    if (Math.round(ids[i]) !== HK_PART.PLATE) continue;
    if (pos[i * 3 + 2] > spec.zFront - 0.05) frontVerts++;
    if (pos[i * 3 + 2] < spec.zRear + 0.05) rearVerts++;
  }
  assert.ok(frontVerts > 0 && rearVerts > 0, `車牌要一前一後（前 ${frontVerts} / 後 ${rearVerts}）`);

  // 車牌板上的顏色：前白、後黃、中間有黑字
  const [plateF, plateR] = spec.plates;
  const front = { x: 0, y: 0, z: 1 };
  const rear = { x: 0, y: 0, z: -1 };
  const frontPixels = [];
  const rearPixels = [];
  for (let i = 0; i < 24; i++) {
    const x = -0.13 + i * 0.011;
    frontPixels.push(paintHKT({ x, y: plateF, z: spec.zFront + 0.02 }, front, HK_PART.PLATE, spec));
    rearPixels.push(paintHKT({ x, y: plateR, z: spec.zRear - 0.02 }, rear, HK_PART.PLATE, spec));
  }
  assert.ok(frontPixels.some((c) => c[0] > 230 && c[1] > 230), '前牌白底');
  assert.ok(frontPixels.some((c) => c[0] < 40), '前牌有黑字');
  assert.ok(rearPixels.some((c) => c[0] > 200 && c[2] < 80), '後牌黃底');
  assert.ok(rearPixels.some((c) => c[0] < 40), '後牌有黑字');

  // 車門把手：四隻，貼在車身側面、離地約 0.79 m
  const handleVerts = [];
  for (let i = 0; i < ids.length; i++) {
    if (Math.round(ids[i]) !== HK_PART.CHROME) continue;
    const y = pos[i * 3 + 1];
    if (Math.abs(y - 0.79) < 0.03) handleVerts.push(pos[i * 3]);
  }
  assert.ok(handleVerts.length > 0, '要有車門把手幾何');
  assert.ok(handleVerts.some((x) => x > 0) && handleVerts.some((x) => x < 0), '把手要左右兩邊都有');
});
