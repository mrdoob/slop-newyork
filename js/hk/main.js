import * as THREE from 'three/webgpu';
import { createHongKongLighting } from './lighting.js';
import { applyBranding, getWorld } from '../world.js';
import * as HK from './config.js';
import { buildHongKongCity } from './city.js';
import { createHongKongTraffic } from './traffic.js';
import { createHongKongPedestrians } from './pedestrians.js';
import { BUILD } from './build.js';
import { createHongKongMap } from './map.js';
import { createPlayer, ChaseCamera } from './drive.js';

// js/hk/main.js
// Slop Hong Kong 的進入點（Phase 0 世界切換 → Phase 1 香港資料 → Phase 3 靠左行駛的車流）。
//
// 對外依賴刻意減到最少：香港只靜態依賴 three/webgpu 與 ./hk/*。
// 紐約的 LightingSystem（Preetham 天空）與 createPostProcessing（ACES + bloom）都改成「用到才 import」，
// 這樣任何一個紐約模組壞掉（或 dev 分支 CDN 上的 addon 改了路徑）都不會連帶令香港開唔到機。

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
        <p>${world.subtitle} · <span id="hk-fps">–</span> fps · <span class="hk-build" title="建置版本 build">v${BUILD}</span></p>
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
    <button type="button" class="hk-map-toggle" aria-label="開關地圖 (M)">地圖 <kbd>M</kbd></button>
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
  // index.html 已經有一個（在 module 之前註冊的）版本，優先用它，保證樣式一致。
  if (typeof window !== 'undefined' && typeof window.__slopBootFail === 'function') {
    window.__slopBootFail('香港世界啟動失敗 · Hong Kong boot failed', error);
    return;
  }
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

  // 例外一律顯示在畫面上，唔會留下一片黑 + Unresponsive。
  // 但開機完成之後（bootDone）就唔可以再用全屏錯誤卡蓋住整個世界：
  // 只要有一幀 throw（例如快取新舊模組混用，某個方法唔存在），用家就會乜都睇唔到。
  // 所以開機後改為「紅色提示條 + console.error」，世界繼續行。
  let bootDone = false;
  const reportAfterBoot = (error) => {
    const message = error && (error.stack || error.message) ? String(error.stack || error.message) : String(error);
    console.error('[hk] runtime error', error);
    if (!bootDone) { showBootError(error, PHASES); return; }
    if (document.querySelector('.hk-black-warning')) return;
    const bar = document.createElement('div');
    bar.className = 'hk-black-warning';
    bar.textContent = `香港世界執行錯誤（已繼續運行）：${message.split('\n')[0]}　→ 請 Ctrl+Shift+R 強制重新載入（很可能是舊快取）`;
    document.body.appendChild(bar);
  };
  window.addEventListener('error', (e) => reportAfterBoot(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportAfterBoot(e.reason));

  await yieldToBrowser('初始化 WebGPURenderer…');
  // `?webgl=1`：強制用 WebGL2 後端。用來分辨「香港場景畫唔出」同「WebGPU 後端有問題」。
  const forceWebGL = params.get('webgl') === '1';
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true,
    forceWebGL
  });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);
  await renderer.init();
  mark('renderer');

  // WebGPU 的錯誤是「靜默」的：validation error 只會去 uncapturederror / device.lost，
  // 唔會 throw，畫面就係一直黑。這裡一律接住並記落 gpuErrors，顯示在診斷面板。
  const gpuErrors = [];
  const noteGpuError = (message) => {
    gpuErrors.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
    if (gpuErrors.length > 6) gpuErrors.shift();
    console.error('[hk gpu]', message);
  };
  try {
    const device = renderer.backend?.device;
    if (device?.addEventListener) {
      device.addEventListener('uncapturederror', (event) => noteGpuError(event.error?.message || String(event.error)));
    }
    if (device?.lost?.then) {
      device.lost.then((info) => noteGpuError(`DEVICE LOST: ${info?.reason || ''} ${info?.message || ''}`.trim()));
    }
  } catch (error) {
    console.warn('[hk] could not attach GPU error listeners', error);
  }

  const scene = new THREE.Scene();
  await yieldToBrowser('建立日光與天空…');
  // 自帶照明：半球光 + 平行光 + 明確天空色。不依賴 dev 分支的 SkyMesh / SunLight / PMREM，
  // 因為任何一環不配合都會變成全黑又沒有錯誤訊息（`?sky=1` 才切回完整大氣天空）。
  // `?shadow=0` 關掉陰影（用來分辨「全街都落在陰影裡」）；`?exposure=` 直接調曝光
  const shadows = params.get('shadow') !== '0';
  const exposureOverride = params.has('exposure') ? Number(params.get('exposure')) : null;
  const lighting = createHongKongLighting(scene, { renderer, shadows, preset: params.get('light') || 'golden' });
  if (Number.isFinite(exposureOverride)) renderer.toneMappingExposure = exposureOverride;
  // 想試紐約那套完整大氣天空：?sky=1
  let skyLighting = null;
  if (params.get('sky') === '1') {
    try {
      const { LightingSystem } = await import('../lighting.js');
      skyLighting = new LightingSystem(scene, renderer);
      skyLighting.applyPreset('golden');
      scene.fog = new THREE.Fog(0xdcc5ae, 260, 7000);
      mark('sky');
    } catch (error) {
      console.warn('[hk] full sky unavailable, keeping the simple lighting', error);
      skyLighting = null;
    }
  }
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

  await yieldToBrowser('安排行人…');
  // 重用紐約的人物模型（PersonCrowd / PersonRig）；失敗會自動退回簡化版
  const pedestrians = await createHongKongPedestrians(scene);
  mark('pedestrians');

  const player = createPlayer(scene, city.colliders);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.35, 40000);
  const chase = new ChaseCamera(camera, renderer.domElement);
  camera.position.set(HK.SPAWN.x, 6, HK.SPAWN.z - 12);
  camera.lookAt(HK.SPAWN.x, 1.6, HK.SPAWN.z);

  if (lowDetail) {
    city.group.traverse((o) => { if (o.name === 'HongKongTowers' || o.name === 'HongKongMidRise') o.visible = false; });
  }

  // `?test=1`：鏡頭前放一個**唔受燈光影響**的紅色方塊（MeshBasicMaterial + depthTest false）。
  // 三種結果，三種結論：
  //   見到紅色方塊 → 渲染器同 canvas 正常，問題在場景／材質／燈光；
  //   見到藍天但冇紅方塊 → 相機或 canvas 尺寸有事；
  //   連紅方塊都冇（全黑）→ 畫面根本冇輸出到 canvas（後端／CSS 遮蓋）。
  const testPattern = params.get('test') === '1';
  if (testPattern) {
    const probe = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 2.4, 0.4),
      new THREE.MeshBasicMaterial({ color: 0xff2d2d, depthTest: false, depthWrite: false, fog: false, toneMapped: false })
    );
    probe.name = 'hkTestProbe';
    probe.position.set(0, 0, -6);
    probe.renderOrder = 1e6;
    probe.frustumCulled = false;
    scene.add(camera);
    camera.add(probe);
    mark('testPattern');

  }

  // 視窗大小改變時同步 canvas 與投影（原本冇做，改變視窗大小會變形）
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // --- 繪製路徑 ----------------------------------------------------------------------------------
  // 預設：renderer.render(scene, camera) —— 最笨、最直接、最少變數。
  // `?post=1`：改用紐約那套 TSL RenderPipeline（pass + ACES 調色 + bloom），用來對比。
  const usePost = params.get('post') === '1';
  let postPipeline = null;
  let colorGrade = null;
  if (usePost) {
    try {
      await yieldToBrowser('建立後處理管線…');
      const [{ pass, vec4 }, { createPostProcessing }] = await Promise.all([
        import('three/tsl'),
        import('../post-processing.js')
      ]);
      const scenePass = pass(scene, camera);
      colorGrade = createPostProcessing(renderer, scenePass.getTextureNode('output'), vec4(0, 0, 0, 0));
      postPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);
      colorGrade.applyPreset('golden');
      mark('postfx');
    } catch (error) {
      console.warn('[hk] post-processing unavailable, falling back to a direct render', error);
      postPipeline = null;
    }
  }

  function renderFrame() {
    // 每次都明確回到預設 framebuffer：任何「渲染到離屏 target 之後冇還原」的 bug
    // （PMREM、自訂 pass、讀回像素）都會令之後所有 frame 畫去離屏 → canvas 永遠黑。
    renderer.setRenderTarget(null);
    if (postPipeline) postPipeline.render();
    else renderer.render(scene, camera);
  }

  // --- 黑畫面自救 ---------------------------------------------------------------------------------
  // 用 createImageBitmap / drawImage 把 canvas 讀成 8×8 像素，如果係純黑就當係「畫唔出」。
  // 自救次序：① 重新 setSize + 再 render ② 自動 reload 一次並改用 WebGL2 後端（?webgl=1）。
  // 只在 golden / midday（背景係晴天的淺藍）才做，避免夜景被誤判。
  let blackDetected = false;
  async function sampleCanvasMax() {
    const canvas = renderer.domElement;
    try {
      const bitmap = await createImageBitmap(canvas);
      const scratch = document.createElement('canvas');
      scratch.width = 8;
      scratch.height = 8;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, 8, 8);
      const data = ctx.getImageData(0, 0, 8, 8).data;
      let max = 0;
      for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
      return max;
    } catch (bitmapError) {
      try {
        const scratch = document.createElement('canvas');
        scratch.width = 8;
        scratch.height = 8;
        const ctx = scratch.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0, 8, 8);
        const data = ctx.getImageData(0, 0, 8, 8).data;
        let max = 0;
        for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i], data[i + 1], data[i + 2]);
        return max;
      } catch (drawError) {
        return null; // 讀唔到就唔判斷（唔好誤報）
      }
    }
  }

  async function blackScreenWatchdog() {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (renderer.backend?.isWebGPUBackend !== true) return; // 已經係 WebGL2：唔再自動切
    if (!['golden', 'midday'].includes(lighting.activeId) || testPattern) return;
    const max = await sampleCanvasMax();
    if (max === null || max > 6) return;
    blackDetected = true;
    console.error('[hk] canvas 讀出來係全黑（max channel = ' + max + '）');
    // ① 先試最溫和的一步：重新設定尺寸 + 立即再 render 一次
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderFrame();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const retry = await sampleCanvasMax();
    if (retry !== null && retry > 6) {
      console.warn('[hk] 重新 setSize 之後畫面返嚟了（max = ' + retry + '）');
      blackDetected = false;
      return;
    }
    // ② 仍然黑：只提示，唔自動 reload（自動跳轉會令人以為自己按錯咗）
    const banner = document.createElement('div');
    banner.className = 'hk-black-warning';
    banner.textContent = 'canvas 讀出來係全黑（?blackcheck=1）。留意：WebGPU 的 canvas 事後讀像素可能本身係黑，請以肉眼為準。';
    document.body.appendChild(banner);
  }

  // --- 預編譯（避免第一幀一次過編譯全部 pipeline 而卡死）----------------------------------------
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
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, jobs.length)) }, worker));
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
      if (Number.isFinite(exposureOverride)) renderer.toneMappingExposure = exposureOverride;
      if (skyLighting) skyLighting.applyPreset(id);
      if (colorGrade) colorGrade.applyPreset(id);
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

  // --- 診斷面板（按 D 開關；?debug=1 一開始就顯示）----------------------------------------------------
  // 這面板存在的理由：黑畫面可以是「冇畫任何東西」、「畫了但全黑」或「後處理輸出黑」，
  // draw call 與三角形數就是分辨這三者的最快證據。
  const diag = document.createElement('div');
  diag.className = 'hk-diagnostics';
  // 現在是「畫面全黑」的除錯期，診斷面板預設就開；`?debug=0` 或按 D 可以關掉。
  let diagVisible = params.get('debug') !== '0';
  diag.hidden = !diagVisible;
  document.body.appendChild(diag);
  // 誰在畫面正中央的最上層？如果唔係 canvas，就代表 3D 畫面被 HTML 蓋住（CSS 問題，唔係渲染問題）。
  function topElementAtCentre() {
    try {
      const el = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
      if (!el) return '（冇元素）';
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    } catch {
      return '（elementFromPoint 失敗）';
    }
  }

  function backendName() {
    const name = renderer.backend?.constructor?.name;
    if (renderer.backend?.isWebGPUBackend) return `WebGPU${name ? ` (${name})` : ''}`;
    return `WebGL2${name ? ` (${name})` : ''}${forceWebGL ? ' · 強制' : ' · 自動退回'}`;
  }

  let gpuDetail = (() => {
    const gpu = navigator.gpu;
    if (!gpu) return 'navigator.gpu：冇（瀏覽器唔支援／未開啟 WebGPU）';
    return 'navigator.gpu：有（adapter 查詢中…）';
  })();
  // 額外查一次 adapter：要知道係真 GPU 定係軟件模擬（WARP / SwiftShader），
  // 軟件後端畫唔出係常見原因，而 ?webgl=1 可以直接繞過。
  (async () => {
    if (!navigator.gpu || !navigator.gpu.requestAdapter) return;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) { gpuDetail = 'navigator.gpu：有，但 requestAdapter() 回傳 null'; return; }
      const info = adapter.info || {};
      gpuDetail = `adapter：${info.vendor || '?'} / ${info.architecture || '?'} / ${info.device || info.description || '?'}${info.isFallbackAdapter ? '（軟件模擬）' : ''}`;
    } catch (error) {
      gpuDetail = `adapter 查詢失敗：${error.message}`;
    }
  })();

  let diagLogged = false;
  function updateDiagnostics() {
    if (!diagVisible) return;
    const info = renderer.info || {};
    const r = info.render || {};
    const canvas = renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const top = topElementAtCentre();
    const covered = !top.startsWith('canvas');
    diag.textContent = [
      `版本 v${BUILD} · three r${THREE.REVISION} · ${backendName()}`,
      `canvas ${canvas.width}×${canvas.height} @ ${Math.round(rect.width)}×${Math.round(rect.height)} css · ${canvas.isConnected ? 'in DOM' : '唔在 DOM！'}`,
      `canvas style opacity ${style.opacity} · display ${style.display} · visibility ${style.visibility}`,
      `畫面中央最上層：${top}${covered ? '  ← 蓋住咗 canvas！' : ''}`,
      `draw calls ${r.drawCalls ?? r.calls ?? '?'} · tris ${r.triangles ?? '?'} · frames ${r.frame ?? '?'}${blackDetected ? ' · 讀到全黑！' : ''}`,
      `scene children ${scene.children.length} · lights ${scene.children.filter((o) => o.isLight).length} · pedestrians ${pedestrians.counts.pedestrians}（${pedestrians.counts.model}）`,
      `background ${scene.background && scene.background.getHexString ? `#${scene.background.getHexString()}` : String(scene.background)}`,
      `camera ${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)} · near ${camera.near} far ${camera.far}`,
      `player ${player.state.x.toFixed(0)}, ${player.state.z.toFixed(0)} · ${HK.districtAt(player.state.x, player.state.z).zh}`,
      `path ${postPipeline ? 'post pipeline' : 'direct render'}${skyLighting ? ' + full sky' : ''} · test pattern ${testPattern ? 'ON' : 'off'}`,
      `light ${lighting.activeId} · shadow ${shadows ? 'on' : 'off'} · exposure ${renderer.toneMappingExposure?.toFixed?.(2) ?? '?'} · env ${lighting.hasEnvironment ? 'PMREM' : `冇（${lighting.envError || 'renderer 未提供'}）`}`,
      `${gpuDetail}`,
      gpuErrors.length ? `GPU 錯誤：\n${gpuErrors.join('\n')}` : 'GPU 錯誤：冇（uncapturederror 靜默）',
      'D 隱藏 · F12 有完整日誌'
    ].join('\n');
    diag.classList.toggle('is-warning', covered || (r.drawCalls ?? r.calls ?? 0) === 0);
    if (!diagLogged && (r.frame ?? 0) > 2) {
      diagLogged = true;
      console.log('[hk diag]\n' + diag.textContent);
      if (covered && !top.startsWith('（')) console.warn(`[hk] canvas 被 ${top} 蓋住 —— 這是 CSS 問題，不是渲染問題`);
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyD' && !e.metaKey && !e.ctrlKey) {
      diagVisible = !diagVisible;
      diag.hidden = !diagVisible;
      updateDiagnostics();
    }
  });
  mark('diagnostics');

  /** 傳送到世界座標（地圖點擊用）：保留車頭方向，速度歸零。 */
  function teleportTo(x, z) {
    player.state.x = x;
    player.state.z = z;
    player.state.speed = 0;
    chase.smoothed.set(x - Math.sin(player.state.heading) * 9.5, 6, z - Math.cos(player.state.heading) * 9.5);
  }

  // --- 地圖（M 開關；點地圖傳送）-------------------------------------------------------------------
  const map = createHongKongMap({ onTeleport: (x, z) => teleportTo(x, z) });
  const mapToggle = hud.querySelector('.hk-map-toggle');
  mapToggle?.addEventListener('click', () => map.toggle());
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      map.toggle();
      event.preventDefault();
    }
  });
  mark('map');

  // --- 主迴圈 ----------------------------------------------------------------------------------------
  let last = performance.now();
  let elapsed = 0;
  let bumpCount = 0;
  let frameNow = 0;
  // 第一幀先在 try/catch 內畫一次：着色器若編不過，會顯示錯誤而唔係黑畫面
  try {
    player.update(0.016);
    chase.update(0.016, player.state);
    traffic.update(0.016, camera.position, player.state);
    pedestrians.update?.(0.016, camera.position);
    await yieldToBrowser('第一幀…');
    renderFrame();
    const device = renderer.backend?.device;
    const submitted = device && device.queue?.onSubmittedWorkDone ? Promise.resolve(device.queue.onSubmittedWorkDone()) : Promise.resolve();
    await submitted.catch(() => {});
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    mark('firstFrame');
    bootDone = true;
    const info = renderer.info?.render || {};
    console.log('[hk] first frame', { drawCalls: info.drawCalls ?? info.calls, triangles: info.triangles, path: postPipeline ? 'post' : 'direct', sky: !!skyLighting });
    console.log(`[hk] build ${BUILD}`);
    console.log(`[hk] boot ${PHASES.map(([l, t]) => `${l} ${t}ms`).join(', ')}`);
    console.log(`[hk] ${city.counts.buildings} buildings · ${city.counts.landmarks} landmarks · ${traffic.counts.cars} cars · ${traffic.counts.lanes} lanes (keep left) · ${pedestrians.counts.pedestrians} pedestrians (${pedestrians.counts.model})`);
  } catch (error) {
    showBootError(error, PHASES);
  }

  // 注意：WebGPU 的 canvas 在 present 之後唔可以可靠地讀返像素（讀出嚟永遠係黑），
  // 所以自動偵測會誤報。現在改成 opt-in：?blackcheck=1 才會做，而且唔會自動 reload。
  if (params.get('blackcheck') === '1') blackScreenWatchdog();

  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    elapsed += dt;

    player.update(dt);
    const bump = typeof traffic.collidePlayer === 'function' ? traffic.collidePlayer(player.state) : { hit: false };
    if (bump.hit) bumpCount++;
    chase.update(dt, player.state);
    traffic.update(dt, camera.position, player.state);
    pedestrians.update?.(dt);
    lighting.update(player.state);
    if (skyLighting) skyLighting.update(player.state);
    updateHud(dt);
    updateDiagnostics();

    renderFrame();
  });

  // 除錯／驗證用（不會影響正常遊玩）
  globalThis.__slopHK = { build: BUILD, scene, renderer, city, traffic, pedestrians, player, camera, HK, lighting, testPattern, gpuErrors };
  return { scene, renderer, city, traffic, player };
}
