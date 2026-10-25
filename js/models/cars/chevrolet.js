// js/models/cars/chevrolet.js
// Chevrolet (GM de México, built in Ramos Arizpe, Silao & San Luis Potosí). Fields: README.md

export const CARS = [
  {
    id: 'chevrolet-aveo', name: 'Chevrolet Aveo', body: 'sedan', class: 'economy',
    size: [4.40, 1.73, 1.47], mass: 1120, drive: 'fwd', power: [72, 6000], torque: [136, 4000], redline: 6500,
    gears: 5, top: 175, rarity: 22
  },
  {
    id: 'chevrolet-onix', name: 'Chevrolet Onix', body: 'sedan', class: 'economy',
    size: [4.47, 1.73, 1.48], mass: 1130, drive: 'fwd', power: [85, 5500], torque: [180, 2000], redline: 6200,
    gears: 6, top: 190, rarity: 12
  },
  {
    id: 'chevrolet-tracker', name: 'Chevrolet Tracker', body: 'suv', class: 'economy',
    size: [4.27, 1.79, 1.63], mass: 1270, drive: 'fwd', power: [98, 5500], torque: [220, 2000], redline: 6200,
    gears: 6, top: 190, rarity: 6
  },
  {
    id: 'chevrolet-tahoe', name: 'Chevrolet Tahoe', body: 'suv', class: 'truck',
    size: [5.35, 2.06, 1.93], mass: 2580, drive: 'rwd', power: [265, 5600], torque: [519, 4100], redline: 6000,
    gears: 10, top: 180, limited: true, rarity: 1.2, paints: [0x16191e, 0x16191e, 0xf0f3f7, 0x3a434d]
  },
  {
    id: 'chevrolet-silverado', name: 'Chevrolet Silverado', body: 'pickup', class: 'truck',
    size: [5.88, 2.06, 1.92], mass: 2350, drive: 'rwd', power: [265, 5600], torque: [519, 4100], redline: 6000,
    gears: 8, top: 180, limited: true, rarity: 3
  },
  {
    id: 'chevrolet-camaro-ss', name: 'Chevrolet Camaro SS', body: 'coupe', class: 'sport',
    size: [4.78, 1.90, 1.35], mass: 1700, drive: 'rwd', power: [339, 6000], torque: [617, 4400], redline: 6500,
    gears: 10, top: 266, rarity: 0.5, paints: [0xd6a400, 0x1a1c20, 0xb3121b, 0x2a5aa8]
  },
  {
    id: 'chevrolet-corvette', name: 'Chevrolet Corvette C8', body: 'coupe', class: 'super',
    size: [4.63, 1.93, 1.23], mass: 1580, drive: 'rwd', power: [369, 6450], torque: [637, 5150], redline: 6600,
    gears: 8, top: 312, rarity: 0.1, paints: [0xc8102e, 0xe8a200, 0xf2f2ee, 0x1a1c20]
  }
];
