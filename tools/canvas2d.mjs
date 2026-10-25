// tools/canvas2d.mjs — 一個「夠用」的 Canvas 2D 光柵化器，寫成可以塞進 jsdom／Node 的假 context。
//
// 為什麼要這個：sandbox 冇瀏覽器。香港的地圖（js/hk/map.js）是純 2D canvas 畫的，
// 如果冇辦法把 canvas 內容變成圖，我就只能盲改 —— 而上一次「地圖唔似樣」正是盲改的結果。
//
// 支援：moveTo / lineTo / arc / rect / closePath / beginPath、fill / stroke（nonzero 掃描線）、
//       fillRect / clearRect / save / restore / translate / rotate / scale、setLineDash（虛線）、
//       純色 fillStyle / strokeStyle、lineWidth、文字（以細方塊示意，唔會拋錯）。
// 唔支援：漸變、pattern、文字真正字型、globalCompositeOperation。
import { encodePng } from './png.mjs';
import { writeFileSync } from 'node:fs';

const parseColor = (style) => {
  if (typeof style !== 'string') return [255, 0, 255, 1];
  const s = style.trim();
  if (s.startsWith('#')) {
    if (s.length === 7) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
    if (s.length === 4) return [parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16), parseInt(s[3] + s[3], 16), 1];
    return [255, 0, 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  return [200, 200, 200, 1];
};

class Transform {
  constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
  clone() { const t = new Transform(); Object.assign(t, this); return t; }
  apply(x, y) { return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f]; }
  multiply(m) {
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b;
    this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d;
    this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e;
    this.f = b * m.e + d * m.f + f;
  }
}

/** 建立一個 Canvas2D 的替代品，畫到 width×height 的 RGBA buffer。 */
export function createCanvas2D(width, height, background = [12, 18, 24, 255]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = background[0];
    pixels[i * 4 + 1] = background[1];
    pixels[i * 4 + 2] = background[2];
    pixels[i * 4 + 3] = background[3];
  }

  let transform = new Transform();
  const stack = [];
  let subpaths = [];
  let current = null;
  const stats = { fillText: 0, fill: 0, stroke: 0, trianglesFilled: 0 };

  const blend = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const [r, g, b, a] = color;
    const i = (y * width + x) * 4;
    const alpha = a * (color[3] ?? 1);
    if (alpha >= 0.999) {
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
      return;
    }
    pixels[i] = pixels[i] * (1 - alpha) + r * alpha;
    pixels[i + 1] = pixels[i + 1] * (1 - alpha) + g * alpha;
    pixels[i + 2] = pixels[i + 2] * (1 - alpha) + b * alpha;
    pixels[i + 3] = 255;
  };

  /** 掃描線填充（even-odd），polys = [[x,y],…] */
  const fillPolys = (polys, color) => {
    // 一定要補回封閉邊：未 closePath 的多邊形（例如 fillRect 的四點）少了最後一條邊，
    // 掃描線的交叉數會變成奇數 → 整條掃描線都填唔到。（這正是第一版 fillRect 完全畫唔出東西的原因。）
    polys = polys.map((poly) => {
      if (poly.length < 3) return poly;
      const [fx, fy] = poly[0];
      const [lx, ly] = poly[poly.length - 1];
      return fx === lx && fy === ly ? poly : [...poly, [fx, fy]];
    });
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const poly of polys) {
      for (const [x, y] of poly) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(height - 1, Math.ceil(maxY));
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(width - 1, Math.ceil(maxX));
    if (y1 < y0 || x1 < x0) return;
    const crossings = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5;
      crossings.length = 0;
      for (const poly of polys) {
        for (let i = 0; i + 1 < poly.length; i++) {
          const [ax, ay] = poly[i];
          const [bx, by] = poly[i + 1];
          if ((ay > sy) === (by > sy)) continue;
          crossings.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      if (!crossings.length) continue;
      crossings.sort((p, q) => p - q);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(x0, Math.ceil(crossings[k] - 0.5));
        const to = Math.min(x1, Math.floor(crossings[k + 1] - 0.5));
        for (let x = from; x <= to; x++) blend(x, y, color);
      }
    }
    stats.trianglesFilled += 1;
  };

  const screenPolys = () => subpaths.map((sp) => sp.map(([x, y]) => transform.apply(x, y)));

  const ctx = {
    canvas: { width, height },
    stats,
    // state
    fillStyle: '#ffffff',
    strokeStyle: '#ffffff',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    globalCompositeOperation: 'source-over',
    _dash: [],

    save() { stack.push({ transform: transform.clone(), fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, _dash: ctx._dash.slice(), globalAlpha: ctx.globalAlpha }); },
    restore() {
      const s = stack.pop();
      if (!s) return;
      transform = s.transform;
      ctx.fillStyle = s.fillStyle;
      ctx.strokeStyle = s.strokeStyle;
      ctx.lineWidth = s.lineWidth;
      ctx._dash = s._dash;
      ctx.globalAlpha = s.globalAlpha;
    },
    translate(x, y) { transform.multiply({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); },
    rotate(angle) { const c = Math.cos(angle); const s = Math.sin(angle); transform.multiply({ a: c, b: s, c: -s, d: c, e: 0, f: 0 }); },
    scale(x, y) { transform.multiply({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 }); },
    setTransform(a, b, c, d, e, f) { transform = Object.assign(new Transform(), { a, b, c, d, e, f }); },
    getTransform() { return { ...transform }; },

    beginPath() { subpaths = []; current = null; },
    closePath() { if (current && current.length) current.push(current[0]); },
    moveTo(x, y) { current = [[x, y]]; subpaths.push(current); },
    lineTo(x, y) {
      if (!current) { current = [[x, y]]; subpaths.push(current); return; }
      current.push([x, y]);
    },
    rect(x, y, w, h) { ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); },
    arc(cx, cy, r, start = 0, end = Math.PI * 2, ccw = false) {
      const steps = Math.max(8, Math.min(64, Math.round(Math.abs(end - start) * 12)));
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = start + ((end - start) * i) / steps * (ccw ? -1 : 1);
        pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
      }
      if (current && current.length && Math.hypot(current[current.length - 1][0] - pts[0][0], current[current.length - 1][1] - pts[0][1]) < 1e-6) {
        current.push(...pts.slice(1));
      } else {
        current = pts;
        subpaths.push(current);
      }
    },
    ellipse(cx, cy, rx, ry, rotation = 0, start = 0, end = Math.PI * 2) {
      const steps = 48;
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = start + ((end - start) * i) / steps;
        const x = Math.cos(t) * rx;
        const y = Math.sin(t) * ry;
        pts.push([cx + x * Math.cos(rotation) - y * Math.sin(rotation), cy + x * Math.sin(rotation) + y * Math.cos(rotation)]);
      }
      current = pts;
      subpaths.push(current);
    },

    fill(rule) {
      const color = parseColor(ctx.fillStyle);
      color[3] = (color[3] ?? 1) * ctx.globalAlpha;
      const polys = screenPolys().filter((p) => p.length > 2);
      if (polys.length) fillPolys(polys, color);
      stats.fill += 1;
    },
    stroke() {
      const color = parseColor(ctx.strokeStyle);
      color[3] = (color[3] ?? 1) * ctx.globalAlpha;
      const w = Math.max(0.4, ctx.lineWidth) / 2;
      const dash = ctx._dash && ctx._dash.length ? ctx._dash : null;
      for (const sub of subpaths) {
        const pts = sub.map(([x, y]) => transform.apply(x, y));
        if (pts.length < 2) {
          if (pts.length === 1) fillPolys([[[pts[0][0] - w, pts[0][1] - w], [pts[0][0] + w, pts[0][1] - w], [pts[0][0] + w, pts[0][1] + w], [pts[0][0] - w, pts[0][1] + w]]], color);
          continue;
        }
        let travelled = 0;
        let dashIndex = 0;
        let dashOn = true;
        for (let i = 0; i + 1 < pts.length; i++) {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[i + 1];
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-6) continue;
          const nx = (-(by - ay) / len) * w;
          const ny = ((bx - ax) / len) * w;
          if (!dash) {
            fillPolys([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]], color);
            continue;
          }
          let t = 0;
          while (t < len) {
            const remaining = dash[dashIndex % dash.length] - travelled;
            const step = Math.min(remaining, len - t);
            if (dashOn) {
              const x0 = ax + ((bx - ax) * t) / len;
              const y0 = ay + ((by - ay) * t) / len;
              const x1 = ax + ((bx - ax) * (t + step)) / len;
              const y1 = ay + ((by - ay) * (t + step)) / len;
              fillPolys([[[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]], color);
            }
            t += step;
            travelled += step;
            if (travelled >= dash[dashIndex % dash.length] - 1e-6) { travelled = 0; dashIndex++; dashOn = !dashOn; }
            if (step <= 0) break;
          }
        }
      }
      stats.stroke += 1;
    },
    setLineDash(arr) { ctx._dash = Array.isArray(arr) ? arr.slice() : []; },
    getLineDash() { return ctx._dash.slice(); },

    fillRect(x, y, w, h) {
      const color = parseColor(ctx.fillStyle);
      color[3] = (color[3] ?? 1) * ctx.globalAlpha;
      const [x0, y0] = transform.apply(x, y);
      const [x1, y1] = transform.apply(x + w, y + h);
      fillPolys([[[Math.min(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.max(y0, y1)], [Math.min(x0, x1), Math.max(y0, y1)]]], color);
    },
    clearRect(x, y, w, h) {
      const saved = ctx.fillStyle;
      ctx.fillStyle = `rgba(0,0,0,0)`;
      const [x0, y0] = transform.apply(x, y);
      const [x1, y1] = transform.apply(x + w, y + h);
      for (let py = Math.max(0, Math.floor(Math.min(y0, y1))); py <= Math.min(height - 1, Math.ceil(Math.max(y0, y1))); py++) {
        for (let px = Math.max(0, Math.floor(Math.min(x0, x1))); px <= Math.min(width - 1, Math.ceil(Math.max(x0, x1))); px++) {
          const i = (py * width + px) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
          pixels[i + 3] = 255;
        }
      }
      ctx.fillStyle = saved;
    },
    strokeRect(x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.stroke(); },

    // 文字：用一個灰色小方塊示意（只為睇得到「有冇畫字」，唔會假裝有字型）
    fillText(text, x, y) {
      stats.fillText += 1;
      const [px, py] = transform.apply(x, y);
      const size = Math.max(4, parseFloat(String(ctx.font).match(/(\d+(?:\.\d+)?)px/)?.[1] || 10));
      const w = Math.min(60, String(text).length * size * 0.5);
      const color = parseColor(ctx.fillStyle);
      color[3] = 0.55;
      fillPolys([[[px, py - size * 0.6], [px + w, py - size * 0.6], [px + w, py + size * 0.25], [px, py + size * 0.25]]], color);
    },
    strokeText() { stats.fillText += 1; },
    measureText(text) { return { width: String(text).length * 6 }; },

    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    drawImage() {},
    getImageData(x, y, w = 1, h = 1) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
    putImageData() {}
  };

  ctx.writePng = (path) => writeFileSync(path, encodePng(width, height, pixels));
  ctx.pixels = pixels;
  return ctx;
}
