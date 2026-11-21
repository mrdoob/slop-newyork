import * as THREE from 'three/webgpu';
import { cityUniforms } from './tsl-materials.js';
import {
  Fn,
  If,
  float,
  vec2,
  vec3,
  vec4,
  color,
  attribute,
  varying,
  vertexStage,
  sin,
  cos,
  atan,
  pow,
  dot,
  abs,
  fract,
  floor,
  min,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  length,
  sqrt,
  fwidth,
  dFdx,
  dFdy,
  cross,
  normalize,
  select,
  normalView,
  positionView,
  positionViewDirection,
  uniform,
  texture,
  time,
  instanceIndex
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';
import { part, mirrorSection, roundedRectShape, roundedBox } from './vehicles.js';

// Car geometry and materials, lofted with LoftGeometry and adapted from Three.js CarGenerator. The bus (bus.js) lofts
// its body with the same machinery; the pieces every vehicle uses are in vehicles.js.

// Car bodies are lofted from ~45 cross-sections generated along the car out of a few smooth side- & plan-view curves
// (monotone cubic splines) plus elliptical roundings into the nose and tail: rounded plan-view corners, a hood that
// rolls down into the fascia, a tucked-in sill, crowned hood & deck, fender flares and circular wheel arches. A second,
// open loft sits on the belt line as the glasshouse (raked windshield & backlight, tumblehome side glass, crowned roof
// with rounded rails). All the detail (glass, seals, pillars, lamps, grilles, plates, door seams, NYPD & taxi liveries,
// brake lights & turn signals) is painted by one TSL material from object-space position & normal, so each body type
// stays a single instanced draw call.
const CAR_PARTS = {
  BODY: 0,
  WINDOW: 1,
  TYRE: 2,
  ALLOY: 3,
  TRIM: 4,
  MIRROR: 5,
  SIGN: 6,
  FRONT: 7,
  REAR: 8
};

// Design tables. Curves are [z, value] control points (z = +front); nose / tail entries are [length, tip value,
// superellipse exponent] roundings of the same quantities into the tips.
const BODY_SPECS = {
  sedan: {
    name: 'sedan',
    zFront: 2.22,
    zRear: -2.28,
    wheelRadius: 0.35,
    wheelZ: 1.4,
    wheelX: 0.8,
    archGap: 0.036, // wheel arch radius = wheelRadius + archGap
    archFlare: 0.022, // extra half-width over the wheels
    tuck: 0.07, // sill tucked in from the widest point
    halfWidth: [[2.22, 0.9], [1.4, 0.918], [0, 0.926], [-1.4, 0.922], [-2.28, 0.908]],
    sill: [[2.22, 0.265], [1.2, 0.245], [-1.2, 0.245], [-2.28, 0.285]],
    shoulder: [[2.22, 0.68], [1.75, 0.76], [1.4, 0.772], [0, 0.782], [-1.4, 0.795], [-2.28, 0.77]],
    edge: [[2.08, 0.81], [1.55, 0.865], [0.82, 0.948], [0.3, 0.97], [-0.4, 0.985], [-1.2, 1.0], [-1.58, 0.995], [-1.88, 0.968], [-2.12, 0.94]],
    crown: [[2.1, 0.04], [0.95, 0.035], [0.68, 0.004], [-1.66, 0.004], [-1.92, 0.018], [-2.28, 0.014]],
    tumble: [[2.22, 0.12], [0.9, 0.1], [-1.6, 0.1], [-2.28, 0.115]],
    nose: { halfWidth: [0.32, 0.68, 2.8], edge: [0.14, 0.74, 2.6], crown: [0.14, 0.012, 2], sill: [0.16, 0.31, 2], shoulder: [0.22, 0.62, 2.6] },
    tail: { halfWidth: [0.3, 0.72, 2.8], edge: [0.1, 0.91, 3], crown: [0.1, 0.008, 2], sill: [0.16, 0.36, 2], shoulder: [0.22, 0.7, 2.6] },
    noseRake: { length: 0.55, y: [[0.25, 0.045], [0.36, 0], [0.54, 0], [0.68, 0.03], [0.78, 0.1], [0.86, 0.14]], plan: 0.085 },
    tailRake: { length: 0.42, y: [[0.27, 0.075], [0.44, 0], [0.56, 0], [0.62, 0.012], [0.76, 0.015], [0.94, 0.03]], plan: 0.065 },
    cabin: {
      cowl: 0.82,
      roofFront: -0.02,
      roofRear: -1.12,
      deck: -1.86,
      roofY: [[-0.02, 1.41], [-0.55, 1.445], [-1.12, 1.405]],
      rail: [0.62, 0.595], // roof rail half-width at the front & rear of the roof
      inset: 0.03, // side glass base inset from the body's top edge
      bulge: 0.014, // side glass outward curvature
      roofEdge: 0.05, // roof rail rounding height
      roofCrown: 0.035,
      roofRound: 4,
      pillars: [-0.36], // B (and C) pillar centres
      glassEnd: -1.56 // where the side glass ends on the belt, ahead of the deck: the C-pillar's base
    },
    doors: [0.79, -0.36, -0.98], // door shut lines
    handles: [-0.2, -0.86],
    headlight: [0.6, 0.68, 0.24, 0.048], // centre |x|, y, half-width, half-height
    taillight: [0.6, 0.815, 0.265, 0.052],
    grille: [0.66, 0.3, 0.042], // upper grille between the headlights: y, half-width, half-height
    intake: [0.4, 0.55, 0.072], // lower grille
    plates: [0.46, 0.665], // front / rear plate centre heights
    bumperLine: [0.75, 0.555], // hood / bumper and trunk / bumper shut lines on the nose & tail
    bumpers: [[0.44, 0.03], [0.48, 0.03]], // front / rear bumper reference lines: centre height, half-height
    chrome: true, // chrome strip along the side windows' sills
    cladding: 0, // height of the unpainted lower body cladding (SUVs)
    sign: false,
    rails: false,
    rearWiper: false,
    // Seat rows (seat-back z, front first) seen through the glass, see cabinInterior()
    interior: { seats: [-0.52, -1.26] }
  },
  suv: {
    name: 'suv',
    zFront: 2.32,
    zRear: -2.35,
    wheelRadius: 0.38,
    wheelZ: 1.45,
    wheelX: 0.845,
    archGap: 0.05,
    archFlare: 0.032,
    tuck: 0.065,
    halfWidth: [[2.32, 0.935], [1.45, 0.964], [0, 0.97], [-1.45, 0.966], [-2.35, 0.945]],
    sill: [[2.32, 0.38], [1.2, 0.335], [-1.2, 0.335], [-2.35, 0.415]],
    shoulder: [[2.32, 0.81], [1.75, 0.885], [1.45, 0.9], [0, 0.925], [-1.45, 0.955], [-2.35, 0.94]],
    edge: [[2.16, 0.985], [1.65, 1.068], [1.1, 1.098], [0.82, 1.105], [0, 1.125], [-0.95, 1.15], [-1.55, 1.185], [-1.9, 1.2], [-2.2, 1.195], [-2.35, 1.17]],
    crown: [[2.16, 0.048], [0.95, 0.042], [0.68, 0.004], [-2.35, 0.004]],
    tumble: [[2.32, 0.125], [0.9, 0.105], [-1.6, 0.11], [-2.35, 0.125]],
    nose: { halfWidth: [0.34, 0.72, 2.8], edge: [0.14, 0.91, 2.6], crown: [0.14, 0.015, 2], sill: [0.16, 0.43, 2], shoulder: [0.22, 0.7, 2.6] },
    tail: { halfWidth: [0.28, 0.76, 2.8], edge: [0.06, 1.15, 3], crown: [0.06, 0.004, 2], sill: [0.16, 0.46, 2], shoulder: [0.2, 0.86, 2.6] },
    noseRake: { length: 0.62, y: [[0.35, 0.085], [0.5, 0], [0.76, 0.012], [0.92, 0.075], [1.04, 0.145]], plan: 0.075 },
    tailRake: { length: 0.42, y: [[0.38, 0.085], [0.54, 0], [0.66, 0], [0.76, 0.02], [1.02, 0.028], [1.19, 0.035]], plan: 0.045 },
    cabin: {
      cowl: 0.82,
      roofFront: -0.22,
      roofRear: -1.7,
      deck: -2.2,
      roofY: [[-0.22, 1.71], [-0.85, 1.735], [-1.7, 1.67]],
      rail: [0.665, 0.635],
      inset: 0.035,
      bulge: 0.014,
      roofEdge: 0.055,
      roofCrown: 0.032,
      roofRound: 4,
      pillars: [-0.38, -1.2],
      glassEnd: -1.9
    },
    doors: [0.78, -0.38, -1.04],
    handles: [-0.2, -0.92],
    headlight: [0.63, 0.875, 0.245, 0.05],
    taillight: [0.65, 0.98, 0.25, 0.058],
    grille: [0.835, 0.375, 0.105],
    intake: [0.49, 0.48, 0.058],
    plates: [0.58, 0.82],
    bumperLine: [0.94, 0.66],
    bumpers: [[0.54, 0.04], [0.56, 0.04]],
    chrome: false,
    cladding: 0.46,
    sign: false,
    rails: true,
    rearWiper: true,
    interior: { seats: [-0.55, -1.4] },
    privacyGlass: true // tinted glass behind the B-pillar
  }
};
BODY_SPECS.taxi = Object.assign({}, BODY_SPECS.sedan, { name: 'taxi', sign: true });
BODY_SPECS.pickup = {
  name: 'pickup',
  zFront: 2.74,
  zRear: -2.94,
  wheelRadius: 0.435,
  wheelZ: 1.92,
  wheelX: 0.91,
  archGap: 0.058,
  archPower: 3.2,
  archFlare: 0.042,
  tuck: 0.065,
  upperRound: 4.6,
  stationStep: 0.46,
  proxyStep: 1.3,
  halfWidth: [[2.74, 0.99], [1.92, 1.02], [0, 1.025], [-1.92, 1.02], [-2.94, 1.0]],
  sill: [[2.74, 0.51], [1.4, 0.48], [-1.4, 0.48], [-2.94, 0.52]],
  shoulder: [[2.74, 1.12], [2.15, 1.18], [1.92, 1.19], [0, 1.195], [-1.92, 1.195], [-2.94, 1.18]],
  edge: [[2.62, 1.25], [2.15, 1.29], [1.4, 1.305], [1.14, 1.31], [0.1, 1.31], [-0.96, 1.315], [-1.92, 1.315], [-2.82, 1.305]],
  crown: [[2.62, 0.042], [1.35, 0.038], [1.02, 0.005], [-2.94, 0.004]],
  tumble: [[2.74, 0.1], [1.14, 0.085], [-0.96, 0.085], [-2.94, 0.09]],
  nose: { halfWidth: [0.28, 0.82, 3.2], edge: [0.12, 1.22, 3.2], crown: [0.12, 0.015, 2], sill: [0.18, 0.55, 2.2], shoulder: [0.18, 1.04, 2.8] },
  tail: { halfWidth: [0.22, 0.86, 3.2], edge: [0.06, 1.28, 3], crown: [0.06, 0.004, 2], sill: [0.18, 0.56, 2.2], shoulder: [0.16, 1.1, 2.8] },
  noseRake: { length: 0.34, y: [[0.5, 0.045], [0.62, 0], [1.18, 0], [1.26, 0.018], [1.34, 0.045]], plan: 0.038 },
  tailRake: { length: 0.3, y: [[0.52, 0.055], [0.64, 0], [0.8, 0], [0.9, 0.018], [1.3, 0.022]], plan: 0.03 },
  cabin: {
    cowl: 1.14,
    roofFront: 0.34,
    roofRear: -0.68,
    deck: -0.96,
    roofY: [[0.34, 1.965], [-0.16, 1.99], [-0.68, 1.975]],
    rail: [0.75, 0.74],
    inset: 0.035,
    bulge: 0.012,
    roofEdge: 0.055,
    roofCrown: 0.028,
    roofRound: 4.5,
    pillars: [0.1],
    glassEnd: -0.78
  },
  doors: [1.06, 0.1, -0.78],
  handles: [0.26, -0.58],
  headlight: [0.73, 1.09, 0.21, 0.11],
  taillight: [0.8, 1.1, 0.16, 0.14],
  grille: [0.99, 0.48, 0.235],
  intake: [0.61, 0.52, 0.065],
  plates: [0.66, 0.92],
  bumperLine: [1.24, 0.8],
  bumpers: [[0.6, 0.045], [0.6, 0.045]],
  mirrorScale: [1.28, 1.32, 1.12],
  chrome: true,
  cladding: 0.55,
  sign: false,
  rails: false,
  rearWiper: false,
  bedCover: true,
  interior: { seats: [-0.06, -0.6] }
};
// High-roof delivery van (~Mercedes Sprinter / Ford Transit 148"): short sloped nose, a tall wide windshield, glass
// only in the cab doors, flat cargo sides & a flat rear (spec.cargo, see buildCargoCabin). spec.cabin describes the cab
// alone, its roof ending at the B-pillar, so the material's windshield & door glass outlines land on the cab.
BODY_SPECS.van = {
  name: 'van',
  zFront: 2.8,
  zRear: -3.08,
  wheelRadius: 0.38,
  wheelZ: 1.8,
  wheelX: 0.86,
  archGap: 0.05,
  archFlare: 0.012,
  tuck: 0.05,
  lowerRound: 4,
  upperRound: 5,
  upperSamples: [1],
  halfWidth: [[2.8, 0.95], [1.8, 0.99], [0.8, 1.0], [-3.08, 1.0]],
  sill: [[2.8, 0.36], [2.1, 0.42], [1.2, 0.45], [-3.08, 0.48]],
  shoulder: [[2.8, 0.66], [2.2, 0.82], [1.6, 0.9], [-3.08, 0.92]],
  edge: [[2.64, 0.97], [2.2, 1.08], [1.75, 1.18], [1.0, 1.21], [0.4, 1.22], [-3.08, 1.22]],
  crown: [[2.64, 0.03], [1.9, 0.025], [1.6, 0.004], [-3.08, 0]],
  tumble: [[2.8, 0.1], [2.0, 0.06], [1.3, 0.015], [-3.08, 0.015]],
  nose: { halfWidth: [0.38, 0.74, 2.6], edge: [0.16, 0.95, 2.4], crown: [0.16, 0.01, 2], sill: [0.18, 0.4, 2], shoulder: [0.24, 0.62, 2.4] },
  tail: { halfWidth: [0.09, 0.93, 3.2], edge: [0.03, 1.2, 3], crown: [0.03, 0, 2], sill: [0.08, 0.5, 2], shoulder: [0.08, 0.9, 3] },
  noseRake: { length: 0.55, y: [[0.32, 0.06], [0.45, 0], [0.7, 0], [0.85, 0.05], [1.0, 0.12]], plan: 0.09 },
  cabin: {
    cowl: 1.75,
    roofFront: 1.22,
    roofRear: 0.48, // B-pillar: the cab's glass ends here, the cargo box (spec.cargo) carries the roof on to the tail
    deck: 0.42,
    roofY: [[1.22, 2.02], [0.48, 2.02]],
    rail: [0.92, 0.94],
    inset: 0,
    bulge: 0.006,
    roofEdge: 0.06,
    roofCrown: 0.03,
    roofRound: 4,
    pillars: [-0.1, -0.9], // behind the door glass: no B / C pillar bars
    glassEnd: 0.44
  },
  cargo: {
    // High roof above the cab roof along z; its first knot is the windshield header (cabin.roofFront)
    rise: [[1.22, 0], [1.08, 0.12], [0.9, 0.29], [0.7, 0.44], [0.5, 0.54], [0.28, 0.6], [0.05, 0.62], [-2.94, 0.62], [-3.08, 0.585]],
    roofEdge: 0.15, // height of the high roof's rounded shoulder
    roofRound: 4,
    bumper: [0.42, 0.62, 0.08] // rear step bumper: bottom, top, protrusion
  },
  doors: [1.32, 0.42, 0.33, -0.97], // front door, sliding door
  handles: [0.55, 0.22],
  headlight: [0.66, 0.84, 0.24, 0.08],
  taillight: [0.9, 0.9, 0.065, 0.28],
  grille: [0.73, 0.42, 0.13],
  intake: [0.46, 0.5, 0.05],
  plates: [0.47, 0.78],
  bumperLine: [0.575, 0.62],
  bumpers: [[0.48, 0.07], [0.52, 0.1]],
  chrome: false,
  cladding: 0.56,
  mirrorScale: [1.3, 2.6, 1.1],
  sign: false,
  rails: false,
  rearWiper: false,
  // Painted van details (optional fields): no light bar between the tail lamps, rear barn doors (half-width, top) and
  // a curb-side (-x) sliding door (front z, rear z, top) running up the cargo side
  tailStrip: false,
  barnDoors: [0.8, 2.34],
  slidingDoor: [0.33, -0.97, 2.28],
  // A bulkhead closes the cab off from the cargo box
  interior: { seats: [0.62], bulkhead: 0.47 }
};
// Minivan (~Toyota Sienna / Honda Odyssey): low sloping nose, very fast windshield, long roof, sliding side doors,
// long rear quarter glass & a steep hatch.
BODY_SPECS.minivan = {
  name: 'minivan',
  zFront: 2.5,
  zRear: -2.67,
  wheelRadius: 0.37,
  wheelZ: 1.515,
  wheelX: 0.845,
  archGap: 0.045,
  archFlare: 0.02,
  tuck: 0.06,
  halfWidth: [[2.5, 0.93], [1.515, 0.975], [0, 0.985], [-1.515, 0.98], [-2.67, 0.955]],
  sill: [[2.5, 0.33], [1.2, 0.31], [-1.2, 0.31], [-2.67, 0.38]],
  shoulder: [[2.5, 0.72], [1.5, 0.8], [0, 0.82], [-1.5, 0.84], [-2.67, 0.84]],
  edge: [[2.36, 0.88], [1.9, 0.95], [1.55, 1.0], [0.8, 1.04], [-0.5, 1.07], [-1.6, 1.11], [-2.3, 1.13], [-2.6, 1.11]],
  crown: [[2.36, 0.035], [1.6, 0.03], [1.4, 0.004], [-2.67, 0.004]],
  tumble: [[2.5, 0.12], [1.5, 0.1], [-1.5, 0.1], [-2.67, 0.12]],
  nose: { halfWidth: [0.36, 0.7, 2.7], edge: [0.16, 0.86, 2.5], crown: [0.16, 0.012, 2], sill: [0.18, 0.36, 2], shoulder: [0.24, 0.62, 2.5] },
  tail: { halfWidth: [0.26, 0.8, 2.8], edge: [0.07, 1.06, 3], crown: [0.07, 0.004, 2], sill: [0.16, 0.44, 2], shoulder: [0.2, 0.84, 2.6] },
  noseRake: { length: 0.6, y: [[0.3, 0.08], [0.45, 0], [0.62, 0], [0.75, 0.04], [0.9, 0.11]], plan: 0.08 },
  tailRake: { length: 0.42, y: [[0.38, 0.08], [0.52, 0], [0.7, 0], [0.85, 0.02], [1.1, 0.05]], plan: 0.05 },
  cabin: {
    cowl: 1.55,
    roofFront: 0.42,
    roofRear: -2.2,
    deck: -2.55,
    roofY: [[0.42, 1.72], [-0.6, 1.765], [-1.6, 1.755], [-2.2, 1.715]],
    rail: [0.76, 0.72],
    inset: 0.03,
    bulge: 0.012,
    roofEdge: 0.06,
    roofCrown: 0.03,
    roofRound: 4,
    pillars: [0.28, -0.98],
    glassEnd: -1.98
  },
  doors: [1.05, 0.28, -0.98], // front door, sliding door
  handles: [0.42, 0.15],
  headlight: [0.66, 0.775, 0.24, 0.055],
  taillight: [0.7, 1.0, 0.2, 0.07],
  grille: [0.74, 0.3, 0.035],
  intake: [0.49, 0.55, 0.12],
  plates: [0.49, 0.84],
  bumperLine: [0.68, 0.72],
  bumpers: [[0.45, 0.04], [0.55, 0.04]],
  chrome: false,
  cladding: 0,
  sign: false,
  rails: false,
  rearWiper: true,
  interior: { seats: [0.14, -0.86, -1.86] },
  privacyGlass: true
};

for (const spec of Object.values(BODY_SPECS)) {
  // Kept for code that places lamp flares: lamp heights (front, rear) and centres across the car
  spec.lamps = [spec.headlight[1], spec.taillight[1]];
  spec.lampX = [spec.headlight[0], spec.taillight[0]];
}

const lerp = (a, b, t) => a + (b - a) * t;

// Monotone cubic (Fritsch-Carlson) interpolation through [x, y] control points: smooth, never overshoots
function smoothCurve(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m.push(0);
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m.push((w1 + w2) / (w1 / d[i - 1] + w2 / d[i]));
    }
  }
  m.push(d[n - 2]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// 1 along the body, falling to 0 at the tip along a superelliptic quarter (vertical tangent at the tip)
function endFactor(z, zTip, length, exponent = 2) {
  const u = zTip > 0 ? (z - (zTip - length)) / length : (zTip + length - z) / length;
  if (u <= 0) return 1;
  if (u >= 1) return 0;
  return Math.pow(1 - Math.pow(u, exponent), 1 / exponent);
}

/**
 * Evaluates a body spec's curves into the cross-section parameters along the vehicle (memoized on the spec):
 *   body(z) -> { W: half-width, yB: sill, yS: shoulder (widest), yE / xE: top edge, yT: crown, xB: sill half-width }
 */
function bodyProfile(spec) {
  if (spec._body) return spec._body;
  const W0 = smoothCurve(spec.halfWidth);
  const B0 = smoothCurve(spec.sill);
  const S0 = smoothCurve(spec.shoulder);
  const E0 = smoothCurve(spec.edge);
  const C0 = smoothCurve(spec.crown);
  const T0 = smoothCurve(spec.tumble);
  const archR = spec.wheelRadius + spec.archGap;
  const axles = [spec.wheelZ, -spec.wheelZ];

  const rounded = (z, value, key) => {
    const nose = spec.nose[key];
    const tail = spec.tail[key];
    if (nose && z > 0) value = nose[1] + (value - nose[1]) * endFactor(z, spec.zFront, nose[0], nose[2]);
    if (tail && z < 0) value = tail[1] + (value - tail[1]) * endFactor(z, spec.zRear, tail[0], tail[2]);
    return value;
  };

  const body = (z) => {
    let flare = 0;
    for (const axle of axles) {
      const d = (z - axle) / (archR + 0.4);
      if (Math.abs(d) < 1) flare = Math.max(flare, (1 - d * d) ** 2);
    }
    const W = rounded(z, W0(z) + spec.archFlare * flare, 'halfWidth');
    const ySill = rounded(z, B0(z), 'sill');
    const archPow = spec.archPower || 2;
    let yB = ySill;
    for (const axle of axles) {
      const d = Math.abs(z - axle);
      if (d < archR) {
        yB = Math.max(yB, ySill + (spec.wheelRadius + archR - ySill) * Math.pow(1 - Math.pow(d / archR, archPow), 1 / archPow));
      }
    }
    const yE = rounded(z, E0(z), 'edge');
    const yT = yE + Math.max(0, rounded(z, C0(z), 'crown'));
    const yS = Math.min(Math.max(rounded(z, S0(z), 'shoulder'), yB + 0.035), yE - 0.035);
    const xE = Math.max(W - T0(z), W * 0.55);
    return { z, W, yB, ySill, yS, yE, yT, xE, xB: W - spec.tuck };
  };
  spec._body = body;
  return body;
}

/**
 * A car's body profile plus its glasshouse (memoized on the spec):
 *   cabin(z) -> { beltX, beltY: side glass base, railX, railY: top of the side glass, h: roof / glass crown height }
 */
function carLayout(spec) {
  if (spec._layout) return spec._layout;
  if (!spec.lamps && spec.headlight && spec.taillight) {
    spec.lamps = [spec.headlight[1], spec.taillight[1]];
    spec.lampX = [spec.headlight[0], spec.taillight[0]];
  }
  const body = bodyProfile(spec);
  const archR = spec.wheelRadius + spec.archGap;
  const cab = spec.cabin;
  const roofY = smoothCurve(cab.roofY);
  const H = cab.roofEdge + cab.roofCrown;
  const belt = (z) => {
    const s = body(z);
    return { x: s.xE - cab.inset, y: s.yE - 0.004 };
  };
  const bc = belt(cab.cowl);
  const bd = belt(cab.deck);
  const railF = { x: cab.rail[0], y: roofY(cab.roofFront) - H };
  const railR = { x: cab.rail[1], y: roofY(cab.roofRear) - H };
  const roofMid = (cab.roofFront + cab.roofRear) / 2;
  const railM = { x: (cab.rail[0] + cab.rail[1]) / 2, y: roofY(roofMid) - H };
  // At the cowl & deck the glass arch stays under the hood / trunk crown, so the glass grows out of the panel
  const hCowl = Math.max(0.006, body(cab.cowl).yT - bc.y - 0.008);
  const hDeck = Math.max(0.006, body(cab.deck).yT - bd.y - 0.008);

  const cabin = (z) => {
    const b = belt(z);
    let railX;
    let railY;
    let h;
    if (z >= cab.roofFront) {
      const t = (cab.cowl - z) / (cab.cowl - cab.roofFront);
      railX = lerp(bc.x, railF.x, t);
      railY = lerp(bc.y, railF.y, t);
      h = lerp(hCowl, H, Math.min(1, t * 1.6));
    } else if (z <= cab.roofRear) {
      const t = (z - cab.deck) / (cab.roofRear - cab.deck);
      railX = lerp(bd.x, railR.x, t);
      railY = lerp(bd.y, railR.y, t);
      h = lerp(hDeck, H, Math.min(1, t * 1.6));
    } else {
      const t = (cab.roofFront - z) / (cab.roofFront - cab.roofRear);
      railX = lerp(railF.x, railR.x, t);
      railY = roofY(z) - H;
      h = H;
    }
    return { z, beltX: Math.max(b.x, railX), beltY: Math.min(b.y, railY), railX, railY, h, bulge: cab.bulge };
  };

  // Height of the glasshouse's top surface (roof / windshield crown) at |x| for a cabin section
  const cabinTop = (c, x) => {
    const n = cab.roofRound;
    const ratio = Math.min(1, Math.abs(x) / Math.max(c.railX, 1e-4));
    const th = Math.acos(Math.pow(ratio, n / 2));
    return c.railY + c.h * Math.pow(Math.sin(th), 2 / n);
  };

  spec._layout = { spec, body, cabin, cabinTop, archR, belt: { cowl: bc, deck: bd }, rail: { front: railF, mid: railM, rear: railR, roofMid } };
  return spec._layout;
}

const BODY_LOWER_ROUND = 2.8;
const BODY_UPPER_ROUND = 3.2;

// Right half of a body cross-section: superelliptic lower corner (sill -> widest point), superelliptic upper corner
// (widest point -> top edge) and a parabolic crown. Specs may sharpen the corners (lowerRound / upperRound) and sample
// the upper corner more densely (upperSamples).
function bodyHalfProfile(s, detail, spec = {}) {
  const n1 = spec.lowerRound || BODY_LOWER_ROUND;
  const n2 = spec.upperRound || BODY_UPPER_ROUND;
  const right = [];
  const low = detail ? [0, 0.32, 0.64, 1] : [0, 1];
  const up = detail ? spec.upperSamples || [0.38, 0.72, 1] : [1];
  const top = detail ? [0.66, 0.33] : [0.5];
  for (const a of low) {
    const th = (a * Math.PI) / 2;
    const y = s.yS - (s.yS - s.yB) * Math.pow(Math.cos(th), 2 / n1);
    if (s.ySill !== undefined) {
      const u = Math.min(1, Math.max(0, (s.yS - y) / Math.max(s.yS - s.ySill, 1e-4)));
      right.push([s.xB + (s.W - s.xB) * Math.pow(Math.max(0, 1 - Math.pow(u, n1)), 1 / n1), y]);
    } else {
      right.push([s.xB + (s.W - s.xB) * Math.pow(Math.sin(th), 2 / n1), y]);
    }
  }
  for (const a of up) {
    const th = (a * Math.PI) / 2;
    right.push([s.xE + (s.W - s.xE) * Math.pow(Math.cos(th), 2 / n2), s.yS + (s.yE - s.yS) * Math.pow(Math.sin(th), 2 / n2)]);
  }
  for (const f of top) right.push([s.xE * f, s.yE + (s.yT - s.yE) * (1 - f * f)]);
  return right;
}

// Cars place their sections at the features (tips, nose & tail roundings, wheel arches, cowl & deck) and fill the gaps
// in between: finely over the hood & deck, coarsely along the doors, where the cabin hides the body's top. Other
// lofts (the bus) keep a regular step plus the feature stations.
function bodyStations(spec, detail) {
  const zs = [];
  const add = (z) => zs.push(Math.min(spec.zFront, Math.max(spec.zRear, z)));
  const cab = spec.cabin;
  const step = detail ? spec.stationStep || 0.28 : 0.75;
  if (!cab) {
    for (let z = spec.zRear; z < spec.zFront; z += step) add(z);
  }
  add(spec.zFront);
  add(spec.zRear);
  const noseLen = Math.max(...Object.values(spec.nose).map((v) => v[0]));
  const tailLen = Math.max(...Object.values(spec.tail).map((v) => v[0]));
  for (const u of detail ? [0, 0.3, 0.52, 0.7, 0.83, 0.92, 0.97, 0.993] : [0, 0.72]) {
    add(spec.zFront - noseLen * (1 - u));
    add(spec.zRear + tailLen * (1 - u));
  }
  const archR = spec.wheelRadius + spec.archGap;
  const k = detail ? 8 : 4;
  for (const axle of [spec.wheelZ, -spec.wheelZ]) {
    for (let i = 0; i <= k; i++) add(axle + archR * Math.cos((i / k) * Math.PI));
    if (!cab) {
      add(axle + archR + 0.006);
      add(axle - archR - 0.006);
    }
  }
  if (detail && cab) {
    add(cab.cowl);
    add(cab.deck);
  }
  zs.sort((a, b) => b - a);
  const eps = detail ? 0.004 : 0.04;
  const out = [];
  for (const z of zs) {
    if (!out.length || out[out.length - 1] - z > eps) out.push(z);
  }
  out[0] = spec.zFront;
  out[out.length - 1] = spec.zRear;
  if (!cab) return out;
  const filled = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    const mid = (a + b) / 2;
    const gap = !detail ? (spec.proxyStep || 0.75) : mid < cab.cowl - 0.1 && mid > cab.deck + 0.1 ? 0.5 : (spec.stationStep || 0.27);
    const n = Math.ceil((a - b) / gap - 0.15);
    for (let j = 1; j < n; j++) filled.push(lerp(a, b, j / n));
    filled.push(b);
  }
  return filled;
}

// Optional raked nose & tail, spec.noseRake / tailRake = { length, y: [[height, setback], ...], plan }: every body
// vertex within `length` of the tip moves back by a setback that depends on its height (plus plan * x^2, which rounds
// the fascia in plan view), eased in quadratically, so the fascia slopes back from the bumper up to the hood and the
// tail tucks in under its lip instead of ending in vertical slabs. Returns (x, y, z) => z, or null (memoized).
function bodyRake(spec) {
  if (spec._rake !== undefined) return spec._rake;
  const ends = [[spec.noseRake, spec.zFront, 1], [spec.tailRake, spec.zRear, -1]]
    .filter(([rake]) => rake)
    .map(([rake, tip, dir]) => ({ tip, dir, length: rake.length, plan: rake.plan || 0, setback: smoothCurve(rake.y) }));
  spec._rake = ends.length
    ? (x, y, z) => {
      for (const e of ends) {
        const u = ((z - e.tip) * e.dir + e.length) / e.length;
        if (u > 0) return z - e.dir * (e.setback(y) + e.plan * x * x) * u * u;
      }
      return z;
    }
    : null;
  return spec._rake;
}

// z of a body's nose (front) or tail surface on the centreline at height y, for plates & badges mounted on the tips
function carTipZ(spec, y, front = true) {
  const rake = bodyRake(spec);
  const z = front ? spec.zFront : spec.zRear;
  return rake ? rake(0, y, z) : z;
}

// Closes a raked body tip with a grid that follows the rake (a flat loft cap can't bow out at the bumper): each
// right-half point of the tip section is joined to its mirror image by a row split into `columns`, the crown point
// closes the top. Row 0 (the sill) stays straight so it meets the flat underbody without a gap. front: faces +z.
function buildTipCap(right, top, z, rake, front, columns) {
  const pos = [];
  const index = [];
  const row = columns + 1;
  for (let i = 0; i < right.length; i++) {
    const [x, y] = right[i];
    for (let j = 0; j <= columns; j++) {
      const px = x * ((2 * j) / columns - 1);
      pos.push(px, y, rake(i === 0 ? x : px, y, z));
    }
  }
  const apex = pos.length / 3;
  pos.push(0, top, rake(0, top, z));
  const tri = (a, b, c) => (front ? index.push(a, b, c) : index.push(a, c, b));
  for (let i = 0; i < right.length - 1; i++) {
    for (let j = 0; j < columns; j++) {
      const a = i * row + j;
      tri(a, a + 1, a + row + 1);
      tri(a, a + row + 1, a + row);
    }
  }
  const last = (right.length - 1) * row;
  for (let j = 0; j < columns; j++) tri(last + j, last + j + 1, apex);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function buildBodyLoft(spec, detail = 1) {
  const body = bodyProfile(spec);
  const rake = bodyRake(spec);
  const stations = bodyStations(spec, detail);
  const sections = stations.map((z) => {
    const s = body(z);
    const section = mirrorSection(bodyHalfProfile(s, detail, spec), [0, s.yT], z);
    if (rake) for (const p of section) p.z = rake(p.x, p.y, z);
    return section;
  });
  if (!rake) return new LoftGeometry(sections, { capStart: true, capEnd: true });
  const loft = new LoftGeometry(sections, { closed: false });
  const under = new LoftGeometry(sections.map((sec) => [sec[sec.length - 1], sec[0]]), { closed: false });
  const cols = detail ? 4 : 1;
  const ring = sections[0].length;
  const row = cols + 1;
  const nRight = (ring - 1) / 2;
  const lNorm = loft.attributes.normal;
  const caps = [0, stations.length - 1].map((si) => {
    const s = body(stations[si]);
    const cap = buildTipCap(bodyHalfProfile(s, detail, spec), s.yT, stations[si], rake, si === 0, cols);
    const cNorm = cap.attributes.normal;
    const base = si * ring;
    const blend = (li, ci) => {
      const nx = lNorm.getX(li) + cNorm.getX(ci);
      const ny = lNorm.getY(li) + cNorm.getY(ci);
      const nz = lNorm.getZ(li) + cNorm.getZ(ci);
      const len = Math.hypot(nx, ny, nz) || 1;
      lNorm.setXYZ(li, nx / len, ny / len, nz / len);
      cNorm.setXYZ(ci, nx / len, ny / len, nz / len);
    };
    for (let i = 1; i < nRight; i++) {
      blend(base + i, i * row);
      blend(base + ring - 1 - i, i * row + cols);
    }
    blend(base + nRight, nRight * row);
    return part(cap, CAR_PARTS.BODY);
  });
  return mergeGeometries([part(loft, CAR_PARTS.BODY), ...caps, part(under, CAR_PARTS.TRIM)]);
}

function buildCarBody(spec, detail = 1) {
  const g = buildBodyLoft(spec, detail);
  return g.getAttribute('partId') ? g : part(g, CAR_PARTS.BODY);
}

function cabinSection(c, detail, roundness) {
  const right = [[c.beltX, c.beltY]];
  if (detail) {
    for (const s of [1 / 3, 2 / 3]) {
      right.push([lerp(c.beltX, c.railX, s) + c.bulge * 4 * s * (1 - s), lerp(c.beltY, c.railY, s)]);
    }
  }
  right.push([c.railX, c.railY]);
  for (const f of detail ? [0.2, 0.42, 0.68] : [0.5]) {
    const th = (f * Math.PI) / 2;
    right.push([c.railX * Math.pow(Math.cos(th), 2 / roundness), c.railY + c.h * Math.pow(Math.sin(th), 2 / roundness)]);
  }
  return mirrorSection(right, [0, c.railY + c.h], c.z);
}

function cabinStations(spec, detail) {
  const cab = spec.cabin;
  const zs = [];
  for (const t of detail ? [0, 0.1, 0.24, 0.42, 0.62, 0.82] : [0, 0.5]) zs.push(lerp(cab.cowl, cab.roofFront, t));
  for (const t of detail ? [0, 0.25, 0.5, 0.75] : [0, 0.5]) zs.push(lerp(cab.roofFront, cab.roofRear, t));
  for (const t of detail ? [1, 0.8, 0.6, 0.4, 0.22, 0.1, 0] : [1, 0.5, 0]) zs.push(lerp(cab.deck, cab.roofRear, t));
  return zs;
}

function buildCarCabin(spec, detail = 1) {
  if (spec.cargo) return buildCargoCabin(spec, detail);
  const L = carLayout(spec);
  const sections = cabinStations(spec, detail).map((z) => cabinSection(L.cabin(z), detail, spec.cabin.roofRound));
  return part(new LoftGeometry(sections, { closed: false }), CAR_PARTS.WINDOW);
}

// Delivery van upper body (spec.cargo), built instead of the glasshouse: one WINDOW loft from the cowl to the tail.
// spec.cabin describes the cab alone (its roof ends at the B-pillar), so up to the windshield header the sections are
// carLayout's and the material's windshield & door glass outlines land on them as on any car. Behind the header the
// roof rises into a high-roof cap (spec.cargo.rise above the cab roof) and runs flat over the cargo box, whose sides
// carry the door glass plane on up to the roof shoulder; the tail closes with a flat rear face on the body's rounded
// plan corners, over a black step bumper.
function buildCargoCabin(spec, detail = 1) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const cargo = spec.cargo;
  const rise = smoothCurve(cargo.rise);
  const fullRise = Math.max(...cargo.rise.map((p) => p[1]));
  const H = cab.roofEdge + cab.roofCrown;
  const rr = L.rail.rear;
  const bR = L.body(cab.roofRear);
  // Lean (dx / dy) of the door glass at the B-pillar, continued up the cargo sides
  const lean = (bR.xE - cab.inset - rr.x) / (rr.y - (bR.yE - 0.004));
  const n = cargo.roofRound;
  const section = (z) => {
    let c;
    if (z >= cab.roofRear) {
      c = L.cabin(z);
    } else {
      const s = L.body(z);
      const beltX = s.xE - cab.inset;
      const beltY = s.yE - 0.004;
      c = { beltX, beltY, railX: beltX - (rr.y - beltY) * lean, railY: rr.y, h: H, bulge: cab.bulge };
    }
    const up = z < cab.roofFront ? rise(z) : 0;
    // The roof's rounded shoulder grows from the cab roof's edge to the high roof's as the cap rises
    const hR = lerp(c.h, cargo.roofEdge, Math.min(1, up / fullRise));
    const top = c.railY + c.h + up;
    const sy = top - hR;
    const sx = c.railX - (sy - c.railY) * lean;
    const round = (f, x, y) => {
      const th = (f * Math.PI) / 2;
      return [x * Math.pow(Math.cos(th), 2 / n), y + hR * Math.pow(Math.sin(th), 2 / n)];
    };
    const right = [[c.beltX, c.beltY]];
    if (detail) {
      for (const t of [1 / 3, 2 / 3]) {
        right.push([lerp(c.beltX, c.railX, t) + c.bulge * 4 * t * (1 - t), lerp(c.beltY, c.railY, t)]);
      }
      right.push([c.railX, c.railY]);
      // Under the cab roof the shoulder vertex slides onto the roof's rounding instead of doubling the rail
      const k = Math.min(1, up / 0.05);
      const r0 = round(0.1, sx, sy);
      right.push([lerp(r0[0], sx, k), lerp(r0[1], sy, k)]);
    } else {
      right.push([sx, sy]);
    }
    for (const f of detail ? [0.2, 0.42, 0.68] : [0.5]) right.push(round(f, sx, sy));
    return mirrorSection(right, [0, top], z);
  };
  // Sections along the windshield, at the rise curve's knots (the first one is the windshield header) and on the
  // tail's plan rounding; the far proxy keeps the header, the end of the cap and the tail
  const zr = spec.zRear;
  const knots = cargo.rise.map((p) => p[0]).filter((z) => z > zr);
  const capEnd = cargo.rise.find((p) => p[1] === fullRise)[0];
  const zs = detail
    ? [...[0, 0.12, 0.3, 0.55, 0.8].map((t) => lerp(cab.cowl, cab.roofFront, t)), ...knots, zr + 0.045, zr + 0.015, zr]
    : [cab.cowl, cab.roofFront, lerp(cab.roofFront, capEnd, 0.4), capEnd, zr];
  const parts = [part(new LoftGeometry(zs.map(section), { closed: false, capEnd: true }), CAR_PARTS.WINDOW)];
  if (detail) {
    // Step bumper wrapping around the rear corners: a plan-view rounded rectangle extruded upwards
    const [bottom, top, depth] = cargo.bumper;
    const outline = roundedRectShape(L.body(zr + 0.1).W, depth, depth * 0.9);
    const bumper = new THREE.ExtrudeGeometry(outline, { depth: top - bottom, bevelEnabled: false, curveSegments: 2 })
      .rotateX(Math.PI / 2)
      .translate(0, top, zr);
    parts.push(part(bumper, CAR_PARTS.TRIM));
  }
  return mergeGeometries(parts);
}

/**
 * Half-width of a body's outer skin at height y of the cross-section at z (for decals & signs that hug the sides)
 */
function carBodyHalfWidthAt(spec, z, y) {
  const s = bodyProfile(spec)(z);
  const n1 = spec.lowerRound || BODY_LOWER_ROUND;
  const n2 = spec.upperRound || BODY_UPPER_ROUND;
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const th = ((i / 16) * Math.PI) / 2;
    pts.push([s.xB + (s.W - s.xB) * Math.pow(Math.sin(th), 2 / n1), s.yS - (s.yS - s.yB) * Math.pow(Math.cos(th), 2 / n1)]);
  }
  for (let i = 1; i <= 16; i++) {
    const th = ((i / 16) * Math.PI) / 2;
    pts.push([s.xE + (s.W - s.xE) * Math.pow(Math.cos(th), 2 / n2), s.yS + (s.yE - s.yS) * Math.pow(Math.sin(th), 2 / n2)]);
  }
  if (y <= pts[0][1]) return pts[0][0];
  for (let i = 1; i < pts.length; i++) {
    if (y <= pts[i][1]) {
      const t = (y - pts[i - 1][1]) / Math.max(pts[i][1] - pts[i - 1][1], 1e-6);
      return lerp(pts[i - 1][0], pts[i][0], t);
    }
  }
  return s.xE;
}

/**
 * A thin grid patch lying `offset` m off the body side (side = +1: +x) over z0..z1, y0..y1. UVs read from the
 * front of the car to the back on both sides (u = 0 at the front on the +x side, at the back on the -x side).
 */
function buildCarSidePatch(spec, side, z0, z1, y0, y1, offset = 0.003, nz = 10, ny = 6) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const y = lerp(y0, y1, v);
    for (let i = 0; i <= nz; i++) {
      const u = i / nz;
      const z = side > 0 ? lerp(z1, z0, u) : lerp(z0, z1, u);
      positions.push(side * (carBodyHalfWidthAt(spec, z, y) + offset), y, z);
      uvs.push(u, v);
      if (i < nz && j < ny) {
        const a = j * (nz + 1) + i;
        const b = a + 1;
        const c = a + nz + 1;
        const d = c + 1;
        if (side > 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

const WHEEL_SEGMENTS = 18;

/**
 * Builds a single wheel assembly centered at the origin (for steerable/spinning player wheels) or translated to
 * (x, r, z): a low-profile LatheGeometry tyre (flat tread, rounded shoulders, bulged sidewalls), a concave alloy face
 * (rim flange dishing in to a domed centre cap) and a dark disc closing the tyre from the inboard side.
 */
function buildWheelParts(spec, side, translateToAxle = false, z = 0) {
  const r = spec.wheelRadius;
  const rim = r * 0.68;
  const width = r * 0.68;
  const bead = rim + 0.006;
  const hubR = rim * 0.3;
  // Lathe profiles run from inboard (-) to outboard (+) along the axle; LatheGeometry revolves them about y
  const tyre = new THREE.LatheGeometry([
    new THREE.Vector2(bead, -width * 0.42),
    new THREE.Vector2(r * 0.86, -width * 0.5),
    new THREE.Vector2(r, -width * 0.33),
    new THREE.Vector2(r, width * 0.33),
    new THREE.Vector2(r * 0.86, width * 0.5),
    new THREE.Vector2(bead, width * 0.42)
  ], WHEEL_SEGMENTS);
  const face = new THREE.LatheGeometry([
    new THREE.Vector2(bead, width * 0.42),
    new THREE.Vector2(rim - 0.01, width * 0.4),
    new THREE.Vector2(hubR, width * 0.25)
  ], WHEEL_SEGMENTS);
  // Centre cap: a fan whose rim vertices coincide with the face's inner ring (CircleGeometry turned onto the lathe
  // axis, phase-shifted to the lathe's angles)
  const cap = new THREE.CircleGeometry(hubR, WHEEL_SEGMENTS, -Math.PI / 2);
  cap.attributes.position.setZ(0, 0.012);
  cap.computeVertexNormals();
  cap.rotateX(-Math.PI / 2).translate(0, width * 0.25, 0);
  // Closes the tyre's inboard bead hole: a 9-gon whose edges stay outside the bead circle
  const back = new THREE.CircleGeometry((bead + 0.003) / Math.cos(Math.PI / 9), 9)
    .rotateX(Math.PI / 2)
    .translate(0, -width * 0.4, 0);

  const x = translateToAxle ? side * spec.wheelX : 0;
  const y = translateToAxle ? r : 0;
  const zOff = translateToAxle ? z : 0;
  const list = [part(tyre, CAR_PARTS.TYRE), part(face, CAR_PARTS.ALLOY), part(cap, CAR_PARTS.ALLOY), part(back, CAR_PARTS.TRIM)];
  for (const g of list) g.rotateZ(-side * Math.PI * 0.5).translate(x, y, zOff);

  if (translateToAxle) list.push(buildWheelWell(spec, side, z));
  return list;
}

// Dark arch liner behind a wheel, reaching down to the sill so the arch never shows through to the other side
function buildWheelWell(spec, side, z) {
  const r = spec.wheelRadius;
  const archR = r + spec.archGap;
  const width = r * 0.68;
  const y0 = spec.sill[1][1];
  const rx = archR + 0.015;
  const ry = r + archR - y0 + 0.015;
  const x = side * (spec.wheelX - (width * 0.5 + 0.02));
  const archPow = spec.archPower || 2;
  const makeHalf = (rotY) => {
    const geo = new THREE.CircleGeometry(1, 10, 0, Math.PI);
    if (archPow !== 2) {
      const pos = geo.attributes.position;
      for (let i = 1; i < pos.count; i++) {
        const u = Math.min(1, Math.abs(pos.getX(i)));
        pos.setY(i, Math.pow(1 - Math.pow(u, archPow), 1 / archPow));
      }
    }
    return geo.scale(rx, ry, 1).rotateY(rotY).translate(x, y0, z);
  };
  return part(mergeGeometries([makeHalf(side * Math.PI * 0.5), makeHalf(-side * Math.PI * 0.5)]), CAR_PARTS.TRIM);
}

function buildSteerableWheelGeo(spec, side) {
  return mergeGeometries(buildWheelParts(spec, side, false));
}

function buildMirrors(spec) {
  const L = carLayout(spec);
  const z = spec.cabin.cowl - 0.17;
  const c = L.cabin(z);
  const [sx, sy, sz] = spec.mirrorScale || [1, 1, 1];
  const list = [];
  for (const side of [-1, 1]) {
    const housing = roundedBox(0.1, 0.06, 0.085, 0.035, 0.014)
      .scale(sx, sy, sz)
      .rotateY(side * 0.12)
      .translate(side * (c.beltX + 0.15), c.beltY + 0.085, z - 0.02);
    const arm = new THREE.BoxGeometry(0.12, 0.035, 0.06)
      .rotateZ(side * 0.35)
      .translate(side * (c.beltX + 0.04), c.beltY + 0.045, z);
    list.push(part(housing, CAR_PARTS.MIRROR), part(arm, CAR_PARTS.TRIM));
  }
  return list;
}

function buildRoofRails(spec) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const list = [];
  for (const side of [-1, 1]) {
    const sections = [0.04, 0.1, 0.9, 0.96].map((t, i) => {
      const z = lerp(cab.roofFront, cab.roofRear, t);
      const c = L.cabin(z);
      const x = side * c.railX * 0.8;
      const y = L.cabinTop(c, x) + (i === 0 || i === 3 ? 0.004 : 0.05);
      return [
        new THREE.Vector3(x - 0.02, y - 0.016, z),
        new THREE.Vector3(x + 0.02, y - 0.016, z),
        new THREE.Vector3(x + 0.02, y + 0.016, z),
        new THREE.Vector3(x - 0.02, y + 0.016, z)
      ].reverse();
    });
    list.push(part(new LoftGeometry(sections, { capStart: true, capEnd: true }), CAR_PARTS.TRIM));
  }
  return list;
}

// NYC medallion roof light: a lit, gently tapered box on a black mount
function taxiSignPlacement(spec) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const z = lerp(cab.roofFront, cab.roofRear, 0.45);
  const c = L.cabin(z);
  return { z, y: c.railY + c.h };
}

function buildTaxiSign(spec) {
  const { z, y } = taxiSignPlacement(spec);
  const shape = new THREE.Shape();
  const hw0 = 0.3;
  const hw1 = 0.27;
  const h = 0.15;
  const r = 0.035;
  shape.moveTo(-hw0, 0);
  shape.lineTo(hw0, 0);
  shape.lineTo(hw1, h - r);
  shape.quadraticCurveTo(hw1 - 0.004, h, hw1 - r, h);
  shape.lineTo(-hw1 + r, h);
  shape.quadraticCurveTo(-hw1 + 0.004, h, -hw1, h - r);
  shape.lineTo(-hw0, 0);
  const sign = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 3
  }).translate(0, y + 0.03, z - 0.06);
  const mount = new THREE.BoxGeometry(0.46, 0.04, 0.12).translate(0, y + 0.012, z);
  return [part(sign, CAR_PARTS.SIGN), part(mount, CAR_PARTS.TRIM)];
}

// Matte-black tonneau cover and bed-side rail caps over a pickup truck's bed (behind cabin.deck)
function buildBedCover(spec) {
  const body = bodyProfile(spec);
  const zs = [spec.cabin.deck - 0.01, spec.zRear + 0.42, spec.zRear + 0.08];
  const sections = zs.map((z) => {
    const s = body(z);
    const x = s.xE - 0.045;
    const y = s.yE + 0.014;
    return [
      [-x, y],
      [-x + 0.006, y + 0.032],
      [-x + 0.056, y + 0.032],
      [-x + 0.068, y + 0.02],
      [x - 0.068, y + 0.02],
      [x - 0.056, y + 0.032],
      [x - 0.006, y + 0.032],
      [x, y]
    ].map(([px, py]) => new THREE.Vector3(px, py, z));
  });
  return [part(new LoftGeometry(sections, { closed: false, capStart: false, capEnd: true }), CAR_PARTS.TRIM)];
}

// Bumpers are part of the body loft (the raked nose & tail): body-coloured fascias, like modern cars'
function buildCarGeometry(spec, includeWheels = true) {
  const parts = [buildCarBody(spec, 1), buildCarCabin(spec, 1), ...buildMirrors(spec)];
  for (const side of [-1, 1]) {
    for (const z of [-spec.wheelZ, spec.wheelZ]) {
      if (includeWheels) parts.push(...buildWheelParts(spec, side, true, z));
      else parts.push(buildWheelWell(spec, side, z));
    }
  }
  if (spec.rails) parts.push(...buildRoofRails(spec));
  if (spec.bedCover) parts.push(...buildBedCover(spec));
  if (spec.sign) parts.push(...buildTaxiSign(spec));
  return mergeGeometries(parts);
}

// A ~250-triangle stand-in for distant cars (a few pixels tall): the same body & glasshouse lofted from a handful of
// coarse sections, dark wheel blocks and the taxi's roof sign. Same attributes (partId, uv, normal) as the full
// model, so it renders with the same material and per-instance paint.
function buildCarProxyGeometry(spec) {
  const parts = [buildCarBody(spec, 0), buildCarCabin(spec, 0)];
  const r = spec.wheelRadius;
  for (const side of [-1, 1]) {
    for (const z of [-spec.wheelZ, spec.wheelZ]) {
      const wheel = new THREE.CylinderGeometry(r * 0.96, r * 0.96, r * 0.62, 6)
        .rotateZ(Math.PI * 0.5)
        .translate(side * spec.wheelX, r, z);
      parts.push(part(wheel, CAR_PARTS.TYRE));
    }
  }
  if (spec.sign) {
    const { z, y } = taxiSignPlacement(spec);
    parts.push(part(new THREE.BoxGeometry(0.58, 0.16, 0.16).translate(0, y + 0.1, z), CAR_PARTS.SIGN));
  }
  return mergeGeometries(parts);
}

// NYPD roof light bar (red on the -x half, blue on the +x half) for a body spec's roof, lit by createLightbarMaterial
function buildLightbarGeometry(spec = BODY_SPECS.sedan) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const z = lerp(cab.roofFront, cab.roofRear, 0.32);
  const c = L.cabin(z);
  const y = c.railY + c.h;
  const bar = roundedBox(0.13, 0.045, 1.12, 0.04, 0.02).rotateY(Math.PI / 2).translate(0, y + 0.075, z);
  const parts = [part(bar, CAR_PARTS.SIGN)];
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.06, 0.05, 0.16).translate(side * 0.42, y + 0.02, z), CAR_PARTS.TRIM));
  }
  return mergeGeometries(parts);
}

let _lightbarMat = null;

// Light bar lenses: NYPD red (-x), blue (+x) & centre white takedown LED pods flashing in alternation per cruiser
function createLightbarMaterial() {
  if (_lightbarMat) return _lightbarMat;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0.25 });
  const lightbar = () => {
    const p = attribute('position', 'vec3');
    const partId = attribute('partId', 'float');
    const isLens = step(abs(partId.sub(CAR_PARTS.SIGN)), 0.25);
    const phase = fract(float(instanceIndex).mul(0.61803)).toVar();
    const t = fract(time.mul(1.75).add(phase)).toVar();
    const strobe = step(0.45, fract(t.mul(6.0)));
    const redOn = step(t, 0.5).mul(strobe);
    const blueOn = step(0.5, t).mul(strobe);
    const whiteOn = step(0.75, fract(t.mul(3.0))).mul(strobe);
    const isRed = smoothstep(-0.045, -0.065, p.x);
    const isBlue = smoothstep(0.045, 0.065, p.x);
    const isWhite = float(1.0).sub(max(isRed, isBlue));
    const pod = smoothstep(-0.05, 0.35, sin(p.x.mul(52.0))).mul(0.35).add(0.65);
    return { isLens, redOn, blueOn, whiteOn, isRed, isBlue, isWhite, pod };
  };
  mat.colorNode = Fn(() => {
    const s = lightbar();
    const lens = mix(mix(color(0xdce2e8), color(0x8e0d14), s.isRed), color(0x0f3c9a), s.isBlue).mul(s.pod);
    return mix(color(0x14171a), lens, s.isLens);
  })();
  mat.emissiveNode = Fn(() => {
    const s = lightbar();
    const rEmit = color(0xff1820).mul(s.isRed.mul(s.redOn).mul(6.2));
    const bEmit = color(0x286eff).mul(s.isBlue.mul(s.blueOn).mul(7.2));
    const wEmit = color(0xf4f8ff).mul(s.isWhite.mul(s.whiteOn).mul(3.8));
    return rEmit.add(bEmit).add(wEmit).mul(s.pod).mul(s.isLens);
  })();
  _lightbarMat = mat;
  return mat;
}

// IQ polynomial smooth maximum: rounds the corners of max()-combined half-plane distances
// Triangle wave 0..1..0 with period 1 (a cheap stand-in for sin in fragment patterns)
const wave = (x) => abs(fract(x).sub(0.5)).mul(2.0);

const smax = (a, b, k) => {
  const h = max(float(k).sub(abs(a.sub(b))), 0.0).div(k);
  return max(a, b).add(h.mul(h).mul(k * 0.25));
};

// Signed distance (approximate outside, exact inside) to a convex polygon given as outward half-planes [nx, ny, c],
// and the screen footprint across its nearest edge: the per-axis footprints (fu, fv) of the polygon's coordinates
// weighted by the normal of the half-plane that dominates the distance
const polygonEdge = (px, py, planes, k, fu, fv) => {
  let d = null;
  let w = null;
  let nearest = null;
  for (const [nx, ny, c] of planes) {
    const e = px.mul(nx).add(py.mul(ny)).sub(c);
    const we = fu.mul(Math.abs(nx)).add(fv.mul(Math.abs(ny)));
    if (d === null) {
      d = nearest = e;
      w = we;
    } else {
      d = smax(d, e, k);
      w = mix(w, we, step(nearest, e));
      nearest = max(nearest, e);
    }
  }
  return { d, w };
};

// Outward half-planes of a counter-clockwise polygon, each edge moved in by its margin
function polygonPlanes(points, margins) {
  const planes = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const len = Math.hypot(bx - ax, by - ay);
    const nx = (by - ay) / len;
    const ny = -(bx - ax) / len;
    planes.push([nx, ny, ax * nx + ay * ny - margins[i]]);
  }
  return planes;
}

/**
 * Screen derivatives of the view-space and object-space positions, for objectViewRay(). Take them in uniform control
 * flow (before any per-part branch) and keep the result in variables.
 */
function viewRayDerivatives(p) {
  return { dVx: dFdx(positionView).toVar(), dVy: dFdy(positionView).toVar(), dOx: dFdx(p).toVar(), dOy: dFdy(p).toVar() };
}

/**
 * The view ray (camera to fragment) in object space, for an instanced mesh whose instance matrix the material can't
 * read: the pixel footprint vectors span the surface in both spaces (the instance's rotation maps one pair onto the
 * other), their cross products the normal. Expand the view-space ray on the reciprocal basis of the view-space trio and
 * rebuild it from the object-space one. View space, not world: the city is kilometres across, too coarse in fp32 for
 * pixel-sized differences.
 */
function objectViewRay({ dVx, dVy, dOx, dOy }) {
  const cV = cross(dVx, dVy);
  const cO = cross(dOx, dOy);
  const ray = positionView;
  const k = float(1.0).div(max(dot(cV, cV), 1e-30));
  return normalize(dOx.mul(dot(ray, cross(dVy, cV))).add(dOy.mul(dot(ray, cross(cV, dVx)))).add(cO.mul(dot(ray, cV))).mul(k));
}

// Daylight seen through a vehicle's far windows along `d` (object space, +y up): the street below the horizon, the
// hazy sky above it
function throughGlass(d) {
  return mix(vec3(0.12, 0.125, 0.13), cityUniforms.uSkyHorizonColor.mul(0.5), smoothstep(-0.06, 0.25, d.y));
}

const SEAT_COLORS = [0x19191b, 0x38383a, 0x7c6f5c, 0x5a3622];
const OCCUPANT_SKIN = [0xc68863, 0x8a5535, 0xe0b090, 0x5a3424, 0xa96f4c];
const OCCUPANT_CLOTHES = [0x1a1c22, 0x4a5060, 0x2a3a5a, 0x8a8478, 0x5a2a2a];

/**
 * The cabin seen through a car's glass, ray traced in object space from the glass fragment `o` along the view ray `d`:
 * a box from the floor to the headliner, the door trim and dashboard below the belt, daylight through the far windows,
 * seat backs with headrests per row (spec.interior.seats), a steering wheel, the driver and sometimes a passenger.
 * `hash` (0..1) picks the trim colour and the passengers. Returns the albedo the glass shows (before its tint).
 */
function cabinInterior(spec, o, d, hash) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const seats = spec.interior.seats;
  const bulkhead = spec.interior.bulkhead;
  const beltY = (L.belt.cowl.y + (spec.cargo ? L.belt.cowl.y : L.belt.deck.y)) / 2;
  const mid = L.cabin((cab.roofFront + cab.roofRear) / 2);
  const xi = Math.min(L.belt.cowl.x, L.belt.deck.x) - 0.07;
  const floorY = spec.sill[1][1] + 0.12;
  const roofY = mid.railY + mid.h - 0.07;
  const zFront = cab.cowl;
  const zBack = bulkhead ?? cab.deck;
  const glassEnd = cab.glassEnd ?? cab.deck;
  const deckY = L.belt.deck.y + 0.02;
  const dashTop = beltY + 0.05;
  const dashRear = seats[0] + 0.8;
  const far = float(1e4);
  const sgn = step(0.0, d).mul(2.0).sub(1.0);
  const inv = vec3(1.0).div(d.add(sgn.mul(1e-5)));
  const ahead = (t) => select(t.greaterThan(0.0), t, far);

  // Where the ray leaves the cabin box, and what is there: the far side's window or door trim, headliner or floor,
  // windshield or dashboard, backlight or parcel shelf (bulkhead on a cargo van)
  const tSide = ahead(sgn.x.mul(xi).sub(o.x).mul(inv.x));
  const tUp = ahead(select(d.y.greaterThan(0.0), float(roofY).sub(o.y), float(floorY).sub(o.y)).mul(inv.y));
  const tEnd = ahead(select(d.z.greaterThan(0.0), float(zFront).sub(o.z), float(zBack).sub(o.z)).mul(inv.z));
  const tBest = min(tSide, min(tUp, tEnd)).toVar();
  const h = o.add(d.mul(tBest));
  const outside = throughGlass(d);
  let pillars = float(0.0);
  for (const zp of cab.pillars) pillars = max(pillars, step(abs(h.z.sub(zp)), 0.05));
  const sideGlass = step(beltY + 0.02, h.y)
    .mul(step(h.y, roofY - 0.04))
    .mul(step(glassEnd + 0.03, h.z))
    .mul(step(h.z, zFront - 0.12))
    .mul(float(1.0).sub(pillars));
  const frontGlass = step(dashTop, h.y);
  const backGlass = bulkhead === undefined ? step(deckY, h.y) : float(0.0);
  const endGlass = select(d.z.greaterThan(0.0), frontGlass, backGlass);
  const isSide = step(tSide, min(tUp, tEnd));
  const isUp = step(tUp, min(tSide, tEnd)).mul(float(1.0).sub(isSide));
  const seeThrough = mix(mix(endGlass, float(0.0), isUp), sideGlass, isSide);
  const trim = spec.sign ? color(SEAT_COLORS[0]) : pickColor(SEAT_COLORS, hash);
  const seatX = xi * 0.5; // the front seats' (and the driver's) distance from the centreline
  const benchX = xi * 0.58;
  const light = step(0.5, hash).mul(step(hash, 0.75)); // the beige cabins have a light headliner
  const headliner = mix(vec3(0.05), vec3(0.3, 0.29, 0.27), light.mul(0.6).add(0.4));
  const shell = mix(mix(trim.mul(0.5).add(0.012), headliner, step(0.0, d.y).mul(isUp)), vec3(0.015), float(1.0).sub(step(0.0, d.y)).mul(isUp));
  // The roof shades the cabin: everything inside is lit far less than the glass (0.42), daylight through it less so
  const col = vec3(mix(shell.mul(0.42), outside.mul(0.85), seeThrough)).toVar();

  const hit = (t, c) => {
    const nearer = step(t, tBest);
    tBest.assign(mix(tBest, t, nearer));
    col.assign(mix(col, c.mul(0.42), nearer));
  };
  // Dashboard top under the windshield (its face below is hidden behind it from outside)
  {
    const tTop = ahead(float(dashTop).sub(o.y).mul(inv.y));
    hit(select(o.z.add(d.z.mul(tTop)).greaterThan(dashRear).and(d.y.lessThan(0.0)), tTop, far), vec3(0.018));
  }
  // Seat backs & headrests, front row first (two seats either side of the console) then benches
  seats.forEach((zs, row) => {
    const t = ahead(float(zs).sub(o.z).mul(inv.z));
    const q = o.add(d.mul(t));
    const ax = abs(q.x);
    const front = row === 0;
    const back = step(ax, xi - 0.03)
      .mul(front ? step(0.1, ax) : float(1.0))
      .mul(step(floorY + 0.12, q.y))
      .mul(step(q.y, beltY + (front ? 0.12 : 0.08)));
    const restX = front ? seatX : benchX;
    const restY = beltY + (front ? 0.16 : 0.12);
    const rest = step(abs(ax.sub(restX)), front ? 0.115 : 0.1).mul(step(restY, q.y)).mul(step(q.y, restY + 0.17));
    hit(select(max(back, rest).greaterThan(0.5), t, far), trim.mul(mix(1.0, 0.8, rest)));
  });
  // Steering wheel (on the left: driver's side): a rim and spokes on a plane tilted towards the driver
  {
    const c = vec3(seatX, beltY + 0.0, seats[0] + 0.62);
    const nW = vec3(0.0, 0.45, -0.893);
    const den = dot(d, nW);
    const t = ahead(dot(c.sub(o), nW).div(select(abs(den).greaterThan(1e-4), den, float(1e-4))));
    const r = length(o.add(d.mul(t)).sub(c));
    const wheel = step(abs(r.sub(0.17)), 0.018).add(step(r, 0.06)).add(step(abs(o.add(d.mul(t)).y.sub(c.y)), 0.018).mul(step(r, 0.17)));
    hit(select(wheel.greaterThan(0.5), t, far), vec3(0.012));
  }
  // Occupants: head (hair on top) & shoulders as ellipsoids. The driver always, a front passenger in some cars and
  // someone in the back of others (taxis carry their fares there)
  const ellipsoid = (center, radii) => {
    const oc = o.sub(center).div(radii);
    const dd = d.div(radii);
    const a = dot(dd, dd);
    const b = dot(oc, dd);
    const disc = b.mul(b).sub(a.mul(dot(oc, oc).sub(1.0)));
    return select(disc.greaterThan(0.0), ahead(b.negate().sub(sqrt(max(disc, 0.0))).div(a)), far);
  };
  const people = [[seatX, seats[0], float(1.0)], [-seatX, seats[0], step(spec.sign ? 0.96 : 0.7, fract(hash.mul(7.31)))]];
  if (seats.length > 1) people.push([-benchX, seats[1], step(spec.sign ? 0.35 : 0.78, fract(hash.mul(3.17)))]);
  people.forEach(([x, zs, present], i) => {
    const seated = () => {
      const pick = fract(hash.mul(11.7 + i * 5.3));
      const headC = vec3(x, beltY + 0.31, zs + 0.2);
      const tHead = ellipsoid(headC, vec3(0.08, 0.11, 0.095));
      const hairTop = step(headC.y.add(0.035), o.y.add(d.y.mul(tHead)));
      hit(tHead, mix(pickColor(OCCUPANT_SKIN, pick).mul(0.7), vec3(0.012), hairTop));
      hit(ellipsoid(vec3(x, beltY - 0.02, zs + 0.09), vec3(0.2, 0.28, 0.12)), pickColor(OCCUPANT_CLOTHES, fract(pick.mul(3.7))));
    };
    // (the same for every fragment of a car: an empty seat costs nothing)
    if (i === 0) seated();
    else If(present.greaterThan(0.5), seated);
  });
  return col;
}

// Branchless palette lookup (hex colours) by a 0..1 value
function pickColor(hexArray, t) {
  let acc = color(hexArray[0]);
  for (let i = 1; i < hexArray.length; i++) acc = mix(acc, color(hexArray[i]), step(float(i), t.mul(hexArray.length)));
  return acc;
}

// Packs per-instance style fields into carState.w (livery 0..7, metallic 0..1, trim 0..3, wheelStyle 0..3, and a
// per-car seed 0..255 that dresses the cabin & its occupants). Livery 1 with default options encodes to 1, keeping
// existing NYPD carState.w = 1 checks compatible.
function carStyleCode({ livery = 0, metallic = 0, trim = 0, wheel = 0, seed = 0 } = {}) {
  return (livery & 7) + ((metallic & 1) << 3) + ((trim & 3) << 4) + ((wheel & 3) << 6) + ((seed & 255) << 8);
}

// The same style code with a per-car seed (0..255) in its top bits
function withCarSeed(style, seed) {
  return (style & 255) + ((seed & 255) << 8);
}

const _carMaterialCache = new Map();
const _carWheelMaterialCache = new Map();
let _carPlateTexture;

// Shared procedural alloy rim, spoke, brake-rotor & tyre rubber evaluation used by both `createLoftedCarMaterial`
// (for highway cars & >90 m proxies) and `createCarWheelMaterial` (for <90 m 3D spinning wheels), keeping near/far
// wheel appearance identical across the LOD boundary.
function evalAlloyColor(wheelVec, rNorm, fwRing, fwSpoke, isPolice, isBlackout, wheelCode) {
  const one = float(1.0);
  const fadeMed = (w) => smoothstep(0.042, 0.012, w);
  const wAngle = atan(wheelVec.y, wheelVec.x);
  const inSpokeZone = smoothstep(0.14, 0.18, rNorm).mul(smoothstep(0.63, 0.59, rNorm));
  const wSel1 = step(abs(wheelCode.sub(1.0)), 0.25);
  const wSel2 = step(abs(wheelCode.sub(2.0)), 0.25);
  const spokeVal = float(0.0).toVar();
  If(isPolice.greaterThan(0.5), () => {
    const steelHoles = smoothstep(0.048, 0.028, abs(rNorm.sub(0.44))).mul(smoothstep(0.2, 0.5, cos(wAngle.mul(10.0))));
    spokeVal.assign(one.sub(steelHoles));
  }).ElseIf(wSel2.greaterThan(0.5), () => {
    const fork = mix(float(0.62), float(0.22), smoothstep(0.34, 0.56, rNorm));
    spokeVal.assign(smoothstep(0.26, 0.1, abs(cos(wAngle.mul(7.0)).sub(fork))));
  }).ElseIf(wSel1.greaterThan(0.5), () => {
    spokeVal.assign(smoothstep(0.32, 0.62, cos(wAngle.mul(10.0).add(rNorm.mul(2.2)))));
  }).Else(() => {
    const c5 = abs(cos(wAngle.mul(5.0)));
    spokeVal.assign(smoothstep(0.54, 0.68, c5).mul(one.sub(smoothstep(0.86, 0.94, c5).mul(smoothstep(0.24, 0.34, rNorm)))));
  });
  const spokes = mix(float(0.55), spokeVal, fadeMed(fwSpoke)).mul(inSpokeZone);
  const rimRing = smoothstep(0.59, 0.62, rNorm).mul(smoothstep(0.695, 0.675, rNorm));
  const centerHub = smoothstep(0.2, 0.16, rNorm);
  const lugHoles = smoothstep(0.145, 0.115, rNorm)
    .mul(smoothstep(0.08, 0.105, rNorm))
    .mul(smoothstep(0.4, 0.7, cos(wAngle.mul(5.0))))
    .mul(fadeMed(max(fwRing, fwSpoke)));
  const centerCap = smoothstep(0.075, 0.055, rNorm).mul(one.sub(isPolice));
  const alloyMetal = clamp(max(spokes, max(rimRing, centerHub)).sub(max(lugHoles.mul(0.85), centerCap.mul(0.75))), 0.0, 1.0);
  const brakeDisc = smoothstep(0.2, 0.24, rNorm).mul(smoothstep(0.5, 0.46, rNorm)).mul(one.sub(alloyMetal));
  const brakeCaliper = brakeDisc.mul(smoothstep(0.15, 0.25, wheelVec.x)).mul(smoothstep(0.05, 0.15, wheelVec.y));
  const wheelFinish = mix(
    mix(color(0xd8e0e8), color(0x4a5058), max(isBlackout, step(abs(wheelCode.sub(3.0)), 0.25))),
    color(0x181b1f),
    isPolice.mul(one.sub(centerHub))
  );
  const rotorCol = mix(mix(color(0x0c0f13), color(0x3e444b), brakeDisc), color(0x8a1c20), brakeCaliper);
  return mix(rotorCol, wheelFinish, alloyMetal);
}

function evalTyreColor(rNorm, fwRing) {
  const sidewallRib = smoothstep(0.018, 0.004, abs(rNorm.sub(0.8))).mul(0.06).mul(smoothstep(0.018, 0.005, fwRing));
  const tyreShade = smoothstep(0.88, 0.96, rNorm).mul(-0.14).add(0.92).add(sidewallRib);
  return color(0x17191c).mul(tyreShade);
}

/**
 * Lightweight TSL material for 3D steerable/spinning car wheels (`buildSteerableWheelGeo`).
 * Instanced street-traffic wheels read per-instance `wheelStyle` (`carStyleCode` float); standalone player wheels
 * bake a fixed `style` code without compiling or evaluating body/window/lamp/plate graphs.
 */
function createCarWheelMaterial({ instanced = false, style = 0, wheelRadius = BODY_SPECS.sedan.wheelRadius } = {}) {
  const cacheKey = `${instanced ? 'instanced' : `fixed_${style}`}_${wheelRadius}`;
  if (_carWheelMaterialCache.has(cacheKey)) {
    return _carWheelMaterialCache.get(cacheKey);
  }

  let isPolice, isBlackout, wheelCode;
  if (instanced) {
    const wCode = attribute('wheelStyle', 'float');
    const vWheel = varying(
      vertexStage(
        vec3(
          step(abs(floor(fract(wCode.div(8.0)).mul(8.0).add(0.5)).sub(1.0)), 0.25),
          step(abs(floor(fract(floor(wCode.div(16.0).add(0.01)).mul(0.25)).mul(4.0).add(0.5)).sub(2.0)), 0.25),
          floor(fract(floor(wCode.div(64.0).add(0.01)).mul(0.25)).mul(4.0).add(0.5))
        )
      )
    );
    isPolice = vWheel.x;
    isBlackout = vWheel.y;
    wheelCode = vWheel.z;
  } else {
    const s = style | 0;
    isPolice = float((s & 7) === 1 ? 1.0 : 0.0);
    isBlackout = float(((s >> 4) & 3) === 2 ? 1.0 : 0.0);
    wheelCode = float((s >> 6) & 3);
  }

  const p = attribute('position', 'vec3');
  const partId = attribute('partId', 'float');
  const isAlloy = step(abs(partId.sub(CAR_PARTS.ALLOY)), 0.25);
  const isTyre = step(abs(partId.sub(CAR_PARTS.TYRE)), 0.25);
  const invR = float(1 / wheelRadius);

  const colorFn = Fn(() => {
    const outCol = vec3(color(0x181b1f)).toVar();
    const wheelVec = vec2(p.z, p.y);
    const wheelDist = length(wheelVec);
    const rNorm = wheelDist.mul(invR);
    const fwZY = max(vec2(fwidth(p.z), fwidth(p.y)), vec2(0.0005)).toVar();
    const wheelDir = wheelVec.div(max(wheelDist, 0.0001));
    const fwRing = abs(wheelDir.x).mul(fwZY.x).add(abs(wheelDir.y).mul(fwZY.y));
    const fwSpoke = abs(wheelDir.y).mul(fwZY.x).add(abs(wheelDir.x).mul(fwZY.y));

    If(isAlloy.greaterThan(0.5), () => {
      outCol.assign(evalAlloyColor(wheelVec, rNorm, fwRing, fwSpoke, isPolice, isBlackout, wheelCode));
    }).ElseIf(isTyre.greaterThan(0.5), () => {
      outCol.assign(evalTyreColor(rNorm, fwRing));
    });
    return outCol;
  });

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.envMapIntensity = 1.35;
  mat.colorNode = colorFn();
  mat.roughnessNode = mix(float(0.78), mix(float(0.22), float(0.52), isPolice), isAlloy);
  mat.metalnessNode = mix(float(0.04), mix(float(0.84), float(0.22), isPolice), isAlloy);

  _carWheelMaterialCache.set(cacheKey, mat);
  return mat;
}

// One small generated atlas serves every rear plate (3 Empire Gold + 1 Excelsior White), with mipmaps for distant traffic.
function carPlateTexture() {
  if (_carPlateTexture) return _carPlateTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const rows = [
    { bg: '#f2b718', bar: '#14233c', fg: '#14233c', label: 'KBM-4728' },
    { bg: '#e8edf2', bar: '#162b4c', fg: '#162b4c', label: 'JTR-8319' },
    { bg: '#f2b718', bar: '#14233c', fg: '#14233c', label: 'HXL-2506' },
    { bg: '#f0b416', bar: '#14233c', fg: '#14233c', label: 'T748219C' }
  ];
  rows.forEach(({ bg, bar, fg, label }, row) => {
    const y0 = row * 64;
    ctx.fillStyle = bg;
    ctx.fillRect(0, y0, 128, 64);
    ctx.fillStyle = bar;
    ctx.fillRect(0, y0, 128, 13);
    ctx.fillRect(0, y0 + 56, 128, 8);
    ctx.fillStyle = bg;
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NEW YORK', 64, y0 + 7);
    ctx.fillStyle = fg;
    ctx.font = 'bold 21px monospace';
    ctx.fillText(label, 64, y0 + 35);
  });
  _carPlateTexture = new THREE.CanvasTexture(canvas);
  _carPlateTexture.colorSpace = THREE.SRGBColorSpace;
  _carPlateTexture.anisotropy = 16;
  return _carPlateTexture;
}

/**
 * Creates the TSL material for lofted vehicles.
 * Instanced traffic reads the per-instance `paintColor` (vec3) and `carState` (vec4: brake, left (+x) & right (-x)
 * turn signal, style/livery code from `carStyleCode` where 1 = NYPD) attributes; with a fixed `fixedColorHex` (the
 * player's taxi, or fixed wheels) the state is the `material.userData.carState` uniform instead, with its fourth
 * component controlling reverse lights.
 * Every mask is built once and shared by the colour, roughness, metalness & emissive graphs (TSL turns nodes used
 * more than once into temporaries), so the fragment shader evaluates each SDF a single time.
 */
function createLoftedCarMaterial(spec, fixedColorHex = null) {
  const cacheKey = `${spec.name}_${fixedColorHex ?? 'instanced'}`;
  if (_carMaterialCache.has(cacheKey)) {
    return _carMaterialCache.get(cacheKey);
  }

  const L = carLayout(spec);
  const cab = spec.cabin;
  const fixed = fixedColorHex !== null;
  const stateUniform = fixed ? uniform(new THREE.Vector4(0, 0, 0, 0)) : null;
  const state = fixed ? stateUniform : attribute('carState', 'vec4');
  const paint = fixed ? color(fixedColorHex) : attribute('paintColor', 'vec3');

  // Decode per-instance style code (livery 0..7, metallic 0..1, trim 0..3, wheel 0..3) in the vertex stage
  const wCode = fixed ? float(0.0) : state.w;
  const vStyle = varying(
    vertexStage(
      vec4(
        floor(fract(wCode.div(8.0)).mul(8.0).add(0.5)),
        step(0.5, fract(floor(wCode.div(8.0).add(0.01)).mul(0.5))),
        floor(fract(floor(wCode.div(16.0).add(0.01)).mul(0.25)).mul(4.0).add(0.5)),
        floor(fract(floor(wCode.div(64.0).add(0.01)).mul(0.25)).mul(4.0).add(0.5))
      )
    )
  );
  const livery = vStyle.x;
  const isMetallic = vStyle.y;
  const trimCode = vStyle.z;
  const wheelCode = vStyle.w;
  const isLivery = (id) => step(abs(livery.sub(id)), 0.25);

  const axleZ = float(spec.wheelZ);
  const wheelR = float(spec.wheelRadius);
  const archR = L.archR;

  // Glass outlines from the glasshouse layout: side windows in side view (z, y), windshield & backlight from above
  // (|x|, z). Optional cab.glassEnd stops the side DLO ahead of the deck so the C / D pillar stays painted body colour.
  const bc = L.belt.cowl;
  const bd = L.belt.deck;
  const glassEndZ = cab.glassEnd ?? cab.deck;
  const bEndY = L.body(glassEndZ).yE - 0.004;
  const rearEdgeMargin = cab.glassEnd !== undefined ? 0.034 : 0.065;
  const rf = L.rail.front;
  const rm = L.rail.mid;
  const rr = L.rail.rear;
  const sidePoly = [[cab.cowl, bc.y], [cab.roofFront, rf.y], [L.rail.roofMid, rm.y], [cab.roofRear, rr.y], [glassEndZ, bEndY]];
  const sideGlassPlanes = polygonPlanes(sidePoly, [0.048, 0.028, 0.028, rearEdgeMargin, 0.02]);
  const frontPoly = [[-1, cab.cowl], [-1, cab.roofFront], [rf.x, cab.roofFront], [bc.x, cab.cowl]];
  const frontGlassPlanes = polygonPlanes(frontPoly, [0, 0.042, 0.058, 0.048]);
  const rearPoly = [[-1, cab.roofRear], [-1, cab.deck], [bd.x, cab.deck], [rr.x, cab.roofRear]];
  const rearGlassPlanes = polygonPlanes(rearPoly, [0, 0.045, 0.062, 0.048]);
  const [hlX, hlY, hlW, hlH] = spec.headlight;
  const [tlX, tlY, tlW, tlH] = spec.taillight;
  const [grY, grW, grH] = spec.grille;
  const [inY, inW, inH] = spec.intake;
  const [plateF, plateR] = spec.plates;
  const frontZone = spec.zFront - 0.58;
  const rearZone = spec.zRear + 0.58;
  const sillY = spec.sill[1][1];
  const rearSill = spec.tail.sill[1];
  const signY = taxiSignPlacement(spec).y + 0.105;
  const doorMid = (spec.doors[0] + spec.doors[1]) / 2;
  const trunkBot = Math.min(spec.bumperLine[1], plateR - 0.115);
  const one = float(1.0);

  const p = attribute('position', 'vec3');
  const n = attribute('normal', 'vec3');
  const partId = attribute('partId', 'float');
  const isPart = (id) => step(abs(partId.sub(id)), 0.25);
  const isBody = isPart(CAR_PARTS.BODY);
  const isWindow = isPart(CAR_PARTS.WINDOW);
  const isTyre = isPart(CAR_PARTS.TYRE);
  const isAlloy = isPart(CAR_PARTS.ALLOY);
  const isMirror = isPart(CAR_PARTS.MIRROR);
  const isSign = isPart(CAR_PARTS.SIGN);
  const ax = abs(p.x);
  const isSide = smoothstep(0.45, 0.7, abs(n.x));
  const belt = mix(float(bd.y), float(bc.y), clamp(p.z.sub(cab.deck).div(cab.cowl - cab.deck), 0.0, 1.0));
  const ndv = clamp(dot(normalView, positionViewDirection), 0.0, 1.0);
  const fresnel = pow(one.sub(ndv), 3.2);

  // Per-axis screen footprint of the object-space position, taken outside the branches (derivatives need uniform
  // control flow). Every edge and sub-pixel fade uses the footprint across itself: on a side seen at a grazing angle
  // z is foreshortened but y is not, so horizontal lines stay sharp while door seams soften (anisotropic filtering).
  const fwp = max(fwidth(p), vec3(0.0005)).toVar();
  const fwX = fwp.x;
  const fwY = fwp.y;
  const fwZ = fwp.z;
  const fwXY = vec2(fwX, fwY);
  const fwXZ = vec2(fwX, fwZ);
  const fwZY = vec2(fwZ, fwY);
  const fadeFine = (w) => smoothstep(0.018, 0.005, w);
  const fadeMed = (w) => smoothstep(0.042, 0.012, w);
  // Edges ramp over one footprint (crisp but anti-aliased); bands |d| < h are box-filtered exactly, so thin lines
  // narrow and lighten smoothly below a pixel instead of being faded out. Only periodic patterns need the fades.
  const cov = (d, w) => smoothstep(w.mul(0.5), w.mul(-0.5), d);
  const band = (d, h, w) => clamp(min(d.add(h), w.mul(0.5)).sub(max(d.sub(h), w.mul(-0.5))).div(w), 0.0, 1.0);
  // Rounded-rect distance and the footprint across its nearest edge (the box's dominant axis), from the per-axis
  // footprints of its two coordinates
  const rrectEdge = (pt, hs, rad, fw2) => {
    const q = abs(pt).sub(hs).add(rad);
    return { d: length(max(q, vec2(0.0))).add(min(max(q.x, q.y), 0.0)).sub(rad), w: mix(fw2.y, fw2.x, step(q.y, q.x)) };
  };
  const rrect = (pt, hs, rad, fw2) => {
    const e = rrectEdge(pt, hs, rad, fw2);
    return cov(e.d, e.w);
  };
  // Footprint across the edge of max(a, b) / min(a, b) of two 1D distances with footprints wa, wb
  const maxEdgeW = (a, b, wa, wb) => mix(wa, wb, step(a, b));
  const minEdgeW = (a, b, wa, wb) => mix(wa, wb, step(b, a));

  const isPolice = fixed ? float(0.0) : isLivery(1.0);
  const isBoro = fixed ? float(0.0) : isLivery(2.0);
  const isTLC = fixed ? float(0.0) : isLivery(3.0);
  const isTwoTone = fixed ? float(0.0) : max(isLivery(4.0), step(abs(trimCode.sub(3.0)), 0.25));
  const isBlackout = step(abs(trimCode.sub(2.0)), 0.25);
  const hasChrome = max(float(spec.chrome ? 1.0 : 0.0), step(abs(trimCode.sub(1.0)), 0.25)).mul(one.sub(isBlackout));

  // Wheel arches: distance from the nearest axle in side view (or from the hub of a centred, spinning wheel)
  const isCenteredWheel = step(abs(p.z), wheelR.add(0.05)).mul(max(isTyre, isAlloy));
  const wheelVec = mix(vec2(abs(p.z).sub(axleZ), p.y.sub(wheelR)), vec2(p.z, p.y), isCenteredWheel);
  const wheelDist = length(wheelVec);
  const rNorm = wheelDist.div(wheelR);
  // Footprints across the wheel's rings (radial) and spokes (tangential) in the (z, y) wheel plane
  const wheelDir = wheelVec.div(max(wheelDist, 0.0001));
  const fwRing = abs(wheelDir.x).mul(fwZ).add(abs(wheelDir.y).mul(fwY));
  const fwSpoke = abs(wheelDir.y).mul(fwZ).add(abs(wheelDir.x).mul(fwY));
  const proxyAlloy = isTyre.mul(cov(rNorm.sub(0.60).mul(wheelR), fwRing)).mul(smoothstep(0.68, 0.82, abs(n.x)));
  const isAlloyFace = max(isAlloy, proxyAlloy);
  const isTyreRubber = isTyre.sub(proxyAlloy);

  const paintLuma = dot(paint, vec3(0.299, 0.587, 0.114));
  const whiteComp = mix(float(0.98), float(0.84), smoothstep(0.60, 0.92, paintLuma));
  const paintFlop = mix(one, ndv.mul(0.22).add(0.82), isMetallic);
  const basePaint = paint.mul(whiteComp).mul(paintFlop);
  const archLip = smoothstep(archR + 0.05, archR - 0.005, wheelDist).mul(smoothstep(0.6, 0.9, ax));
  const ao = smoothstep(0.22, 0.66, p.y).mul(0.2).add(0.8).mul(one.sub(archLip.mul(0.55)));

  // Road film thrown up by the tyres: over the lower body (higher towards the tail), around & behind the wheel arches
  // and up the rear, broken into streaks. How dirty a car is comes from its seed: most are fairly clean.
  const vDirt = varying(vertexStage(fract(floor(wCode.div(256.0).add(0.01)).mul(0.371).add(0.13))));
  const dirtAmount = vDirt.mul(vDirt).mul(0.8).add(0.12);
  const dirtMask = () => {
    const rearward = clamp(p.z.sub(spec.zFront).div(spec.zRear - spec.zFront), 0.0, 1.0);
    const lowLine = rearward.mul(0.2).add(sillY + 0.2);
    const low = smoothstep(lowLine, lowLine.sub(0.22), p.y);
    let spray = float(0.0);
    for (const axle of [spec.wheelZ, -spec.wheelZ]) {
      const behind = float(axle - archR).sub(p.z);
      spray = max(spray, smoothstep(0.75, 0.0, behind).mul(step(-0.02, behind)).mul(smoothstep(spec.wheelRadius * 2 + 0.1, sillY, p.y)));
    }
    const arch = smoothstep(archR + 0.1, archR, wheelDist);
    const tail = smoothstep(rearZone + 0.15, rearZone - 0.1, p.z).mul(smoothstep(-0.2, -0.6, n.z)).mul(smoothstep(plateR + 0.3, sillY, p.y));
    const streaks = wave(p.z.mul(2.3).add(p.y.mul(0.9))).mul(wave(p.z.mul(5.1).sub(p.y.mul(1.7)).add(0.37))).mul(0.45).add(0.55);
    return clamp(max(max(low, spray.mul(0.85)), max(arch.mul(0.8), tail)).mul(streaks), 0.0, 1.0);
  };
  const tlSize = vec2(tlW * 1.04, tlH * 1.2);

  // Shared glasshouse polygon evaluation (used by colorNode, roughnessNode & metalnessNode on CAR_PARTS.WINDOW only)
  const evalWindowGlass = () => {
    const side = polygonEdge(p.z, p.y, sideGlassPlanes, 0.065, fwZ, fwY);
    let dSideG = side.d;
    let wSideG = side.w;
    const pillarCut = (zp, halfWidth) => {
      const e = float(halfWidth).sub(abs(p.z.sub(zp)));
      wSideG = maxEdgeW(dSideG, e, wSideG, fwZ);
      dSideG = max(dSideG, e);
    };
    for (const zp of cab.pillars) pillarCut(zp, 0.038);
    if (cab.pillars.length === 1) pillarCut(cab.roofRear - 0.04, 0.014);
    const front = polygonEdge(ax, p.z, frontGlassPlanes, 0.085, fwX, fwZ);
    const sideGlass = cov(dSideG, wSideG);
    const frontGlass = cov(front.d, front.w);
    const rear = spec.cargo ? null : polygonEdge(ax, p.z, rearGlassPlanes, 0.085, fwX, fwZ);
    const rearGlass = rear ? cov(rear.d, rear.w) : float(0.0);
    const glass = max(max(sideGlass, frontGlass), rearGlass);
    // The seal follows the nearest outline, filtered across that outline
    let dSeal = side.d;
    let wSeal = side.w;
    for (const o of rear ? [front, rear] : [front]) {
      wSeal = minEdgeW(dSeal, o.d, wSeal, o.w);
      dSeal = min(dSeal, o.d);
    }
    const seal = cov(dSeal.sub(0.016), wSeal);
    return { glass, frontGlass, rearGlass, seal };
  };

  // Lamp, roof-sign & CHMSL masks shared by the colour and emissive graphs (each evaluates them in its own branch)
  const headlightMasks = () => {
    const hlUV = vec2(ax.sub(hlX), p.y.sub(hlY).sub(ax.sub(hlX).mul(0.032)));
    const headlight = rrect(hlUV, vec2(hlW, hlH), 0.014, fwXY).mul(smoothstep(0.02, 0.25, n.z));
    const turnFront = smoothstep(hlW * 0.76, hlW * 0.83, hlUV.x).mul(headlight);
    const lit = headlight.mul(one.sub(turnFront));
    const projUV = vec2(abs(hlUV.x.add(hlW * 0.09)).sub(hlW * 0.25), hlUV.y.sub(hlH * 0.08));
    const proj = rrectEdge(projUV, vec2(hlW * 0.165, hlH * 0.44), 0.009, fwXY);
    const drlH = max(abs(hlUV.y.add(hlH * 0.60)), max(hlUV.x.sub(hlW * 0.67), float(-hlW * 0.82).sub(hlUV.x)));
    const drlV = max(abs(hlUV.x.sub(hlW * 0.67)), max(hlUV.y.sub(hlH * 0.48), float(-hlH * 0.60).sub(hlUV.y)));
    return {
      headlight,
      turnFront,
      projBucket: cov(proj.d.sub(0.008), proj.w).mul(lit),
      projRing: cov(proj.d.sub(0.002), proj.w).mul(lit),
      headlightLens: cov(proj.d.add(0.004), proj.w).mul(lit),
      drl: cov(min(drlH, drlV).sub(0.0045), minEdgeW(drlH, drlV, fwY, fwX)).mul(lit)
    };
  };
  const taillightMasks = () => {
    const tlUV = vec2(ax.sub(tlX), p.y.sub(tlY));
    const tail = rrectEdge(tlUV, tlSize, 0.018, fwXY);
    const taillight = cov(tail.d, tail.w).mul(smoothstep(0.02, 0.25, n.z.negate()));
    const lowerStrip = smoothstep(-tlH * 0.12, -tlH * 0.24, tlUV.y);
    return {
      tlUV,
      taillight,
      tailLens: cov(tail.d.add(0.0045), tail.w).mul(taillight),
      turnRearSection: lowerStrip.mul(smoothstep(0.0, tlW * 0.08, tlUV.x)),
      reverseRearSection: lowerStrip.mul(smoothstep(tlW * 0.04, -tlW * 0.04, tlUV.x)),
      ledBar: max(band(tlUV.y.sub(tlH * 0.36), 0.0085, fwY), band(tlUV.y.add(tlH * 0.02), 0.0085, fwY))
    };
  };
  const signGlyphMask = () => smoothstep(0.25, 0.58, sin(p.x.mul(90.0)))
    .mul(band(p.x, 0.17, fwX))
    .mul(band(p.y.sub(signY), 0.042, fwY))
    .mul(fadeFine(fwX));
  const chmslMask = (rearGlass) => spec.barnDoors
    ? rrect(vec2(p.x, p.y.sub(spec.barnDoors[1] + 0.055)), vec2(0.16, 0.015), 0.005, fwXY)
        .mul(smoothstep(-0.15, -0.45, n.z))
        .mul(smoothstep(rearZone + 0.05, rearZone - 0.05, p.z))
    : rrect(vec2(p.x, p.z.sub(cab.roofRear - 0.075)), vec2(0.16, 0.011), 0.005, fwXZ)
        .mul(rearGlass())
        .mul(smoothstep(-0.05, -0.2, n.z));

  // ---- Colour (per-part If branches so each fragment only evaluates its own part's masks) ---------------------------
  const colorFn = Fn(() => {
    const outCol = vec3(color(0x181b1f)).toVar();

    // Sample plate texture outside If() so hardware mipmaps + anisotropy filter cleanly without derivative issues
    const plateVariant = floor(fract(paint.r.mul(7).add(paint.g.mul(13)).add(paint.b.mul(17)).add(isTLC.mul(0.75))).mul(4));
    const isFrontSide = smoothstep(-0.02, 0.02, n.z);
    const plateSignX = mix(float(-0.31), float(0.31), isFrontSide);
    const plateCenterY = mix(float(plateR), float(plateF), isFrontSide);
    const plateUV = vec2(
      clamp(p.x.div(plateSignX).add(0.5), 0.02, 0.98),
      clamp(p.y.sub(plateCenterY).div(0.115).add(0.5), 0.06, 0.94).add(plateVariant).div(4.0)
    );
    const plateCol = texture(carPlateTexture(), plateUV).rgb;

    If(isBody.greaterThan(0.5), () => {
      const bCol = vec3(basePaint.mul(ao)).toVar();
      if (spec.cladding > 0) {
        const clad = max(smoothstep(spec.cladding + 0.01, spec.cladding - 0.01, p.y), smoothstep(archR + 0.068, archR + 0.052, wheelDist));
        bCol.assign(mix(bCol, color(0x1d2024), clad));
      }
      if (spec.bedCover) {
        const bedTop = cov(p.z.sub(cab.deck - 0.01), fwZ).mul(cov(float(spec.zRear + 0.08).sub(p.z), fwZ)).mul(smoothstep(0.68, 0.85, n.y)).mul(cov(ax.sub(0.88), fwX));
        bCol.assign(mix(bCol, color(0x16191d), bedTop));
      }
      const grime = smoothstep(sillY + 0.16, sillY - 0.01, p.y).mul(0.2);
      bCol.assign(mix(bCol, color(0x2d2b28), grime));
      bCol.assign(mix(bCol, color(0x6a6357).mul(ao), dirtMask().mul(dirtAmount).mul(0.6)));

      // Side doors, handles & liveries (evaluated only on side-facing body fragments)
      If(isSide.greaterThan(0.05), () => {
        const hasLivery = max(isPolice, max(isBoro, float(spec.sign ? 1.0 : 0.0)));
        If(hasLivery.greaterThan(0.5), () => {
          const along = smoothstep(spec.zRear + 0.22, spec.zRear + 0.3, p.z).mul(smoothstep(spec.zFront - 0.28, spec.zFront - 0.36, p.z));
          const stripe = band(p.y.sub(0.57), 0.072, fwY).mul(along);
          const pin = band(p.y.sub(0.675), 0.011, fwY).mul(along);
          const letterPattern = mix(float(0.35), smoothstep(0.2, 0.55, sin(p.z.mul(72.0))), fadeFine(fwZ));
          const lettering = letterPattern
            .mul(band(p.y.sub(0.765), 0.042, fwY))
            .mul(band(p.z.sub(doorMid), 0.24, fwZ));
          const polMask = isPolice.mul(isSide).mul(ao);
          bCol.assign(mix(mix(bCol, color(0x1b3d8a), max(stripe, lettering).mul(polMask)), color(0x6ba5dc), pin.mul(polMask)));

          const hasTaxiBadge = max(float(spec.sign ? 1.0 : 0.0), isBoro).mul(isSide);
          const badge = rrect(vec2(p.z.sub(doorMid), p.y.sub(0.66)), vec2(0.21, 0.052), 0.012, fwZY).mul(hasTaxiBadge);
          const emblemUV = vec2(abs(p.z.sub(doorMid)).sub(0.15), p.y.sub(0.66));
          const emblemLen = length(emblemUV);
          const emblemW = abs(emblemUV.x).mul(fwZ).add(abs(emblemUV.y).mul(fwY)).div(max(emblemLen, 0.0001));
          const emblem = cov(emblemLen.sub(0.039), emblemW);
          const letters = mix(float(0.4), smoothstep(0.15, 0.55, sin(p.z.mul(95.0))), fadeFine(fwZ))
            .mul(band(p.z.sub(doorMid), 0.1, fwZ))
            .mul(band(p.y.sub(0.66), 0.028, fwY));
          const badgeFg = mix(color(0xffbe14), color(0xeaf4e6), isBoro).mul(ao);
          bCol.assign(mix(mix(bCol, color(0x121417), badge), badgeFg, max(emblem, letters).mul(badge)));
        });

        const frontOfSlide = spec.slidingDoor ? smoothstep(spec.slidingDoor[0] + 0.02, spec.slidingDoor[0] + 0.06, p.z) : one;
        const sideDoorMask = spec.slidingDoor ? max(frontOfSlide, step(p.x, 0.0)) : one;
        const topDoorFade = spec.slidingDoor ? mix(one, smoothstep(0.0, -0.015, p.y.sub(belt)), frontOfSlide) : smoothstep(0.0, -0.015, p.y.sub(belt));
        const onDoors = isSide.mul(smoothstep(sillY + 0.04, sillY + 0.07, p.y)).mul(topDoorFade).mul(sideDoorMask);
        let seams = float(0.0);
        for (const zd of spec.doors) seams = max(seams, band(p.z.sub(zd), 0.0035, fwZ));
        let hDistZ = abs(p.z.sub(spec.handles[0]));
        for (let i = 1; i < spec.handles.length; i++) hDistZ = min(hDistZ, abs(p.z.sub(spec.handles[i])));
        const hUV = vec2(hDistZ, p.y.sub(belt.sub(0.092)));
        const handle = rrectEdge(hUV, vec2(0.066, 0.0085), 0.005, fwZY);
        const handleBar = cov(handle.d, handle.w).mul(onDoors);
        const pocket = rrectEdge(vec2(hDistZ, hUV.y.add(0.002)), vec2(0.028, 0.015), 0.009, fwZY);
        const handlePocket = cov(pocket.d.sub(0.004), pocket.w)
          .mul(one.sub(handleBar))
          .mul(onDoors);
        bCol.assign(bCol.mul(one.sub(seams.mul(onDoors).mul(0.58))).mul(one.sub(handlePocket.mul(0.68))));
        bCol.assign(mix(bCol, mix(bCol.mul(1.12), color(0xd8dfe6), hasChrome.mul(0.75)), handleBar));
        if (spec.slidingDoor) {
          const sdRear = spec.slidingDoor[1];
          const slideTrack = rrect(vec2(p.z.sub(sdRear - 0.42), p.y.sub(belt.sub(0.048))), vec2(0.42, 0.009), 0.004, fwZY)
            .mul(step(p.x, 0.0))
            .mul(isSide);
          bCol.assign(mix(bCol, color(0x121519), slideTrack));
        }
      });

      // Front fascia: headlamps, honeycomb grille, lower intake, air curtains & front NY license plate
      If(p.z.greaterThan(frontZone).and(n.z.greaterThan(0.02)), () => {
        const front = smoothstep(0.12, 0.38, n.z);
        const hoodSeam = band(p.y.sub(spec.bumperLine[0]), 0.0035, fwY)
          .mul(cov(ax.sub(hlX - hlW * 0.5), fwX))
          .mul(front);
        bCol.assign(bCol.mul(one.sub(hoodSeam.mul(0.52))));

        const g = rrectEdge(vec2(p.x, p.y.sub(grY)), vec2(grW, grH), 0.015, fwXY);
        const grille = cov(g.d, g.w).mul(front);
        const grilleOuter = cov(g.d.sub(0.013), g.w).mul(front);
        const grilleWing = band(p.y.sub(grY + grH * 0.12), 0.0045, fwY).mul(grille);
        const grilleFrame = max(grilleOuter.sub(grille), grilleWing.mul(0.75));
        const emblemFront = rrect(vec2(p.x, p.y.sub(grY + grH * 0.12)), vec2(0.032, 0.015), 0.008, fwXY).mul(grille);
        const intake = rrect(vec2(p.x, p.y.sub(inY)), vec2(inW, inH), 0.032, fwXY).mul(front);
        const airCurtain = rrect(vec2(ax.sub(hlX + hlW * 0.42), p.y.sub(inY + 0.03)), vec2(0.042, inH * 0.85), 0.014, fwXY).mul(front);
        const meshWave = smoothstep(-0.1, 0.35, sin(p.x.add(p.y).mul(110.0)).mul(sin(p.x.sub(p.y).mul(110.0))));
        const meshPattern = mix(float(0.68), meshWave.mul(0.38).add(0.52), fadeFine(max(fwX, fwY)));
        const slatWave = smoothstep(0.3, 0.6, fract(p.y.mul(52.0)));
        const intakeSlats = mix(float(0.72), slatWave.mul(0.35).add(0.55), fadeFine(fwY));
        const frameCol = mix(color(0x181b20), color(0xd2d8de), hasChrome);
        bCol.assign(mix(bCol, frameCol, grilleFrame));
        bCol.assign(mix(bCol, color(0x101317).mul(meshPattern), grille.mul(one.sub(grilleWing))));
        bCol.assign(mix(bCol, color(0xd4dbe2), emblemFront));
        bCol.assign(mix(bCol, color(0x0f1216).mul(intakeSlats), max(intake, airCurtain)));

        const { headlight, turnFront, projBucket, projRing, headlightLens, drl } = headlightMasks();
        const lampBezel = mix(mix(color(0x13171d), color(0x4a535e), projBucket), color(0x9ea8b2), projRing.mul(0.78));
        const lampColor = mix(mix(lampBezel, color(0xf4f8ff), headlightLens), color(0xffffff), drl);
        bCol.assign(mix(bCol, mix(lampColor, color(0xb85e16), turnFront), headlight));

        const frontPlateEdge = rrectEdge(vec2(p.x, p.y.sub(plateF)), vec2(0.155, 0.055), 0.008, fwXY);
        const plateRecessF = cov(frontPlateEdge.d.sub(0.015), frontPlateEdge.w).mul(front);
        const plateFront = cov(frontPlateEdge.d, frontPlateEdge.w).mul(front);
        bCol.assign(mix(bCol, color(0x1e2227), plateRecessF));
        bCol.assign(mix(bCol, plateCol, plateFront));
      }).ElseIf(p.z.lessThan(rearZone).and(n.z.lessThan(-0.02)), () => {
        // Rear fascia: wraparound tail lamps, diffuser, exhausts & rear NY license plate
        const rear = smoothstep(0.12, 0.38, n.z.negate());
        const rearPlateEdge = rrectEdge(vec2(p.x, p.y.sub(plateR)), vec2(0.155, 0.06), 0.008, fwXY);
        const platePocket = rrect(vec2(p.x, p.y.sub(plateR + 0.01)), vec2(0.24, 0.105), 0.03, fwXY).mul(rear);
        let trunkSeam;
        if (spec.barnDoors) {
          const [barnW] = spec.barnDoors;
          const barnSide = ax.sub(barnW);
          const barnBottom = float(trunkBot).sub(p.y);
          const barnEdgeW = maxEdgeW(barnBottom, barnSide, fwY, fwX);
          const barnOutline = band(max(barnSide, barnBottom), 0.0035, barnEdgeW);
          const barnSplit = band(p.x, 0.0045, fwX).mul(cov(barnBottom, fwY));
          trunkSeam = max(barnOutline, barnSplit).mul(rear).mul(one.sub(platePocket));
        } else {
          const trunkWidth = mix(float(tlX - tlW - 0.025), float(tlX), smoothstep(tlY - tlH, spec.tail.edge[1], p.y));
          const trunkSide = ax.sub(trunkWidth);
          const trunkBottom = float(trunkBot).sub(p.y);
          const trunkW = maxEdgeW(trunkBottom, trunkSide, fwY, fwX);
          trunkSeam = band(max(trunkSide, trunkBottom), 0.003, trunkW).mul(rear).mul(one.sub(platePocket));
        }
        bCol.assign(bCol.mul(one.sub(trunkSeam.mul(0.56))));

        const pocketShade = smoothstep(plateR - 0.09, plateR + 0.115, p.y).mul(-0.25).add(0.9);
        bCol.assign(mix(bCol, bCol.mul(pocketShade), platePocket));

        const { tlUV, taillight, tailLens, turnRearSection, reverseRearSection, ledBar: ledBarMask } = taillightMasks();
        const tailgateHandle = spec.bedCover
          ? rrect(vec2(p.x, p.y.sub(tlY + tlH * 0.42)), vec2(0.085, 0.016), 0.005, fwXY).mul(rear)
          : spec.barnDoors
            ? rrect(vec2(p.x.add(0.072), p.y.sub(1.04)), vec2(0.013, 0.056), 0.005, fwXY).mul(rear)
            : float(0.0);
        const ledBar = ledBarMask.mul(tailLens).mul(one.sub(max(turnRearSection, reverseRearSection)));
        const tailFacet = smoothstep(-tlH, tlH, tlUV.y).mul(0.28).add(0.78);
        const tailRuby = mix(color(0x981018).mul(tailFacet), color(0xff2834), ledBar);
        const tailColor = mix(mix(tailRuby, color(0xf07818), turnRearSection), color(0xe4edf4), reverseRearSection);

        const rearValance = smoothstep(rearSill + 0.075, rearSill + 0.02, p.y).mul(rear);
        const exhaust = rrectEdge(vec2(ax.sub(0.5), p.y.sub(rearSill + 0.036)), vec2(0.052, 0.017), 0.008, fwXY);
        const exhaustRim = cov(exhaust.d, exhaust.w).mul(rearValance);
        const exhaustBore = cov(exhaust.d.add(0.006), exhaust.w).mul(rearValance);
        const reflector = rrect(vec2(ax.sub(0.65), p.y.sub(spec.bumpers[1][0] + 0.04)), vec2(0.075, 0.01), 0.004, fwXY).mul(rear);
        const emblemRear = spec.barnDoors
          ? float(0.0)
          : rrect(vec2(p.x, p.y.sub(tlY - tlH * 0.12)), vec2(0.022, 0.01), 0.009, fwXY).mul(rear);

        bCol.assign(mix(bCol, color(0x14171b), max(rearValance, tailgateHandle)));
        bCol.assign(mix(mix(bCol, color(0x828a92), exhaustRim), color(0x060709), exhaustBore));
        bCol.assign(mix(bCol, color(0x8a0c14), reflector));
        bCol.assign(mix(bCol, color(0x16090c), taillight));
        bCol.assign(mix(bCol, tailColor, tailLens));
        bCol.assign(mix(bCol, color(0xb8c0c8), emblemRear));

        const plateRecessR = cov(rearPlateEdge.d.sub(0.02), rearPlateEdge.w).mul(rear);
        const plateRear = cov(rearPlateEdge.d, rearPlateEdge.w).mul(rear);
        bCol.assign(mix(bCol, color(0x1e2227), plateRecessR));
        bCol.assign(mix(bCol, plateCol, plateRear));
      });

      const under = smoothstep(-0.25, -0.55, n.y);
      outCol.assign(mix(bCol, color(0x0c0e11), under));
    }).ElseIf(isWindow.greaterThan(0.5), () => {
      const { glass, frontGlass, rearGlass, seal } = evalWindowGlass();
      const beltStrip = band(p.y.sub(belt.add(0.01)), 0.007, fwY)
        .mul(smoothstep(0.5, 0.7, abs(n.x)))
        .mul(cov(float(glassEndZ + 0.03).sub(p.z), fwZ))
        .mul(cov(p.z.sub(cab.cowl - 0.07), fwZ));
      const chromeBelt = beltStrip.mul(hasChrome);
      const chmsl = chmslMask(() => rearGlass);
      const rearWiper = spec.rearWiper
        ? rrect(vec2(p.x.add(0.15), p.z.sub(cab.deck + 0.075)), vec2(0.22, 0.006), 0.003, fwXZ).mul(rearGlass)
        : float(0.0);

      const carSeed = floor(wCode.div(256.0).add(0.01));
      const interiorHash = fract(carSeed.mul(0.618034).add(paint.r.mul(7.13)).add(paint.g.mul(13.7)).add(paint.b.mul(17.3)));
      // Traced only where there is glass, and only near: beyond ~45 m the cabin is a few dim pixels behind the
      // reflections, so it fades to its average
      const distance = positionView.z.negate();
      // (screen derivatives for the view ray, taken here for the glasshouse only: whole quads of it, except along its
      // edge with the body, where there is no glass)
      const rayDerivatives = viewRayDerivatives(p);
      const cabinCol = vec3(0.02).toVar();
      If(glass.greaterThan(0.004).and(distance.lessThan(45.0)), () => {
        cabinCol.assign(mix(cabinInterior(spec, p, objectViewRay(rayDerivatives), interiorHash), vec3(0.02), smoothstep(35.0, 45.0, distance)));
      });
      // Green-grey laminated glass; privacy glass behind the B-pillar on SUVs & minivans. Fresnel reflection takes
      // over towards grazing angles
      const tint = spec.privacyGlass
        ? mix(vec3(0.6, 0.66, 0.64), vec3(0.17, 0.19, 0.19), step(p.z, cab.pillars[0]))
        : vec3(0.6, 0.66, 0.64);
      const glassBase = cabinCol.mul(tint).mul(float(1.0).sub(fresnel.mul(0.85)));
      const tlcSticker = rrect(vec2(p.x.add(bc.x - 0.16), p.z.sub(cab.cowl - 0.14)), vec2(0.045, 0.03), 0.008, fwXZ)
        .mul(frontGlass)
        .mul(isTLC);
      const glassCol = mix(glassBase, color(0x3a88e8), tlcSticker.mul(0.65));
      let roofPaint = mix(basePaint.mul(ao), color(0x111418), isTwoTone.mul(cov(float(rf.y - 0.04).sub(p.y), fwY)));
      if (spec.slidingDoor) {
        const [sdFront, sdRear, sdTop] = spec.slidingDoor;
        const sdMidZ = (sdFront + sdRear) * 0.5;
        const sdHalfZ = (sdFront - sdRear) * 0.5;
        const slideSide = abs(p.z.sub(sdMidZ)).sub(sdHalfZ);
        const slideTop = p.y.sub(sdTop);
        const slideW = maxEdgeW(slideTop, slideSide, fwY, fwZ);
        const slideSeamW = band(max(slideSide, slideTop), 0.0035, slideW).mul(step(p.x, -0.2)).mul(isSide);
        const panelRibW = band(p.z.add(1.98), 0.0035, fwZ).mul(cov(slideTop, fwY)).mul(isSide).mul(0.55);
        roofPaint = roofPaint.mul(one.sub(max(slideSeamW, panelRibW).mul(0.58)));
      }
      if (spec.barnDoors) {
        const [barnW, barnTop] = spec.barnDoors;
        const rearWall = smoothstep(-0.15, -0.45, n.z).mul(smoothstep(rearZone + 0.05, rearZone - 0.05, p.z));
        const barnSide = ax.sub(barnW);
        const barnTopD = p.y.sub(barnTop);
        const barnEdgeW = maxEdgeW(barnTopD, barnSide, fwY, fwX);
        const barnOutlineW = band(max(barnSide, barnTopD), 0.0035, barnEdgeW);
        const barnSplitW = band(p.x, 0.0045, fwX).mul(cov(barnTopD, fwY));
        const barnSeamW = max(barnOutlineW, barnSplitW).mul(rearWall);
        const barnHinge = rrect(vec2(ax.sub(barnW), abs(p.y.sub(1.78)).sub(0.34)), vec2(0.022, 0.03), 0.005, fwXY).mul(rearWall);
        roofPaint = mix(roofPaint.mul(one.sub(barnSeamW.mul(0.58))), color(0x14171b), barnHinge);
      }
      const wCol = mix(
        mix(mix(mix(roofPaint, color(0x111315), max(seal, beltStrip)), glassCol, glass), color(0xd2d8de), chromeBelt),
        color(0x6a0a0e),
        chmsl
      );
      outCol.assign(mix(wCol, color(0x14171a), rearWiper));
    }).ElseIf(isAlloyFace.greaterThan(0.5), () => {
      outCol.assign(evalAlloyColor(wheelVec, rNorm, fwRing, fwSpoke, isPolice, isBlackout, wheelCode));
    }).ElseIf(isTyreRubber.greaterThan(0.5), () => {
      outCol.assign(evalTyreColor(rNorm, fwRing));
    }).ElseIf(isMirror.greaterThan(0.5), () => {
      const mirrorGlass = smoothstep(0.45, 0.65, n.z.negate());
      const mirrorTurn = smoothstep(0.05, 0.2, n.z)
        .mul(band(p.y.sub(bc.y + 0.082), 0.006, fwY))
        .mul(cov(float(0.88).sub(ax), fwX));
      const mirrorCapPaint = mix(basePaint, color(0x121519), max(isTwoTone, isBlackout));
      outCol.assign(mix(mix(mirrorCapPaint, color(0x8896a2), mirrorGlass), color(0x98a4ae), mirrorTurn));
    }).ElseIf(isSign.greaterThan(0.5), () => {
      const signFace = smoothstep(0.55, 0.75, abs(n.z));
      const signGlyph = signGlyphMask();
      outCol.assign(mix(color(0xf3efe2), mix(color(0xfff1b8), color(0x15181b), signGlyph), signFace));
    });

    return outCol;
  });

  // ---- Roughness & metalness (glossy clearcoat with tight sun highlight & strong SSR/IBL reflection) ---------------
  const paintRough = mix(float(0.11), float(0.16), isMetallic);
  const paintMetal = mix(float(0.32), float(0.42), isMetallic).add(fresnel.mul(0.14));

  const roughFn = Fn(() => {
    const r = float(0.78).toVar();
    If(isBody.greaterThan(0.5), () => {
      const lowMatte = smoothstep(sillY + 0.10, sillY - 0.01, p.y).mul(0.16);
      r.assign(paintRough.add(lowMatte).add(dirtMask().mul(dirtAmount).mul(0.5)));
    }).ElseIf(isWindow.greaterThan(0.5), () => {
      const { glass, seal } = evalWindowGlass();
      r.assign(mix(mix(paintRough, float(0.78), seal), float(0.08), glass));
    }).ElseIf(isAlloyFace.greaterThan(0.5), () => {
      r.assign(mix(float(0.22), float(0.52), isPolice));
    }).ElseIf(isMirror.greaterThan(0.5), () => {
      r.assign(0.12);
    }).ElseIf(isSign.greaterThan(0.5), () => {
      r.assign(0.35);
    });
    return r;
  });

  const metalFn = Fn(() => {
    const m = float(0.04).toVar();
    If(isBody.greaterThan(0.5), () => {
      m.assign(paintMetal);
    }).ElseIf(isWindow.greaterThan(0.5), () => {
      const { glass, seal } = evalWindowGlass();
      m.assign(mix(mix(paintMetal, float(0.04), seal), mix(float(0.16), float(0.36), fresnel), glass));
    }).ElseIf(isAlloyFace.greaterThan(0.5), () => {
      m.assign(mix(float(0.84), float(0.22), isPolice));
    }).ElseIf(isMirror.greaterThan(0.5), () => {
      m.assign(mix(paintMetal, float(0.65), smoothstep(0.45, 0.65, n.z.negate())));
    });
    return m;
  });

  // ---- Emissive (evaluated only on front/rear lamp zones, taxi sign, or braking rear window) -----------------------
  const brake = state.x;
  const blink = max(state.y.mul(step(0.0, p.x)), state.z.mul(step(p.x, 0.0)));
  const nightHeadlamp = smoothstep(0.60, 1.15, cityUniforms.uInteriorGlow);

  const emissiveFn = Fn(() => {
    const emit = vec3(0.0).toVar();
    If(isBody.greaterThan(0.5), () => {
      If(p.z.greaterThan(frontZone).and(n.z.greaterThan(0.02)), () => {
        const { turnFront, headlightLens, drl } = headlightMasks();
        const headlamps = color(0xfff8ec)
          .mul(headlightLens.mul(nightHeadlamp.mul(1.35).add(1.45)).add(drl.mul(nightHeadlamp.mul(0.75).add(1.65))))
          .mul(one.sub(max(turnFront, drl).mul(blink)));
        const turn = color(0xff9812).mul(max(turnFront, drl.mul(0.75)).mul(blink).mul(2.4));
        emit.assign(headlamps.add(turn));
      }).ElseIf(p.z.lessThan(rearZone).and(n.z.lessThan(-0.02)), () => {
        const { tailLens, turnRearSection, reverseRearSection, ledBar: ledBarMask } = taillightMasks();
        const turnRear = turnRearSection.mul(tailLens);
        const redArea = tailLens.mul(one.sub(max(turnRearSection, reverseRearSection)));
        const ledBar = ledBarMask.mul(redArea);
        const redLens = max(redArea.mul(0.58), ledBar);
        const tail = color(0xff0c16).mul(redLens.mul(brake.mul(2.3).add(nightHeadlamp.mul(0.55)).add(0.24)));
        const turn = color(0xff9812).mul(turnRear.mul(blink).mul(2.4));
        let rearEmit = tail.add(turn);
        if (fixed) rearEmit = rearEmit.add(color(0xf0f6ff).mul(tailLens).mul(reverseRearSection).mul(state.w).mul(1.8));
        emit.assign(rearEmit);
      });
    }).ElseIf(isSign.greaterThan(0.5), () => {
      const signFace = smoothstep(0.55, 0.75, abs(n.z));
      const signGlyph = signGlyphMask();
      emit.assign(color(0xffe28a).mul(signFace.mul(one.sub(signGlyph.mul(0.9))).mul(1.65)));
    }).ElseIf(isWindow.mul(brake).greaterThan(0.5), () => {
      const chmsl = chmslMask(() => {
        const rear = polygonEdge(ax, p.z, rearGlassPlanes, 0.085, fwX, fwZ);
        return cov(rear.d, rear.w);
      });
      emit.assign(color(0xff0c16).mul(chmsl.mul(2.3)));
    });
    return emit;
  });

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.envMapIntensity = 1.35;
  if (fixed) mat.userData.carState = stateUniform;
  mat.colorNode = colorFn();
  mat.roughnessNode = roughFn();
  mat.metalnessNode = metalFn();
  mat.emissiveNode = emissiveFn();

  _carMaterialCache.set(cacheKey, mat);
  return mat;
}

export {
  CAR_PARTS,
  BODY_SPECS,
  carLayout,
  carBodyHalfWidthAt,
  carTipZ,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  buildCarGeometry,
  buildCarProxyGeometry,
  createLoftedCarMaterial,
  createCarWheelMaterial,
  carStyleCode,
  withCarSeed,
  viewRayDerivatives,
  objectViewRay,
  throughGlass,
  buildLightbarGeometry,
  createLightbarMaterial,
  buildBodyLoft
};
