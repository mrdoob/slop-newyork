// tools/dom-stub.mjs — 冇瀏覽器時的最小 DOM：只夠應付 canvas 貼圖繪製。
// 用於 tools/render-model.mjs 等「在 Node 裡跑遊戲模組」的工具（唔需要 jsdom）。
const noopGradient = { addColorStop() {} };

function makeContext(canvas) {
  const base = {
    canvas,
    measureText: (text) => ({ width: String(text).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => noopGradient,
    createRadialGradient: () => noopGradient,
    createPattern: () => noopGradient,
    getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    drawImage() {},
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  };
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      let value = target[prop];
      if (value === undefined) value = target[prop] = () => undefined;
      return value;
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
}

function makeCanvas() {
  const canvas = {
    width: 256,
    height: 256,
    style: {},
    getContext: () => (canvas.__ctx ||= makeContext(canvas)),
    toDataURL: () => 'data:image/png;base64,',
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height })
  };
  return canvas;
}

function makeElement(tag) {
  if (String(tag).toLowerCase() === 'canvas') return makeCanvas();
  const element = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) { element.children.push(child); return child; },
    removeChild() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => null,
    textContent: ''
  };
  return element;
}

export function installDomStub() {
  if (globalThis.document) return globalThis.document;
  const body = makeElement('body');
  globalThis.document = {
    createElement: makeElement,
    createElementNS: (_ns, tag) => makeElement(tag),
    body,
    documentElement: makeElement('html'),
    head: makeElement('head'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };
  if (!globalThis.window) globalThis.window = globalThis;
  globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
  return globalThis.document;
}
