// js/world.js
// 世界切換層（Phase 0）：讓同一個 repo 同時容納「Slop New York」與「Slop Hong Kong」。
//
//   ?world=hk    → 香港
//   ?world=ny    → 紐約（預設）
//   沒有 query 時：記住上次的選擇（localStorage['slop-world']），預設紐約。
//
// 這一層刻意做到最小：只決定「載入哪一個世界」與「品牌字串」，不碰任何幾何或物理。
// 之後要加第三個城市（例如東京、新加坡），只需要在 WORLDS 加一筆 + 新目錄。

export const WORLDS = {
  ny: {
    id: 'ny',
    zh: '紐約',
    en: 'New York',
    title: 'Slop New York',
    bullet: 'NY',
    subtitle: 'three.js · WebGPU · TSL',
    storageKey: 'nyc-player-state',
    description: 'Real Manhattan, 125th St to Battery Park, on foot, by taxi, by bike or by helicopter.'
  },
  hk: {
    id: 'hk',
    zh: '香港',
    en: 'Hong Kong',
    title: 'Slop Hong Kong',
    bullet: 'HK',
    subtitle: 'three.js · WebGPU · TSL · 靠左行駛',
    storageKey: 'hk-player-state',
    description: '維多利亞港兩岸：中環、金鐘、灣仔、銅鑼灣、尖沙咀、旺角，靠左行駛。'
  }
};

const ALIASES = {
  hk: 'hk',
  'hong-kong': 'hk',
  hongkong: 'hk',
  '香港': 'hk',
  ny: 'ny',
  nyc: 'ny',
  'new-york': 'ny',
  '紐約': 'ny'
};

/** 目前要跑哪一個世界（純函式，方便測試）。 */
export function resolveWorld(search = '', stored = null) {
  let query = '';
  try {
    query = new URLSearchParams(search).get('world') || new URLSearchParams(search).get('city') || '';
  } catch {
    query = '';
  }
  const wanted = ALIASES[String(query).toLowerCase()] || ALIASES[query];
  if (wanted) return wanted;
  return stored === 'hk' ? 'hk' : 'ny';
}

export function getWorldId() {
  let stored = null;
  try {
    stored = localStorage.getItem('slop-world');
  } catch { /* 私隱模式：就用預設 */ }
  const id = resolveWorld(typeof location !== 'undefined' ? location.search : '', stored);
  try {
    localStorage.setItem('slop-world', id);
  } catch { /* 同上 */ }
  return id;
}

export function getWorld(id = getWorldId()) {
  return WORLDS[id] || WORLDS.ny;
}

/** 換掉頁面上所有「紐約」品牌：title、HUD 標題、loading 畫面的子彈與標題。 */
export function applyBranding(world) {
  if (typeof document === 'undefined') return;
  document.title = world.title;
  document.body.dataset.world = world.id;
  const set = (selector, text) => {
    for (const el of document.querySelectorAll(selector)) el.textContent = text;
  };
  set('.loader-bullet', world.bullet);
  set('.loader-title', world.title);
  const h1 = document.querySelector('.brand h1');
  if (h1) h1.textContent = world.title;
  const bullet = document.querySelector('.brand .mta-bullet');
  if (bullet) bullet.textContent = world.bullet;
  const sub = document.querySelector('.brand-subtitle');
  if (sub) {
    // 保留 FPS 元素
    const fps = document.getElementById('hud-fps');
    sub.replaceChildren(document.createTextNode(`${world.subtitle} · `));
    if (fps) {
      fps.className = 'fps-ok';
      sub.append(fps, document.createTextNode(' fps'));
    }
  }
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute('content', `${world.title} — ${world.description}`);
  const status = document.getElementById('loading-status');
  if (status && status.textContent) status.textContent = 'Building Hong Kong…';
}
