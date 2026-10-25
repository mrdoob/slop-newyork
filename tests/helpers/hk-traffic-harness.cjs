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
    perFleet: traffic.cars.length
  }));
  if (traffic.counts.cars !== 96) throw new Error(`expected 96 cars, got ${traffic.counts.cars}`);
  if (!finite) throw new Error('a car ended up at a non-finite distance');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
