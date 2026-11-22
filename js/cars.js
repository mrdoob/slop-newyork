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
  instanceIndex,
  struct
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
    // Fascias, painted by createLoftedCarMaterial (fasciaFront / fasciaRear). Lamps are quads given by their inner &
    // outer ends [u, bottom y, top y], u being |x| across the face that carries on round the corner along the side, so
    // lamps wrap into the fenders & quarter panels. Outlines are [|x|, y] polygons, counter-clockwise.
    // Mid-size sedan of the 2010s: rounded-rectangle lamps with a level top, a chrome-framed barred grille between
    // them, a small lower intake & fog lamps
    front: {
      lamp: { inner: [0.42, 0.64, 0.755], outer: [0.98, 0.66, 0.765], round: 0.03, drl: 'none', projectors: [0.28] },
      hood: 0.792, // hood shut line across the face
      grille: { outline: [[0, 0.6], [0.4, 0.6], [0.41, 0.74], [0, 0.74]], round: 0.03, mesh: 'bars', frame: 0.018 },
      intake: { outline: [[0, 0.36], [0.42, 0.36], [0.46, 0.5], [0, 0.5]], round: 0.04 },
      fogs: [0.7, 0.42, 0.045, 0.03] // fog lamp pods: |x|, y, half-width, half-height
    },
    // Level lamps wrapping round the corners onto the trunk lid (whose shut line runs through them), an emblem between
    // them, the plate in a recess on the lid, reflectors at the bumper's corners, a black valance with exhausts
    rear: {
      lamp: { inner: [0.44, 0.79, 0.885], outer: [1.0, 0.782, 0.892], round: 0.028, led: 'c' },
      lid: [0.62, 0.555], // trunk lid half-width & bottom edge (shut lines)
      emblem: [0.84, 0.042, 0.03], // centre badge: y, half-width, half-height
      badges: [[-0.45, 0.7, 0.085, 0.013, 0]], // chrome lettering: x, y, half-width, half-height, word (BADGE_WORDS)
      crease: 0.525, // a crease across the bumper
      reflector: [0.76, 0.47, 0.05, 0.011], // |x|, y, half-width, half-height
      diffuser: 0.43,
      exhaust: [0.5, 0.396]
    },
    plates: [0.46, 0.665], // front / rear plate centre heights
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
    // Compact / mid-size SUV: angular lamps with an L-shaped running light either side of a wide hexagonal grille
    // with horizontal bars; fog pods, a lower intake & a silver skid plate in the black lower bumper
    front: {
      lamp: { inner: [0.42, 0.852, 0.918], outer: [1.06, 0.838, 0.968], round: 0.016, drl: 'l', projectors: [0.36, 0.56] },
      hood: 0.968,
      grille: { outline: [[0, 0.625], [0.5, 0.625], [0.575, 0.705], [0.41, 0.905], [0, 0.905]], round: 0.03, mesh: 'bars', frame: 0.022 },
      intake: { outline: [[0, 0.47], [0.5, 0.47], [0.53, 0.585], [0, 0.585]], round: 0.025 },
      fogs: [0.74, 0.545, 0.075, 0.045],
      skid: [[0, 0.37], [0.36, 0.37], [0.42, 0.455], [0, 0.455]]
    },
    // Level lamps from the liftgate round the D-pillar corners, outlined by an LED loop; an emblem between them
    rear: {
      lamp: { inner: [0.5, 0.972, 1.064], outer: [1.12, 0.962, 1.074], round: 0.024, led: 'outline' },
      lid: [0.6, 0.66], // liftgate half-width & bottom edge
      emblem: [1.0, 0.05, 0.036],
      badges: [[-0.42, 0.9, 0.075, 0.013, 1]],
      reflector: [0.84, 0.6, 0.012, 0.045],
      skid: [[0, 0.38], [0.38, 0.38], [0.44, 0.47], [0, 0.47]]
    },
    plates: [0.528, 0.82],
    chrome: false,
    cladding: 0.46,
    sign: false,
    rails: true,
    rearWiper: true,
    interior: { seats: [-0.55, -1.4] },
    privacyGlass: true // tinted glass behind the B-pillar
  }
};
// NYC yellow cab: a full-size sedan of the Crown Victoria years, the cab New York is known for. Long & rounded: a level
// belt, a glasshouse with a thick C-pillar, a long trunk rolling over into a tall tail. Behind: tall lamps at
// the corners (stepped red optics over amber turn signals) either side of a gloss-black panel across the trunk lid
// holding the plate & the reverse lamps; a chrome strip under them all; an emblem & an amber trouble light above; a big
// body-coloured bumper with a rub strip; twin exhausts. In front: an upright face with wide clear reflector lamps
// (amber at the corners) either side of a chrome-framed mesh grille, a black slot in the bumper.
BODY_SPECS.taxi = Object.assign({}, BODY_SPECS.sedan, {
  name: 'taxi',
  halfWidth: [[2.22, 0.905], [1.4, 0.92], [0, 0.926], [-1.4, 0.924], [-2.28, 0.918]],
  sill: [[2.22, 0.275], [1.2, 0.25], [-1.2, 0.25], [-2.28, 0.3]],
  shoulder: [[2.22, 0.66], [1.75, 0.74], [1.4, 0.755], [0, 0.77], [-1.4, 0.78], [-2.28, 0.74]],
  edge: [[2.08, 0.835], [1.55, 0.885], [0.82, 0.945], [0.3, 0.968], [-0.4, 0.982], [-1.2, 0.998], [-1.6, 1.0], [-1.88, 0.99], [-2.12, 0.975]],
  crown: [[2.1, 0.03], [0.95, 0.028], [0.72, 0.004], [-1.46, 0.004], [-1.6, 0.012], [-2.28, 0.01]],
  tumble: [[2.22, 0.12], [0.9, 0.1], [-1.6, 0.1], [-2.28, 0.115]],
  nose: { halfWidth: [0.32, 0.69, 2.8], edge: [0.13, 0.79, 2.6], crown: [0.13, 0.012, 2], sill: [0.16, 0.32, 2], shoulder: [0.22, 0.6, 2.6] },
  tail: { halfWidth: [0.3, 0.72, 2.8], edge: [0.1, 0.93, 3], crown: [0.1, 0.008, 2], sill: [0.16, 0.36, 2], shoulder: [0.22, 0.64, 2.6] },
  noseRake: { length: 0.55, y: [[0.25, 0.05], [0.36, 0], [0.55, 0], [0.65, 0.018], [0.75, 0.05], [0.83, 0.1]], plan: 0.085 },
  tailRake: { length: 0.42, y: [[0.3, 0.075], [0.44, 0], [0.58, 0], [0.66, 0.02], [0.74, 0.032], [0.9, 0.045], [0.96, 0.075]], plan: 0.065 },
  cabin: {
    cowl: 0.86,
    roofFront: 0.04,
    roofRear: -1.06,
    deck: -1.66,
    roofY: [[0.04, 1.415], [-0.5, 1.445], [-1.06, 1.41]],
    rail: [0.62, 0.6],
    inset: 0.03,
    bulge: 0.014,
    roofEdge: 0.05,
    roofCrown: 0.035,
    roofRound: 4,
    pillars: [-0.38],
    glassEnd: -1.22,
    quarterGlass: false // the rear door glass runs right back to the C-pillar
  },
  doors: [0.82, -0.38, -1.0],
  handles: [-0.22, -0.86],
  front: {
    lamp: { inner: [0.44, 0.668, 0.772], outer: [0.99, 0.668, 0.772], round: 0.016, drl: 'none', projectors: [0.4, 0.7], bowls: true, turn: 'inner' },
    hood: 0.786,
    grille: { outline: [[0, 0.6], [0.37, 0.6], [0.405, 0.635], [0.405, 0.758], [0.37, 0.782], [0, 0.782]], round: 0.03, frame: 0.016, blackFrame: true, emblem: [0.07, 0.03] },
    intake: { outline: [[0, 0.35], [0.6, 0.35], [0.63, 0.42], [0, 0.42]], round: 0.025 },
    crease: 0.57
  },
  rear: {
    lamp: { inner: [0.56, 0.694, 0.905], outer: [1.0, 0.694, 0.915], slant: 0.17, round: 0.012, led: 'ribs', turn: 'amber' },
    lid: [0.73, 0.694],
    applique: [[0, 0.697], [0.551, 0.697], [0.676, 0.85], [0, 0.85]], // dark panel between the lamps (outline)
    reverse: [[0.172, 0.706], [0.252, 0.706], [0.31, 0.842], [0.172, 0.842]], // reverse lamps either side of the plate
    chromeStrip: [0.65, 0.694], // bottom, top; it runs round the corners under the lamps
    emblem: [0.888, 0.058, 0.021],
    beacon: [0.3, 0.888, 0.03], // the amber trouble light: x, y, radius
    badges: [[-0.4, 0.886, 0.085, 0.012, 0]],
    crease: [0.6, 0.44],
    diffuser: 0.392, // the shadowed lip under the bumper, the exhausts poking out of it
    exhaust: [0.66, 0.39, 0.034, 0.02]
  },
  plates: [0.485, 0.772],
  sign: true,
  chmsl: 'shelf', // the high brake light sits on the parcel shelf, at the foot of the backlight
  interior: { seats: [-0.5, -1.16] }
});
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
  // Full-size pickup: a tall grille with two bars between C-clamp lamps; a separate bumper with fog lamps & tow hooks
  front: {
    lamp: { inner: [0.585, 0.995, 1.19], outer: [1.02, 1.01, 1.18], round: 0.02, drl: 'clamp', projectors: [0.42, 0.62] },
    hood: 1.215,
    grille: { outline: [[0, 0.81], [0.56, 0.81], [0.57, 1.2], [0, 1.2]], round: 0.03, mesh: 'honeycomb', frame: 0.03, bars: [0.94, 1.07] },
    bumper: [0.55, 0.795], // separate bumper: bottom, top
    fogs: [0.76, 0.665, 0.04, 0.032],
    hooks: [0.52, 0.585],
    lip: 0.56 // black air dam below the bumper
  },
  // Tall lamps on the bed's corner posts either side of the tailgate; the plate in the step bumper
  rear: {
    lamp: { inner: [0.815, 0.86, 1.24], outer: [0.95, 0.86, 1.24], round: 0.012, led: 'stack' },
    lid: [0.795, 0.79], // tailgate half-width & bottom edge
    handle: 1.225,
    lettering: [1.04, 0.42, 0.045], // stamped name across the tailgate: y, half-width, half-height
    bumper: [0.5, 0.785]
  },
  plates: [0.672, 0.64],
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
  // Delivery van: big rounded lamps running back along the fenders level with the grille's top, their running lights
  // along the bottom; a three-slat grille, a black bumper with fog lamps
  front: {
    lamp: { inner: [0.48, 0.79, 0.9], outer: [1.1, 0.81, 0.92], round: 0.04, drl: 'under', projectors: [0.3] },
    hood: 0.93,
    grille: { outline: [[0, 0.555], [0.4, 0.555], [0.435, 0.85], [0, 0.85]], round: 0.04, mesh: 'honeycomb', frame: 0.022, bars: [0.635, 0.712, 0.789] },
    fogs: [0.72, 0.47, 0.06, 0.035]
  },
  // Tall lamps on the rear corners (tail & stop, amber turn, white reverse) beside the barn doors
  rear: {
    lamp: { inner: [0.84, 0.62, 1.18], outer: [1.0, 0.62, 1.18], round: 0.01, led: 'stack', turn: 'amber' },
    lid: [0.8, 0.62] // barn doors' half-width & bottom edge (spec.barnDoors)
  },
  plates: [0.47, 0.78],
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
  // Minivan: rounded wraparound lamps with a level top & their running lights along the bottom, a rounded lower
  // grille with slats, round fog lamps
  front: {
    lamp: { inner: [0.42, 0.75, 0.83], outer: [1.08, 0.765, 0.832], round: 0.035, drl: 'under', projectors: [0.36] },
    hood: 0.84,
    grille: { outline: [[0, 0.4], [0.4, 0.4], [0.47, 0.62], [0, 0.62]], round: 0.07, mesh: 'bars', frame: 0.014 },
    fogs: [0.7, 0.47, 0.05, 0.035],
    lip: 0.345 // black splitter below
  },
  // Level lamp bands round the D-pillars onto the liftgate, an emblem between them
  rear: {
    lamp: { inner: [0.4, 0.978, 1.046], outer: [1.15, 0.968, 1.062], round: 0.022, led: 'c' },
    lid: [0.64, 0.72],
    emblem: [1.01, 0.045, 0.032],
    reflector: [0.78, 0.5, 0.012, 0.045],
    crease: 0.6,
    diffuser: 0.45
  },
  plates: [0.49, 0.84],
  chrome: false,
  cladding: 0,
  sign: false,
  rails: false,
  rearWiper: true,
  interior: { seats: [0.14, -0.86, -1.86] },
  privacyGlass: true
};

// A lamp's centre on the face of the vehicle (u capped to the tip's half-width) and its half-size: [|x|, y, hw, hh]
function lampSummary(lamp, tipHalfWidth) {
  const [u0, b0, t0] = lamp.inner;
  const [u1, b1, t1] = lamp.outer;
  const u = Math.min((u0 + u1) / 2, tipHalfWidth - 0.08);
  return [u, (b0 + t0 + b1 + t1) / 4, (Math.min(u1, tipHalfWidth) - u0) / 2, (Math.max(t0, t1) - Math.min(b0, b1)) / 2];
}

for (const spec of Object.values(BODY_SPECS)) {
  // Kept for code that places lamp flares & headlight spots: lamp centres (front, rear) on the faces
  spec.headlight = lampSummary(spec.front.lamp, spec.nose.halfWidth[1]);
  spec.taillight = lampSummary(spec.rear.lamp, spec.tail.halfWidth[1]);
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

// z of a body's nose (front) or tail surface on the centreline at height y, for plates & badges mounted on the tips:
// the tip cap is flat between its rows (the tip section's points, see buildTipCap), so this follows those facets rather
// than the smooth rake curve, which bows out past them where it is concave
function carTipZ(spec, y, front = true) {
  const rake = bodyRake(spec);
  const z = front ? spec.zFront : spec.zRear;
  if (!rake) return z;
  const rows = bodyHalfProfile(bodyProfile(spec)(z), 1, spec).map((pt) => pt[1]);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (b > a && y >= a && y <= b) return lerp(rake(0, a, z), rake(0, b, z), (y - a) / (b - a));
  }
  return rake(0, y, z);
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

// NYC cab roof topper, as the Crown Victoria cabs carried it: a long sign along the roof on a rail, tapering towards its
// rounded top, an ad on either side and the cab's medallion number lit on either end (taxiTopperTexture)
const TOPPER = { length: 1.06, base: 0.12, top: 0.08, height: 0.33, lift: 0.05 };
function taxiSignPlacement(spec) {
  const L = carLayout(spec);
  const cab = spec.cabin;
  const z = lerp(cab.roofFront, cab.roofRear, 0.45);
  const c = L.cabin(z);
  return { z, y: c.railY + c.h };
}

function buildTaxiSign(spec) {
  const { z, y } = taxiSignPlacement(spec);
  const { length, base, top, height, lift } = TOPPER;
  const shape = new THREE.Shape();
  const r = 0.035;
  shape.moveTo(-base, 0);
  shape.lineTo(base, 0);
  shape.lineTo(top, height - r);
  shape.quadraticCurveTo(top, height, top - r, height);
  shape.lineTo(-top + r, height);
  shape.quadraticCurveTo(-top, height, -top, height - r);
  shape.lineTo(-base, 0);
  const bevel = 0.014;
  const sign = new THREE.ExtrudeGeometry(shape, {
    depth: length - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: 0.01,
    bevelSegments: 2,
    curveSegments: 3
  }).translate(0, y + lift, z - length / 2 + bevel);
  const rail = new THREE.BoxGeometry(0.16, lift + 0.01, length * 0.82).translate(0, y + lift / 2 - 0.005, z);
  return [part(sign, CAR_PARTS.SIGN), part(rail, CAR_PARTS.TRIM)];
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
    const box = new THREE.BoxGeometry(TOPPER.base + TOPPER.top, TOPPER.height, TOPPER.length);
    parts.push(part(box.translate(0, y + TOPPER.lift + TOPPER.height / 2, z), CAR_PARTS.SIGN));
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
let _carBadgeTexture;
let _taxiTopperTexture;
// Made-up model names, lettered in chrome on the trunk lids & liftgates
const BADGE_WORDS = ['MERIDIAN', 'HYBRID'];

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
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  // Top to bottom: plate variants 4 .. 0 (the texture is flipped): a yellow cab's medallion plate (the medallion
  // number: a digit, a letter & two digits), a for-hire vehicle's T plate, three passenger plates
  const rows = [
    { bg: '#f0b416', bar: '#14233c', fg: '#14233c', label: '5J22', footer: 'NYC TAXI' },
    { bg: '#f0b416', bar: '#14233c', fg: '#14233c', label: 'T748219C' },
    { bg: '#f2b718', bar: '#14233c', fg: '#14233c', label: 'HXL-2506' },
    { bg: '#e8edf2', bar: '#162b4c', fg: '#162b4c', label: 'JTR-8319' },
    { bg: '#f2b718', bar: '#14233c', fg: '#14233c', label: 'KBM-4728' }
  ];
  rows.forEach(({ bg, bar, fg, label, footer }, row) => {
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
    ctx.font = footer ? 'bold 26px monospace' : 'bold 21px monospace';
    ctx.fillText(label, 64, y0 + 34);
    if (footer) {
      ctx.fillStyle = bg;
      ctx.font = 'bold 7px sans-serif';
      ctx.fillText(footer, 64, y0 + 60);
    }
  });
  _carPlateTexture = new THREE.CanvasTexture(canvas);
  _carPlateTexture.colorSpace = THREE.SRGBColorSpace;
  _carPlateTexture.anisotropy = 16;
  return _carPlateTexture;
}

// The badge lettering: one word per row, white on transparent (the material paints it chrome)
function carBadgeTexture() {
  if (_carBadgeTexture) return _carBadgeTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 32 * BADGE_WORDS.length;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 26px sans-serif';
  // letter-spaced, squeezed to the row's width
  BADGE_WORDS.forEach((word, row) => ctx.fillText(word.split('').join(String.fromCharCode(8202)), 128, row * 32 + 17, 244));
  _carBadgeTexture = new THREE.CanvasTexture(canvas);
  _carBadgeTexture.anisotropy = 16;
  return _carBadgeTexture;
}

// The roof toppers' faces, five 128 px rows top to bottom: the medallion numbers lit on the ends (traffic cabs' 5J22,
// the player's 7Y48), then four ads for the sides, for brands as made up as the billboards'
const TOPPER_ADS = 4;
function taxiTopperTexture() {
  if (_taxiTopperTexture) return _taxiTopperTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128 * (1 + TOPPER_ADS);
  const ctx = canvas.getContext('2d');
  const text = (str, x, y, font, fill, maxWidth = 480) => {
    ctx.font = font;
    ctx.fillStyle = fill;
    ctx.fillText(str, x, y, maxWidth);
  };
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // medallion numbers: black on the lit panel
  ['5J22', '7Y48'].forEach((number, i) => {
    ctx.fillStyle = '#fff3c4';
    ctx.fillRect(i * 256, 0, 256, 128);
    text(number, i * 256 + 128, 70, 'bold 92px sans-serif', '#15171a', 236);
  });
  const row = (i) => 128 * (1 + i);
  // Gotham Cola: a white wave on red
  ctx.fillStyle = '#c8102e';
  ctx.fillRect(0, row(0), 512, 128);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, row(0) + 96, 512, 10);
  text('Gotham Cola', 256, row(0) + 52, 'italic bold 64px serif', '#ffffff');
  text('ICE COLD · TASTE THE SKYLINE', 256, row(0) + 114, 'bold 14px sans-serif', '#c8102e');
  // CHRONO GENÈVE: gold on black, framed
  ctx.fillStyle = '#0d0d0f';
  ctx.fillRect(0, row(1), 512, 128);
  ctx.fillStyle = '#b8954a';
  ctx.fillRect(10, row(1) + 10, 492, 3);
  ctx.fillRect(10, row(1) + 115, 492, 3);
  text('CHRONO GENÈVE', 256, row(1) + 58, '600 50px serif', '#d9b866');
  text('FIFTH AVENUE FLAGSHIP', 256, row(1) + 96, '500 17px sans-serif', '#b8954a');
  // a show: gold on deep purple
  ctx.fillStyle = '#2a0f45';
  ctx.fillRect(0, row(2), 512, 128);
  ctx.fillStyle = '#4a1d72';
  ctx.fillRect(0, row(2) + 84, 512, 44);
  text('THE GILDED HOUR', 256, row(2) + 46, 'bold 54px serif', '#f2c75c');
  text('NOW ON BROADWAY', 256, row(2) + 106, 'bold 24px sans-serif', '#ffffff');
  // skyline tours: white on sky blue over a skyline
  ctx.fillStyle = '#1f8fd6';
  ctx.fillRect(0, row(3), 512, 128);
  ctx.fillStyle = '#0f5f9a';
  for (let x = 0, k = 0; x < 512; k++) {
    const w = 18 + ((k * 37) % 23), h = 22 + ((k * 53) % 46);
    ctx.fillRect(x, row(3) + 128 - h, w - 3, h);
    x += w;
  }
  text('SKYLINE TOURS', 256, row(3) + 44, 'bold 56px sans-serif', '#ffffff');
  text('SEE NEW YORK FROM THE TOP', 256, row(3) + 84, 'bold 20px sans-serif', '#ffe680');
  _taxiTopperTexture = new THREE.CanvasTexture(canvas);
  _taxiTopperTexture.colorSpace = THREE.SRGBColorSpace;
  _taxiTopperTexture.anisotropy = 16;
  return _taxiTopperTexture;
}

/**
 * Creates the TSL material for lofted vehicles.
 * Instanced traffic reads the per-instance `paintColor` (vec3) and `carState` (vec4: brake, left (+x) & right (-x)
 * turn signal, style/livery code from `carStyleCode` where 1 = NYPD) attributes; with a fixed `fixedColorHex` (the
 * player's taxi, or fixed wheels) the state is the `material.userData.carState` uniform instead, with its fourth
 * component controlling reverse lights.
 * The colour, roughness, metalness & emissive come out of one function of per-part branches (a CarSurface struct),
 * so the fragment shader evaluates each of its part's masks a single time.
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
  const [plateF, plateR] = spec.plates;
  const frontZone = spec.zFront - 0.58;
  const rearZone = spec.zRear + 0.58;
  const sillY = spec.sill[1][1];
  const rearSill = spec.tail.sill[1];
  const doorMid = (spec.doors[0] + spec.doors[1]) / 2;
  const trunkBot = spec.rear.lid[1];
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

  // Glasshouse polygon evaluation (the window branch's colour, roughness, metalness & high brake light)
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
    if (cab.pillars.length === 1 && cab.quarterGlass !== false) pillarCut(cab.roofRear - 0.04, 0.014);
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

  // ---- Fascia lamps (masks shared by the fascia's colour and emissive) ----------------------------------------------
  // A lamp (spec.front.lamp / spec.rear.lamp) is a quad in the unwrapped coordinate u: |x| across the face plus how far
  // the surface lies behind the fascia's centreline (its tip line, straight over the lamp's heights, set back by the
  // rake's plan-view rounding), so a lamp carries on round the corner along the fender or quarter panel. Returns the
  // signed distance & footprint across its outline, where along it a point is (t: 0 inner .. 1 outer end) and across it
  // (v: 0 bottom .. 1 top edge), and the distances to its four edges.
  const lampFrame = (lamp, front) => {
    const [u0, b0, t0] = lamp.inner;
    const [u1, b1, t1] = lamp.outer;
    const yA = Math.min(b0, b1) - 0.02;
    const yB = Math.max(t0, t1) + 0.02;
    const zA = carTipZ(spec, yA, front);
    const zB = carTipZ(spec, yB, front);
    const plan = (front ? spec.noseRake : spec.tailRake)?.plan || 0;
    const tipZ = float(zA).add(p.y.sub(yA).mul((zB - zA) / (yB - yA)));
    const behind = (front ? tipZ.sub(p.z) : p.z.sub(tipZ)).sub(ax.mul(ax).mul(plan));
    const u = ax.add(max(behind, 0.0));
    const fu = fwX.add(fwZ);
    // lamp.slant: the inner edge leans outwards by this much from the bottom to the top (a lamp narrowing upwards)
    const slant = lamp.slant || 0;
    const uIn = slant ? float(u0).add(clamp(p.y.sub(b0).div(t0 - b0), 0.0, 1.0).mul(slant)) : float(u0);
    const t = clamp(u.sub(uIn).div(float(u1).sub(uIn)), 0.0, 1.0);
    const bot = mix(float(b0), float(b1), t);
    const top = mix(float(t0), float(t1), t);
    const dIn = uIn.sub(u).mul((t0 - b0) / Math.hypot(t0 - b0, slant));
    const dOut = u.sub(u1);
    const dBot = bot.sub(p.y);
    const dTop = p.y.sub(top);
    const du = max(dIn, dOut);
    const dv = max(dBot, dTop);
    return {
      u, t, fu, dIn, dOut, dBot, dTop,
      v: p.y.sub(bot).div(top.sub(bot)),
      d: smax(du, dv, lamp.round),
      w: mix(fwY, fu, step(dv, du)),
      facing: smoothstep(0.8, 0.6, abs(n.y)) // not on the hood or the underside
    };
  };
  const LED_INSET = 0.0085;
  // Headlamp: a housing round a clear lens with projector buckets, the running-light signature (an LED line inside the
  // top edge, turning down the inner end for 'hook' & 'clamp', the outer end for 'l'; 'clamp' also closes along the
  // bottom of its inner part; 'under' runs along the bottom edge instead, 'none' has none) and the amber turn signal &
  // side marker round the corner
  const headLampMasks = () => {
    const lamp = spec.front.lamp;
    const L = lampFrame(lamp, true);
    const housing = cov(L.d, L.w).mul(L.facing);
    const lens = cov(L.d.add(0.005), L.w).mul(housing);
    const ledW = lamp.drl === 'clamp' ? 0.0075 : 0.0055;
    let drl = lamp.drl === 'none' ? float(0.0)
      : lamp.drl === 'under' ? band(L.dBot.add(LED_INSET), ledW, fwY).mul(smoothstep(0.02, 0.06, L.t))
      : band(L.dTop.add(LED_INSET), ledW, fwY).mul(smoothstep(0.02, 0.06, L.t));
    if (lamp.drl === 'hook' || lamp.drl === 'clamp') drl = max(drl, band(L.dIn.add(LED_INSET), ledW, L.fu).mul(step(0.2, L.v)));
    if (lamp.drl === 'clamp') drl = max(drl, band(L.dBot.add(LED_INSET), ledW, fwY).mul(step(L.t, 0.38)));
    if (lamp.drl === 'l') drl = max(drl, band(L.dOut.add(0.035), ledW, L.fu).mul(step(0.25, L.v)));
    let bucket = float(0.0);
    let projLens = float(0.0);
    let radial = float(1.0);
    const [u0, b0, t0] = lamp.inner;
    const [u1, b1, t1] = lamp.outer;
    const fr = L.fu.add(fwY).mul(0.5);
    for (const tk of lamp.projectors) {
      const bk = lerp(b0, b1, tk);
      const hk = lerp(t0, t1, tk) - bk;
      // projectors: a small lens in a bucket; reflector lamps (bowls): a wide chrome parabola round the bulb
      const dist = length(vec2(L.u.sub(lerp(u0, u1, tk)).mul(lamp.bowls ? 0.6 : 1.0), p.y.sub(bk + hk * (lamp.bowls ? 0.5 : 0.42))));
      const rk = lamp.bowls ? hk * 0.46 : Math.min(hk * 0.36, 0.034);
      bucket = max(bucket, cov(dist.sub(rk), fr));
      projLens = max(projLens, cov(dist.sub(rk * (lamp.bowls ? 0.8 : 0.6)), fr));
      if (lamp.bowls) radial = min(radial, dist.div(rk));
    }
    // amber at the outer end round the corner, or (turn: 'inner') at the inner end with a side marker round the corner
    const turn = (lamp.turn === 'inner' ? max(smoothstep(0.2, 0.17, L.t), smoothstep(0.93, 0.95, L.t)) : smoothstep(0.86, 0.9, L.t)).mul(lens);
    return { housing, lens, v: L.v, drl: drl.mul(lens).mul(float(1.0).sub(turn)), bucket: bucket.mul(lens), projLens: projLens.mul(lens), radial, turn };
  };
  // Tail lamp: a red lens in a dark housing with its LED signature ('c': lines inside the top & bottom edges joined at
  // the outer end, 'outline': a loop inside the outline, 'stack': bars across the tail section), the white reverse lamp
  // (the inner end, or the bottom of a stack) and the turn signal (red, or amber in a stack with turn: 'amber')
  const tailLampMasks = () => {
    const lamp = spec.rear.lamp;
    const L = lampFrame(lamp, false);
    const housing = cov(L.d, L.w).mul(L.facing);
    const lens = cov(L.d.add(0.004), L.w).mul(housing);
    let led;
    let reverse;
    let turn;
    let ribs = float(0.0);
    if (lamp.led === 'stack') {
      reverse = smoothstep(0.235, 0.215, L.v);
      turn = smoothstep(0.215, 0.235, L.v).mul(smoothstep(0.47, 0.45, L.v));
      const h = (lamp.inner[2] - lamp.inner[1]);
      led = float(0.0);
      for (const vk of [0.58, 0.7, 0.82]) led = max(led, band(L.v.sub(vk).mul(h), 0.006, fwY));
    } else if (lamp.led === 'ribs') {
      // bulb lamps: the red lens stepped into horizontal optics (each step's lower edge catches the light) over an
      // amber turn signal along the bottom; the reverse lamps are elsewhere (rear.reverse)
      const h = (lamp.inner[2] - lamp.inner[1] + lamp.outer[2] - lamp.outer[1]) / 2;
      // (the amber section sits inside a red border, and stops short of the corner)
      reverse = float(0.0);
      turn = smoothstep(0.21, 0.19, L.v).mul(smoothstep(0.025, 0.045, L.v)).mul(smoothstep(0.02, 0.04, L.t)).mul(smoothstep(0.8, 0.77, L.t));
      led = float(0.0);
      const optic = fract(L.v.sub(0.22).mul(3.5 / 0.78)); // three and a half steps, ~5 cm each
      ribs = mix(float(0.5), smoothstep(0.1, 0.95, optic), fadeMed(fwY.mul(h * 10.0))).mul(smoothstep(0.2, 0.24, L.v));
    } else {
      reverse = smoothstep(0.13, 0.11, L.t);
      turn = smoothstep(0.11, 0.13, L.t).mul(smoothstep(0.36, 0.34, L.t)).mul(step(L.v, 0.5));
      if (lamp.led === 'outline') {
        led = band(L.d.add(LED_INSET), 0.0045, L.w);
      } else if (lamp.led === 'blade') {
        // two light guides along the lamp, across its outer part
        const h = (lamp.inner[2] - lamp.inner[1] + lamp.outer[2] - lamp.outer[1]) / 2;
        led = max(band(L.v.sub(0.66).mul(h), 0.0045, fwY), band(L.v.sub(0.4).mul(h), 0.0045, fwY)).mul(smoothstep(0.17, 0.21, L.t));
      } else {
        led = max(max(band(L.dTop.add(LED_INSET), 0.0042, fwY), band(L.dBot.add(LED_INSET), 0.0042, fwY)), band(L.dOut.add(LED_INSET), 0.0045, L.fu));
      }
    }
    const amber = lamp.turn === 'amber' ? turn : float(0.0);
    return {
      housing, lens, v: L.v, t: L.t, u: L.u, fu: L.fu, facing: L.facing,
      led: led.mul(lens).mul(float(1.0).sub(max(reverse, amber))),
      reverse: reverse.mul(lens),
      turn: turn.mul(lens),
      amber: amber.mul(lens),
      ribs
    };
  };
  // Reverse lamps on the trunk lid either side of the plate (rear.reverse: the right one's outline): their outline's
  // distance & footprint
  const lidReverse = () => outline(spec.rear.reverse, 0.006);
  // The taxi's roof topper: an ad in a frame on either side (by the cab's seed; the player's cab shows the show), its
  // medallion number lit on either end, each read left to right from where it faces. One texture sample
  // (taxiTopperTexture's rows), taken outside the part branches, shared by the colour & emissive graphs
  const topper = spec.sign ? (() => {
    const { z: tz, y: ty } = taxiSignPlacement(spec);
    const y0 = ty + TOPPER.lift;
    const rel = p.z.sub(tz);
    const side = smoothstep(0.6, 0.85, abs(n.x));
    const end = smoothstep(0.6, 0.85, abs(n.z));
    const halfLen = TOPPER.length / 2 - 0.05, v0 = y0 + 0.04, v1 = y0 + TOPPER.height - 0.05;
    const su = float(0.5).sub(step(0.0, n.x).mul(2.0).sub(1.0).mul(rel).div(2 * halfLen));
    const sv = p.y.sub(v0).div(v1 - v0);
    const ew = 0.15, eh = 0.075, ec = y0 + TOPPER.height * 0.6;
    const eu = float(0.5).add(step(0.0, n.z).mul(2.0).sub(1.0).mul(p.x).div(ew));
    const ev = p.y.sub(ec).div(eh).add(0.5);
    const rows = 1 + TOPPER_ADS;
    const ad = fixed ? float(2.0) : floor(fract(floor(wCode.div(256.0).add(0.01)).mul(0.618034)).mul(TOPPER_ADS));
    const sideUV = vec2(clamp(su, 0.01, 0.99), float(TOPPER_ADS - 1).sub(ad).add(clamp(sv, 0.02, 0.98)).div(rows));
    const endUV = vec2(clamp(eu, 0.02, 0.98).add(fixed ? 1.0 : 0.0).mul(0.5), clamp(ev, 0.03, 0.97).add(TOPPER_ADS).div(rows));
    const inSide = cov(abs(rel).sub(halfLen), fwZ).mul(cov(float(v0).sub(p.y), fwY)).mul(cov(p.y.sub(v1), fwY)).mul(side);
    const inEnd = cov(abs(p.x).sub(ew / 2), fwX).mul(cov(abs(p.y.sub(ec)).sub(eh / 2), fwY)).mul(end);
    return { y0, panel: max(inSide, inEnd), end: inEnd, col: texture(taxiTopperTexture(), mix(endUV, sideUV, step(end, side))).rgb };
  })() : null;
  const chmslMask = (rearGlass) => spec.barnDoors
    ? rrect(vec2(p.x, p.y.sub(spec.barnDoors[1] + 0.055)), vec2(0.16, 0.015), 0.005, fwXY)
        .mul(smoothstep(-0.15, -0.45, n.z))
        .mul(smoothstep(rearZone + 0.05, rearZone - 0.05, p.z))
    : rrect(vec2(p.x, p.z.sub(spec.chmsl === 'shelf' ? cab.deck + 0.07 : cab.roofRear - 0.075)), vec2(0.16, 0.011), 0.005, fwXZ)
        .mul(rearGlass)
        .mul(smoothstep(-0.05, -0.2, n.z));

  // ---- Fascias -------------------------------------------------------------------------------------------------
  // Chrome mirrors its surroundings: the dark street below the horizon and the bright sky above, so its colour follows
  // which way it faces (sharper than the paint's reflections, which the material's roughness blurs)
  const chrome = () => mix(color(0x2f343a), color(0xe9eef3), smoothstep(-0.35, 0.45, n.y.add(n.z.mul(0.0)))).mul(1.05);
  // Grille frames & bars, bumpers & garnishes: chrome on chrome-trimmed cars, gloss black on blacked-out ones, dark
  // grey plastic otherwise
  const trimFinish = () => mix(mix(color(0x2a2e33), chrome(), hasChrome), color(0x111316), isBlackout);
  // A symmetric outline from its right half ([|x|, y] points, counter-clockwise); the edge along the centreline is moved
  // far out so it never shapes the outline
  const outline = (points, round) => {
    const margins = points.map(([x0], i) => (x0 === 0 && points[(i + 1) % points.length][0] === 0 ? -10 : 0));
    return polygonEdge(ax, p.y, polygonPlanes(points, margins), round, fwX, fwY);
  };
  const honeycomb = () => {
    const wave = smoothstep(-0.1, 0.35, sin(p.x.add(p.y).mul(110.0)).mul(sin(p.x.sub(p.y).mul(110.0))));
    return mix(float(0.68), wave.mul(0.38).add(0.52), fadeFine(max(fwX, fwY)));
  };
  const slats = (freq) => mix(float(0.72), smoothstep(0.3, 0.6, fract(p.y.mul(freq))).mul(0.4).add(0.5), fadeFine(fwY));
  const plateOn = (bCol, plateCol, y, recessed, facing) => {
    const edge = rrectEdge(vec2(p.x, p.y.sub(y)), vec2(0.155, 0.057), 0.008, fwXY);
    bCol.assign(mix(bCol, color(0x1e2227), cov(edge.d.sub(recessed ? 0.02 : 0.012), edge.w).mul(facing)));
    bCol.assign(mix(bCol, plateCol, cov(edge.d, edge.w).mul(facing)));
  };

  const fasciaFront = (bCol, plateCol) => {
    const F = spec.front;
    const face = smoothstep(0.12, 0.38, n.z).mul(smoothstep(0.85, 0.6, n.y));
    const trim = trimFinish();
    // Hood shut line across the face, above the lamps
    bCol.assign(bCol.mul(one.sub(band(p.y.sub(F.hood), 0.0035, fwY).mul(face).mul(0.5))));
    // A separate bumper (trucks), wrapping round the corners, with its top edge shadowed
    if (F.bumper) {
      const [bb, bt] = F.bumper;
      const corner = smoothstep(spec.zFront - 0.42, spec.zFront - 0.36, p.z).mul(smoothstep(0.85, 0.6, n.y));
      const bumper = cov(float(bb).sub(p.y), fwY).mul(cov(p.y.sub(bt), fwY)).mul(corner);
      const bumperCol = mix(color(0x2e3237).mul(smoothstep(bb, bt, p.y).mul(0.18).add(0.86)), chrome(), hasChrome);
      bCol.assign(mix(bCol, bumperCol, bumper));
      bCol.assign(bCol.mul(one.sub(band(p.y.sub(bt), 0.004, fwY).mul(corner).mul(0.55))));
    }
    // Lower intake (between the fog pods) and the skid plate below it
    if (F.intake) {
      const e = outline(F.intake.outline, F.intake.round);
      bCol.assign(mix(bCol, color(0x0f1216).mul(slats(34.0)), cov(e.d, e.w).mul(face)));
    }
    if (F.skid) {
      const e = outline(F.skid, 0.02);
      bCol.assign(mix(bCol, color(0x8e959c).mul(smoothstep(F.skid[0][1], F.skid[2][1], p.y).mul(0.25).add(0.85)), cov(e.d, e.w).mul(face)));
    }
    // The grille: an outline filled with mesh or slats, a frame round it, bars across, a badge
    {
      const G = F.grille;
      const e = outline(G.outline, G.round);
      const inside = cov(e.d, e.w).mul(face);
      const fill = G.mesh === 'bars' ? slats(26.0) : honeycomb();
      bCol.assign(mix(bCol, color(0x0e1114).mul(fill), inside));
      if (G.frame) bCol.assign(mix(bCol, G.blackFrame ? color(0x111316) : trim, max(cov(e.d.sub(G.frame), e.w).mul(face).sub(inside), 0.0)));
      if (G.bars) {
        let bars = float(0.0);
        for (const yb of G.bars) bars = max(bars, band(p.y.sub(yb), 0.016, fwY));
        bCol.assign(mix(bCol, trim, bars.mul(inside)));
      }
      const top = G.outline[G.outline.length - 1][1];
      const bottom = G.outline[0][1];
      const badgeY = G.bars ? (G.bars[0] + G.bars[1]) / 2 : top - (top - bottom) * 0.28;
      if (G.emblem) {
        // an oval: a chrome ring round a dark field
        const [ew, eh] = G.emblem;
        const r = length(vec2(p.x.div(ew), p.y.sub(badgeY).div(eh)));
        const rw = fwX.div(ew).add(fwY.div(eh)).mul(0.5);
        bCol.assign(mix(mix(bCol, chrome(), cov(r.sub(1.0), rw).mul(inside)), color(0x1a1d21), cov(r.sub(0.78), rw).mul(inside)));
      } else {
        const badge = rrect(vec2(p.x, p.y.sub(badgeY)), vec2(0.034, 0.016), 0.012, fwXY).mul(inside);
        bCol.assign(mix(bCol, color(0xd4dbe2), badge));
      }
    }
    // Fog lamp pods, tow hooks, the black lip below
    if (F.fogs) {
      const [fx, fy, fw, fh] = F.fogs;
      const pod = rrect(vec2(ax.sub(fx), p.y.sub(fy)), vec2(fw, fh), Math.min(fw, fh) * 0.8, fwXY).mul(face);
      const fogR = Math.min(fw, fh) * 0.62;
      const fog = cov(length(vec2(ax.sub(fx + fw - fogR - 0.012), p.y.sub(fy))).sub(fogR), fwX.add(fwY).mul(0.5)).mul(pod);
      bCol.assign(mix(mix(bCol, color(0x111417), pod), color(0xc9d1d8), fog));
    }
    if (F.hooks) {
      const [hx, hy] = F.hooks;
      bCol.assign(mix(bCol, color(0xa8161c), rrect(vec2(ax.sub(hx), p.y.sub(hy)), vec2(0.03, 0.024), 0.01, fwXY).mul(face)));
    }
    if (F.lip) bCol.assign(mix(bCol, color(0x121418), cov(p.y.sub(F.lip), fwY).mul(smoothstep(0.85, 0.6, n.y))));
    // A crease along the top of the bumper
    if (F.crease) {
      bCol.assign(bCol.mul(one.add(band(p.y.sub(F.crease - 0.006), 0.003, fwY).mul(0.12)).sub(band(p.y.sub(F.crease), 0.004, fwY).mul(0.22)).mul(face).add(one.sub(face))));
    }
    // Headlamps
    const H = headLampMasks();
    const { housing, lens, v, drl, bucket, projLens, radial, turn } = H;
    // Behind the clear lens, silver reflectors catching the sky (darker towards the bottom), or a smoked housing on
    // blacked-out trims; each projector sits in a chrome bezel round a dark bucket, each reflector bowl is bright
    // chrome round its bulb's cap, dimming in rings out to its rim
    const interior = mix(mix(color(0x5c6670), color(0xc9d1d9), v), mix(color(0x0e1115), color(0x2c333b), v.mul(v)), isBlackout);
    let lampCol;
    if (spec.front.lamp.bowls) {
      // the bowls brighten towards their bulbs, each capped by a small grey shield
      const bowl = mix(color(0xf2f6fa), interior, smoothstep(0.0, 1.1, radial));
      const cap = smoothstep(0.16, 0.12, radial).mul(0.6);
      lampCol = mix(mix(interior, bowl, bucket), color(0xa8b0b8), cap.mul(bucket));
    } else {
      const bezel = mix(color(0x9aa4ae), color(0x14171b), smoothstep(0.55, 0.85, bucket));
      lampCol = mix(mix(mix(interior, bezel, min(bucket.mul(1.6), 1.0)), color(0xeef4ff), projLens), color(0xffffff), drl);
    }
    bCol.assign(mix(bCol, color(0x121519), housing));
    bCol.assign(mix(bCol, mix(lampCol, color(0xc4782a), turn), lens));
    plateOn(bCol, plateCol, plateF, false, face);
    return H;
  };

  const fasciaRear = (bCol, plateCol, badgeInk) => {
    const R = spec.rear;
    const back = smoothstep(0.12, 0.38, n.z.negate()).mul(smoothstep(0.85, 0.6, n.y));
    const trim = trimFinish();
    const [lidW, lidBottom] = R.lid;
    const TL = tailLampMasks();
    const lidRev = R.reverse ? lidReverse() : null;
    // Shut lines: barn doors, or the trunk lid / liftgate / tailgate outline
    const platePocket = R.bumper || R.applique ? float(0.0) : rrect(vec2(p.x, p.y.sub(plateR + 0.01)), vec2(0.24, 0.105), 0.03, fwXY).mul(back);
    if (spec.barnDoors) {
      const barnSide = ax.sub(lidW);
      const barnBottom = float(trunkBot).sub(p.y);
      const barnOutline = band(max(barnSide, barnBottom), 0.0035, maxEdgeW(barnBottom, barnSide, fwY, fwX));
      const barnSplit = band(p.x, 0.0045, fwX).mul(cov(barnBottom, fwY));
      bCol.assign(bCol.mul(one.sub(max(barnOutline, barnSplit).mul(back).mul(0.56))));
      bCol.assign(mix(bCol, color(0x14171b), rrect(vec2(p.x.add(0.072), p.y.sub(1.04)), vec2(0.013, 0.056), 0.005, fwXY).mul(back)));
    } else {
      const side = ax.sub(lidW);
      const bottom = float(lidBottom).sub(p.y);
      const seam = band(max(side, bottom), 0.003, maxEdgeW(bottom, side, fwY, fwX)).mul(back).mul(one.sub(platePocket));
      bCol.assign(bCol.mul(one.sub(seam.mul(0.56))));
    }
    // The plate's pocket on a trunk lid or liftgate
    bCol.assign(mix(bCol, bCol.mul(smoothstep(plateR - 0.09, plateR + 0.115, p.y).mul(-0.25).add(0.9)), platePocket));
    // A crease across the bumper: shadow under a highlight
    if (R.crease) {
      for (const yc of [].concat(R.crease)) {
        const groove = band(p.y.sub(yc), 0.004, fwY).mul(0.24).add(smoothstep(yc - 0.03, yc, p.y).mul(smoothstep(yc + 0.001, yc - 0.004, p.y)).mul(0.1));
        bCol.assign(bCol.mul(one.add(band(p.y.sub(yc + 0.007), 0.003, fwY).mul(0.14)).sub(groove).mul(back).add(one.sub(back))));
      }
    }
    // A chrome strip across the tail under the lamps, carrying on round the corners as far as they do: convex, so it
    // mirrors the street along its bottom & the sky along its top; a dark gap to the bumper below it
    if (R.chromeStrip) {
      const [sb, st] = R.chromeStrip;
      const strip = cov(float(sb).sub(p.y), fwY).mul(cov(p.y.sub(st), fwY)).mul(cov(TL.u.sub(R.lamp.outer[0]), TL.fu)).mul(TL.facing);
      const g = p.y.sub(sb).div(st - sb);
      const stripCol = mix(mix(color(0x2a2f35), color(0x8d969f), smoothstep(0.0, 0.4, g)), color(0xf1f5f9), smoothstep(0.45, 0.62, g));
      bCol.assign(mix(bCol, stripCol, strip));
      bCol.assign(bCol.mul(one.sub(band(p.y.sub(sb - 0.004), 0.0025, fwY).mul(cov(TL.u.sub(R.lamp.outer[0]), TL.fu)).mul(TL.facing).mul(0.45))));
    }
    // The gloss-black panel across the trunk lid between the lamps, and the reverse lamps in it either side of the
    // plate: clear, fluted lenses over chrome
    if (R.applique) {
      const e = outline(R.applique, 0.008);
      const ab = R.applique[0][1];
      const at = R.applique[2][1];
      bCol.assign(mix(bCol, mix(color(0x1b1e22), color(0x3d4248), smoothstep(ab, at, p.y)), cov(e.d, e.w).mul(back)));
    }
    if (R.reverse) {
      const e = lidRev;
      const yb = R.reverse[0][1];
      const yt = R.reverse[2][1];
      const flutes = mix(float(0.88), smoothstep(0.1, 0.9, fract(p.y.mul(90.0))).mul(0.3).add(0.75), fadeFine(fwY.mul(4.0)));
      const lensCol = mix(color(0x8c96a0), color(0xeef3f8), smoothstep(yb, yt, p.y)).mul(flutes);
      bCol.assign(mix(mix(bCol, color(0xc4ccd4), cov(e.d.sub(0.004), e.w).mul(back)), lensCol, cov(e.d, e.w).mul(back)));
    }
    // Centre emblem: a chrome oval ring round a dark field; chrome lettering on the lid
    if (R.emblem) {
      const [ey, ew, eh] = R.emblem;
      const e = length(vec2(p.x.div(ew), p.y.sub(ey).div(eh)));
      const ew2 = fwX.div(ew).add(fwY.div(eh)).mul(0.5);
      const ring = cov(e.sub(1.0), ew2).mul(back);
      const field = cov(e.sub(0.76), ew2).mul(back);
      bCol.assign(mix(mix(bCol, chrome(), ring), color(0x1a1d21), field));
    }
    bCol.assign(mix(bCol, chrome(), badgeInk.mul(back)));
    // The amber trouble light on the trunk lid: a dome on a chrome base, lit from above
    if (R.beacon) {
      const [bx, by, br] = R.beacon;
      const d = length(vec2(p.x.sub(bx), p.y.sub(by)));
      const fw = fwX.add(fwY).mul(0.5);
      const glint = smoothstep(br * 0.45, 0.0, length(vec2(p.x.sub(bx - br * 0.25), p.y.sub(by + br * 0.4))));
      const dome = mix(mix(color(0x9c3c06), color(0xff9a24), smoothstep(br, br * 0.2, d)).mul(one.sub(band(d.sub(br * 0.55), 0.002, fw).mul(0.3))), color(0xffe2b0), glint);
      bCol.assign(mix(mix(bCol, chrome(), cov(d.sub(br - 0.0), fw).mul(back)), dome, cov(d.sub(br - 0.004), fw).mul(back)));
    }
    // Tailgate: handle, stamped name; the step bumper below with its rubber step & the plate
    if (R.handle) bCol.assign(mix(bCol, color(0x14171b), rrect(vec2(p.x, p.y.sub(R.handle)), vec2(0.09, 0.017), 0.006, fwXY).mul(back)));
    if (R.lettering) {
      const [ly, lw, lh] = R.lettering;
      // block letters with their counters, pressed into the panel: shadowed along their tops, lit along their bottoms
      const cell = abs(fract(p.x.div(lw / 3.5).add(0.5)).sub(0.5));
      const glyph = smoothstep(0.4, 0.36, cell).mul(float(1.0).sub(smoothstep(0.1, 0.14, cell).mul(0.0).add(smoothstep(0.14, 0.1, cell)).mul(band(p.y.sub(ly), lh * 0.4, fwY))));
      const letters = band(p.y.sub(ly), lh, fwY).mul(band(p.x, lw, fwX)).mul(mix(float(0.5), glyph, fadeFine(fwX))).mul(back);
      const relief = band(p.y.sub(ly + lh), 0.004, fwY).mul(band(p.x, lw, fwX)).mul(back);
      bCol.assign(bCol.mul(one.sub(letters.mul(0.07)).sub(relief.mul(0.16))));
    }
    if (R.bumper) {
      const [bb, bt] = R.bumper;
      const corner = smoothstep(spec.zRear + 0.42, spec.zRear + 0.36, p.z).mul(smoothstep(0.85, 0.6, n.y));
      const bumper = cov(float(bb).sub(p.y), fwY).mul(cov(p.y.sub(bt), fwY)).mul(corner);
      bCol.assign(mix(bCol, mix(color(0x2e3237).mul(smoothstep(bb, bt, p.y).mul(0.18).add(0.86)), chrome(), hasChrome), bumper));
      bCol.assign(bCol.mul(one.sub(band(p.y.sub(bt), 0.004, fwY).mul(corner).mul(0.55))));
      const stepPad = band(p.y.sub(bt - 0.02), 0.018, fwY).mul(band(p.x, 0.3, fwX)).mul(corner);
      bCol.assign(mix(bCol, color(0x16181b), stepPad));
    }
    // Diffuser & exhausts, skid plate, reflectors
    if (R.diffuser) bCol.assign(mix(bCol, color(0x14171b), cov(p.y.sub(R.diffuser), fwY).mul(back)));
    if (R.exhaust) {
      const [ex, ey, ew = 0.052, eh = 0.018] = R.exhaust;
      const exhaust = rrectEdge(vec2(ax.sub(ex), p.y.sub(ey)), vec2(ew, eh), Math.min(ew, eh) * 0.6, fwXY);
      bCol.assign(mix(mix(bCol, color(0x828a92), cov(exhaust.d, exhaust.w).mul(back)), color(0x060709), cov(exhaust.d.add(0.006), exhaust.w).mul(back)));
    }
    if (R.skid) {
      const e = outline(R.skid, 0.02);
      bCol.assign(mix(bCol, color(0x8e959c).mul(smoothstep(R.skid[0][1], R.skid[2][1], p.y).mul(0.25).add(0.85)), cov(e.d, e.w).mul(back)));
    }
    if (R.reflector) {
      const [rx, ry, rw, rh] = R.reflector;
      bCol.assign(mix(bCol, color(0x8a0c14), rrect(vec2(ax.sub(rx), p.y.sub(ry)), vec2(rw, rh), Math.min(rw, rh) * 0.6, fwXY).mul(back)));
    }
    if (R.sensors) {
      const [sy, xs] = R.sensors;
      for (const sx of xs) {
        const dist = length(vec2(ax.sub(sx), p.y.sub(sy)));
        bCol.assign(bCol.mul(one.sub(band(dist.sub(0.011), 0.0025, fwX.add(fwY).mul(0.5)).mul(back).mul(0.35))));
      }
    }
    // Tail lamps: a glossy red lens over chrome reflectors (brighter through its middle), its LEDs, the white reverse
    // lamp; the trunk lid's shut line runs through the lamps where they cross onto the lid
    const { housing, lens, v, led, reverse, amber, ribs } = TL;
    const ruby = R.lamp.led === 'ribs'
      ? mix(color(0x5c0810), color(0xc8202f), ribs)
      : mix(color(0x7a0c15), color(0xb01c27), smoothstep(0.0, 0.5, v).mul(smoothstep(1.0, 0.55, v)).mul(0.7).add(v.mul(0.3)));
    const amberCol = R.lamp.led === 'ribs' ? mix(color(0xb4500a), color(0xf08a1c), smoothstep(0.0, 0.17, v)) : color(0xd77016);
    const tailCol = mix(mix(mix(ruby, color(0xff3a44), led), amberCol, amber), color(0xe2e9ef), reverse);
    bCol.assign(mix(bCol, color(0x1a0a0e), housing));
    bCol.assign(mix(bCol, tailCol, lens));
    if (!spec.barnDoors && !R.bumper && !R.applique) bCol.assign(bCol.mul(one.sub(band(ax.sub(lidW), 0.003, fwX).mul(housing).mul(0.6))));
    plateOn(bCol, plateCol, plateR, !R.bumper, back);
    return { ...TL, lidRev };
  };

  // ---- Roughness & metalness (glossy clearcoat with tight sun highlight & strong SSR/IBL reflection) ---------------
  const paintRough = mix(float(0.11), float(0.16), isMetallic);
  const paintMetal = mix(float(0.32), float(0.42), isMetallic).add(fresnel.mul(0.14));

  // ---- Emissive: the lamps, the taxi's topper & the high brake light -----------------------------------------------
  const brake = state.x;
  const blink = max(state.y.mul(step(0.0, p.x)), state.z.mul(step(p.x, 0.0)));
  const nightHeadlamp = smoothstep(0.60, 1.15, cityUniforms.uInteriorGlow);
  // Low beams through the projector lenses (a little of the lens around them), running lights; both dim on the side
  // that is signalling, where the amber marker blinks
  const headlampGlow = ({ lens, drl, projLens, turn }) => {
    const beams = projLens.mul(nightHeadlamp.mul(1.35).add(1.45)).add(lens.mul(nightHeadlamp.mul(0.035).add(0.01)));
    const running = drl.mul(nightHeadlamp.mul(0.75).add(1.65));
    const headlamps = color(0xfff8ec).mul(beams.add(running)).mul(one.sub(drl.mul(blink)));
    return headlamps.add(color(0xff9812).mul(max(turn, drl.mul(0.75)).mul(blink).mul(2.4)));
  };
  const tailLampGlow = ({ lens, led, reverse, turn, amber, lidRev }) => {
    const redArea = lens.mul(one.sub(max(reverse, amber)));
    const redLens = spec.rear.lamp.led === 'ribs' ? redArea.mul(0.8) : max(redArea.mul(0.55), led);
    const tail = color(0xff0c16).mul(redLens.mul(brake.mul(2.3).add(nightHeadlamp.mul(0.55)).add(0.24)));
    // Turn signals: an amber section, or the red lamp's own section brightening
    const turnCol = spec.rear.lamp.turn === 'amber' ? color(0xff9812) : color(0xff1a10);
    let rearEmit = tail.add(turnCol.mul(turn.mul(blink).mul(2.4)));
    if (fixed) {
      const lidLamps = lidRev ? cov(lidRev.d, lidRev.w).mul(smoothstep(0.12, 0.38, n.z.negate())) : float(0.0);
      rearEmit = rearEmit.add(color(0xf0f6ff).mul(max(reverse, lidLamps)).mul(state.w).mul(1.8));
    }
    return rearEmit;
  };

  // ---- The surface: per-part If branches, so each fragment only evaluates its own part's masks, each once for its
  // colour, roughness, metalness & emissive ---------------------------------------------------------------------------
  const CarSurface = struct({ color: 'vec3', roughness: 'float', metalness: 'float', emissive: 'vec3' }, 'CarSurface');
  const surfaceFn = Fn(() => {
    const outCol = vec3(color(0x181b1f)).toVar();
    const rough = float(0.78).toVar();
    const metal = float(0.04).toVar();
    const emit = vec3(0.0).toVar();

    // Sample plate texture outside If() so hardware mipmaps + anisotropy filter cleanly without derivative issues
    // Passenger plates (0-2) by paint, T plates on for-hire black cars (3), medallion plates on yellow cabs (4)
    const plateVariant = spec.sign
      ? float(4.0)
      : mix(floor(fract(paint.r.mul(7).add(paint.g.mul(13)).add(paint.b.mul(17))).mul(3)), float(3.0), isTLC);
    const isFrontSide = smoothstep(-0.02, 0.02, n.z);
    const plateSignX = mix(float(-0.31), float(0.31), isFrontSide);
    const plateCenterY = mix(float(plateR), float(plateF), isFrontSide);
    const plateUV = vec2(
      clamp(p.x.div(plateSignX).add(0.5), 0.02, 0.98),
      clamp(p.y.sub(plateCenterY).div(0.115).add(0.5), 0.06, 0.94).add(plateVariant).div(5.0)
    );
    const plateCol = texture(carPlateTexture(), plateUV).rgb;
    const topperCol = topper ? vec3(topper.col).toVar() : null;
    // Badge lettering on the rear (the badge on this side of the car): read left to right from behind
    let badgeInk = float(0.0);
    const badges = spec.rear.badges || [];
    if (badges.length) {
      const pickB = (k) => (badges.length > 1 ? select(p.x.lessThan(0.0), float(badges[0][k]), float(badges[1][k])) : float(badges[0][k]));
      const bx = pickB(0);
      const by = pickB(1);
      const bw = pickB(2);
      const bh = pickB(3);
      const row = pickB(4);
      const badgeUV = vec2(
        clamp(float(0.5).sub(p.x.sub(bx).div(bw.mul(2.0))), 0.0, 1.0),
        clamp(p.y.sub(by).div(bh.mul(2.0)).add(0.5), 0.02, 0.98).add(float(BADGE_WORDS.length - 1).sub(row)).div(BADGE_WORDS.length)
      );
      const inBadge = step(abs(p.x.sub(bx)), bw).mul(step(abs(p.y.sub(by)), bh)).mul(step(p.z, rearZone));
      badgeInk = texture(carBadgeTexture(), badgeUV).w.mul(inBadge);
    }

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
      const dirt = dirtMask().mul(dirtAmount);
      bCol.assign(mix(bCol, color(0x6a6357).mul(ao), dirt.mul(0.6)));

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

      // Front & rear fascias: grilles, bumpers, lamps & NY license plates (fasciaFront / fasciaRear)
      If(p.z.greaterThan(frontZone), () => {
        emit.assign(headlampGlow(fasciaFront(bCol, plateCol)));
      }).ElseIf(p.z.lessThan(rearZone), () => {
        emit.assign(tailLampGlow(fasciaRear(bCol, plateCol, badgeInk)));
      });

      const under = smoothstep(-0.25, -0.55, n.y);
      outCol.assign(mix(bCol, color(0x0c0e11), under));
      const lowMatte = smoothstep(sillY + 0.10, sillY - 0.01, p.y).mul(0.16);
      rough.assign(paintRough.add(lowMatte).add(dirt.mul(0.5)));
      metal.assign(paintMetal);
    }).ElseIf(isWindow.greaterThan(0.5), () => {
      const { glass, frontGlass, rearGlass, seal } = evalWindowGlass();
      const beltStrip = band(p.y.sub(belt.add(0.01)), 0.007, fwY)
        .mul(smoothstep(0.5, 0.7, abs(n.x)))
        .mul(cov(float(glassEndZ + 0.03).sub(p.z), fwZ))
        .mul(cov(p.z.sub(cab.cowl - 0.07), fwZ));
      const chromeBelt = beltStrip.mul(hasChrome);
      const chmsl = chmslMask(rearGlass);
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
      rough.assign(mix(mix(paintRough, float(0.78), seal), float(0.08), glass));
      metal.assign(mix(mix(paintMetal, float(0.04), seal), mix(float(0.16), float(0.36), fresnel), glass));
      // The high brake light
      If(isWindow.mul(brake).greaterThan(0.5), () => {
        emit.assign(color(0xff0c16).mul(chmsl.mul(2.3)));
      });
    }).ElseIf(isAlloyFace.greaterThan(0.5), () => {
      outCol.assign(evalAlloyColor(wheelVec, rNorm, fwRing, fwSpoke, isPolice, isBlackout, wheelCode));
      rough.assign(mix(float(0.22), float(0.52), isPolice));
      metal.assign(mix(float(0.84), float(0.22), isPolice));
    }).ElseIf(isTyreRubber.greaterThan(0.5), () => {
      outCol.assign(evalTyreColor(rNorm, fwRing));
    }).ElseIf(isMirror.greaterThan(0.5), () => {
      const mirrorGlass = smoothstep(0.45, 0.65, n.z.negate());
      const mirrorTurn = smoothstep(0.05, 0.2, n.z)
        .mul(band(p.y.sub(bc.y + 0.082), 0.006, fwY))
        .mul(cov(float(0.88).sub(ax), fwX));
      const mirrorCapPaint = mix(basePaint, color(0x121519), max(isTwoTone, isBlackout));
      outCol.assign(mix(mix(mirrorCapPaint, color(0x8896a2), mirrorGlass), color(0x98a4ae), mirrorTurn));
      rough.assign(0.12);
      metal.assign(mix(paintMetal, float(0.65), mirrorGlass));
    }).ElseIf(isSign.greaterThan(0.5), () => {
      if (!topper) {
        outCol.assign(color(0xeef0f2)); // (only taxis have one)
        rough.assign(0.35);
        return;
      }
      // white plastic round the panels, a little darker down by the rail
      const shell = mix(color(0xb9bdc2), color(0xeef0f2), smoothstep(topper.y0, topper.y0 + 0.12, p.y));
      outCol.assign(mix(shell, topperCol, topper.panel));
      rough.assign(mix(float(0.35), float(0.18), topper.panel));
      // backlit: the ads glow faintly by day and brightly at night, the medallion number brighter still
      emit.assign(topperCol.mul(topper.panel.mul(nightHeadlamp.mul(0.9).add(0.3)).add(topper.end.mul(0.7))));
    });

    return CarSurface(outCol, rough, metal, emit);
  });

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.envMapIntensity = 1.35;
  if (fixed) mat.userData.carState = stateUniform;
  const surface = surfaceFn();
  mat.colorNode = surface.get('color');
  mat.roughnessNode = surface.get('roughness');
  mat.metalnessNode = surface.get('metalness');
  mat.emissiveNode = surface.get('emissive');

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
