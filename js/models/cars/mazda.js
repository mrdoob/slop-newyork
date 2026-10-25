// js/models/cars/mazda.js
// Mazda (built in Salamanca). Fields: README.md

export const CARS = [
  {
    id: 'mazda-3', name: 'Mazda 3', body: 'sedan', class: 'family',
    size: [4.66, 1.80, 1.44], mass: 1400, drive: 'fwd', power: [139, 6000], torque: [252, 4000], redline: 6500,
    gears: 6, top: 210, rarity: 6, paints: [0x9e1b22, 0x9e1b22, 0x52575e, 0xf2f2ee, 0x1c2026]
  },
  {
    id: 'mazda-cx-5', name: 'Mazda CX-5', body: 'suv', class: 'family',
    size: [4.58, 1.84, 1.68], mass: 1620, drive: 'awd', power: [140, 6000], torque: [252, 4000], redline: 6500,
    gears: 6, top: 195, rarity: 5, paints: [0x9e1b22, 0x52575e, 0xf2f2ee, 0x1c2026]
  },
  {
    id: 'mazda-mx-5', name: 'Mazda MX-5', body: 'coupe', class: 'sport',
    size: [3.92, 1.73, 1.23], mass: 1080, drive: 'rwd', power: [135, 7000], torque: [205, 4000], redline: 7500,
    gears: 6, top: 219, rarity: 0.5, paints: [0x9e1b22, 0xf2f2ee, 0x1c2026, 0x2a5aa8]
  }
];
