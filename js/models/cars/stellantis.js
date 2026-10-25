// js/models/cars/stellantis.js
// RAM, Dodge & Jeep (built in Saltillo & Toluca). Fields: README.md

export const CARS = [
  {
    id: 'ram-700', name: 'RAM 700', body: 'pickup', class: 'economy',
    size: [4.48, 1.73, 1.58], mass: 1150, drive: 'fwd', power: [73, 6250], torque: [134, 3500], redline: 6500,
    gears: 5, top: 165, rarity: 5, paints: [0xf2f2ee, 0xf2f2ee, 0xc8cdd2, 0xa31d22]
  },
  {
    id: 'ram-1500', name: 'RAM 1500', body: 'pickup', class: 'truck',
    size: [5.82, 2.08, 1.97], mass: 2400, drive: 'rwd', power: [295, 5600], torque: [556, 3950], redline: 5800,
    gears: 8, top: 180, limited: true, rarity: 2
  },
  {
    id: 'dodge-charger-pursuit', name: 'Patrulla', body: 'sedan', class: 'sport', traffic: false, // state police cruiser
    size: [5.04, 1.91, 1.48], mass: 1950, drive: 'rwd', power: [276, 5250], torque: [536, 4200], redline: 5800,
    gears: 8, top: 240, limited: true, rarity: 0
  },
  {
    id: 'dodge-challenger-hellcat', name: 'Dodge Challenger SRT Hellcat', body: 'coupe', class: 'super',
    size: [5.03, 1.92, 1.45], mass: 2000, drive: 'rwd', power: [527, 6000], torque: [881, 4800], redline: 6200,
    gears: 8, top: 320, rarity: 0.15, paints: [0x1a1c20, 0x5b2a86, 0xe06a1b, 0xb3121b]
  },
  {
    id: 'jeep-wrangler', name: 'Jeep Wrangler', body: 'suv', class: 'truck',
    size: [4.33, 1.89, 1.84], mass: 1980, drive: 'awd', power: [213, 6400], torque: [353, 4800], redline: 6600,
    gears: 8, top: 175, limited: true, rarity: 0.8, paints: [0x1a1c20, 0xf2f2ee, 0x3b5a2b, 0xb3121b]
  }
];
