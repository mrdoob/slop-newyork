import * as THREE from 'three/webgpu';
import { color, mix, smoothstep, step, positionLocal } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GEO } from './taipei-geodata.js';
import { buildFootprintBuildings } from './footprint-buildings.js';
import { buildGraphRoads } from './graph-roads.js';
import { SimpleVehicles } from './simple-vehicles.js';
import { buildGreenAreas, treeSites } from './green-areas.js';
import { createTreeField } from './trees.js';
import { buildSignalControl } from './signal-control.js';
import { buildFootprintTraffic } from './footprint-traffic.js';
import { buildStreetFurniture } from './street-furniture.js';

// js/taipei-main.js
// Taipei milestone viewer (taipei.html): the 1 km box around Taipei 101 from OSM footprints, orbit camera, sun & sky.
// The NYC app (index.html, js/main.js) is untouched and stays the comparison baseline.

// Loading screen (taipei.html #loading): a sweeping bar while the modules download, then real progress through the
// build steps and shader compilation. Each step yields a frame so the bar repaints between the synchronous builds.
const loading = {
  el: document.getElementById('loading'),
  bar: document.getElementById('loading-bar'),
  fill: document.getElementById('loading-fill'),
  status: document.getElementById('loading-status'),
  set(p, label) {
    const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
    this.bar.classList.remove('is-indeterminate');
    this.fill.style.transform = `scaleX(${pct / 100})`;
    this.bar.setAttribute('aria-valuenow', String(pct));
    if (label) this.status.textContent = `${label}… ${pct}%`;
  },
  async step(p, label) {
    this.set(p, label);
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  },
  done() {
    this.set(1);
    this.status.textContent = 'Ready';
    this.el.classList.add('hidden');
    this.el.addEventListener('transitionend', () => this.el.remove(), { once: true });
  },
  fail(message) {
    this.bar.classList.remove('is-indeterminate');
    this.el.classList.add('failed');
    this.status.textContent = message;
  }
};

// Compile every visible object's shaders behind the loading screen (onProgress: 0..1), a few side by side: one
// compileAsync() waits a frame after each slice of work, so several keep the main thread busy. Meshes sharing a
// material share a pipeline, so one job compiles them in turn.
async function precompile(renderer, scene, camera, onProgress) {
  const jobs = [];
  const byMaterial = new Map();
  scene.traverseVisible((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh || Array.isArray(o.material)) { jobs.push([o]); return; }
    if (!byMaterial.has(o.material)) { byMaterial.set(o.material, []); jobs.push(byMaterial.get(o.material)); }
    byMaterial.get(o.material).push(o);
  });
  let next = 0, done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      for (const object of job) {
        await new Promise((resolve) => setTimeout(resolve, 0)); // each compile in a task of its own
        try {
          await renderer.compileAsync(object, camera, scene);
        } catch (e) {
          console.warn('[compile]', e); // the first frame compiles it instead
        }
      }
      onProgress(++done / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

async function init() {
  await loading.step(0.02, 'Starting WebGPU');
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  await loading.step(0.06, 'Lighting the sky');

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xb9cddc);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 1500, 6000);

  // Box extent in world metres, from the frame's [S, W, N, E] box
  const [s, w, n, e] = GEO.frame.box;
  const kx = (Math.PI / 180) * 6378137 * Math.cos((GEO.frame.lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * 6378137;
  const half = Math.max((e - w) * kx, (n - s) * ky) / 2;

  // Ground: the lots and plazas between the streets
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 6, half * 6),
    new THREE.MeshStandardNodeMaterial({ color: 0x8c8a83, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Sky reflections (glass, car paint): an environment map of a blue sky over a grey city floor
  const envScene = new THREE.Scene();
  const envMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const up = positionLocal.normalize().y;
  envMat.colorNode = mix(color(0x8f8b84), mix(color(0xdde6ee), color(0x5f8fc4), smoothstep(0.0, 0.7, up)), step(0.0, up));
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat));
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(envScene).texture;
  scene.environmentIntensity = 0.6;

  scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x5a5650, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
  sun.position.set(-700, 1100, 500); // afternoon sun from the south-west
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 10, far: 3500 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  await loading.step(0.1, `Raising ${GEO.buildings.length} buildings`);
  const buildings = buildFootprintBuildings(scene, GEO);
  await loading.step(0.22, 'Paving roads & sidewalks');
  // Taiwan marks two-way centre lines in yellow (lane dividers stay white)
  buildGraphRoads(scene, GEO, { centreLineColour: 0xe8b420 });
  await loading.step(0.3, `Planting ${(GEO.trees || []).length} trees & street furniture`);
  buildGreenAreas(scene, GEO);
  scene.add(createTreeField(scene, treeSites(GEO)).group);
  // Street furniture in Taipei's colours: YouBike 2.0 yellow, Chunghwa Post's green & red post box pair, Taipei Metro blue
  buildStreetFurniture(scene, GEO, { bikeShareColour: 0xf0b400, postBoxColours: [0x2e8b3a, 0xc8261e], metroSignColour: 0x0b5aa2 });
  await loading.step(0.38, 'Signals, cars & pedestrians');

  // Signals & traffic: Taiwan drives on the right; cars mostly white, silver, grey & black, taxis yellow
  const signals = buildSignalControl(scene, GEO, { driveOnRight: true });
  const traffic = buildFootprintTraffic(scene, GEO, {
    signals,
    driveOnRight: true,
    carCount: 140,
    pedCount: 220,
    taxiShare: 0.14,
    taxiColour: 0xf3c316,
    palette: [0xf4f4f2, 0xf4f4f2, 0xf4f4f2, 0xc8cbcf, 0xc8cbcf, 0x8a8e93, 0x1c1e21, 0x1c1e21, 0x24395a, 0x7d1d22]
  });

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 20000);
  camera.position.set(900, 520, 1100); // from the south-east, Taipei 101 in view
  const controls = new OrbitControls(camera, renderer.domElement);
  const t101 = GEO.landmarks['Taipei 101'];
  controls.target.set(t101 ? t101.x : 0, 120, t101 ? t101.z : 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 30;
  controls.maxDistance = 6000;
  controls.update();

  // HUD: what is data and what is estimated
  const st = buildings.stats;
  const pct = (k) => Math.round((100 * st.bySource[k]) / st.total);
  document.getElementById('stats').textContent =
    `${st.total} buildings · heights: ${pct('height')}% height tag, ${pct('levels')}% storey count, ` +
    `${pct('estimate')}% estimated · tallest ${st.maxTop} m`;
  let showEstimates = false;
  const toggle = document.getElementById('btn-estimates');
  const setEstimates = (on) => {
    showEstimates = on;
    buildings.setShowEstimates(on);
    toggle.setAttribute('aria-pressed', String(on));
  };
  toggle.addEventListener('click', () => setEstimates(!showEstimates));
  window.addEventListener('keydown', (ev) => { if (ev.key === 'e' || ev.key === 'E') setEstimates(!showEstimates); });

  // Car & plane: Taiwan drives on the right; the car starts on the widest road near Taipei 101, the plane south of it
  const vehicles = new SimpleVehicles(scene, GEO, {
    spawnNear: { x: t101 ? t101.x : 0, z: t101 ? t101.z : 0 },
    driveOnRight: true,
    blocked: (x, z, fx, fz, hl, hw) =>
      traffic.carOverlaps(x, z, fx, fz, hl + 0.1, hw + 0.1) || traffic.pedNear(x + fx * hl * 0.6, z + fz * hl * 0.6, 1.6) || traffic.pedNear(x - fx * hl * 0.6, z - fz * hl * 0.6, 1.6),
    planeSpawn: { x: -250, y: 220, z: 900, heading: 0 }
  });
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  const vehicleStatus = document.getElementById('vehicle-status');
  const setMode = (mode) => {
    if (mode === 'orbit' && vehicles.mode !== 'orbit') {
      // keep looking at where the vehicle was
      const v = vehicles.mode === 'car' ? vehicles.car : vehicles.plane;
      controls.target.set(v.x, vehicles.mode === 'car' ? 0 : v.y, v.z);
    }
    vehicles.setMode(mode, camera);
    controls.enabled = mode === 'orbit';
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    document.getElementById('drive-help').hidden = mode === 'orbit';
    renderer.domElement.focus();
  };
  for (const b of modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));
  window.addEventListener('keydown', (ev) => {
    const mode = { Digit1: 'orbit', Digit2: 'car', Digit3: 'plane' }[ev.code];
    if (mode) setMode(mode);
  });

  // Shaders: compile with the city's first frame of traffic in place, the car & plane shown for the moment
  signals.update(0);
  traffic.update(1 / 60, camera, null);
  vehicles.car.group.visible = vehicles.plane.group.visible = true;
  await loading.step(0.45, 'Compiling shaders');
  await precompile(renderer, scene, camera, (f) => loading.set(0.45 + 0.55 * f, 'Compiling shaders'));
  vehicles.car.group.visible = vehicles.plane.group.visible = false;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = timer.getDelta();
    if (vehicles.mode === 'orbit') controls.update();
    else vehicles.update(dt, camera);
    signals.update(dt);
    traffic.update(dt, camera, vehicles.mode === 'car' ? vehicles.car : null);
    vehicleStatus.textContent = vehicles.status;
    renderer.render(scene, camera);
  });
  window.__taipei = { scene, camera, controls, buildings, vehicles, setMode, signals, traffic }; // for debugging from the console
  requestAnimationFrame(() => loading.done());
}

init().catch((err) => {
  console.error(err);
  const message = `Failed to start: ${err.message} (WebGPU needs a recent Chrome or Edge, served over http)`;
  loading.fail(message);
  document.getElementById('stats').textContent = message;
});
