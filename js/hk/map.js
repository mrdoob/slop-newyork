import * as HK from './config.js';

// js/hk/map.js
// 香港的全域地圖（Phase 3 補完：紐約有 #fullmap-modal，香港之前完全冇地圖）。
//
// 全部線條都由 js/hk-geodata.js 推導：海岸線、17 條走廊、電車線、9 個傳送點、車流。
// 用 2D canvas 畫，唔需要 GPU；比例固定成「整個 seed 範圍」，所以一眼睇得出中環、尖沙咀、旺角的相對位置。
//   · 按 M 或點 HUD 的「地圖」開關
//   · 點地圖上任何位置 = 傳送到那裡（同紐約版一樣）
//   · 玩家 = 紅色箭頭（有方向），車流 = 黃點，傳送點 = 白色圓點 + 名稱

const COLORS = {
  water: '#0d1b26',
  land: '#20262c',
  road: '#4b5560',
  trunk: '#6b7682',
  tram: '#8a6a44',
  car: '#f0c14b',
  player: '#e0342c',
  teleport: '#e8eef4',
  label: 'rgba(232,238,244,0.82)'
};

/** 世界座標 → 地圖座標的投影（fit 到 canvas，保留長寬比，北朝上）。 */
export function createProjection(bounds, width, height, padding = 10) {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanZ = Math.max(1, bounds.maxZ - bounds.minZ);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanZ);
  const offsetX = (width - spanX * scale) / 2;
  const offsetZ = (height - spanZ * scale) / 2;
  return {
    scale,
    toMap: (x, z) => ({
      x: offsetX + (x - bounds.minX) * scale,
      y: offsetZ + (z - bounds.minZ) * scale
    }),
    toWorld: (mx, my) => ({
      x: bounds.minX + (mx - offsetX) / scale,
      z: bounds.minZ + (my - offsetZ) / scale
    })
  };
}

export function createHongKongMap({ onTeleport = null, size = 300 } = {}) {
  // 世界範圍：由陸地與走廊共同決定
  const bounds = (() => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const consider = (x, z) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    };
    for (const land of HK.LAND) for (const p of land.pts) consider(p.x, p.z);
    for (const road of HK.ROADS) for (const p of road.pts) consider(p.x, p.z);
    return { minX, maxX, minZ, maxZ };
  })();

  const root = document.createElement('section');
  root.className = 'hk-map';
  root.hidden = true;
  root.innerHTML = `
    <header class="hk-map-head">
      <strong>香港地圖 · Hong Kong</strong>
      <span class="hk-map-hint">點地圖 = 傳送 · M 關閉</span>
      <button type="button" class="hk-map-close" aria-label="關閉地圖">✕</button>
    </header>
    <canvas width="${size}" height="${size}" class="hk-map-canvas"></canvas>
    <footer class="hk-map-foot"><span id="hk-map-pos">—</span></footer>
  `;
  document.body.appendChild(root);

  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const posLabel = root.querySelector('#hk-map-pos');
  const projection = createProjection(bounds, canvas.width, canvas.height, 12);

  let open = false;
  let lastState = { x: HK.SPAWN.x, z: HK.SPAWN.z, heading: HK.SPAWN.heading, speed: 0 };
  let cars = [];

  function setOpen(next) {
    open = next;
    root.hidden = !open;
    if (open) draw();
    return open;
  }

  function draw() {
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLORS.water;
    ctx.fillRect(0, 0, width, height);

    // 陸地
    ctx.fillStyle = COLORS.land;
    ctx.strokeStyle = 'rgba(120, 160, 180, 0.35)';
    ctx.lineWidth = 1;
    for (const land of HK.LAND) {
      ctx.beginPath();
      land.pts.forEach((p, i) => {
        const m = projection.toMap(p.x, p.z);
        if (i === 0) ctx.moveTo(m.x, m.y);
        else ctx.lineTo(m.x, m.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // 走廊（幹道粗一點）
    for (const road of HK.ROADS) {
      ctx.beginPath();
      road.pts.forEach((p, i) => {
        const m = projection.toMap(p.x, p.z);
        if (i === 0) ctx.moveTo(m.x, m.y);
        else ctx.lineTo(m.x, m.y);
      });
      ctx.strokeStyle = road.cls === 'trunk' ? COLORS.trunk : COLORS.road;
      ctx.lineWidth = road.cls === 'trunk' ? Math.max(2, road.w * projection.scale * 0.9) : Math.max(1.2, road.w * projection.scale * 0.6);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // 電車線
    if (HK.TRAM.length > 1) {
      ctx.beginPath();
      HK.TRAM.forEach((p, i) => {
        const m = projection.toMap(p.x, p.z);
        if (i === 0) ctx.moveTo(m.x, m.y);
        else ctx.lineTo(m.x, m.y);
      });
      ctx.strokeStyle = COLORS.tram;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 車流：黃點
    ctx.fillStyle = COLORS.car;
    for (const car of cars) {
      const m = projection.toMap(car.x, car.z);
      ctx.fillRect(m.x - 1, m.y - 1, 2, 2);
    }

    // 傳送點
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const tp of HK.TELEPORTS) {
      const m = projection.toMap(tp.x, tp.z);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.teleport;
      ctx.fill();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(tp.zh, m.x + 5, m.y);
    }

    // 玩家：紅色箭頭
    const pm = projection.toMap(lastState.x, lastState.z);
    ctx.save();
    ctx.translate(pm.x, pm.y);
    // heading 是 atan2(dx, dz)；地圖上 +x 向右、+z 向下，所以直接旋轉
    ctx.rotate(-lastState.heading);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = COLORS.player;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    if (posLabel) {
      posLabel.textContent = `${HK.locationLabel(lastState.x, lastState.z)} · ${Math.round(Math.abs(lastState.speed) * 3.6)} km/h`;
    }
  }

  canvas.addEventListener('click', (event) => {
    if (!onTeleport) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const my = ((event.clientY - rect.top) / rect.height) * canvas.height;
    const world = projection.toWorld(mx, my);
    onTeleport(world.x, world.z);
    draw();
  });

  root.querySelector('.hk-map-close').addEventListener('click', () => setOpen(false));

  return {
    root,
    bounds,
    projection,
    get isOpen() { return open; },
    toggle: () => setOpen(!open),
    setOpen,
    draw,
    /** @param {{x:number,z:number,heading:number,speed:number}} state @param {Array<{x:number,z:number}>} cars */
    update(state, carPositions = cars) {
      if (state) lastState = state;
      cars = carPositions;
      if (open) draw();
    }
  };
}
