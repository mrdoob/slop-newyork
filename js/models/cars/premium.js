// js/models/cars/premium.js
// German premium sedans & coupés (BMW is built in San Luis Potosí, Audi in San José Chiapa). Fields: README.md

export const CARS = [
  {
    id: 'bmw-330i', name: 'BMW 330i', body: 'sedan', class: 'premium',
    size: [4.71, 1.83, 1.44], mass: 1570, drive: 'rwd', power: [190, 5000], torque: [400, 1550], redline: 7000,
    gears: 8, top: 250, limited: true, rarity: 2, paints: [0x1a1c20, 0xf2f2ee, 0x2a3f6c, 0x7d8288]
  },
  {
    id: 'bmw-m4', name: 'BMW M4', body: 'coupe', class: 'sport',
    size: [4.80, 1.89, 1.39], mass: 1750, drive: 'rwd', power: [375, 6250], torque: [650, 2750], redline: 7200,
    gears: 8, top: 250, limited: true, rarity: 0.3, paints: [0x6aa84f, 0x1a1c20, 0x2a5aa8, 0xf2f2ee]
  },
  {
    id: 'mercedes-c200', name: 'Mercedes-Benz C 200', body: 'sedan', class: 'premium',
    size: [4.75, 1.82, 1.44], mass: 1620, drive: 'rwd', power: [150, 5800], torque: [300, 1800], redline: 6500,
    gears: 9, top: 246, limited: true, rarity: 2, paints: [0x1a1c20, 0xf2f2ee, 0x7d8288, 0x2a3f6c]
  },
  {
    id: 'audi-a3', name: 'Audi A3 Sedán', body: 'sedan', class: 'premium',
    size: [4.50, 1.82, 1.43], mass: 1370, drive: 'fwd', power: [110, 5000], torque: [250, 1500], redline: 6500,
    gears: 7, top: 230, rarity: 2, paints: [0x1a1c20, 0xf2f2ee, 0x7d8288, 0x9e1b22]
  },
  {
    id: 'mg-5', name: 'MG 5', body: 'sedan', class: 'economy',
    size: [4.68, 1.82, 1.48], mass: 1270, drive: 'fwd', power: [84, 6000], torque: [150, 4500], redline: 6400,
    gears: 5, top: 180, rarity: 8
  }
];
