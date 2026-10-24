const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Runs main.js from the loading overlay setup through renderer start-up, stopping before the city is built.
const main = readFileSync(join(__dirname, '../js/main.js'), 'utf8');
const startup = main.slice(main.indexOf('  const container ='), main.indexOf('  // 2. Build Scene'));

function element(className = '') {
  return {
    className,
    style: {},
    children: [],
    textContent: '',
    classList: {
      names: new Set(),
      add(name) { this.names.add(name); },
      remove(name) { this.names.delete(name); },
      contains(name) { return this.names.has(name); }
    },
    querySelector: () => element('loader-track'),
    addEventListener(type, listener) { this[`on${type}`] = listener; },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); },
    replaceChildren(...nodes) { this.children = nodes; this.textContent = ''; }
  };
}

async function start(backend, { initError = null } = {}) {
  const elements = new Map();
  const loops = [];
  const logs = [];
  class WebGPURenderer {
    constructor() {
      this.backend = backend;
      this.domElement = element();
      this.shadowMap = {};
    }
    setPixelRatio() {}
    setSize() {}
    init() { return initError ? Promise.reject(initError) : Promise.resolve(); }
    setAnimationLoop(loop) { loops.push(loop); }
  }
  const context = vm.createContext({
    THREE: { REVISION: 'test', WebGPURenderer },
    ClusteredLighting: class {},
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: () => element()
    },
    window: { innerWidth: 800, innerHeight: 600 },
    location: { reload() {} },
    performance: { now: () => 0 },
    console: { log() {}, warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
  });
  const reachedCity = await vm.runInContext(`(async () => {\n${startup}\nreturn true;\n})()`, context);
  const status = elements.get('loading-status');
  const part = (className) => status.children[0]?.children.find((child) => child.className === className);
  return {
    reachedCity: reachedCity === true,
    overlay: elements.get('loading-overlay'),
    get title() { return part('loader-error-title')?.textContent; },
    get reload() { return part('loader-reload-btn'); },
    loops,
    logs
  };
}

test('a WebGL2 fallback stops start-up and explains that WebGPU is required', async () => {
  const result = await start({ isWebGPUBackend: false });
  assert.equal(result.reachedCity, false, 'the city is not built on the fallback backend');
  assert.equal(result.title, 'WebGPU required');
  assert.equal(result.overlay.classList.contains('hidden'), false, 'the loading overlay stays up');
  assert.ok(result.reload, 'a reload button is offered');
});

test('a rejected renderer init stops start-up with an error instead of an unhandled rejection', async () => {
  const result = await start({}, { initError: new Error('No available adapters.') });
  assert.equal(result.reachedCity, false);
  assert.equal(result.title, 'WebGPU unavailable');
});

test('a lost device stops the animation loop and shows the error over the city', async () => {
  let lose;
  const lost = new Promise((resolve) => { lose = resolve; });
  const result = await start({ isWebGPUBackend: true, device: { lost } });
  assert.equal(result.reachedCity, true, 'a working WebGPU device continues to build the city');
  assert.equal(result.title, undefined);

  result.overlay.classList.add('hidden'); // the city is on screen
  lose({ reason: 'unknown', message: 'D3D11 device removed' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(result.loops, [null], 'rendering stops');
  assert.equal(result.overlay.classList.contains('hidden'), false, 'the overlay comes back');
  assert.equal(result.title, 'Graphics device lost');
  assert.ok(result.reload);
});

test('deliberately destroying the device is not reported as a loss', async () => {
  let lose;
  const lost = new Promise((resolve) => { lose = resolve; });
  const result = await start({ isWebGPUBackend: true, device: { lost } });
  result.overlay.classList.add('hidden');
  lose({ reason: 'destroyed', message: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result.loops, []);
  assert.equal(result.overlay.classList.contains('hidden'), true);
  assert.equal(result.title, undefined);
});
