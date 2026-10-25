// tests/hk-drive.test.mjs
// 玩家紅的士的「手感」與碰撞測試。
//
// 這兩個測試直接對應用家回報的兩件事：
//   1. 「架車離咗地咁、個車輪不動、車燈不着、起動同停沒chok」 —— 原本的 createPlayer 只是把
//      一個合併好的 mesh 搬來搬去：冇車輪、冇懸掛、冇燈。這裡釘死四樣東西必須存在而且會動。
//   2. 「有隱形建物阻住架車前進」 —— 樓宇碰撞以前用軸對齊盒（AABB）包住旋轉過的樓，
//      30° 的樓會多出四隻角的空氣。測試會沿**每一條車道**每 2 m 取樣，證明 OBB 之下
//      整條路網都開得通（同時證明舊 AABB 會誤中過千個點）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const threePath = new URL('../node_modules/three/package.json', import.meta.url);
const skip = existsSync(threePath) ? false : 'three is not installed (npm install three@0.186.1 --no-save)';

async function load() {
  const { installDomStub } = await import('../tools/dom-stub.mjs');
  installDomStub();
  const THREE = await import('three');
  const HK = await import('../js/hk/config.js');
  const drive = await import('../js/hk/drive.js');
  const vehicles = await import('../js/hk/vehicles.js');
  return { THREE, HK, drive, vehicles };
}

/** 由 HK.BUILDINGS 建立與 js/hk/city.js 一致的碰撞體（AABB 供快速剔除 + OBB 供真碰撞）。 */
function makeColliders(HK, THREE) {
  void THREE;
  return HK.BUILDINGS.map((b) => {
    const c = Math.abs(Math.cos(b.rot));
    const s = Math.abs(Math.sin(b.rot));
    const hx = (b.w * c + b.d * s) / 2;
    const hz = (b.w * s + b.d * c) / 2;
    return { minX: b.x - hx, maxX: b.x + hx, minZ: b.z - hz, maxZ: b.z + hz, x: b.x, z: b.z, rot: b.rot, hw: b.w / 2, hd: b.d / 2 };
  });
}

test('樓宇碰撞用 OBB：沿每一條車道都開得通，唔會再有隱形牆', { skip }, async () => {
  const { HK, THREE } = await load();
  const colliders = makeColliders(HK, THREE);
  const R = 1.35; // 玩家的碰撞半徑（drive.js 的 state.radius）
  const index = new Map();
  const cellKey = (i, j) => i * 100000 + j;
  for (const c of colliders) {
    for (let i = Math.floor(c.minX / 100); i <= Math.floor(c.maxX / 100); i++) {
      for (let j = Math.floor(c.minZ / 100); j <= Math.floor(c.maxZ / 100); j++) {
        const k = cellKey(i, j);
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(c);
      }
    }
  }

  let aabbBlocked = 0;
  let obbBlocked = 0;
  let samples = 0;
  const blocked = [];
  for (const lane of HK.buildLanes()) {
    for (let s = 0; s <= lane.len; s += 2) {
      const p = HK.poseAt(lane, s);
      samples++;
      let aabb = false;
      let obb = false;
      for (const c of index.get(cellKey(Math.floor(p.x / 100), Math.floor(p.z / 100))) ?? []) {
        const nx = Math.max(c.minX, Math.min(p.x, c.maxX));
        const nz = Math.max(c.minZ, Math.min(p.z, c.maxZ));
        if ((nx - p.x) ** 2 + (nz - p.z) ** 2 < R * R) aabb = true;
        const cos = Math.cos(-c.rot);
        const sin = Math.sin(-c.rot);
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        const mx = Math.max(-c.hw, Math.min(lx, c.hw));
        const mz = Math.max(-c.hd, Math.min(lz, c.hd));
        if ((lx - mx) ** 2 + (lz - mz) ** 2 < R * R) obb = true;
      }
      if (aabb) aabbBlocked++;
      if (obb) {
        obbBlocked++;
        if (blocked.length < 5) blocked.push(`${lane.road.en} @ ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
      }
    }
  }

  assert.ok(samples > 30000, `車道取樣數應該過三萬（實際 ${samples}）`);
  // 這一行就是「隱形牆」的證據：舊 AABB 會擋住上千個車道取樣點
  assert.ok(aabbBlocked > 100, `舊的 AABB 碰撞應該會誤中過百個車道點（實際 ${aabbBlocked}）—— 用來說明根因`);
  assert.equal(obbBlocked, 0, `改成 OBB 之後車道應該全部開得通，但仍然有 ${obbBlocked} 點被擋：${blocked.join(' · ')}`);
});

test('玩家紅的士：有四個會轉、會自轉的車輪，兩盞頭燈、車底軟影同懸掛樞軸', { skip }, async () => {
  const { THREE, HK, drive, vehicles } = await load();
  scene: {
    const scene = new THREE.Scene();
    const player = drive.createPlayer(scene, makeColliders(HK, THREE));
    assert.equal(player.wheels.length, 4, '要有四條輪胎（唔係一個合併 mesh）');
    assert.equal(player.wheels.filter((w) => w.isFront).length, 2, '前輪要有兩條（可以轉向）');
    for (const w of player.wheels) {
      assert.ok(w.tire?.isMesh, '每個輪胎都要係獨立 mesh，才可以自轉');
      assert.ok(w.steerPivot?.isObject3D, '每個輪胎要有轉向樞軸');
    }
    assert.equal(player.headLights.length, 2, '要有兩盞頭燈 SpotLight');
    for (const spot of player.headLights) {
      assert.ok(spot.isSpotLight, '頭燈要係 SpotLight');
      assert.ok(spot.intensity > 0, '頭燈要真係開着（用戶：車燈不着）');
    }
    assert.ok(player.carShadow?.isMesh, '要有車底 contact shadow，車唔會再看落像浮空');
    assert.ok(player.chassisPivot?.isObject3D, '要有懸掛樞軸');

    // 車輪要貼地：世界座標的最低點 = 路面高度（±3 cm）
    player.root.position.set(HK.SPAWN.x, HK.KERB_HEIGHT, HK.SPAWN.z);
    player.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const w of player.wheels) box.expandByObject(w.steerPivot);
    assert.ok(Math.abs(box.min.y - HK.KERB_HEIGHT) < 0.03, `車輪最低點應該貼住路面（${box.min.y.toFixed(3)} vs ${HK.KERB_HEIGHT}）`);

    assert.ok(vehicles.HK_TAXI_SPEC.headlampsOn, '香港的士的頭燈要長亮');
  }
});

test('駕駛手感：起步有後仰、剎車有前傾、車輪按里程轉、剎車燈會着', { skip }, async () => {
  const { THREE, HK, drive } = await load();
  const scene = new THREE.Scene();
  const player = drive.createPlayer(scene, makeColliders(HK, THREE));
  const dt = 1 / 60;

  const startX = player.state.x;
  const startZ = player.state.z;

  // 起步：油門踩 1 秒
  player.keys.forward = true;
  for (let i = 0; i < 60; i++) player.update(dt);
  const speed = player.state.speed;
  assert.ok(speed > 3, `踩一秒油門應該有速度（實際 ${speed.toFixed(2)} m/s）`);
  const moved = Math.hypot(player.state.x - startX, player.state.z - startZ);
  assert.ok(moved > 1, `車要真係行前（實際 ${moved.toFixed(2)} m）`);
  assert.ok(Math.abs(player.state.wheelSpin) > 0.5, `車輪要自轉（spin=${player.state.wheelSpin.toFixed(2)}）`);
  assert.ok(player.state.pitch < 0, `起步加速時車頭應該抬起（pitch=${player.state.pitch.toFixed(4)}）`);

  // 剎車：等懸掛回中，再踩 Space
  player.keys.forward = false;
  for (let i = 0; i < 60; i++) player.update(dt);
  player.keys.brake = true;
  let sawNoseDive = false;
  for (let i = 0; i < 12; i++) {
    player.update(dt);
    if (player.state.pitch > 0.002) sawNoseDive = true;
  }
  assert.ok(sawNoseDive, `剎車時車頭應該向下沉（pitch=${player.state.pitch.toFixed(4)}）`);
  assert.ok(player.material.userData.carState.value.x === 1, '剎車燈要亮（carState.x = 1）');

  // 車身唔會沉入地下
  assert.ok(player.state.heaveY >= -0.08 && player.state.heaveY <= 0.08, '懸掛行程要在合理範圍');
});

test('車速：油門踩落去真係快（市區巡航 > 100 km/h，Shift 更快）', { skip }, async () => {
  const { THREE, HK, drive } = await load();
  const scene = new THREE.Scene();
  const player = drive.createPlayer(scene, makeColliders(HK, THREE));
  const dt = 1 / 60;

  player.keys.forward = true;
  for (let i = 0; i < 60 * 8; i++) player.update(dt);
  const cruise = player.state.speed;
  assert.ok(cruise > 30, `8 秒油門之後應該 > 30 m/s（108 km/h），實際 ${cruise.toFixed(1)} m/s = ${(cruise * 3.6).toFixed(0)} km/h`);
  assert.ok(cruise > 32, `巡航要接近上限（實際 ${cruise.toFixed(1)} m/s = ${(cruise * 3.6).toFixed(0)} km/h，改之前只有 79 km/h）`);
  assert.ok(cruise <= 36.5, `唔應該超過巡航上限（${cruise.toFixed(1)} m/s）`);

  player.keys.boost = true;
  for (let i = 0; i < 60 * 4; i++) player.update(dt);
  const boosted = player.state.speed;
  assert.ok(boosted > cruise + 8, `Shift 加速要明顯更快（${boosted.toFixed(1)} vs ${cruise.toFixed(1)} m/s）`);
  assert.ok(boosted > 40, `Shift 4 秒之後應該 > 144 km/h（實際 ${(boosted * 3.6).toFixed(0)} km/h）`);
  assert.ok(boosted <= 52.5, '加速上限要守住');
});

test('視角：追尾／近鏡／車頭冚／車廂內 四個都揀得到，而且位置合理', { skip }, async () => {
  const { THREE, HK, drive } = await load();
  const scene = new THREE.Scene();
  const player = drive.createPlayer(scene, makeColliders(HK, THREE));
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.35, 40000);
  const dom = { addEventListener() {}, setPointerCapture() {} };
  const chase = new drive.ChaseCamera(camera, dom);

  const ids = drive.CAMERA_MODES.map((m) => m.id);
  assert.deepEqual(ids, ['chase', 'close', 'bonnet', 'cockpit'], '要有四個視角，包括車廂內');
  assert.equal(chase.mode, 'chase', '預設是追尾');

  // 把車放到一個已知位置與朝向
  player.state.x = HK.SPAWN.x;
  player.state.z = HK.SPAWN.z;
  player.state.heading = 0; // 面向 +Z
  const fx = Math.sin(0);
  const fz = Math.cos(0);

  const distanceFromCar = () => Math.hypot(camera.position.x - player.state.x, camera.position.z - player.state.z);

  chase.setMode('chase');
  for (let i = 0; i < 240; i++) chase.update(1 / 60, player.state);
  const chaseDist = distanceFromCar();
  assert.ok(chaseDist > 6, `追尾鏡頭應該在車後方（實際 ${chaseDist.toFixed(1)} m）`);
  // 在車後：沿 −forward 方向
  const behind = (camera.position.x - player.state.x) * fx + (camera.position.z - player.state.z) * fz;
  assert.ok(behind < -4, `追尾要在車尾方向（forward 分量 ${behind.toFixed(1)} m）`);

  chase.setMode('close');
  for (let i = 0; i < 240; i++) chase.update(1 / 60, player.state);
  assert.ok(distanceFromCar() < chaseDist - 2, '近鏡要比追尾更貼近');

  chase.setMode('bonnet');
  for (let i = 0; i < 30; i++) chase.update(1 / 60, player.state);
  const bonnetFwd = (camera.position.x - player.state.x) * fx + (camera.position.z - player.state.z) * fz;
  assert.ok(bonnetFwd > 0.8, `車頭冚鏡頭要在車頭（forward 分量 ${bonnetFwd.toFixed(2)} m）`);
  assert.ok(camera.position.y > HK.KERB_HEIGHT + 0.9, '車頭冚鏡頭要高過引擎蓋');

  chase.setMode('cockpit');
  for (let i = 0; i < 30; i++) chase.update(1 / 60, player.state);
  const side = Math.abs((camera.position.x - player.state.x) * fz - (camera.position.z - player.state.z) * fx);
  const along = (camera.position.x - player.state.x) * fx + (camera.position.z - player.state.z) * fz;
  assert.ok(side < 0.9, `車廂內鏡頭要在車身闊度之內（側向 ${side.toFixed(2)} m）`);
  assert.ok(Math.abs(along) < 1.1, `車廂內鏡頭要在車廂位置（縱向 ${along.toFixed(2)} m）`);
  assert.ok(camera.position.y > HK.KERB_HEIGHT + 1.0 && camera.position.y < HK.KERB_HEIGHT + 1.6, `司機眼高要合理（${camera.position.y.toFixed(2)} m）`);

  // 車廂內是右軚（香港）：司機位在車的右邊（本地 x 為負）
  const cockpit = drive.CAMERA_MODES.find((m) => m.id === 'cockpit');
  assert.ok(cockpit.offset[0] < 0, '香港右軚：司機位在車身右邊（本地 x < 0）');

  // C 鍵循環
  chase.setMode('chase');
  const order = [chase.nextMode(), chase.nextMode(), chase.nextMode(), chase.nextMode()];
  assert.deepEqual(order, ['close', 'bonnet', 'cockpit', 'chase'], 'C 鍵要順序循環四個視角');
});

test('光線：四個預設可以直接揀（唔止 G 鍵循環）', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const lighting = await import('../js/hk/lighting.js');
  // 用假的 scene/renderer 建一個照明系統，確認四個預設都存在而且天空色唔同
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const sys = lighting.createHongKongLighting(scene, { shadows: false, preset: 'golden' });
  const ids = Object.keys(sys.PRESETS);
  assert.deepEqual(ids.sort(), ['golden', 'midday', 'midnight', 'twilight']);
  const skies = new Set(ids.map((id) => sys.PRESETS[id].sky));
  assert.equal(skies.size, 4, '四個預設要有四個唔同的天空色');
  for (const id of ids) {
    sys.applyPreset(id);
    assert.equal(sys.activeId, id, `applyPreset('${id}') 要真正生效`);
  }
  // HUD 要有得直接揀，唔需要記住 G 鍵
  const main = readFileSync(new URL('../js/hk/main.js', import.meta.url), 'utf8');
  assert.match(main, /const LIGHT_PRESETS = \[/, '要有光線預設清單');
  assert.match(main, /data-light="\$\{p\.id\}"/, 'HUD 要有光線按鈕');
  assert.match(main, /closest\('\[data-light\]'\)/, '按光線按鈕要切換');
  assert.match(main, /e\.code === 'KeyC'/, 'C 鍵要切換視角');
  assert.match(main, /data-cam="\$\{m\.id\}"/, 'HUD 要有視角按鈕');
});
