import { PersonCrowd, PersonRig, OUTFIT_SEED } from './pedestrians.js';

// js/sim/bystanders.js
// The people who stay put: the taqueros and their customers at the stalls (street-food.js), the crowds outside the
// antros and at the house parties dancing (nightlife.js), the diners & dancers inside (interiors.js), the onlookers
// at a fire (fires.js). One skinned crowd (pedestrians.js PersonCrowd) and a pool of rigs, each kept by the key its
// owner gives it, so a person keeps their looks and their footing from frame to frame. Every frame: begin(), then
// place() each person in view, then end(dt).

class Bystanders {
  /**
   * @param {THREE.Scene} scene
   * @param {number} max - most people drawn at once
   * @param {(x: number, z: number) => number} ground - the height they stand on
   */
  constructor(scene, max, ground, { farDistance = 30 } = {}) {
    this.crowd = new PersonCrowd(max, { farDistance });
    for (const m of this.crowd.meshes) scene.add(m);
    this.max = max;
    this.ground = (owner, x, z) => ground(x, z);
    this.rigs = new Map(); // key → { rig, seen }
    this.frame = 0;
    this.placed = [];
    this.time = 0;
  }

  begin() {
    this.frame++;
    this.placed.length = 0;
  }

  /**
   * Someone at (x, z) facing `heading`, `distance` m from the camera. `seed` dresses them (an outfit: OUTFIT_SEED x
   * its number + a seed); `dance` 0..1 has them step to the music, `sway` shifts their weight about
   */
  place(key, x, z, heading, distance, { seed = 0, dance = 0, sway = 0, female = null, scale = null } = {}) {
    if (this.placed.length >= this.max) return;
    let slot = this.rigs.get(key);
    if (!slot) {
      const r = (k) => {
        const s = Math.sin((seed + 1) * 91.7 + k * 13.3) * 43758.5453;
        return s - Math.floor(s);
      };
      const isFemale = female ?? r(1) < 0.5;
      slot = {
        rig: new PersonRig({
          seed: seed % OUTFIT_SEED === seed ? Math.floor(r(2) * 997) + 0.5 : seed,
          scale: scale ?? 0.92 + r(3) * 0.14, female: isFemale, girth: 0.92 + r(4) * 0.22,
          hair: isFemale ? 0.3 + r(5) * 0.7 : r(5) * 0.25, armSwing: 0.9 + r(6) * 0.2
        }),
        phase: r(7) * 6.28
      };
      this.rigs.set(key, slot);
    }
    slot.seen = this.frame;
    // dancing: a little step from side to side and a turn to the beat (~2 beats/s); swaying: weight shifts
    const t = this.time + slot.phase;
    const step = dance * 0.16 * Math.sin(t * 3.1) + sway * 0.05 * Math.sin(t * 0.7);
    const turn = dance * 0.35 * Math.sin(t * 1.55);
    slot.x = x + Math.cos(heading) * step;
    slot.z = z - Math.sin(heading) * step;
    slot.heading = heading + turn;
    slot.distance = distance;
    this.placed.push(slot);
  }

  end(dt) {
    this.time += dt;
    this.crowd.begin();
    for (const slot of this.placed) {
      // (the far ones keep their pose: their footing is too small to see)
      slot.rig.update(dt, slot.x, slot.z, slot.heading, this.ground, null, 0, slot.distance < 60 || !slot.rig.placed);
      this.crowd.add(slot.rig, slot.distance);
    }
    this.crowd.end();
    // forget whoever has been out of view a while
    if (this.frame % 120 === 0) {
      for (const [key, slot] of this.rigs) if (this.frame - slot.seen > 600) this.rigs.delete(key);
    }
  }
}

export { Bystanders };
