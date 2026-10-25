// Builds the Hong Kong traffic system outside the browser, so a hang shows up as a killed process
// instead of a frozen tab. Run by tests/hk-traffic.test.cjs through spawnSync with a timeout.
const { loadModule } = require('./module.cjs');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = join(__dirname, '..', '..');
  const HK = await import(pathToFileURL(join(root, 'js/hk/config.js')).href);

  class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new V3(this.x, this.y, this.z); }
    lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  }
  const THREE = {
    Group: class { constructor() { this.children = []; } add(...o) { this.children.push(...o); } },
    InstancedMesh: class {
      constructor(geo, mat, count) { this.geometry = geo; this.material = mat; this.count = count; this.instanceMatrix = { setUsage() {}, needsUpdate: false }; this.setMatrixAtCalls = 0; }
      setMatrixAt() { this.setMatrixAtCalls++; }
    },
    DynamicDrawUsage: 35048,
    Vector3: V3,
    Matrix4: class { compose() { return this; } },
    Quaternion: class { setFromAxisAngle() { return this; } }
  };
  const scene = { children: [], add(...o) { this.children.push(...o); } };
  const vehicleStub = {
    AI_FLEET: [
      { id: 'taxi', share: 0.46, geometry: () => ({ name: 'taxi' }) },
      { id: 'sedan-white', share: 0.22, geometry: () => ({ name: 'sedan-white' }) },
      { id: 'sedan-silver', share: 0.16, geometry: () => ({ name: 'sedan-silver' }) },
      { id: 'suv-dark', share: 0.16, geometry: () => ({ name: 'suv-dark' }) }
    ],
    createAiMaterial: () => ({}),
    buildDoubleDecker: () => ({ position: new V3(), rotation: new V3() }),
    buildTram: () => ({ position: new V3(), rotation: new V3() }),
    buildMinibus: () => ({ position: new V3(), rotation: new V3() }),
    buildFerry: () => ({ position: new V3(), rotation: new V3() })
  };

  const source = readFileSync(join(root, 'js/hk/traffic.js'), 'utf8');
  const { createHongKongTraffic } = loadModule(source, {
    globals: { Math, console },
    imports: { 'three/webgpu': THREE, './config.js': HK, './fleet.js': { allocateFleet: (await import(pathToFileURL(join(root, 'js/hk/fleet.js')).href)).allocateFleet }, './vehicles.js': vehicleStub }
  });

  const t0 = Date.now();
  const traffic = createHongKongTraffic(scene);
  const buildMs = Date.now() - t0;

  // A few simulated frames, including lane recycling (cars reaching the end of their lane).
  const camera = new V3(0, 20, 0);
  const startLanes = traffic.cars.map((c) => traffic.lanes.indexOf(c.lane));
  const startHeavyLanes = traffic.heavy.map((v) => traffic.lanes.indexOf(v.lane));
  let minSameLaneGap = Infinity;
  const ft0 = Date.now();
  for (let frame = 0; frame < 200; frame++) {
    traffic.update(1 / 30, camera);
    for (const v of [...traffic.cars, ...traffic.heavy]) {
      if (!v.lane || !Number.isFinite(v.s)) continue;
      if (v.s < -1e-6 || v.s > v.lane.len + 1e-6) throw new Error(`s out of range: ${v.s} / ${v.lane.len}`);
    }
    // 同一條車道、同一個 frame 的「沿線間距」：唔可以疊車
    const byLane = new Map();
    for (const v of [...traffic.cars, ...traffic.heavy]) {
      if (!v.lane) continue;
      const list = byLane.get(v.lane) || [];
      list.push(v.s);
      byLane.set(v.lane, list);
    }
    for (const list of byLane.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a - b);
      for (let i = 1; i < list.length; i++) minSameLaneGap = Math.min(minSameLaneGap, list[i] - list[i - 1]);
    }
  }
  const frameMs = (Date.now() - ft0) / 200;
  const laneChanges = traffic.cars.filter((c, i) => traffic.lanes.indexOf(c.lane) !== startLanes[i]).length;
  const heavyLaneChanges = traffic.heavy.filter((v, i) => traffic.lanes.indexOf(v.lane) !== startHeavyLanes[i]).length;

  // 撞車：把玩家放在第一架車的位置上，應該被推開 + 大幅減速
  const target = traffic.cars[0];
  const pose = HK.poseAt(target.lane, target.s);
  const player = { x: pose.x, z: pose.z, speed: 12 };
  const bump = traffic.collidePlayer(player);
  const pushed = Math.hypot(player.x - pose.x, player.z - pose.z);

  // 長車身的回歸測試（用戶截圖：巴士穿過紅的士）。
  // 把玩家放在巴士**中段旁邊**：距巴士中心 ~4.7 m，舊的「中心點距離 < 5.6 m 才算撞」仍然會漏，
  // 而且玩家其實已經在 1.28 m 半闊的車身裡面。
  const bus = traffic.heavy.find((v) => v.kind === 'bus');
  const busPose = HK.poseAt(bus.lane, bus.s);
  const sideX = Math.cos(busPose.heading);
  const sideZ = -Math.sin(busPose.heading);
  const fwdX = Math.sin(busPose.heading);
  const fwdZ = Math.cos(busPose.heading);
  const beside = { x: busPose.x + fwdX * 4.6 + sideX * 0.9, z: busPose.z + fwdZ * 4.6 + sideZ * 0.9, speed: 9 };
  const busBump = traffic.collidePlayer(beside);
  // 推開之後，玩家應該完全離開巴士車身矩形（半長 5.9、半闊 1.28）＋ 玩家半徑
  const lf = (beside.x - busPose.x) * fwdX + (beside.z - busPose.z) * fwdZ;
  const ll = (beside.x - busPose.x) * sideX + (beside.z - busPose.z) * sideZ;
  const outF = Math.max(0, Math.abs(lf) - 5.9);
  const outL = Math.max(0, Math.abs(ll) - 1.28);
  const busClearance = Math.hypot(outF, outL);
  const busStopped = bus.speed;

  // 迎面而來的巴士會因為玩家在前方而收油
  const ahead = traffic.heavy.find((v) => v.kind === 'bus');
  const poseAhead = HK.poseAt(ahead.lane, ahead.s);
  const playerAhead = { x: poseAhead.x + Math.sin(poseAhead.heading) * 12, z: poseAhead.z + Math.cos(poseAhead.heading) * 12, speed: 0 };
  for (let i = 0; i < 30; i++) traffic.update(1 / 30, camera, playerAhead);
  const busSlowed = ahead.speed;

  // 電車軌：AI 車道唔可以壓住電車線（實測舊版 1,249 個取樣點 < 2 m，最近 0.04 m = 汽車穿過電車）
  function distanceToTram(x, z) {
    let best = Infinity;
    for (let i = 1; i < HK.TRAM.length; i++) {
      const a = HK.TRAM[i - 1];
      const b = HK.TRAM[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const d = Math.hypot(a.x + t * dx - x, a.z + t * dz - z);
      if (d < best) best = d;
    }
    return best;
  }
  let tramSamples = 0;
  let tramNear = 0;
  for (const lane of traffic.lanes) {
    for (let s = 0; s <= lane.len; s += 6) {
      const p = HK.poseAt(lane, s);
      tramSamples++;
      if (distanceToTram(p.x, p.z) < 2.6) tramNear++;
    }
  }

  const positions = traffic.cars.map((c) => c.s);
  const finite = positions.every((s) => Number.isFinite(s));
  console.log(JSON.stringify({
    cars: traffic.counts.cars,
    laneChanges,
    heavyLaneChanges,
    minSameLaneGap: +minSameLaneGap.toFixed(2),
    bumpHit: bump.hit,
    bumpedSpeed: +player.speed.toFixed(2),
    pushedBy: +pushed.toFixed(2),
    lanes: traffic.counts.lanes,
    buses: traffic.counts.buses,
    minibuses: traffic.counts.minibuses,
    trams: traffic.counts.trams,
    buildMs,
    frameMs: +frameMs.toFixed(3),
    finite,
    busSideHit: busBump.hit,
    busClearance: +busClearance.toFixed(2),
    busStopped: +busStopped.toFixed(2),
    busSlowed: +busSlowed.toFixed(2),
    tramNear,
    tramSamples,
    lanesOnTramTracks: traffic.counts.lanesOnTramTracks,
    perFleet: traffic.cars.length
  }));
  if (traffic.counts.cars !== 96) throw new Error(`expected 96 cars, got ${traffic.counts.cars}`);
  if (!finite) throw new Error('a car ended up at a non-finite distance');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
