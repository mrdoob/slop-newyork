// js/models/motos/index.js
// Motorcycles, with the same fields as the car models (../cars/README.md; body 'moto', mass with its rider). Italika,
// Mexico's best-selling make, is what most of Tepic rides; the player's moto is the FT150 parked near the start.

const MOTO_MODELS = [
  {
    id: 'italika-ft150', name: 'Italika FT150', body: 'moto', class: 'moto',
    size: [1.98, 0.76, 1.08], mass: 195, drive: 'rwd', power: [8.2, 8000], torque: [11.2, 6000], redline: 9500,
    gears: 5, top: 105, rarity: 0, paints: [0xb3121b, 0x1a1c20, 0x2a5aa8]
  },
  {
    id: 'italika-250z', name: 'Italika 250Z', body: 'moto', class: 'moto',
    size: [2.05, 0.8, 1.12], mass: 230, drive: 'rwd', power: [12.7, 8000], torque: [17, 6500], redline: 9500,
    gears: 5, top: 125, rarity: 0, paints: [0x1a1c20, 0xb3121b, 0xf2f2ee]
  },
  {
    id: 'italika-vort-x-300r', name: 'Italika Vort-X 300R', body: 'moto', class: 'moto',
    size: [2.02, 0.74, 1.1], mass: 215, drive: 'rwd', power: [21.3, 9000], torque: [25, 7000], redline: 10500,
    gears: 6, top: 150, rarity: 0, paints: [0x1a1c20, 0x2a5aa8, 0xe06a1b]
  }
];
const MOTO_MODEL_BY_ID = Object.fromEntries(MOTO_MODELS.map((m) => [m.id, m]));
const PLAYER_MOTO = MOTO_MODEL_BY_ID['italika-ft150'];

export { MOTO_MODELS, MOTO_MODEL_BY_ID, PLAYER_MOTO };
