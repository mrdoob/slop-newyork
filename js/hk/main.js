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

/** 真正的「讓路」：setTimeout 係 macrotask，瀏覽器一定會在之間 painting，唔似 rAF 的微任務。 */
const yieldToBrowser = (label) => new Promise((resolve) => {
  const status = document.getElementById('loading-status');
  if (status && label) status.textContent = label;
  setTimeout(resolve, 16);
});

const PHASES = [];
function mark(label) {
  PHASES.push([label, Math.round(performance.now())]);
}

/** 把錯誤直接顯示在載入畫面上（黑畫面 + 一句話，好過顯示 Unresponsive）。 */
function showBootError(error, phaseList) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  const message = error && error.stack ? String(error.stack).split('\n').slice(0, 6).join('\n') : String(error);
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="hk-boot-error" style="max-width:min(760px,92vw);text-align:left;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
      <div style="font:700 15px/1.4 Inter,system-ui,sans-serif;color:#ff8f93;margin-bottom:10px">香港世界啟動失敗 · Hong Kong boot failed</div>
      <pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;color:#ffd7d8;background:rgba(0,0,0,.45);padding:12px;border-radius:10px;border:1px solid rgba(255,120,125,.35);margin:0 0 10px">${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>
      <div style="font:12px/1.6 Inter,system-ui,sans-serif;color:rgba(255,255,255,.72)">
        已完成的階段：${(phaseList || []).map(([l, t]) => `${l} (${t} ms)`).join(' → ') || '（無）'}<br>
        請把上面這段連同 Console（F12）的紅色錯誤一齊貼回去。
      </div>
    </div>`;
  console.error('[hk] boot failed', error);
}

export async function startHongKong() {
  const world = getWorld('hk');
  applyBranding(world);

  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const params = new URLSearchParams(location.search);
  const lowDetail = params.get('low') === '1';

  // 例外一律顯示在畫面上，唔會留下一片黑 + Unresponsive
  window.addEventListener('error', (e) => showBootError(e.error || e.message, PHASES));
  window.addEventListener('unhandledrejection', (e) => showBootError(e.reason, PHASES));

  await yieldToBrowser('初始化 WebGPURenderer…');
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
  mark('renderer');

  const scene = new THREE.Scene();
  await yieldToBrowser('建立天空、日光與環境光（PMREM）…');
  const lighting = new LightingSystem(scene, renderer);
  lighting.applyPreset('golden');
  mark('lighting');

  await yieldToBrowser('興建維港與樓宇…');
  const city = await buildHongKongCity(scene, {
    onProgress: async (label) => {
      await yieldToBrowser(label);
      mark(label);
    }
  });
  mark('city');

  await yieldToBrowser('安排靠左行駛的車流…');
  const traffic = createHongKongTraffic(scene);
  mark('traffic');

  const player = createPlayer(scene, city.colliders);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.35, 40000);
  const chase = new ChaseCamera(camera, renderer.domElement);
  camera.position.set(HK.SPAWN.x, 6, HK.SPAWN.z - 12);
  camera.lookAt(HK.SPAWN.x, 1.6, HK.SPAWN.z);

  await yieldToBrowser('編譯著色器與後處理…');
  // 香港唔開 SSR（維港水面用 IBL 反射），但保留 ACES + 分時段調色 + bloom
  const scenePass = pass(scene, camera);
  const colorGrade = createPostProcessing(renderer, scenePass.getTextureNode('output'), vec4(0, 0, 0, 0));
  const pipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);
  mark('postfx');

  if (lowDetail) {
    city.group.traverse((o) => { if (o.name === 'HongKongTowers' || o.name === 'HongKongMidRise') o.visible = false; });
  }

  // 預編譯：幾百條 pipeline 一次過交給 GPU 會鎖死主執行緒幾十秒（紐約版就是為此寫了同樣的機制）。
  // 這裡用 8 條並行 compileAsync，每批之後讓瀏覽器 paint 並更新進度。
  await yieldToBrowser('預編譯著色器（0%）…');
  {
    const jobs = [];
    const seen = new Set();
    scene.traverseVisible((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      const key = o.isInstancedMesh ? o : o.material;
      if (!key || seen.has(key)) return;
      seen.add(key);
      jobs.push(o);
    });
    let next = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        try {
          await renderer.compileAsync(jobs[i], camera, scene);
        } catch (error) {
          console.warn('[hk compile]', error);
        }
        if (++done % 8 === 0) {
          const pct = Math.round((done / jobs.length) * 100);
          const status = document.getElementById('loading-status');
          if (status) status.textContent = `預編譯著色器（${pct}%）…`;
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
    mark(`compile(${jobs.length})`);
  }

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
  // 第一幀先在 try/catch 內畫一次：着色器若編不過，會顯示錯誤而唔係黑畫面
  try {
    player.update(0.016);
    chase.update(0.016, player.state);
    traffic.update(0.016, camera.position);
    await yieldToBrowser('第一幀…');
    pipeline.render();
    const device = renderer.backend?.device;
    const info = device && device.queue?.onSubmittedWorkDone ? Promise.resolve(device.queue.onSubmittedWorkDone()) : Promise.resolve();
    await info.catch(() => {});
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    mark('firstFrame');
    console.log(`[hk] boot ${PHASES.map(([l, t]) => `${l} ${t}ms`).join(', ')}`);
    console.log(`[hk] ${city.counts.buildings} buildings · ${city.counts.landmarks} landmarks · ${traffic.counts.cars} cars · ${traffic.counts.lanes} lanes (keep left)`);
  } catch (error) {
    showBootError(error, PHASES);
  }

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
  });

  // 除錯／驗證用（不會影響正常遊玩）
  globalThis.__slopHK = { scene, renderer, city, traffic, player, camera, HK };
  return { scene, renderer, city, traffic, player };
}
