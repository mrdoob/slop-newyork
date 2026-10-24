// js/hud-panels.js
// Minimizable on-screen panels. Every element with data-panel="<name>" gets a toggle button: minimized, the panel shows
// only that button (labelled with data-title) and any child marked .panel-keep (e.g. the map-data credit, which must
// stay visible). Each panel's state is remembered per browser; panels listed in data-collapse-small start minimized on
// small or touch screens until the viewer opens them.
//
// initPanels({ small }) -> { set(name, open), isOpen(name) }

const STORE = 'slop-taipei-panels';

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save(state) {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private mode: not remembered */ }
}

function initPanels({ small = false } = {}) {
  const state = load();
  const panels = new Map();
  for (const el of document.querySelectorAll('[data-panel]')) {
    const name = el.dataset.panel;
    const title = el.dataset.title || name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'panel-toggle';
    el.prepend(button);
    const apply = (open) => {
      el.classList.toggle('is-min', !open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', `${open ? 'Minimize' : 'Show'} ${title}`);
      button.title = `${open ? 'Minimize' : 'Show'} ${title}`;
      button.innerHTML = open ? '<span aria-hidden="true">–</span>' : `<span aria-hidden="true">+</span> ${title}`;
    };
    const fallback = !(small && 'collapseSmall' in el.dataset);
    panels.set(name, apply);
    apply(state[name] ?? fallback);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = el.classList.contains('is-min');
      state[name] = open;
      save(state);
      apply(open);
    });
  }
  return {
    set(name, open) { panels.get(name)?.(open); },
    isOpen(name) { return !document.querySelector(`[data-panel="${name}"]`)?.classList.contains('is-min'); }
  };
}

export { initPanels };
