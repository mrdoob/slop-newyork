// js/ui/crime-hud.js
// The crime HUD (crime.js's state): wanted stars, health, stamina (player/stats.js) & armour bars, money, the weapon in hand and its rounds,
// short messages, the red edges of getting hurt and the WASTED / BUSTED screen. Safe DOM APIs only; the text and
// bars change only when their values do.

const TOAST_TIME = 2.6; // s a message stays

class CrimeHud {
  constructor(doc = document) {
    this.el = {
      root: doc.getElementById('hud-crime'),
      stars: [...doc.querySelectorAll('#hud-wanted .wanted-star')],
      wanted: doc.getElementById('hud-wanted'),
      health: doc.getElementById('hud-health'),
      armor: doc.getElementById('hud-armor'),
      armorRow: doc.getElementById('hud-armor-row'),
      stamina: doc.getElementById('hud-stamina'),
      staminaRow: doc.getElementById('hud-stamina-row'),
      money: doc.getElementById('hud-money'),
      weapon: doc.getElementById('hud-weapon-name'),
      ammo: doc.getElementById('hud-ammo'),
      toast: doc.getElementById('hud-toast'),
      banner: doc.getElementById('hud-banner'),
      vignette: doc.getElementById('hud-hurt')
    };
    this.shown = {};
    this.toastTime = 0;
    this.money = null; // the money shown, counting towards the real figure
  }

  set(key, value, apply) {
    if (this.shown[key] === value) return;
    this.shown[key] = value;
    apply(value);
  }

  update(crime, dt, stamina = null) {
    const el = this.el;
    if (!el.root) return;
    // wanted stars: lit up to the level, the next to go flashing while the police have lost sight of the player
    const stars = crime.wanted.stars;
    const evading = crime.wanted.evading > 0.05 && stars > 0;
    this.set('stars', stars, (n) => {
      el.stars.forEach((s, i) => s.classList.toggle('is-lit', i < n));
      el.wanted.classList.toggle('is-wanted', n > 0);
      el.wanted.setAttribute('aria-label', `Wanted level: ${n} of 5`);
    });
    this.set('evading', evading, (on) => el.wanted.classList.toggle('is-evading', on));

    this.set('health', Math.ceil(crime.health), (h) => {
      el.health.style.transform = `scaleX(${Math.max(0, h) / 100})`;
      el.health.parentElement.classList.toggle('is-low', h <= 25);
    });
    // stamina only while it isn't full
    if (stamina && el.stamina) {
      this.set('stamina', Math.round(stamina.value), (v) => {
        el.stamina.style.transform = `scaleX(${v / 100})`;
        el.staminaRow.hidden = v >= 100;
      });
      this.set('winded', stamina.winded, (on) => el.staminaRow.classList.toggle('is-winded', on));
    }
    this.set('armor', Math.ceil(crime.armor), (a) => {
      el.armor.style.transform = `scaleX(${a / 100})`;
      el.armorRow.hidden = a <= 0;
    });

    // money rolls towards its new value
    if (this.money === null) this.money = crime.money;
    const diff = crime.money - this.money;
    this.money = Math.abs(diff) < 1 ? crime.money : this.money + diff * Math.min(1, dt * 8);
    this.set('money', Math.round(this.money), (m) => {
      el.money.textContent = `$${Math.max(0, m).toLocaleString('en-US')}`;
    });

    const w = crime.arsenal.weapon;
    this.set('weapon', w.label, (label) => { el.weapon.textContent = label; });
    const rounds = crime.arsenal.ammo[w.id];
    this.set('ammo', rounds, (n) => { el.ammo.textContent = n === Infinity ? '' : String(n); });

    // messages, one at a time
    this.toastTime -= dt;
    if (this.toastTime <= 0 && crime.toasts.length) {
      el.toast.textContent = crime.toasts.shift();
      el.toast.hidden = false;
      el.toast.classList.remove('is-in');
      void el.toast.offsetWidth; // (restart its animation)
      el.toast.classList.add('is-in');
      this.toastTime = TOAST_TIME;
    } else if (this.toastTime <= 0 && !el.toast.hidden) {
      el.toast.hidden = true;
    }

    this.set('banner', crime.state, (state) => {
      el.banner.hidden = state === 'play';
      el.banner.textContent = state === 'wasted' ? 'Wasted' : state === 'busted' ? 'Busted' : '';
      el.banner.classList.toggle('is-busted', state === 'busted');
      document.body.classList.toggle('is-down', state !== 'play');
    });
    this.set('hurt', Math.round(crime.hurtFlash * 20) / 20, (k) => { el.vignette.style.opacity = String(Math.min(0.85, k)); });
  }
}

export { CrimeHud };
