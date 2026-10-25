// js/models/cars/ford.js
// Ford (built in Hermosillo & Cuautitlán). Fields: README.md

export const CARS = [
  {
    id: 'ford-ranger', name: 'Ford Ranger', body: 'pickup', class: 'truck',
    size: [5.37, 1.92, 1.85], mass: 2050, drive: 'rwd', power: [122, 5500], torque: [226, 4500], redline: 6000,
    gears: 6, top: 175, rarity: 5
  },
  {
    id: 'ford-lobo', name: 'Ford Lobo', body: 'pickup', class: 'truck',
    size: [5.89, 2.03, 1.96], mass: 2250, drive: 'rwd', power: [298, 5000], torque: [637, 3100], redline: 6000,
    gears: 10, top: 180, limited: true, rarity: 2
  },
  {
    id: 'ford-bronco', name: 'Ford Bronco', body: 'suv', class: 'truck',
    size: [4.81, 1.93, 1.85], mass: 2100, drive: 'awd', power: [224, 5750], torque: [441, 3000], redline: 6000,
    gears: 10, top: 180, limited: true, rarity: 0.8, paints: [0x2e6b8a, 0xe06a1b, 0x1a1c20, 0xf2f2ee]
  },
  {
    id: 'ford-mustang-gt', name: 'Ford Mustang GT', body: 'coupe', class: 'sport',
    size: [4.81, 1.92, 1.38], mass: 1750, drive: 'rwd', power: [360, 7250], torque: [556, 4600], redline: 7500,
    gears: 10, top: 250, limited: true, rarity: 0.6, paints: [0xb3121b, 0x1a1c20, 0x2a5aa8, 0xd6a400, 0xf2f2ee]
  }
];
