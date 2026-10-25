import * as HK from './config.js';

// js/hk/map.js
// 香港的全域地圖（純 2D canvas，唔需要 GPU）。
//
// 第一版用種子資料畫「兩個雲」——用戶一句「地圖唔掂喎」講得對。第二版改成真正的城市地圖：
//   · 海岸線：地政總署陸地邊界（js/hk-coastline.js，~20 m 精度），所以維港、中環填海、
//     尖沙咀海運碼頭、紅磡灣等地標形狀都對得返
//   · 樓宇：1,349 棟的腳印（略暗的灰），一眼睇得出市區紋理
//   · 道路：按等級分粗細 ＋ 深色「路肩」（casing），主幹道再加一條淺色中線
//   · 電車線：琥珀色虛線；車流：黃點；9 個傳送點：白圈 ＋ 名稱（帶深色底）
//   · 玩家：紅色箭咀 ＋ 朝向；右下角指北針 ＋ 1 km 比例尺
//
// 操作：按 M 或 HUD 的「地圖」開關；點地圖任何一點 = 傳送到那裡（同紐約版一樣）。

const COLORS = {
  water: '#071820',
  waterDeep: '#05131a',
  land: '#39525b',
  landFar: '#2c4048',
  landEdge: '#8ec6d8',
  building: '#5f7a86',
  buildingTower: '#7b98a4',
  buildingEdge: 'rgba(6, 12, 16, 0.5)',
  roadCasing: '#0a1418',
  roadFill: '#cbd3d6',
  trunkFill: '#eef3f5',
  tram: '#c69a52',
  car: '#f0c14b',
  player: '#e0342c',
  playerRing: 'rgba(224, 52, 44, 0.35)',
  teleport: '#eef4f8',
  label: 'rgba(236, 242, 246, 0.92)',
  labelDim: 'rgba(196, 214, 224, 0.6)',
  labelBg: 'rgba(6, 14, 20, 0.72)'
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

/** 地圖要顯示的範圍：樓宇 ＋ 走廊的外框，四周留 320 m（剛好包住兩岸的海岸線）。 */
export function mapBounds(padding = 320) {
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
  for (const road of HK.ROADS) for (const p of road.pts) consider(p.x, p.z);
  for (const b of HK.BUILDINGS) consider(b.x, b.z);
  return { minX: minX - padding, maxX: maxX + padding, minZ: minZ - padding, maxZ: maxZ + padding };
}

const traceRing = (ctx, projection, ring, close = true) => {
  ctx.beginPath();
  ring.forEach((p, i) => {
    const m = projection.toMap(p.x, p.z);
    if (i === 0) ctx.moveTo(m.x, m.y);
    else ctx.lineTo(m.x, m.y);
  });
  if (close) ctx.closePath();
};

const tracePolyline = (ctx, projection, pts) => {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const m = projection.toMap(p.x, p.z);
    if (i === 0) ctx.moveTo(m.x, m.y);
    else ctx.lineTo(m.x, m.y);
  });
};

/** 帶深色底的標籤（地圖上最易讀的做法）。 */
function label(ctx, text, x, y, { align = 'left', size = 10, color = COLORS.label, bg = COLORS.labelBg } = {}) {
  ctx.save();
  ctx.font = `600 ${size}px Inter, "Noto Sans HK", system-ui, sans-serif`;
  const width = ctx.measureText ? ctx.measureText(text).width : text.length * size * 0.6;
  const padX = 4;
  const padY = 2.5;
  const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(left - padX, y - size + 1.5, width + padX * 2, size + padY * 2 - 1);
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(text, left, y + padY);
  ctx.restore();
}

export function createHongKongMap({ onTeleport = null, size = 520 } = {}) {
  const bounds = mapBounds();

  const root = document.createElement('section');
  root.className = 'hk-map';
  root.hidden = true;
  root.innerHTML = `
    <header class="hk-map-head">
      <strong>香港地圖 · Hong Kong</strong>
      <span class="hk-map-hint">點地圖 = 傳送 · M 關閉</span>
      <button type="button" class="hk-map-close" aria-label="關閉地圖">✕</button>
    </header>
    <div class="hk-map-body">
      <canvas width="${size}" height="${size}" class="hk-map-canvas"></canvas>
      <div class="hk-map-legend">
        <span><i style="background:${COLORS.player}"></i>你</span>
        <span><i style="background:${COLORS.car}"></i>車流</span>
        <span><i style="background:${COLORS.teleport};border-radius:50%"></i>傳送點</span>
        <span><i style="background:${COLORS.tram}"></i>電車</span>
      </div>
    </div>
    <footer class="hk-map-foot"><span id="hk-map-pos">—</span></footer>
  `;
  document.body.appendChild(root);

  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const posLabel = root.querySelector('#hk-map-pos');
  const projection = createProjection(bounds, canvas.width, canvas.height, 18);

  let open = false;
  let lastState = { x: HK.SPAWN.x, z: HK.SPAWN.z, heading: HK.SPAWN.heading, speed: 0 };
  let cars = [];

  function setOpen(next) {
    open = next;
    root.hidden = !open;
    if (open) draw();
    return open;
  }

  // 大廈腳印只計一次（1,349 個），之後每幀只畫投影後的方塊。
  const footprints = HK.BUILDINGS.map((b) => {
    const cos = Math.cos(b.rot || 0);
    const sin = Math.sin(b.rot || 0);
    const hw = (b.w || 8) / 2;
    const hd = (b.d || 8) / 2;
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([dx, dz]) => ({
      x: b.x + dx * cos + dz * sin,
      z: b.z - dx * sin + dz * cos
    }));
    return { corners, tower: !!b.tower, h: b.h };
  });

  function draw() {
    if (!ctx) return;
    const { width, height } = canvas;
    const t = projection.toMap;

    // --- 海 ------------------------------------------------------------------
    ctx.fillStyle = COLORS.waterDeep;
    ctx.fillRect(0, 0, width, height);

    // --- 全港陸地（真實海岸線：新界、大嶼山、西貢、離島）----------------------
    // 先畫外圍（粗精度），再畫玩樂範圍（~12 m 精度），重疊部分由後者蓋住。
    for (const ring of HK.COAST.territory) {
      traceRing(ctx, projection, ring);
      ctx.fillStyle = COLORS.landFar;
      ctx.fill();
    }
    for (const ring of HK.COAST.land) {
      traceRing(ctx, projection, ring);
      ctx.fillStyle = COLORS.land;
      ctx.fill();
      ctx.strokeStyle = COLORS.landEdge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // --- 樓宇腳印（市區紋理）------------------------------------------------
    for (const f of footprints) {
      ctx.beginPath();
      f.corners.forEach((p, i) => {
        const m = t(p.x, p.z);
        if (i === 0) ctx.moveTo(m.x, m.y);
        else ctx.lineTo(m.x, m.y);
      });
      ctx.closePath();
      ctx.fillStyle = f.tower ? COLORS.buildingTower : COLORS.building;
      ctx.fill();
      ctx.strokeStyle = COLORS.buildingEdge;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // --- 道路：先畫深色路肩，再畫路面 --------------------------------------
    const roads = [...HK.ROADS].sort((a, b) => (a.cls === 'trunk' ? 1 : 0) - (b.cls === 'trunk' ? 1 : 0));
    // 道路闊度用米的真實闊度，再夾在 2–7 px，確保任何尺寸下都睇得見
    const widthOf = (road) => Math.max(2.4, Math.min(8, road.w * projection.scale * 2.2));
    for (const pass of ['casing', 'fill']) {
      for (const road of roads) {
        tracePolyline(ctx, projection, road.pts);
        const w = widthOf(road);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (pass === 'casing') {
          ctx.strokeStyle = COLORS.roadCasing;
          ctx.lineWidth = w + 2.6;
        } else {
          ctx.strokeStyle = road.cls === 'trunk' ? COLORS.trunkFill : COLORS.roadFill;
          ctx.lineWidth = w;
        }
        ctx.stroke();
      }
    }

    // --- 電車線 --------------------------------------------------------------
    if (HK.TRAM.length > 1) {
      tracePolyline(ctx, projection, HK.TRAM);
      ctx.strokeStyle = COLORS.tram;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- 海港渡輪航線 --------------------------------------------------------
    ctx.beginPath();
    const a = t(HK.FERRY.from.x, HK.FERRY.from.z);
    const b = t(HK.FERRY.to.x, HK.FERRY.to.z);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(150, 200, 220, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    // --- 車流 ----------------------------------------------------------------
    ctx.fillStyle = COLORS.car;
    for (const car of cars) {
      const m = t(car.x, car.z);
      ctx.fillRect(m.x - 1.1, m.y - 1.1, 2.2, 2.2);
    }

    // --- 香港島／九龍／維多利亞港 -------------------------------------------------
    const centroids = HK.LAND.map((l) => {
      let sx = 0;
      let sz = 0;
      for (const p of l.pts) {
        sx += p.x;
        sz += p.z;
      }
      return { ...l, cx: sx / l.pts.length, cz: sz / l.pts.length };
    });
    for (const c of centroids) {
      const m = t(c.cx, c.cz);
      label(ctx, `${c.zh} ${c.en}`, m.x, m.y, { align: 'center', size: 11, color: 'rgba(226, 236, 242, 0.55)', bg: null });
    }
    const island = centroids.find((c) => c.id === 'hk-island');
    const kowloon = centroids.find((c) => c.id === 'kowloon');
    if (island && kowloon) {
      const mid = t((island.cx + kowloon.cx) / 2, (island.cz + kowloon.cz) / 2);
      label(ctx, '維多利亞港 Victoria Harbour', mid.x, mid.y, { align: 'center', size: 10, color: 'rgba(140, 196, 216, 0.75)', bg: null });
    }

    // --- 地區名（淡） --------------------------------------------------------
    for (const d of HK.DISTRICTS) {
      const m = t(d.cx, d.cz);
      if (m.x < 0 || m.y < 0 || m.x > width || m.y > height) continue;
      label(ctx, d.zh, m.x, m.y, { align: 'center', size: 9.5, color: COLORS.labelDim, bg: null });
    }

    // --- 傳送點 --------------------------------------------------------------
    for (const tp of HK.TELEPORTS) {
      const m = t(tp.x, tp.z);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.teleport;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(m.x, m.y, 6.2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(238, 244, 248, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      label(ctx, tp.zh, m.x + 9, m.y + 3.5, { size: 9.5 });
    }

    // --- 玩家 ----------------------------------------------------------------
    const pm = t(lastState.x, lastState.z);
    ctx.beginPath();
    ctx.arc(pm.x, pm.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.playerRing;
    ctx.fill();
    ctx.save();
    ctx.translate(pm.x, pm.y);
    // heading = atan2(dx, dz)：地圖 +x 向右、+z 向下，所以直接轉 -heading
    ctx.rotate(-lastState.heading);
    ctx.beginPath();
    ctx.moveTo(0, -8.5);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3.6);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fillStyle = COLORS.player;
    ctx.fill();
    ctx.strokeStyle = 'rgba(8, 12, 16, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    // --- 指北針 ＋ 比例尺 ----------------------------------------------------
    const cx = width - 26;
    const cy = 30;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12);
    ctx.lineTo(cx + 5.5, cy + 6);
    ctx.lineTo(cx, cy + 2.5);
    ctx.lineTo(cx - 5.5, cy + 6);
    ctx.closePath();
    ctx.fillStyle = 'rgba(236, 242, 246, 0.85)';
    ctx.fill();
    label(ctx, 'N', cx - 4, cy - 15, { size: 9.5, color: COLORS.label, bg: null });

    const kmInPixels = 1000 * projection.scale;
    const barPixels = kmInPixels > 80 ? kmInPixels : kmInPixels * 0.5;
    const barLabel = kmInPixels > 80 ? '1 km' : '500 m';
    const bx = 16;
    const by = height - 16;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barPixels, by);
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx, by + 1);
    ctx.moveTo(bx + barPixels, by - 4);
    ctx.lineTo(bx + barPixels, by + 1);
    ctx.strokeStyle = 'rgba(236, 242, 246, 0.8)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = 'rgba(236, 242, 246, 0.8)';
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.fillText(barLabel, bx + barPixels + 6, by + 3.5);

    if (posLabel) {
      const speed = Math.round(Math.abs(lastState.speed) * 3.6);
      posLabel.textContent = `${HK.locationLabel(lastState.x, lastState.z)} · ${speed} km/h`;
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
