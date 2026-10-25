// js/hk/markings.js
// 香港道路標線：一次過寫進單一 typed array，唔會為每一段虛線開一個 BufferGeometry。
//
// （原本寫法對每條虛線段 new 一個 BufferGeometry，香港走廊總共一萬三千個，再 mergeGeometries，
//   主執行緒要卡幾秒至十幾秒，瀏覽器會出 "Page Unresponsive"。改成純陣列之後：一個 geometry、一次上傳。）
//
// 這裡刻意唔 import three.js，所以可以直接在 Node 裡單元測試。

const push = (arr, ...v) => {
  for (const x of v) arr.push(x);
};

/**
 * 沿折線在「行車方向左側」offset 米處畫一條寬 width 的標線（含虛線）。
 * @returns {{positions: Float32Array, indices: Uint32Array, quads: number, triangles: number}}
 */
export function buildRoadMarkings(roads, {
  laneWidth = 3.4,
  y = 0.17,
  lineWidth = 0.14,
  centreWidth = 0.13,
  dash = 4,
  gap = 6,
  edgeInset = 0.5,
  maxQuads = 200000
} = {}) {
  const positions = [];
  const indices = [];
  let quads = 0;

  function quad(ax, az, bx, bz, w) {
    if (quads >= maxQuads) throw new Error('road markings: quad budget exceeded (bad geometry?)');
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (!(len > 0.05) || !Number.isFinite(len)) return;
    const nx = (dz / len) * (w / 2);
    const nz = (-dx / len) * (w / 2);
    const base = positions.length / 3;
    push(positions, ax + nx, y, az + nz, ax - nx, y, az - nz, bx - nx, y, bz - nz, bx + nx, y, bz + nz);
    push(indices, base, base + 1, base + 2, base, base + 2, base + 3);
    quads++;
  }

  /**
   * 在偏移 off 的位置畫線。dash > 0 時按相位切段（相位跨段累加，彎位不會重置）。
   * 用索引運算而非 while，避免任何浮點邊界造成的無限迴圈。
   */
  function line(pts, off, w, { dashed = false, phase = 0 } = {}) {
    const period = dash + gap;
    let run = phase;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.hypot(dx, dz);
      if (!(segLen > 0.05)) continue;
      const ux = dx / segLen;
      const uz = dz / segLen;
      const lx = uz; // 行車方向左側的法線（靠左行駛，見 config.js laneLateral）
      const lz = -ux;
      const ox = lx * off;
      const oz = lz * off;
      if (!dashed) {
        quad(a.x + ox, a.z + oz, b.x + ox, b.z + oz, w);
        continue;
      }
      // 這一段內，第 k 條虛線的起點：run + t ≡ 0 (mod period)
      const first = Math.ceil(run / period) * period - run;
      const steps = Math.floor((segLen - first) / period) + 1;
      for (let k = 0; k < steps; k++) {
        const t0 = first + k * period;
        if (t0 < 0 || t0 >= segLen) continue;
        const t1 = Math.min(segLen, t0 + dash);
        if (t1 - t0 < 0.2) continue;
        quad(
          a.x + ux * t0 + ox, a.z + uz * t0 + oz,
          a.x + ux * t1 + ox, a.z + uz * t1 + oz,
          w
        );
      }
      run += segLen;
    }
  }

  for (const road of roads) {
    const pts = dedupe(road.pts);
    if (pts.length < 2) continue;
    const half = road.w / 2;
    // 路邊線（實線）
    line(pts, half - edgeInset, lineWidth);
    line(pts, -(half - edgeInset), lineWidth);
    if (road.oneway) {
      for (let i = 1; i < road.lanesPerWay; i++) line(pts, i * laneWidth, lineWidth, { dashed: true });
    } else {
      // 雙白線（香港：跨雙白線屬違例）
      line(pts, 0.22, centreWidth);
      line(pts, -0.22, centreWidth);
      for (let i = 1; i < road.lanesPerWay; i++) {
        line(pts, i * laneWidth, lineWidth, { dashed: true });
        line(pts, -i * laneWidth, lineWidth, { dashed: true });
      }
    }
  }

  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    quads,
    triangles: quads * 2
  };
}

/** 去掉連續重複（或距離 < 1 cm）的點，避免零長度線段產生 NaN 法線。 */
export function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.01) out.push(p);
  }
  return out;
}
