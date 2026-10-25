// js/ui/weapon-wheel.js
// The weapon wheel, GTA-style: hold Tab (or tap the weapon on the HUD) and the arsenal (sim/weapons.js) opens round the
// middle of the screen, one slot per weapon with its rounds left. Move the mouse towards one (or point at it) and let
// go of Tab, or click it, to take it in hand; Esc closes it as it was. The game runs slowed while it is open (main.js
// scales the frame by timeScale). Safe DOM APIs only; the slots' text changes only when the rounds do.

import { WEAPONS, WEAPON_ORDER } from '../sim/weapons.js';

const SVG = 'http://www.w3.org/2000/svg';
const SLOW = 0.25; // the game's speed while the wheel is open
const PICK_RADIUS = 28; // px the mouse moves from where the wheel opened before it picks a slot
const PULL_MAX = 140; // px: how far that pull is remembered (a turn the other way picks again at once)
const HINT = { fists: '1', pistol: '2', smg: '3', rifle: '3', bazooka: '4' }; // (crime.js's keys)

class WeaponWheel {
  /**
   * @param {object} crime - the CrimeSystem (sim/crime.js): its arsenal, selectWeapon() and state
   * @param {object} o - aim (player/aim.js, optional: let go of the pointer while choosing), doc
   */
  constructor(crime, { aim = null, doc = document } = {}) {
    this.crime = crime;
    this.aim = aim;
    this.doc = doc;
    this.root = doc.getElementById('weapon-wheel');
    this.isOpen = false;
    this.highlight = null; // weapon id the wheel points at
    this.pullX = 0;
    this.pullY = 0;
    this.byKey = false; // opened with Tab (closes when it comes up) rather than a tap
    this.slots = new Map();
    this.shown = new Map();
    if (!this.root) return;
    this.build();
    this.bind();
  }

  get timeScale() {
    return this.isOpen ? SLOW : 1;
  }

  build() {
    const doc = this.doc;
    const ring = doc.createElement('div');
    ring.className = 'wheel-ring';
    const n = WEAPON_ORDER.length;
    WEAPON_ORDER.forEach((id, i) => {
      const w = WEAPONS[id];
      const slot = doc.createElement('button');
      slot.type = 'button';
      slot.className = 'wheel-slot';
      slot.dataset.weapon = id;
      // clockwise from the top
      slot.style.setProperty('--a', `${(i / n) * 360}deg`);
      const icon = doc.createElementNS(SVG, 'svg');
      icon.setAttribute('class', 'wheel-icon');
      icon.setAttribute('aria-hidden', 'true');
      const use = doc.createElementNS(SVG, 'use');
      use.setAttribute('href', `#w-${id}`);
      icon.appendChild(use);
      const label = doc.createElement('span');
      label.className = 'wheel-label';
      label.textContent = w.label;
      const ammo = doc.createElement('span');
      ammo.className = 'wheel-ammo';
      const key = doc.createElement('span');
      key.className = 'wheel-key';
      key.textContent = HINT[id] || '';
      slot.append(icon, label, ammo, key);
      slot.addEventListener('pointerenter', () => this.point(id));
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.point(id);
        this.close(true);
      });
      ring.appendChild(slot);
      this.slots.set(id, { slot, ammo });
    });
    const centre = doc.createElement('div');
    centre.className = 'wheel-centre';
    this.centreName = doc.createElement('div');
    this.centreName.className = 'wheel-centre-name';
    this.centreAmmo = doc.createElement('div');
    this.centreAmmo.className = 'wheel-centre-ammo';
    centre.append(this.centreName, this.centreAmmo);
    ring.appendChild(centre);
    this.root.appendChild(ring);
    // a tap outside the slots closes it as it was
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close(false);
    });
  }

  bind() {
    const doc = this.doc;
    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Tab') {
        e.preventDefault(); // (not the browser's focus hopping)
        if (!e.repeat && !this.isOpen) this.open(true);
      } else if (e.code === 'Escape' && this.isOpen) {
        this.close(false);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab' && this.isOpen && this.byKey) this.close(true);
    });
    window.addEventListener('blur', () => {
      if (this.isOpen) this.close(false);
    });
    // the mouse's pull from where it was when the wheel opened points at a slot (it works the same with the pointer
    // locked or free)
    doc.addEventListener('mousemove', (e) => {
      if (!this.isOpen) return;
      this.pullX += e.movementX || 0;
      this.pullY += e.movementY || 0;
      const d = Math.hypot(this.pullX, this.pullY);
      if (d > PULL_MAX) {
        this.pullX *= PULL_MAX / d;
        this.pullY *= PULL_MAX / d;
      }
      if (d < PICK_RADIUS) return;
      const n = WEAPON_ORDER.length;
      // (0 at the top, clockwise; screen y runs down)
      const turn = (Math.atan2(this.pullX, -this.pullY) / (Math.PI * 2) + 1) % 1;
      this.point(WEAPON_ORDER[Math.round(turn * n) % n]);
    });
    // the weapon on the HUD opens it too (a tap on a phone)
    doc.getElementById('hud-weapon')?.addEventListener('click', () => {
      if (this.isOpen) this.close(false);
      else this.open(false);
    });
  }

  open(byKey) {
    if (!this.root || this.isOpen || this.crime.state !== 'play') return;
    this.isOpen = true;
    this.byKey = byKey;
    this.pullX = 0;
    this.pullY = 0;
    // (choosing needs the cursor: an aim lets go of it)
    if (this.aim) this.aim.release();
    if (this.doc.pointerLockElement) this.doc.exitPointerLock?.();
    this.highlight = null;
    this.point(this.crime.arsenal.current);
    this.refresh();
    this.root.hidden = false;
    this.root.classList.add('is-open');
    this.doc.body?.classList.add('is-choosing-weapon');
  }

  // Closed, taking the weapon it points at in hand (`take`), or as it was
  close(take) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
    this.doc.body?.classList.remove('is-choosing-weapon');
    const id = this.highlight;
    if (take && id && id !== this.crime.arsenal.current) this.crime.selectWeapon(id);
  }

  point(id) {
    if (!this.crime.arsenal.has(id)) return; // (an empty slot can't be chosen)
    if (this.highlight === id) return;
    this.highlight = id;
    for (const [key, s] of this.slots) s.slot.classList.toggle('is-pointed', key === id);
    const w = WEAPONS[id];
    this.centreName.textContent = w.label;
    const rounds = this.crime.arsenal.ammo[id];
    this.centreAmmo.textContent = rounds === Infinity ? '' : `${rounds} rounds`;
  }

  // The slots' rounds and which are empty or in hand
  refresh() {
    const arsenal = this.crime.arsenal;
    for (const [id, s] of this.slots) {
      const rounds = arsenal.ammo[id];
      const text = rounds === Infinity ? '' : String(rounds);
      if (this.shown.get(id) !== text) {
        this.shown.set(id, text);
        s.ammo.textContent = text;
      }
      s.slot.classList.toggle('is-empty', !arsenal.has(id));
      s.slot.classList.toggle('is-current', id === arsenal.current);
      s.slot.disabled = !arsenal.has(id);
    }
  }

  // Every frame: kept up with the rounds while open, and shut when the player goes down
  update() {
    if (!this.isOpen) return;
    if (this.crime.state !== 'play') {
      this.close(false);
      return;
    }
    this.refresh();
  }
}

function isTyping(e) {
  const t = e.target;
  return Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')));
}

export { WeaponWheel };
