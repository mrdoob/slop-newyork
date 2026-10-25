// js/models/cars/toyota.js
// Toyota (built in Tijuana & Apaseo el Grande). Fields: README.md

export const CARS = [
  {
    id: 'toyota-yaris', name: 'Toyota Yaris', body: 'sedan', class: 'economy',
    size: [4.42, 1.73, 1.47], mass: 1070, drive: 'fwd', power: [79, 6000], torque: [140, 4200], redline: 6500,
    gears: 6, top: 180, rarity: 12
  },
  {
    id: 'toyota-corolla', name: 'Toyota Corolla', body: 'sedan', class: 'family',
    size: [4.63, 1.78, 1.43], mass: 1370, drive: 'fwd', power: [125, 6600], torque: [205, 4800], redline: 6800,
    gears: 6, top: 200, rarity: 10
  },
  {
    id: 'toyota-rav4', name: 'Toyota RAV4', body: 'suv', class: 'family',
    size: [4.60, 1.86, 1.69], mass: 1620, drive: 'awd', power: [152, 6600], torque: [243, 5000], redline: 6800,
    gears: 8, top: 200, rarity: 6
  },
  {
    id: 'toyota-hilux', name: 'Toyota Hilux', body: 'pickup', class: 'truck',
    size: [5.33, 1.86, 1.82], mass: 1900, drive: 'rwd', power: [122, 5200], torque: [245, 4000], redline: 5500,
    gears: 6, top: 170, rarity: 8, paints: [0xf2f2ee, 0xf2f2ee, 0xc8cdd2, 0x2a2d31, 0x6e1f24]
  },
  {
    id: 'toyota-hiace', name: 'Toyota Hiace', body: 'van', class: 'truck',
    size: [5.38, 1.88, 2.29], mass: 2150, drive: 'rwd', power: [120, 5200], torque: [241, 3800], redline: 5500,
    gears: 6, top: 160, rarity: 5, paints: [0xf4f4f0, 0xf4f4f0, 0xc8cdd2]
  },
  {
    id: 'toyota-supra', name: 'Toyota GR Supra', body: 'coupe', class: 'sport',
    size: [4.38, 1.85, 1.29], mass: 1560, drive: 'rwd', power: [285, 5800], torque: [500, 1800], redline: 7000,
    gears: 8, top: 250, limited: true, rarity: 0.25, paints: [0xc8102e, 0xe8a200, 0xf2f2ee, 0x1a1c20]
  }
];
