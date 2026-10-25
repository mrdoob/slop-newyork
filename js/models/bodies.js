// js/models/bodies.js
// The body shapes the car models (cars/) are drawn with, besides actor-models.js's own sedan, taxi & SUV: each is
// the lofted generator's spec (see BODY_SPECS there for what every curve means) as changes to `base`. A model is
// one of these stretched to its real length, width & height, so one shape (one material, one instanced mesh in
// the traffic) serves many cars. Plain data, no three.js.
//
// Frame: metres, +z ahead (zFront > 0 > zRear), y up from the ground, curves as [z, value] points.

export const BODY_SHAPES = {
  // Compact hatchback (March, Gol, Grand i10, GTI, Dolphin Mini): short tail, steep hatch, rear wiper
  hatch: {
    base: 'sedan',
    zFront: 1.95, zRear: -1.95, wheelRadius: 0.31, wheelZ: 1.25, wheelX: 0.8,
    halfWidth: [[1.95, 0.86], [1.25, 0.875], [0, 0.88], [-1.25, 0.875], [-1.95, 0.86]],
    sill: [[1.95, 0.3], [1.1, 0.27], [-1.1, 0.27], [-1.95, 0.32]],
    shoulder: [[1.95, 0.66], [0, 0.72], [-1.95, 0.78]],
    edge: [[1.8, 0.8], [1.3, 0.86], [0.8, 0.94], [0.5, 0.96], [-1.0, 0.99], [-1.8, 0.99]],
    crown: [[1.8, 0.03], [0.85, 0.025], [0.55, 0.004], [-1.95, 0.004]],
    tumble: [[1.95, 0.1], [0.9, 0.09], [-1.95, 0.09]],
    nose: { halfWidth: [0.28, 0.68, 3], edge: [0.12, 0.79, 3], crown: [0.12, 0.01, 2], sill: [0.13, 0.33, 2], shoulder: [0.2, 0.6, 2.4] },
    tail: { halfWidth: [0.22, 0.74, 2.6], edge: [0.06, 0.98, 3], crown: [0.06, 0.0, 2], sill: [0.12, 0.36, 2], shoulder: [0.16, 0.74, 2.4] },
    cabin: {
      cowl: 0.8, roofFront: -0.05, roofRear: -1.45, deck: -1.85,
      roofY: [[-0.05, 1.48], [-0.7, 1.5], [-1.45, 1.46]], rail: [0.64, 0.62],
      inset: 0.035, bulge: 0.012, roofEdge: 0.05, roofCrown: 0.035, roofRound: 4, pillars: [-0.35, -1.15]
    },
    doors: [0.78, -0.35, -1.15], handles: [-0.18, -0.95],
    headlight: [0.55, 0.72, 0.22, 0.06], taillight: [0.6, 0.9, 0.11, 0.12],
    grille: [0.66, 0.28, 0.05], intake: [0.4, 0.42, 0.05], plates: [0.52, 0.66],
    bumperLine: [0.78, 0.6], bumpers: [[0.46, 0.03], [0.5, 0.035]],
    chrome: false, rearWiper: true
  },

  // Low sports coupé / fastback (Mustang, Camaro, Supra, M4, 911, Ferrari, Lamborghini): long bonnet, two doors
  coupe: {
    base: 'sedan',
    zFront: 2.3, zRear: -2.3, wheelRadius: 0.34, wheelZ: 1.42, wheelX: 0.85, archGap: 0.06, archFlare: 0.05,
    halfWidth: [[2.3, 0.9], [1.42, 0.95], [0, 0.93], [-1.42, 0.96], [-2.3, 0.92]],
    sill: [[2.3, 0.22], [1.2, 0.2], [-1.2, 0.2], [-2.3, 0.25]],
    shoulder: [[2.3, 0.52], [0, 0.58], [-2.3, 0.62]],
    edge: [[2.15, 0.66], [1.5, 0.72], [0.7, 0.78], [0.4, 0.8], [-1.0, 0.84], [-1.7, 0.86], [-2.15, 0.84]],
    crown: [[2.1, 0.04], [0.7, 0.03], [0.45, 0.004], [-2.3, 0.004]],
    tumble: [[2.3, 0.1], [0.7, 0.1], [-2.3, 0.08]],
    nose: { halfWidth: [0.32, 0.7, 3], edge: [0.18, 0.62, 3], crown: [0.15, 0.01, 2], sill: [0.14, 0.26, 2], shoulder: [0.22, 0.48, 2.4] },
    tail: { halfWidth: [0.26, 0.78, 2.6], edge: [0.08, 0.84, 3], crown: [0.08, 0.0, 2], sill: [0.14, 0.3, 2], shoulder: [0.18, 0.6, 2.4] },
    cabin: {
      cowl: 0.7, roofFront: -0.3, roofRear: -0.75, deck: -1.75,
      roofY: [[-0.3, 1.3], [-0.5, 1.31], [-0.75, 1.29]], rail: [0.6, 0.57],
      inset: 0.035, bulge: 0.012, roofEdge: 0.05, roofCrown: 0.03, roofRound: 4, pillars: [-0.95]
    },
    doors: [0.66, -0.75], handles: [-0.6],
    headlight: [0.6, 0.6, 0.22, 0.035], taillight: [0.58, 0.74, 0.24, 0.045],
    grille: [0.42, 0.38, 0.08], intake: [0.28, 0.5, 0.04], plates: [0.4, 0.62],
    bumperLine: [0.6, 0.5], bumpers: [[0.32, 0.025], [0.38, 0.03]],
    chrome: false
  },

  // Smooth electric fastback sedan (Tesla Model 3): short nose with no grille, long glass roof
  fastback: {
    base: 'sedan',
    zFront: 2.35, zRear: -2.35, wheelRadius: 0.34, wheelZ: 1.44, wheelX: 0.84,
    halfWidth: [[2.35, 0.88], [1.44, 0.92], [0, 0.925], [-1.44, 0.925], [-2.35, 0.9]],
    sill: [[2.35, 0.27], [1.2, 0.25], [-1.2, 0.25], [-2.35, 0.3]],
    shoulder: [[2.35, 0.56], [0, 0.66], [-2.35, 0.74]],
    edge: [[2.2, 0.7], [1.5, 0.79], [1.0, 0.88], [0.0, 0.96], [-1.6, 0.98], [-2.2, 0.95]],
    crown: [[2.2, 0.05], [1.05, 0.035], [0.95, 0.004], [-2.35, 0.004]],
    tumble: [[2.35, 0.1], [0.9, 0.1], [-2.35, 0.09]],
    nose: { halfWidth: [0.34, 0.66, 3], edge: [0.22, 0.62, 3], crown: [0.2, 0.01, 2], sill: [0.15, 0.3, 2], shoulder: [0.25, 0.5, 2.4] },
    tail: { halfWidth: [0.26, 0.76, 2.6], edge: [0.08, 0.94, 3], crown: [0.08, 0.0, 2], sill: [0.14, 0.34, 2], shoulder: [0.18, 0.66, 2.4] },
    cabin: {
      cowl: 1.0, roofFront: 0.15, roofRear: -0.9, deck: -1.85,
      roofY: [[0.15, 1.42], [-0.35, 1.44], [-0.9, 1.41]], rail: [0.66, 0.62],
      inset: 0.035, bulge: 0.012, roofEdge: 0.05, roofCrown: 0.035, roofRound: 4, pillars: [-0.3]
    },
    doors: [0.95, -0.3, -1.15], handles: [-0.15, -0.95],
    headlight: [0.62, 0.66, 0.2, 0.035], taillight: [0.6, 0.86, 0.25, 0.045],
    grille: [0.5, 0.001, 0.001], intake: [0.32, 0.45, 0.04], plates: [0.42, 0.68],
    bumperLine: [0.66, 0.6], bumpers: [[0.36, 0.02], [0.45, 0.02]],
    chrome: false
  },

  // Pickup (NP300, Hilux, Ranger, Lobo, Silverado, RAM): tall cab, bed behind it under a tonneau cover
  pickup: {
    base: 'suv',
    zFront: 2.7, zRear: -2.7, wheelRadius: 0.4, wheelZ: 1.62, wheelX: 0.86, archGap: 0.08, archFlare: 0.04, tuck: 0.06,
    halfWidth: [[2.7, 0.92], [1.62, 0.96], [0, 0.96], [-1.62, 0.96], [-2.7, 0.95]],
    sill: [[2.7, 0.48], [1.4, 0.45], [-1.4, 0.45], [-2.7, 0.55]],
    shoulder: [[2.7, 0.85], [0, 0.9], [-2.7, 0.95]],
    edge: [[2.55, 1.1], [1.8, 1.16], [1.1, 1.2], [0.8, 1.22], [-0.8, 1.24], [-2.6, 1.24]],
    crown: [[2.5, 0.04], [1.0, 0.03], [0.8, 0.004], [-2.7, 0.004]],
    tumble: [[2.7, 0.08], [-2.7, 0.07]],
    nose: { halfWidth: [0.2, 0.8, 3], edge: [0.1, 1.06, 3], crown: [0.1, 0.01, 2], sill: [0.1, 0.5, 2], shoulder: [0.15, 0.8, 2.4] },
    tail: { halfWidth: [0.12, 0.86, 3], edge: [0.05, 1.22, 3], crown: [0.05, 0, 2], sill: [0.1, 0.56, 2], shoulder: [0.1, 0.92, 2.4] },
    cabin: {
      cowl: 0.95, roofFront: 0.25, roofRear: -0.75, deck: -0.85,
      roofY: [[0.25, 1.86], [-0.25, 1.88], [-0.75, 1.87]], rail: [0.76, 0.76],
      inset: 0.035, bulge: 0.01, roofEdge: 0.05, roofCrown: 0.025, roofRound: 5, pillars: [-0.25]
    },
    doors: [0.9, -0.25, -0.8], handles: [0.0, -0.6],
    headlight: [0.66, 1.0, 0.2, 0.07], taillight: [0.86, 1.0, 0.07, 0.16],
    grille: [0.92, 0.5, 0.14], intake: [0.58, 0.45, 0.04], plates: [0.66, 0.8],
    bumperLine: [1.06, 0.72], bumpers: [[0.62, 0.06], [0.64, 0.06]],
    cladding: 0.55, chrome: false, rails: false, rearWiper: false
  },

  // Passenger van (Hiace, Urvan): short nose, tall box, long row of windows
  van: {
    base: 'suv',
    zFront: 2.65, zRear: -2.65, wheelRadius: 0.34, wheelZ: 1.6, wheelX: 0.82, archGap: 0.07,
    halfWidth: [[2.65, 0.9], [1.6, 0.94], [0, 0.94], [-1.6, 0.94], [-2.65, 0.93]],
    sill: [[2.65, 0.42], [1.4, 0.4], [-1.4, 0.4], [-2.65, 0.45]],
    shoulder: [[2.65, 0.85], [0, 0.9], [-2.65, 0.92]],
    edge: [[2.5, 1.05], [2.2, 1.12], [1.9, 1.16], [-2.5, 1.2]],
    crown: [[2.5, 0.03], [2.0, 0.004], [-2.65, 0.004]],
    tumble: [[2.65, 0.07], [-2.65, 0.07]],
    nose: { halfWidth: [0.22, 0.8, 3], edge: [0.12, 1.0, 3], crown: [0.1, 0.01, 2], sill: [0.1, 0.45, 2], shoulder: [0.15, 0.82, 2.4] },
    tail: { halfWidth: [0.1, 0.86, 3], edge: [0.05, 1.2, 3], crown: [0.05, 0, 2], sill: [0.08, 0.48, 2], shoulder: [0.08, 0.9, 2.4] },
    cabin: {
      cowl: 2.0, roofFront: 1.25, roofRear: -2.4, deck: -2.58,
      roofY: [[1.25, 2.22], [-0.5, 2.26], [-2.4, 2.24]], rail: [0.82, 0.82],
      inset: 0.03, bulge: 0.008, roofEdge: 0.06, roofCrown: 0.03, roofRound: 6, pillars: [0.75, -0.2, -1.3]
    },
    doors: [1.95, 0.8, -0.3], handles: [1.6, 0.2],
    headlight: [0.62, 0.96, 0.2, 0.07], taillight: [0.84, 1.2, 0.06, 0.2],
    grille: [0.88, 0.42, 0.1], intake: [0.55, 0.45, 0.04], plates: [0.6, 0.75],
    bumperLine: [1.0, 0.65], bumpers: [[0.55, 0.05], [0.55, 0.05]],
    cladding: 0, chrome: false, rails: false, rearWiper: true
  },

  // The Cybertruck's stainless wedge: flat panels, sharp edges, a light bar across each end, the roof peaking over the
  // front seats and the vault cover sloping straight down to the tail (glass only over the cabin)
  wedge: {
    base: 'suv',
    zFront: 2.85, zRear: -2.85, wheelRadius: 0.44, wheelZ: 1.85, wheelX: 0.88, archGap: 0.06, archFlare: 0, tuck: 0.02,
    lowerRound: 8, upperRound: 10,
    halfWidth: [[2.85, 0.98], [1.85, 1.0], [0, 1.0], [-1.85, 1.0], [-2.85, 0.99]],
    sill: [[2.85, 0.62], [1.6, 0.5], [-1.6, 0.5], [-2.85, 0.62]],
    shoulder: [[2.85, 0.9], [0, 0.98], [-2.85, 0.98]],
    edge: [[2.75, 1.0], [2.0, 1.1], [1.3, 1.2], [0, 1.22], [-2.75, 1.2]],
    crown: [[2.8, 0.01], [-2.8, 0.01]],
    tumble: [[2.85, 0.06], [-2.85, 0.06]],
    nose: { halfWidth: [0.08, 0.94, 6], edge: [0.06, 0.98, 6], crown: [0.05, 0.005, 2], sill: [0.08, 0.62, 2], shoulder: [0.06, 0.9, 2] },
    tail: { halfWidth: [0.06, 0.96, 6], edge: [0.05, 1.18, 6], crown: [0.05, 0, 2], sill: [0.06, 0.62, 2], shoulder: [0.05, 0.96, 2] },
    cabin: {
      cowl: 1.3, roofFront: -0.15, roofRear: -0.3, deck: -2.8,
      roofY: [[-0.15, 1.79], [-0.22, 1.8], [-0.3, 1.79]], rail: [0.8, 0.8],
      inset: 0.02, bulge: 0, roofEdge: 0.02, roofCrown: 0.01, roofRound: 12, pillars: [-0.75],
      glassEnd: -1.1 // side windows & backlight stop here; the vault cover behind is painted
    },
    doors: [1.2, -0.15, -1.3], handles: [],
    headlight: [0.5, 1.0, 0.5, 0.012], taillight: [0.5, 1.16, 0.5, 0.018],
    grille: [0.8, 0.001, 0.001], intake: [0.66, 0.6, 0.03], plates: [0.75, 0.85],
    bumperLine: [0.9, 0.75], bumpers: [[0.7, 0.01], [0.7, 0.01]],
    cladding: 0, chrome: false, rails: false, rearWiper: false
  }
};
