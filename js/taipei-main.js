import * as THREE from 'three/webgpu';
import { color, mix, smoothstep, step, positionLocal } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildFootprintBuildings } from './footprint-buildings.js';
import { buildGraphRoads } from './graph-roads.js';
import { SimpleVehicles } from './simple-vehicles.js';
import { buildGreenAreas, treeSites } from './green-areas.js';
import { createTreeField } from './trees.js';
import { buildSignalControl } from './signal-control.js';
import { buildViaduct } from './viaduct.js';
import { buildFootprintTraffic } from './footprint-traffic.js';
import { buildStreetFurniture } from './street-furniture.js';
import { buildBasemapOverlay } from './basemap-overlay.js';
import { FootprintMap } from './footprint-map.js';
import { TimeOfDay } from './time-of-day.js';
import { initPanels } from './hud-panels.js';
import { buildTerrainMesh, groundOpening } from './terrain.js';
import { TouchControls } from './touch-controls.js';

// js/taipei-main.js
// Taipei viewer (index.html): one area (GEO.frame.box) from OSM, orbit camera, sun & sky. ?area= picks it: xinyi
// (default; Xinyi District), city (Xinyi + Da'an Districts) or wanhua (1 km around Lungshan Temple), each its own
// generated geodata file.
// The NYC app (nyc.html, js/main.js) is untouched and stays the comparison baseline.

// Loading screen (index.html #loading): a sweeping bar while the modules download, then real progress through the
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

// Phones & tablets: a touch screen gets lighter settings (no MSAA, a smaller shadow map, half the traffic, a lower pixel
// ratio that adapts to the frame rate) and starts with the info & help panels minimized
const TOUCH = window.matchMedia('(any-pointer: coarse)').matches;
const SMALL = TOUCH || window.innerWidth < 700;
const panels = initPanels({ small: SMALL });
if (TOUCH) document.querySelector('.stack').append(document.querySelector('.hud')); // up out of the touch controls' way

const AREAS = { xinyi: './taipei-geodata.js', city: './taipei-city-geodata.js', wanhua: './taipei-wanhua-geodata.js' };
const AREA = AREAS[new URLSearchParams(location.search).get('area')] ? new URLSearchParams(location.search).get('area') : 'xinyi';
let GEO;

async function init() {
  ({ GEO } = await import(AREAS[AREA]));
  await loading.step(0.02, 'Starting WebGPU');
  const renderer = new THREE.WebGPURenderer({ antialias: !TOUCH, powerPreference: 'high-performance', reversedDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, TOUCH ? 1.5 : 2));
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

  // Box extent in world metres, from the frame's [S, W, N, E] box
  const [s, w, n, e] = GEO.frame.box;
  const kx = (Math.PI / 180) * 6378137 * Math.cos((GEO.frame.lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * 6378137;
  const half = Math.max((e - w) * kx, (n - s) * ky) / 2;
  scene.fog = new THREE.Fog(sky, Math.max(2500, half * 2.4), Math.max(9000, half * 8)); // haze beyond the area's far side
  // farthest the box reaches from the origin (the origin, the landmark, needn't be its centre), plus room to turn back
  const reach = Math.max(Math.abs((w - GEO.frame.lon0) * kx), Math.abs((e - GEO.frame.lon0) * kx), Math.abs((n - GEO.frame.lat0) * ky), Math.abs((s - GEO.frame.lat0) * ky)) + 300;

  // Ground: the lots and plazas between the streets
  const groundMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x8c8a83, roughness: 0.95 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 6, half * 6), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GEO.terrain ? -0.1 : 0; // beyond the terrain grid: flat land just under it
  ground.receiveShadow = true;
  scene.add(ground);
  // Hills (GEO.terrain; Xinyi's Four Beasts): the ground follows them, and so does everything placed on it
  // Hillsides tint towards a wooded green as they rise above the basin (a look, not data: Taipei's hills are wooded, OSM
  // maps only some of the woods, which draw on top as green areas with trees)
  const hillMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  hillMaterial.colorNode = mix(color(0x8c8a83), color(0x5a6b45), smoothstep(6.0, 30.0, positionLocal.y));
  const terrainMesh = buildTerrainMesh(GEO, hillMaterial);
  if (terrainMesh) scene.add(terrainMesh);
  // Underpass ramps (GEO.roadGraph.rampDepth) go below the street: an invisible lid over them (0.15 m: out to the
  // retaining walls, js/graph-roads.js) is drawn after the roads and cars and before the ground, so the ground leaves
  // the trench showing (render orders: roads & cars -4, lid -3, ground -2; set below once those exist)
  const opening = groundOpening(GEO, 0.15);
  if (opening) {
    ground.renderOrder = -2;
    if (terrainMesh) terrainMesh.renderOrder = -2;
    opening.renderOrder = -3;
    scene.add(opening);
  }

  // Sky reflections (glass, car paint): an environment map of a blue sky over a grey city floor
  const envScene = new THREE.Scene();
  const envMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const up = positionLocal.normalize().y;
  envMat.colorNode = mix(color(0x8f8b84), mix(color(0xdde6ee), color(0x5f8fc4), smoothstep(0.0, 0.7, up)), step(0.0, up));
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat));
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(envScene).texture;
  scene.environmentIntensity = 0.6;

  const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x5a5650, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
  sun.position.set(-700, 1100, 500); // afternoon sun from the south-west
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(TOUCH ? 2048 : 4096);
  // Shadows over the whole box when it's small; a large area (a whole district) gets a 2 km shadow square that follows
  // the camera's focus (TimeOfDay.follow), so the shadow map's detail doesn't spread over kilometres
  const reachM = Math.min(half * 1.15, 1000);
  Object.assign(sun.shadow.camera, { left: -reachM, right: reachM, top: reachM, bottom: -reachM, near: 10, far: 4500 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  await loading.step(0.1, `Raising ${GEO.buildings.length} buildings`);
  const buildings = buildFootprintBuildings(scene, GEO);
  await loading.step(0.22, 'Paving roads & sidewalks');
  // Taiwan marks two-way centre lines in yellow (lane dividers stay white)
  const roads = buildGraphRoads(scene, GEO, { centreLineColour: 0xe8b420 });
  // Above the street (deck heights estimated: OSM maps layer, not height): the elevated MRT (Wenhu line) and elevated
  // roads (Civic Boulevard, Jianguo and Keelung Road expressways and their ramps)
  buildViaduct(scene, GEO, GEO.rail, { name: 'rail-viaduct' });
  buildViaduct(scene, GEO, GEO.elevatedRoads, { name: 'road-viaduct', surface: 0x3a3d42 });
  await loading.step(0.3, `Planting ${(GEO.trees || []).length} trees & street furniture`);
  buildGreenAreas(scene, GEO);
  scene.add(createTreeField(scene, treeSites(GEO)).group);
  // Street furniture in Taipei's colours: YouBike 2.0 yellow, Chunghwa Post's green & red post box pair, Taipei Metro blue
  const furniture = buildStreetFurniture(scene, GEO, { bikeShareColour: 0xf0b400, postBoxColours: [0x2e8b3a, 0xc8261e], metroSignColour: 0x0b5aa2 });
  await loading.step(0.38, 'Signals, cars & pedestrians');

  // Signals & traffic: Taiwan drives on the right; cars mostly white, silver, grey & black, taxis yellow
  // Taiwan's signals (道路交通標誌標線號誌設置規則 arts. 203–204, 220): heads over the road are horizontal, red at the
  // left, then amber, green, with a square red-digit countdown beside the red lamp; pedestrian signals are two lenses,
  // a red standing figure over a green walking one (Taipei's animated 小綠人, quickening and flashing as time runs out)
  // with a countdown. The timing stays a plausible fixed cycle, not the city's real signal plans.
  const signals = buildSignalControl(scene, GEO, { driveOnRight: true, style: { armHead: 'horizontal', countdown: true, pedestrian: true } });
  const traffic = buildFootprintTraffic(scene, GEO, {
    signals,
    driveOnRight: true,
    // Xinyi's 2 km box: 320 cars, 420 people; other boxes in proportion to their area
    // (capped for whole districts: beyond the camera the extra traffic would cost frames, not add anything seen)
    carCount: Math.round(Math.min(TOUCH ? 260 : 560, 320 * (half / 1000) ** 2 * (TOUCH ? 0.5 : 1))),
    pedCount: Math.round(Math.min(TOUCH ? 340 : 760, 420 * (half / 1000) ** 2 * (TOUCH ? 0.5 : 1))),
    taxiShare: 0.14,
    taxiColour: 0xf3c316,
    palette: [0xf4f4f2, 0xf4f4f2, 0xf4f4f2, 0xc8cbcf, 0xc8cbcf, 0x8a8e93, 0x1c1e21, 0x1c1e21, 0x24395a, 0x7d1d22]
  });
  // what goes down into an underpass trench draws before its lid (see groundOpening above)
  if (opening) for (const o of [roads.group, traffic.cars.group]) o.traverse((m) => { if (m.isMesh) m.renderOrder = -4; });

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 20000);
  // From the south-east, the whole box in view (Xinyi: 1500, 820, 1800 with Taipei 101 at the centre)
  camera.position.set(half * Math.min(1.5, 2200 / half), half * Math.min(0.82, 1300 / half), half * Math.min(1.8, 2600 / half)); // a district: ~3.5 km out
  const controls = new OrbitControls(camera, renderer.domElement);
  const t101 = GEO.landmarks['Taipei 101'];
  controls.target.set(t101 ? t101.x : 0, half * 0.12, t101 ? t101.z : 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 30;
  controls.maxDistance = 8000;
  controls.update();

  // HUD: what is data and what is estimated
  const st = buildings.stats;
  const pct = (k) => Math.round((100 * st.bySource[k]) / st.total);
  document.getElementById('stats').textContent =
    `${st.total} buildings · heights: ${pct('height')}% height tag, ${pct('levels')}% storey count, ` +
    `${st.bySource.address ? `${pct('address')}% floors named at the doors, ` : ''}` +
    `${st.bySource.permit ? `${pct('permit')}% permit drawings, ` : ''}${pct('estimate')}% estimated · tallest ${st.maxTop} m` +
    (st.infill ? ` · +${st.infill} stand-ins (footprint & height inferred where OSM maps none)` : '');
  const infillState = document.getElementById('stats').appendChild(document.createElement('span'));
  let showEstimates = false;
  const toggle = document.getElementById('btn-estimates');
  const setEstimates = (on) => {
    showEstimates = on;
    buildings.setShowEstimates(on);
    toggle.setAttribute('aria-pressed', String(on));
  };
  toggle.addEventListener('click', () => setEstimates(!showEstimates));
  window.addEventListener('keydown', (ev) => { if (ev.key === 'e' || ev.key === 'E') setEstimates(!showEstimates); });
  // Stand-ins (I): shown by default, so blocks OSM leaves empty don't read as open ground; hide them to see OSM alone
  const infillButton = document.getElementById('btn-infill');
  let player = null, map = null; // the SimpleVehicles and FootprintMap below, once made
  let showInfill = GEO.infillShown ?? true; // an area whose stand-ins are less certain starts with them hidden
  const setInfill = (on) => {
    showInfill = on;
    buildings.setShowInfill(on);
    player?.index.setInfill(on); // hidden stand-ins don't block the player
    map?.setInfill(on); // nor show on the map
    infillButton.setAttribute('aria-pressed', String(on));
    infillState.textContent = st.infill && !on ? ' (hidden: I or the button shows them)' : '';
  };
  infillButton.hidden = !st.infill;
  setInfill(showInfill);
  infillButton.addEventListener('click', () => setInfill(!showInfill));
  window.addEventListener('keydown', (ev) => { if ((ev.key === 'i' || ev.key === 'I') && st.infill) setInfill(!showInfill); });

  // Reference photo (M): NLSC aerial orthophotos draped on the ground, loaded from NLSC only when shown, to check roads
  // & footprints by eye
  const overlay = buildBasemapOverlay(scene, GEO, {
    url: (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`,
    zoom: half > 1500 ? 16 : 17, // a district at z17 would be ~250 tiles
    credit: 'Reference photo © 內政部國土測繪中心 (NLSC)'
  });
  const overlayButton = document.getElementById('btn-overlay');
  const overlayCredit = document.getElementById('overlay-credit');
  const setOverlay = (on) => {
    overlayButton.setAttribute('aria-pressed', String(on));
    overlayCredit.hidden = !on;
    overlayCredit.textContent = overlay.credit;
    overlay.setVisible(on, (f) => { overlayCredit.textContent = f < 1 ? `${overlay.credit} · loading ${Math.round(f * 100)}%` : overlay.credit; });
  };
  overlayButton.addEventListener('click', () => setOverlay(!overlay.plane.visible));
  window.addEventListener('keydown', (ev) => { if (ev.key === 'm' || ev.key === 'M') setOverlay(!overlay.plane.visible); });

  // Player: on foot, bicycle (YouBike yellow), car & plane. Taiwan drives on the right; the car starts on the widest road
  // near Taipei 101 (the walker & cyclist beside it), the plane south of it
  const vehicles = (player = new SimpleVehicles(scene, GEO, {
    spawnNear: { x: t101 ? t101.x : 0, z: t101 ? t101.z : 0 },
    driveOnRight: true,
    worldLimit: reach,
    bikeColour: 0xf0b400,
    blocked: (x, z, fx, fz, hl, hw) =>
      traffic.carOverlaps(x, z, fx, fz, hl + 0.1, hw + 0.1) || traffic.pedNear(x + fx * hl * 0.6, z + fz * hl * 0.6, 1.6) || traffic.pedNear(x - fx * hl * 0.6, z - fz * hl * 0.6, 1.6),
    planeSpawn: { x: -half * 0.25, y: 220, z: half * 0.9, heading: 0 },
    // UFO over the landmark; the rocket's pad on the nearest open ground south of it
    ufoSpawn: { x: (t101 ? t101.x : 0) + 60, y: 140, z: (t101 ? t101.z : 0) + 160, heading: 0 },
    rocketPad: { x: (t101 ? t101.x : 0) + half * 0.1, z: (t101 ? t101.z : 0) + half * 0.35 }
  }));
  player.index.setInfill(showInfill);
  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  const vehicleStatus = document.getElementById('vehicle-status');
  // Touch: a stick and hold buttons (js/touch-controls.js, shared with NYC; its mode names are NYC's)
  const touchControls = new TouchControls(vehicles);
  const TOUCH_MODE = { walk: 'cyclist', bike: 'cyclist', car: 'car', plane: 'helicopter', ufo: 'helicopter', rocket: 'helicopter' };
  touchControls.setEnabled(false);
  const setMode = (mode) => {
    if (mode === 'orbit' && vehicles.mode !== 'orbit') {
      // keep looking at where the vehicle was
      const v = vehicles.active;
      controls.target.set(v.x, ['plane', 'ufo', 'rocket'].includes(vehicles.mode) ? v.y : 0, v.z);
    }
    vehicles.setMode(mode, camera);
    controls.enabled = mode === 'orbit';
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    document.getElementById('drive-help').hidden = mode === 'orbit';
    if (TOUCH_MODE[mode]) touchControls.setMode(TOUCH_MODE[mode]);
    touchControls.setEnabled(mode !== 'orbit' && !map.open);
    renderer.domElement.focus();
  };
  for (const b of modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));
  window.addEventListener('keydown', (ev) => {
    const mode = { Digit1: 'orbit', Digit2: 'walk', Digit3: 'bike', Digit4: 'car', Digit5: 'plane', Digit6: 'ufo', Digit7: 'rocket' }[ev.code];
    if (mode) setMode(mode);
  });

  // Map (T): a minimap following the player (or, orbiting, the point the camera looks at); the full map teleports
  const playerOnMap = () => {
    const v = vehicles.active;
    if (v) return { x: v.x, z: v.z, heading: v.heading };
    const f = new THREE.Vector3();
    camera.getWorldDirection(f);
    return { x: controls.target.x, z: controls.target.z, heading: Math.atan2(-f.x, -f.z) };
  };
  map = new FootprintMap(GEO, {
    showInfill,
    mini: document.getElementById('minimap'),
    full: document.getElementById('fullmap'),
    fullCanvas: document.getElementById('fullmap-canvas'),
    hoverInfo: document.getElementById('fullmap-info'),
    getPlayer: playerOnMap,
    onTeleport: (x, z) => {
      if (vehicles.mode !== 'orbit') { vehicles.teleport(x, z, camera); return; }
      // orbiting: move the camera with its target
      const dx = x - controls.target.x, dz = z - controls.target.z;
      controls.target.set(x, controls.target.y, z);
      camera.position.x += dx;
      camera.position.z += dz;
      controls.update();
    },
    onToggle: (open) => {
      vehicles.keys.clear();
      touchControls.setEnabled(!open && vehicles.mode !== 'orbit');
      if (!open) renderer.domElement.focus();
    }
  });
  document.getElementById('fullmap-close').addEventListener('click', () => map.toggle(false));
  if (TOUCH) document.querySelector('#fullmap-info span').textContent = 'Tap to teleport · drag to pan · pinch to zoom';
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyT') map.toggle();
    else if (ev.code === 'Escape') map.toggle(false);
  });

  // Time of day (L, or the buttons): sun, sky & ambient light, and at night lit windows, shopfronts, street lamps,
  // headlamps. Taipei's sun sets in the west; the sun's light covers the box from TimeOfDay's target outwards.
  const timeOfDay = new TimeOfDay(renderer, scene, { sun, hemi, sky, target: new THREE.Vector3(0, 0, 0), distance: 1400 }, {
    onNight: [(f) => buildings.setNight(f), (f) => furniture.setNight(f), (f) => vehicles.setNight(f)]
  });
  const timeButtons = [...document.querySelectorAll('[data-time]')];
  const showTime = () => { for (const b of timeButtons) b.setAttribute('aria-pressed', String(b.dataset.time === timeOfDay.id)); };
  for (const b of timeButtons) b.addEventListener('click', () => { timeOfDay.set(b.dataset.time); showTime(); renderer.domElement.focus(); });
  window.addEventListener('keydown', (ev) => { if (ev.code === 'KeyL' && !map.open) { timeOfDay.next(ev.shiftKey ? -1 : 1); showTime(); } });

  // Shaders: compile with the city's first frame of traffic in place, the car & plane shown for the moment
  signals.update(0);
  traffic.update(1 / 60, camera, null);
  vehicles.car.group.visible = vehicles.plane.group.visible = true;
  vehicles.walkerModel.visible = vehicles.cyclistModel.visible = true;
  // UFO with its beam, rocket with its flame, pad and a puff of smoke
  vehicles.ufoModel.group.visible = vehicles.rocketModel.group.visible = vehicles.pad.visible = true;
  vehicles.ufoModel.beam(50, 1);
  vehicles.rocketModel.flame(1, 0);
  vehicles.smoke.emit(vehicles.rocket.x, 5, vehicles.rocket.z);
  vehicles.smoke.update(0);
  furniture.setNight(1); // the night-only lamplight compiles now too (uniforms don't change pipelines)
  await loading.step(0.45, 'Compiling shaders');
  await precompile(renderer, scene, camera, (f) => loading.set(0.45 + 0.55 * f, 'Compiling shaders'));
  furniture.setNight(0);
  vehicles.car.group.visible = vehicles.plane.group.visible = false;
  vehicles.walkerModel.visible = vehicles.cyclistModel.visible = false;
  vehicles.ufoModel.group.visible = vehicles.rocketModel.group.visible = vehicles.pad.visible = false;
  vehicles.ufoModel.beam(0, 0);
  vehicles.rocketModel.flame(0, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  // Adaptive resolution: every second, a slow average frame lowers the pixel ratio, a run of fast ones raises it again
  const maxRatio = Math.min(window.devicePixelRatio, TOUCH ? 1.5 : 2), minRatio = TOUCH ? 0.6 : 0.75;
  let ratio = renderer.getPixelRatio(), frames = 0, frameTime = 0, fast = 0;
  const adapt = (dt) => {
    frames++;
    frameTime += dt;
    if (frameTime < 1) return;
    const ms = (1000 * frameTime) / frames;
    frames = frameTime = 0;
    let next = ratio;
    if (ms > 26) { next = Math.max(minRatio, ratio * 0.85); fast = 0; }
    else if (ms < 18 && ++fast >= 3) { next = Math.min(maxRatio, ratio * 1.1); fast = 0; }
    if (Math.abs(next - ratio) > 0.01) { ratio = next; renderer.setPixelRatio(ratio); }
  };
  let cullTick = 0;
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = timer.getDelta();
    adapt(dt);
    timeOfDay.update(dt);
    if ((cullTick = (cullTick + 1) % 15) === 0) furniture.update(camera); // distant small furniture off, 4× a second
    const focus = vehicles.active ?? controls.target;
    timeOfDay.follow(focus.x, focus.z);
    if (vehicles.mode === 'orbit') controls.update();
    else vehicles.update(dt, camera);
    signals.update(dt);
    traffic.update(dt, camera, ['walk', 'bike', 'car'].includes(vehicles.mode) ? vehicles.active : null); // cars keep clear of the player
    vehicleStatus.textContent = vehicles.status;
    map.updateMini();
    renderer.render(scene, camera);
  });
  window.__taipei = { renderer, scene, camera, controls, buildings, vehicles, setMode, signals, traffic, setOverlay, map, timeOfDay, panels, touchControls }; // for debugging from the console
  requestAnimationFrame(() => loading.done());
}

init().catch((err) => {
  console.error(err);
  const message = `Failed to start: ${err.message} (WebGPU needs a recent Chrome or Edge, served over http)`;
  loading.fail(message);
  document.getElementById('stats').textContent = message;
});
