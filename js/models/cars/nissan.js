// js/models/cars/nissan.js
// Nissan, Mexico's best-selling make (built in Aguascalientes & Cuernavaca). Fields: README.md

export const CARS = [
  {
    id: 'nissan-tsuru', name: 'Nissan Tsuru', body: 'taxi', class: 'economy', traffic: false, // the classic taxi
    size: [4.32, 1.69, 1.38], mass: 1100, drive: 'fwd', power: [78, 5200], torque: [136, 4000], redline: 6500,
    gears: 5, top: 170, rarity: 0
  },
  {
    id: 'nissan-versa', name: 'Nissan Versa', body: 'sedan', class: 'economy',
    size: [4.50, 1.74, 1.47], mass: 1150, drive: 'fwd', power: [87, 6300], torque: [154, 4000], redline: 6500,
    gears: 5, top: 180, rarity: 30
  },
  {
    id: 'nissan-march', name: 'Nissan March', body: 'hatch', class: 'economy',
    size: [3.83, 1.67, 1.51], mass: 1050, drive: 'fwd', power: [79, 6000], torque: [146, 4400], redline: 6500,
    gears: 5, top: 175, rarity: 18
  },
  {
    id: 'nissan-sentra', name: 'Nissan Sentra', body: 'sedan', class: 'family',
    size: [4.64, 1.82, 1.45], mass: 1370, drive: 'fwd', power: [112, 6400], torque: [197, 4000], redline: 6800,
    gears: 6, top: 200, rarity: 10
  },
  {
    id: 'nissan-kicks', name: 'Nissan Kicks', body: 'suv', class: 'economy',
    size: [4.30, 1.76, 1.59], mass: 1200, drive: 'fwd', power: [88, 6300], torque: [149, 4000], redline: 6500,
    gears: 6, top: 175, rarity: 12
  },
  {
    id: 'nissan-x-trail', name: 'Nissan X-Trail', body: 'suv', class: 'family',
    size: [4.68, 1.84, 1.72], mass: 1640, drive: 'awd', power: [126, 6000], torque: [233, 4400], redline: 6300,
    gears: 6, top: 190, rarity: 6
  },
  {
    id: 'nissan-np300', name: 'Nissan NP300', body: 'pickup', class: 'truck',
    size: [5.25, 1.85, 1.78], mass: 1800, drive: 'rwd', power: [118, 6000], torque: [241, 4000], redline: 6000,
    gears: 5, top: 170, rarity: 14, paints: [0xf2f2ee, 0xf2f2ee, 0xc8cdd2, 0x2a2d31, 0xa31d22]
  },
  {
    id: 'nissan-urvan', name: 'Nissan Urvan', body: 'van', class: 'truck',
    size: [5.23, 1.88, 2.29], mass: 2050, drive: 'rwd', power: [109, 5600], torque: [213, 4400], redline: 6000,
    gears: 5, top: 160, rarity: 4, paints: [0xf4f4f0, 0xf4f4f0, 0xc8cdd2]
  },
  {
    id: 'nissan-gt-r', name: 'Nissan GT-R', body: 'coupe', class: 'super',
    size: [4.71, 1.90, 1.37], mass: 1780, drive: 'awd', power: [419, 6800], torque: [632, 3300], redline: 7100,
    gears: 6, top: 315, rarity: 0.1, paints: [0xd8dde2, 0x1a1c20, 0x2a5aa8, 0xc0c4c8]
  }
];
