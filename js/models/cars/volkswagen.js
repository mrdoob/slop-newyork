// js/models/cars/volkswagen.js
// Volkswagen (built in Puebla). Fields: README.md

export const CARS = [
  {
    id: 'volkswagen-vento', name: 'Volkswagen Vento', body: 'sedan', class: 'economy',
    size: [4.39, 1.70, 1.47], mass: 1170, drive: 'fwd', power: [81, 5250], torque: [155, 3800], redline: 6200,
    gears: 5, top: 185, rarity: 14
  },
  {
    id: 'volkswagen-jetta', name: 'Volkswagen Jetta', body: 'sedan', class: 'family',
    size: [4.70, 1.80, 1.46], mass: 1370, drive: 'fwd', power: [110, 5000], torque: [250, 1750], redline: 6500,
    gears: 8, top: 210, rarity: 10
  },
  {
    id: 'volkswagen-gol', name: 'Volkswagen Gol', body: 'hatch', class: 'economy',
    size: [3.89, 1.66, 1.46], mass: 1000, drive: 'fwd', power: [74, 5250], torque: [155, 4000], redline: 6200,
    gears: 5, top: 180, rarity: 14
  },
  {
    id: 'volkswagen-tiguan', name: 'Volkswagen Tiguan', body: 'suv', class: 'family',
    size: [4.70, 1.84, 1.67], mass: 1620, drive: 'fwd', power: [110, 5000], torque: [250, 1500], redline: 6500,
    gears: 6, top: 195, rarity: 4
  },
  {
    id: 'volkswagen-golf-gti', name: 'Volkswagen Golf GTI', body: 'hatch', class: 'sport',
    size: [4.28, 1.79, 1.44], mass: 1450, drive: 'fwd', power: [180, 5000], torque: [370, 1600], redline: 6700,
    gears: 7, top: 250, limited: true, rarity: 0.8, paints: [0xc8102e, 0xf2f2ee, 0x1a1c20, 0x52575e]
  }
];
