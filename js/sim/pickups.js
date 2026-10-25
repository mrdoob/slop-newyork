import * as THREE from 'three/webgpu';

// js/sim/pickups.js
// Cash pickups, GTA-style: the wallet a knocked-over person drops (traffic.js reports where the body came to rest), a
// glowing wad of green bills spinning over the ground until the player walks or drives through it. A small fixed pool
// of meshes, so a pile-up never allocates.

const POOL = 16;
const LIFETIME = 90; // s a wallet lies there before somebody else picks it up
const FAR = 500; // m from the player past which it's gone
const REACH = { person: 1.5, cyclist: 2.2, car: 2.8 }; // m from the wallet's centre the player picks it up at
const HOVER = 0.45; // m over the ground

class MoneyPickups {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'MoneyPickups';
    scene.add(this.group);
    // a wad of 500-peso greens with a paper band round it, lit from inside so it shows at night and in the shade
    const wad = new THREE.BoxGeometry(0.34, 0.08, 0.17);
    const band = new THREE.BoxGeometry(0.06, 0.09, 0.18);
    const billMat = new THREE.MeshStandardNodeMaterial({ color: 0x1d7a36, emissive: 0x0fb847, emissiveIntensity: 0.55, roughness: 0.75 });
    const bandMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9cfa8, emissive: 0xd9cfa8, emissiveIntensity: 0.15, roughness: 0.8 });
    this.items = [];
    for (let i = 0; i < POOL; i++) {
      const root = new THREE.Group();
      root.add(new THREE.Mesh(wad, billMat), new THREE.Mesh(band, bandMat));
      root.scale.setScalar(1.6); // bigger than life, to be seen from a car
      root.visible = false;
      this.group.add(root);
      this.items.push({ root, active: false, x: 0, y: 0, z: 0, amount: 0, age: 0, phase: i * 1.7 });
    }
    // one stays visible (far below the town) until the first update, so the loading screen compiles its shaders
    this.items[0].root.visible = true;
    this.items[0].root.position.set(0, -200, 0);
    this.warm = true;
  }

  /** A wallet with `amount` pesos on the ground (height y) at (x, z); the oldest gives way when all are out */
  drop(x, y, z, amount) {
    let slot = this.items.find((it) => !it.active);
    if (!slot) slot = this.items.reduce((a, b) => (a.age > b.age ? a : b));
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.amount = amount;
    slot.age = 0;
    slot.root.visible = true;
    slot.root.position.set(x, y + HOVER, z);
  }

  /** Spins & bobs the wallets; returns the pesos the player in `mode` (its `entity`, null: none) picked up this frame */
  update(dt, elapsed, entity, mode) {
    if (this.warm) {
      this.warm = false;
      if (!this.items[0].active) this.items[0].root.visible = false;
    }
    const reach = entity ? REACH[mode] || 0 : 0; // (nobody picks anything up while wasted)
    const px = entity ? entity.position.x : 0;
    const py = entity ? entity.position.y : 0;
    const pz = entity ? entity.position.z : 0;
    let got = 0;
    for (const it of this.items) {
      if (!it.active) continue;
      it.age += dt;
      const d = Math.hypot(it.x - px, it.z - pz);
      if (reach && d < reach && Math.abs(it.y - py) < 3) {
        got += it.amount;
        this.clear(it);
        continue;
      }
      if (it.age > LIFETIME || (entity && d > FAR)) {
        this.clear(it);
        continue;
      }
      it.root.rotation.y = elapsed * 2.4 + it.phase;
      it.root.position.y = it.y + HOVER + Math.sin(elapsed * 3 + it.phase) * 0.08;
    }
    return got;
  }

  clear(it) {
    it.active = false;
    it.root.visible = false;
  }
}

export { MoneyPickups };
