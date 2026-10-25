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
