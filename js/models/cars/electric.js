// js/models/cars/electric.js
// Battery-electric cars: Tesla & BYD. The motor's top rpm stands for the redline; one fixed gear. Fields: README.md

export const CARS = [
  {
    id: 'byd-dolphin-mini', name: 'BYD Dolphin Mini', body: 'hatch', class: 'economy', electric: true,
    size: [3.78, 1.72, 1.58], mass: 1290, drive: 'fwd', power: [55, 4000], torque: [135, 0], redline: 12000,
    gears: 1, top: 130, limited: true, rarity: 3, paints: [0xd7e3a8, 0xf2f2ee, 0x9fc2d8, 0xe9b8c4]
  },
  {
    id: 'tesla-model-3', name: 'Tesla Model 3 Performance', body: 'fastback', class: 'sport', electric: true,
    size: [4.72, 1.85, 1.44], mass: 1900, drive: 'awd', power: [340, 6000], torque: [660, 0], redline: 18000,
    gears: 1, top: 262, limited: true, rarity: 0.5, paints: [0xf2f2ee, 0x1a1c20, 0x2a5aa8, 0xb3121b, 0x7d8288]
  },
  {
    id: 'tesla-model-y', name: 'Tesla Model Y', body: 'suv', class: 'premium', electric: true,
    size: [4.75, 1.92, 1.62], mass: 2000, drive: 'awd', power: [220, 6000], torque: [493, 0], redline: 17000,
    gears: 1, top: 217, limited: true, rarity: 0.6, paints: [0xf2f2ee, 0x1a1c20, 0x7d8288, 0x2a5aa8]
  },
  {
    id: 'tesla-cybertruck', name: 'Tesla Cybertruck', body: 'wedge', class: 'truck', electric: true,
    size: [5.68, 2.03, 1.79], mass: 3100, drive: 'awd', power: [445, 6000], torque: [1000, 0], redline: 15000,
    gears: 1, top: 180, limited: true, rarity: 0.15, paints: [0xaeb3b8]
  }
];
