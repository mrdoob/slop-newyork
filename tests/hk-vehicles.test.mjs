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
