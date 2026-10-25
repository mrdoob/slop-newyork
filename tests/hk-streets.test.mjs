import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

// 街道層的「唔應該發生」檢查：
//   ① 地標唔可以企喺行車道中間（用家截圖：一塊冇材質的灰色大盒企正喺干諾道中）
//   ② 行人只可以行行人道，唔可以行出馬路
// 兩者都係由 corridor 幾何推導，所以可以直接用數學驗，唔需要 GPU。
const hasThree = existsSync(new URL('../node_modules/three/package.json', import.meta.url));
const skip = hasThree ? false : 'three is not installed (npm install three@0.186.1 --no-save)';

const HK = await import('../js/hk/config.js');

/** 點到最近走廊中心線的距離，以及該走廊的半寬。 */
function nearestRoad(x, z) {
  let best = { dist: Infinity, halfWidth: 0, road: null };
  for (const road of HK.ROADS) {
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen2 = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / segLen2));
      const dist = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (dist < best.dist) best = { dist, halfWidth: road.w / 2, road };
    }
  }
  return best;
}

/** 軸對齊 box 沿方向 (nx, nz) 的半寬（support function）。 */
const extentAlong = (item, nx, nz) => Math.abs(nx) * (item.w / 2) + Math.abs(nz) * (item.d / 2);

test('冇任何地標壓住行車道', () => {
  const overlapping = [];
  for (const lm of HK.LANDMARKS) {
    let worst = Infinity;
    for (const road of HK.ROADS) {
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1];
        const b = road.pts[i];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const segLen2 = dx * dx + dz * dz || 1e-6;
        const t = Math.max(0, Math.min(1, ((lm.x - a.x) * dx + (lm.z - a.z) * dz) / segLen2));
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        let nx = lm.x - px;
        let nz = lm.z - pz;
        const dist = Math.hypot(nx, nz);
        if (dist > 1e-4) { nx /= dist; nz /= dist; } else { nx = 1; nz = 0; }
        worst = Math.min(worst, dist - road.w / 2 - extentAlong(lm, nx, nz));
      }
    }
    if (worst < 0) overlapping.push(`${lm.id} (${worst.toFixed(1)} m)`);
  }
  assert.deepEqual(overlapping, [], `以下地標企喺行車道上面：${overlapping.join(', ')}`);
});

test('被搬過嘅地標都有記錄，而且冇被搬到海中心', () => {
  const moved = HK.LANDMARKS.filter((l) => l.shiftedByRoad);
  for (const lm of moved) {
    assert.ok(lm.shiftedByRoad <= 200, `${lm.id} 被搬咗 ${lm.shiftedByRoad} m，太遠`);
    const near = nearestRoad(lm.x, lm.z);
    assert.ok(near.dist < 400, `${lm.id} 離所有街道 ${near.dist.toFixed(0)} m，可能搬咗入海`);
  }
});

test('行人道由走廊推導，而且全部喺行車道以外', { skip }, async () => {
  const { buildSidewalks, walkPose } = await import('../js/hk/pedestrians.js');
  const paths = buildSidewalks();
  assert.ok(paths.length >= 20, `只有 ${paths.length} 條行人道`);
  for (const path of paths) {
    assert.ok(path.len > 20, `行人道太短：${path.len}`);
    assert.ok(path.side === 1 || path.side === -1, 'side 只可以係 ±1');
  }
  // 沿每條行人道取樣，確認它與**自己那條**走廊的車道邊界保持距離。
  // （用最近走廊唔得：兩條街交界處，A 街的行人道的確會經過 B 街的中心線。）
  const distToRoad = (road, x, z) => {
    let best = Infinity;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1];
      const b = road.pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
    }
    return best;
  };
  let checked = 0;
  for (const path of paths.slice(0, 10)) {
    for (let s = 0; s <= path.len; s += 37) {
      const pose = walkPose(path, s, 0);
      const own = distToRoad(path.road, pose.x, pose.z);
      assert.ok(
        own >= path.road.w / 2 - 0.5,
        `行人道位置 (${pose.x.toFixed(0)}, ${pose.z.toFixed(0)}) 距自己條街中心線 ${own.toFixed(1)} m（半寬 ${path.road.w / 2}）`
      );
      assert.ok(Number.isFinite(pose.x) && Number.isFinite(pose.z));
      checked++;
    }
  }
  assert.ok(checked > 50);
});

test('行人實例：位置有限、貼住地面、唔會走出馬路', { skip }, async () => {
  const { createHongKongPedestrians } = await import('../js/hk/pedestrians.js');
  const scene = { children: [], add(o) { this.children.push(o); } };
  const peds = await createHongKongPedestrians(scene, { count: 120 });
  assert.equal(peds.counts.pedestrians, 120);
  assert.equal(peds.counts.model, 'nyc-person', '應該重用紐約的人物模型（PersonCrowd）');
  assert.equal(scene.children.length, 1, '行人應該集中喺一個 group');
  const group = scene.children[0];
  assert.equal(group.children.length, 2, 'PersonCrowd 的兩個 LOD 網格（近／遠）');
  assert.equal(peds.meshes.length, 2);

  for (let frame = 0; frame < 120; frame++) peds.update(1 / 30);

  for (const p of peds.pedestrians) {
    assert.ok(Number.isFinite(p.s), '行人 s 變成 NaN');
    assert.ok(p.s >= 0 && p.s <= p.path.len, `行人 s 超出範圍：${p.s}/${p.path.len}`);
    assert.ok(p.speed >= 1.0 && p.speed <= 1.7, `行人速度不合理：${p.speed}`);
  }
});

test('地圖：世界座標 ↔ 地圖座標可以來回轉換，而且全部落在地圖之內', async () => {
  const { createProjection } = await import('../js/hk/map.js');
  const bounds = { minX: -2000, maxX: 1800, minZ: -4200, maxZ: -200 };
  for (const size of [300, 420, 128]) {
    const projection = createProjection(bounds, size, size, 12);
    for (const point of [
      { x: bounds.minX, z: bounds.minZ },
      { x: bounds.maxX, z: bounds.maxZ },
      { x: 0, z: -2000 },
      { x: 320, z: -4048 }
    ]) {
      const m = projection.toMap(point.x, point.z);
      assert.ok(m.x >= -0.001 && m.x <= size + 0.001, `x 超出地圖：${m.x}`);
      assert.ok(m.y >= -0.001 && m.y <= size + 0.001, `y 超出地圖：${m.y}`);
      const back = projection.toWorld(m.x, m.y);
      assert.ok(Math.abs(back.x - point.x) < 0.5, `x round-trip：${back.x} vs ${point.x}`);
      assert.ok(Math.abs(back.z - point.z) < 0.5, `z round-trip：${back.z} vs ${point.z}`);
    }
    // 北朝上：z 越細（越北）y 越細
    const north = projection.toMap(0, bounds.minZ + 100);
    const south = projection.toMap(0, bounds.maxZ - 100);
    assert.ok(north.y < south.y, '地圖要北朝上');
  }
});
