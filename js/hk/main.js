import * as THREE from 'three/webgpu';
import { pass, vec4 } from 'three/tsl';
import { createPostProcessing } from '../post-processing.js';
import { LightingSystem } from '../lighting.js';
import { applyBranding, getWorld } from '../world.js';
import * as HK from './config.js';
import { buildHongKongCity } from './city.js';
import { createHongKongTraffic } from './traffic.js';
import { createPlayer, ChaseCamera } from './drive.js';

// js/hk/main.js
// Slop Hong Kong 的進入點（Phase 0 世界切換 → Phase 1 香港資料 → Phase 3 靠左行駛的車流）。
//
// 重用與城市無關的既有系統：LightingSystem（Preetham 天空 + PMREM IBL + 2 級 CSM）與
// createPostProcessing（ACES + 分時段調色 + bloom）。新寫的只有：香港幾何（city.js）、靠左車流
// （traffic.js）、香港車種（vehicles.js）與駕駛（drive.js）。

const TIME_CYCLE = ['golden', 'twilight', 'midnight', 'midday'];

function buildHud(world) {
  const hud = document.createElement('div');
  hud.id = 'hk-hud';
  hud.className = 'hk-hud';
  hud.innerHTML = `
    <header class="hk-brand">
      <span class="hk-bullet">HK</span>
      <div class="hk-brand-text">
        <h1>${world.title} <a class="hk-world-link" href="?world=ny">← New York</a></h1>
        <p>${world.subtitle} · <span id="hk-fps">–</span> fps</p>
      </div>
    </header>
    <div class="hk-telemetry">
      <div class="hk-speed"><span id="hk-speed">0</span><span class="hk-unit">km/h</span></div>
      <div class="hk-location" id="hk-location">中環 Central</div>
      <div class="hk-rule">靠左行駛 · Keep left</div>
    </div>
    <div class="hk-hints">
      <span><kbd>W</kbd><kbd>S</kbd> 前進 / 倒車</span>
      <span><kbd>A</kbd><kbd>D</kbd> 轉向</span>
      <span><kbd>Shift</kbd> 加速</span>
      <span><kbd>Space</kbd> 剎車</span>
      <span><kbd>G</kbd> 光線</span>
      <span><kbd>1</kbd>–<kbd>9</kbd> 傳送</span>
      <span>拖曳環繞 · 滾輪縮放</span>
    </div>
    <nav class="hk-teleports">${HK.TELEPORTS.map((t, i) => `<button type="button" data-tp="${i}">${i + 1} ${t.zh}</button>`).join('')}</nav>
  `;
  document.body.appendChild(hud);
  return hud;
}

export async function startHongKong() {
  const world = getWorld('hk');
  applyBranding(world);

  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const setStatus = (text) => {
    if (loadingStatus) loadingStatus.textContent = text;
  };
  setStatus('初始化 WebGPURenderer…');

  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  await renderer.init();

  const scene = new THREE.Scene();
  const lighting = new LightingSystem(scene, renderer);
  lighting.applyPreset('golden');

  setStatus('興建維港、道路與樓宇…');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const city = buildHongKongCity(scene);

  setStatus('安排靠左車流…');
  const traffic = createHongKongTraffic(scene);

  const player = createPlayer(scene, city.colliders);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.35, 40000);
  const chase = new ChaseCamera(camera, renderer.domElement);

  // 後處理：與紐約同一套（ACES + 分時段調色 + 門檻式 bloom）。香港這裡不開 SSR（水面用 IBL 反射）。
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode('output');
  const colorGrade = createPostProcessing(renderer, scenePassColor, vec4(0, 0, 0, 0));
  const pipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // --- 輸入 ------------------------------------------------------------------------------------------
  const keyMap = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'backward', ArrowDown: 'backward',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    ShiftLeft: 'boost', ShiftRight: 'boost',
    Space: 'brake'
  };
  let timeIndex = 0;
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    const action = keyMap[e.code];
    if (action) {
      player.keys[action] = true;
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyG') {
      timeIndex = (timeIndex + 1) % TIME_CYCLE.length;
      const id = TIME_CYCLE[timeIndex];
      lighting.applyPreset(id);
      colorGrade.applyPreset(id);
      city.setNight(id === 'midnight' ? 1 : id === 'twilight' ? 0.5 : 0.1);
    }
    if (/^Digit[1-9]$/.test(e.code)) {
      const index = Number(e.code.slice(5)) - 1;
      const tp = HK.TELEPORTS[index];
      if (tp) {
        player.state.x = tp.x;
        player.state.z = tp.z;
        player.state.heading = tp.heading;
        player.state.speed = 0;
      }
    }
  });
  window.addEventListener('keyup', (e) => {
    const action = keyMap[e.code];
    if (action) player.keys[action] = false;
  });
  window.addEventListener('blur', () => {
    for (const k of Object.keys(player.keys)) player.keys[k] = false;
  });

  const hud = buildHud(world);
  hud.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tp]');
    if (!btn) return;
    const tp = HK.TELEPORTS[Number(btn.dataset.tp)];
    if (!tp) return;
    player.state.x = tp.x;
    player.state.z = tp.z;
    player.state.heading = tp.heading;
    player.state.speed = 0;
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- HUD 更新（每 250 ms，避免每幀碰 DOM）-----------------------------------------------------------
  const elSpeed = hud.querySelector('#hk-speed');
  const elLocation = hud.querySelector('#hk-location');
  const elFps = hud.querySelector('#hk-fps');
  let frames = 0;
  let fpsTime = 0;
  let hudTime = 0;

  function updateHud(dt) {
    frames++;
    fpsTime += dt;
    hudTime += dt;
    if (hudTime < 0.25) return;
    hudTime = 0;
    const kmh = Math.round(Math.abs(player.state.speed) * 3.6);
    if (elSpeed) elSpeed.textContent = String(kmh);
    if (elLocation) elLocation.textContent = HK.locationLabel(player.state.x, player.state.z);
    if (fpsTime > 0) {
      if (elFps) elFps.textContent = String(Math.round(frames / fpsTime));
      frames = 0;
      fpsTime = 0;
    }
  }

  // --- 主迴圈 ----------------------------------------------------------------------------------------
  let last = performance.now();
  let elapsed = 0;
  let firstFrame = true;
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    elapsed += dt;

    player.update(dt);
    chase.update(dt, player.state);
    traffic.update(dt, camera.position);
    lighting.update(camera.position);
    updateHud(dt);

    pipeline.render();

    if (firstFrame) {
      firstFrame = false;
      const device = renderer.backend?.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
      });
    }
  });

  // 除錯／驗證用（不會影響正常遊玩）
  globalThis.__slopHK = { scene, renderer, city, traffic, player, camera, HK };
  console.log(`[hk] ${city.counts.buildings} buildings · ${city.counts.landmarks} landmarks · ${traffic.counts.cars} cars · ${traffic.counts.lanes} lanes (keep left)`);
  return { scene, renderer, city, traffic, player };
}
