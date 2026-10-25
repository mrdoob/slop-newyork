// tools/render-map.mjs
// 把香港地圖（js/hk/map.js）真的畫一次，輸出 PNG。
//
//   node --import ./tools/hk-boot/register.mjs tools/render-map.mjs
//   node --import ./tools/hk-boot/register.mjs tools/render-map.mjs --size=900
//
// 為什麼要這個工具：sandbox 冇瀏覽器，地圖是 2D canvas 畫的，
// 只有把它真的光柵化出來，才可以「用眼」判斷似唔似香港。
import { JSDOM } from 'jsdom';
import { createCanvas2D } from './canvas2d.mjs';
import { mkdirSync } from 'node:fs';

const OUT = new URL('./out/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const sizeArg = process.argv.find((a) => a.startsWith('--size='));
const size = sizeArg ? Number(sizeArg.split('=')[1]) : 760;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:8099/?world=hk' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'MouseEvent', 'Event', 'getComputedStyle']) {
  globalThis[key] = key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key];
}

const contexts = new Map();
dom.window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== '2d') return null;
  if (!contexts.has(this)) contexts.set(this, createCanvas2D(this.width || 300, this.height || 300));
  return contexts.get(this);
};
dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };
};

const { createHongKongMap } = await import('../js/hk/map.js');

const map = createHongKongMap({ size });
const canvas = map.root.querySelector('canvas');
canvas.width = size;
canvas.height = size;
const ctx = canvas.getContext('2d');
map.setOpen(true);
map.update({ x: 32, z: -217, heading: 0.6, speed: 12 }, [
  { x: 100, z: -300 }, { x: -200, z: -600 }, { x: 600, z: -1200 }, { x: 900, z: -900 }
]);
map.draw();

const file = new URL(`map-${size}.png`, OUT);
ctx.writePng(file.pathname);
console.log(`畫布 ${canvas.width}×${canvas.height} · 2D 指令：fill ${ctx.stats.fill}、stroke ${ctx.stats.stroke}、fillText ${ctx.stats.fillText}`);
console.log(`寫出 ${file.pathname}`);
