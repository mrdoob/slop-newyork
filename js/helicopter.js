import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  color,
  attribute,
  abs,
  fract,
  min,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  length,
  fwidth,
  atan,
  round,
  dot,
  normalize,
  vec4,
  select,
  uniform,
  vec3,
  sign,
  positionLocal,
  cameraPosition,
  modelWorldMatrixInverse,
  transformNormalToView
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';
import { part } from './vehicles.js';
import { transparentEffectMRT } from './tsl-materials.js';

// The player's Manhattan sightseeing helicopter: a lofted fuselage with tube skids, rotors and its TSL material.

const _down = new THREE.Vector3(0, -1, 0);

// Filter-width anti-aliased 2D rounded rectangle SDF (ported from CarGenerator.js)
const roundedRect = Fn(([point, halfSize, radiusNode]) => {
  const pt = vec2(point).toVar();
  const hs = vec2(halfSize).toVar();
  const rad = float(radiusNode).toVar();
  const q = abs(pt).sub(hs).add(rad).toVar();
  const dist = length(max(q, vec2(0.0))).add(min(max(q.x, q.y), 0.0)).sub(rad).toVar();
  const edge = max(fwidth(dist), 0.001).toVar();
  return smoothstep(edge, edge.negate(), dist);
});

// Tube sections along a polyline (the skids)
function ring(center, rx, rz, segments = 6, phase = 0) {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2 + phase;
    return new THREE.Vector3(center.x + Math.cos(a) * rx, center.y, center.z + Math.sin(a) * rz);
  });
}

function limbSections(joints, segments = 6, phase = 0) {
  const rotation = new THREE.Quaternion();
  return joints.map(([center, rx, rz], i) => {
    const before = joints[Math.max(0, i - 1)][0];
    const after = joints[Math.min(joints.length - 1, i + 1)][0];
    rotation.setFromUnitVectors(_down, after.clone().sub(before).normalize());
    return ring(new THREE.Vector3(), rx, rz, segments, phase).map((p) =>
      p.applyQuaternion(rotation).add(center)
    );
  });
}

const HELI_PARTS = {
  FUSELAGE: 0,
  COWLING: 1,
  FIN: 2,
  SKID: 3,
  ROTOR: 4,
  EXHAUST: 5
};

/**
 * Helper to create a 12-point symmetric helicopter fuselage cross-section
 * with flattened belly floor, rounded lower chines, wide panoramic cabin flanks,
 * tumblehome upper glass/shoulder, and crowned roof/tailboom.
 */
function heliFuselageSection(z, halfW, botY, topY, bellyFlat = 0.68, shoulderRatio = 0.52) {
  const h = Math.max(0.08, topY - botY);
  const chineY = botY + h * 0.16;
  const shoulderY = botY + h * shoulderRatio;
  const eaveY = botY + h * 0.86;

  const right = [
    new THREE.Vector3(halfW * bellyFlat * 0.55, botY, z),
    new THREE.Vector3(halfW * 0.92, chineY, z),
    new THREE.Vector3(halfW, shoulderY, z),
    new THREE.Vector3(halfW * 0.88, eaveY, z),
    new THREE.Vector3(halfW * 0.46, topY - h * 0.03, z),
    new THREE.Vector3(0.0, topY, z)
  ];
  const left = right
    .slice(0, 5)
    .reverse()
    .map((p) => new THREE.Vector3(-p.x, p.y, p.z));
  const bottomCenter = [new THREE.Vector3(0.0, botY, z)];
  return [...bottomCenter, ...right, ...left].reverse();
}

// Six-point cross-section for the vertical fin and winglets.
function heliAirfoilSection(xCenter, yCenter, zCenter, halfThickX, chordZ) {
  return [
    new THREE.Vector3(xCenter, yCenter, zCenter + chordZ * 0.5),
    new THREE.Vector3(xCenter + halfThickX, yCenter, zCenter + chordZ * 0.18),
    new THREE.Vector3(xCenter + halfThickX * 0.65, yCenter, zCenter - chordZ * 0.25),
    new THREE.Vector3(xCenter, yCenter, zCenter - chordZ * 0.5),
    new THREE.Vector3(xCenter - halfThickX * 0.65, yCenter, zCenter - chordZ * 0.25),
    new THREE.Vector3(xCenter - halfThickX, yCenter, zCenter + chordZ * 0.18)
  ];
}

function buildHelicopterBodyGeometry() {
  const parts = [];

  // 1. Continuous 3D Lofted Monocoque Fuselage-to-Tailboom (15 stations from z = +2.82 nose to z = -5.85 tail)
  // [z, halfW, botY, topY, bellyFlat, shoulderRatio]
  const fuselageProfile = [
    [2.82, 0.16, 0.88, 1.02, 0.50, 0.50], // Aerodynamic nose tip
    [2.62, 0.54, 0.72, 1.18, 0.62, 0.48], // Lower nose chin window
    [2.20, 0.88, 0.58, 1.48, 0.72, 0.46], // Lower windshield base
    [1.55, 1.10, 0.52, 1.86, 0.78, 0.44], // Front pilot cabin & wide panoramic windscreen
    [0.75, 1.16, 0.50, 2.02, 0.80, 0.45], // Main sightseeing passenger cabin (widest section)
    [-0.15, 1.14, 0.50, 2.02, 0.80, 0.46], // Rear passenger cabin
    [-0.95, 1.02, 0.54, 1.96, 0.74, 0.50], // Cabin-to-cowling transition
    [-1.65, 0.74, 0.72, 1.84, 0.62, 0.54], // Rear baggage & tapered clamshell bay
    [-2.35, 0.42, 1.12, 1.74, 0.45, 0.55], // Forward tailboom root
    [-3.25, 0.31, 1.24, 1.72, 0.40, 0.55], // Mid tailboom
    [-4.35, 0.24, 1.32, 1.70, 0.38, 0.55], // Stabilizer station
    [-5.35, 0.18, 1.38, 1.68, 0.36, 0.55], // Rear tailboom before fin
    [-5.85, 0.12, 1.43, 1.65, 0.35, 0.55]  // Tailboom tip cap
  ];

  const fuselageSections = fuselageProfile.map((s) => heliFuselageSection(...s));
  parts.push(part(new LoftGeometry(fuselageSections, { capStart: true, capEnd: true }), HELI_PARTS.FUSELAGE));

  // 2. Sculpted Twin-Turbine Upper Engine Cowling & Mast Doghouse (lofted from z = +0.55 to -2.25)
  const cowlingProfile = [
    [0.55, 0.32, 1.94, 2.12, 0.85, 0.45],
    [0.10, 0.56, 1.96, 2.38, 0.85, 0.48],
    [-0.55, 0.62, 1.94, 2.44, 0.85, 0.50],
    [-1.25, 0.56, 1.88, 2.36, 0.82, 0.50],
    [-1.85, 0.38, 1.76, 2.10, 0.78, 0.50],
    [-2.28, 0.20, 1.68, 1.82, 0.70, 0.50]
  ];
  const cowlingSections = cowlingProfile.map((s) => heliFuselageSection(...s));
  parts.push(part(new LoftGeometry(cowlingSections, { capStart: true, capEnd: true }), HELI_PARTS.COWLING));

  // Twin Canted Turbine Exhaust Nozzles tucked cleanly into rear of engine cowling
  for (const side of [-1, 1]) {
    const exhaust = new THREE.CylinderGeometry(0.10, 0.125, 0.34, 14)
      .rotateX(Math.PI * 0.46)
      .rotateY(side * 0.10)
      .translate(side * 0.24, 2.08, -1.72);
    parts.push(part(exhaust, HELI_PARTS.EXHAUST));
  }

  // 3. 3D Lofted Swept Vertical Tail Fin (Airfoil cross-sections sweeping from z = -5.15 to -6.15)
  // Upper swept fin + lower ventral tail bumper fin
  const vFinProfile = [
    [-0.02, 0.88, -5.28, 0.05, 0.44], // Ventral tail fin tip
    [0.0,   1.48, -5.25, 0.12, 0.88], // Tailboom junction root
    [0.0,   1.95, -5.52, 0.10, 0.76], // Mid swept vertical fin
    [0.0,   2.48, -5.82, 0.08, 0.60], // Upper swept vertical fin
    [0.0,   2.82, -6.04, 0.05, 0.42]  // Top anti-collision beacon tip
  ];
  const vFinSections = vFinProfile.map(([x, y, z, hx, cz]) =>
    heliAirfoilSection(x, y, z, hx, cz).reverse()
  );
  parts.push(part(new LoftGeometry(vFinSections, { capStart: true, capEnd: true }), HELI_PARTS.FIN));

  // 4. 3D Lofted Horizontal Stabilizer Wing + Angled Endplate Winglets at z = -4.25
  const hStabSections = [-1.08, -0.55, 0.0, 0.55, 1.08].map((x) => {
    const taper = 1.0 - Math.abs(x) * 0.24;
    const chord = 0.46 * taper;
    const thick = 0.045 * taper;
    const y = 1.54;
    const z = -4.22 - Math.abs(x) * 0.12;
    return [
      new THREE.Vector3(x, y, z + chord * 0.5),
      new THREE.Vector3(x, y + thick, z + chord * 0.15),
      new THREE.Vector3(x, y + thick * 0.6, z - chord * 0.25),
      new THREE.Vector3(x, y, z - chord * 0.5),
      new THREE.Vector3(x, y - thick * 0.6, z - chord * 0.25),
      new THREE.Vector3(x, y - thick, z + chord * 0.15)
    ];
  });
  parts.push(part(new LoftGeometry(hStabSections, { capStart: true, capEnd: true }), HELI_PARTS.FIN));

  // Endplate Winglets on Horizontal Stabilizer tips
  for (const side of [-1, 1]) {
    const wx = side * 1.08;
    const wz = -4.35;
    const winglet = [
      [-0.22, 0.028, 0.30],
      [0.0,   0.036, 0.38],
      [0.26,  0.024, 0.26]
    ].map(([dy, hx, cz]) =>
      heliAirfoilSection(wx + side * Math.abs(dy) * 0.12, 1.54 + dy, wz - Math.abs(dy) * 0.15, hx, cz).reverse()
    );
    parts.push(part(new LoftGeometry(winglet, { capStart: true, capEnd: true }), HELI_PARTS.FIN));
  }

  // 5. Tubular Landing Skids (LoftGeometry curved skids with upturned front runners + arched cross-tubes + steps)
  for (const side of [-1, 1]) {
    const sx = side * 1.12;
    // Skid runner tube from upturned front tip (z = +2.15, y = 0.28) along ground (y = 0.07) to rear tip (z = -1.75)
    const skidJoints = [
      [new THREE.Vector3(sx, 0.28, 2.15), 0.036, 0.036],
      [new THREE.Vector3(sx, 0.12, 1.88), 0.045, 0.045],
      [new THREE.Vector3(sx, 0.07, 1.45), 0.048, 0.048],
      [new THREE.Vector3(sx, 0.07, 0.0),  0.048, 0.048],
      [new THREE.Vector3(sx, 0.07, -1.45), 0.048, 0.048],
      [new THREE.Vector3(sx, 0.12, -1.75), 0.038, 0.038]
    ];
    const skidSections = skidJoints.map(([c, rx, ry]) =>
      Array.from({ length: 8 }, (_, k) => {
        const a = (k / 8) * Math.PI * 2;
        return new THREE.Vector3(c.x + Math.cos(a) * rx, c.y + Math.sin(a) * ry, c.z);
      }).reverse()
    );
    parts.push(part(new LoftGeometry(skidSections, { capStart: true, capEnd: true }), HELI_PARTS.SKID));

    // Passenger boarding step plate
    const stepBar = new THREE.BoxGeometry(0.14, 0.03, 0.88).translate(side * 1.02, 0.28, 0.42);
    parts.push(part(stepBar, HELI_PARTS.SKID));
  }

  // Front & Rear Arched Skid Cross-Tubes hugging the fuselage belly
  for (const cz of [1.05, -0.82]) {
    const crossPoints = [
      [new THREE.Vector3(-1.12, 0.09, cz), 0.042, 0.042],
      [new THREE.Vector3(-0.92, 0.42, cz), 0.044, 0.044],
      [new THREE.Vector3(-0.62, 0.56, cz), 0.046, 0.046],
      [new THREE.Vector3(0.62,  0.56, cz), 0.046, 0.046],
      [new THREE.Vector3(0.92,  0.42, cz), 0.044, 0.044],
      [new THREE.Vector3(1.12,  0.09, cz), 0.042, 0.042]
    ];
    const crossSections = limbSections(crossPoints, 8);
    parts.push(part(new LoftGeometry(crossSections, { capStart: true, capEnd: true }), HELI_PARTS.SKID));
  }

  // Wire-strike cutter & pitot tube on nose
  const pitot = new THREE.CylinderGeometry(0.015, 0.025, 0.35, 6)
    .rotateX(Math.PI * 0.5)
    .translate(0, 0.88, 2.88);
  parts.push(part(pitot, HELI_PARTS.SKID));

  return mergeGeometries(parts);
}

/**
 * Builds the Main Rotor Mast, Swashplate & Hub; its blades are a rotor disc (createRotorDisc).
 */
function buildHelicopterMainRotorGeometry() {
  // Rotor mast, swashplate collar & aerodynamic hub dome
  const mast = new THREE.CylinderGeometry(0.11, 0.14, 0.52, 14).translate(0, -0.18, 0);
  const swash = new THREE.CylinderGeometry(0.24, 0.26, 0.08, 16).translate(0, -0.12, 0);
  const hubCap = new THREE.SphereGeometry(0.28, 16, 10)
    .scale(1.0, 0.42, 1.0)
    .translate(0, 0.04, 0);
  return mergeGeometries([
    part(mast, HELI_PARTS.SKID),
    part(swash, HELI_PARTS.EXHAUST),
    part(hubCap, HELI_PARTS.ROTOR)
  ]);
}

/**
 * Builds the Tail Rotor Hub; its blades are a rotor disc (createRotorDisc).
 */
function buildHelicopterTailRotorGeometry() {
  const hub = new THREE.CylinderGeometry(0.09, 0.09, 0.18, 12)
    .rotateZ(Math.PI * 0.5);
  return mergeGeometries([part(hub, HELI_PARTS.EXHAUST)]);
}

// The rotors' blades (radii in m from the shaft). The main rotor turns at the rate of its sound (5.2 rev/s,
// audio-synthesis.js), the tail rotor 6 times as fast; both cone up a little under lift. `thickness` is how
// deep a blade looks seen edge-on: its own thickness plus its chord's rise at the blades' pitch.
const MAIN_ROTOR = {
  blades: 4, inner: 0.2, tip: 4.905, gripTo: 0.46, gripChord: 0.14, chord: 0.26, thickness: 0.045,
  tipPaint: 4.35, coning: 0.05, rate: 2 * Math.PI * 5.2
};
const TAIL_ROTOR = {
  blades: 4, inner: 0.09, tip: 0.8, gripTo: 0, gripChord: 0.13, chord: 0.13, thickness: 0.03,
  tipPaint: 0.73, coning: 0, rate: 2 * Math.PI * 5.2 * 6
};

/**
 * A rotor's blades as a disc turning about its +y, seen as a camera sees spinning blades: each point is as opaque as
 * the share of the frame's exposure a blade spends over it. Sharp blades tens of degrees apart in successive frames
 * strobe; smeared over the angle they turn while the frame is exposed (`sweep`, set each frame), they trail into
 * blurred sectors, darker towards the hub, where a blade covers more of each circle, and once they turn further than
 * the gap between them, into a faint even disc. Seen edge-on, the blades' depth makes the disc a dark line.
 */
function createRotorDisc(spec) {
  const geometry = new THREE.RingGeometry(spec.inner, spec.tip + 0.05, 96, 1).rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    position.setY(i, Math.hypot(position.getX(i), position.getZ(i)) * Math.tan(spec.coning));
  }
  geometry.computeVertexNormals();

  const sweep = uniform(0);
  const material = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.55,
    metalness: 0.0
  });

  const p = positionLocal;
  const r = length(p.xz);
  // Angle in the direction the rotor turns: the blades sat at smaller angles earlier in the exposure
  const angle = atan(p.z.negate(), p.x);
  const period = float((2 * Math.PI) / spec.blades);
  // A slanting view ray passes through a blade's depth too, which widens the blade along its path: seen edge-on,
  // most of what shows is the blades' leading & trailing edges, which face along that path rather than up
  const view = normalize(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz.sub(p));
  const path = vec2(p.z.negate(), p.x).div(r);
  const edges = abs(dot(view.xz, path)).div(max(abs(view.y), 0.05)).mul(spec.thickness);
  const surface = select(r.lessThan(spec.gripTo), float(spec.gripChord), float(spec.chord));
  const chord = surface.add(edges);
  const half = min(chord.div(r).mul(0.5), period.mul(0.5));
  const face = vec3(0.0, sign(view.y), 0.0);
  const edge = vec3(path.x, 0.0, path.y).mul(sign(dot(view.xz, path)));
  material.normalNode = transformNormalToView(normalize(mix(face, edge, edges.div(chord))));
  // Share of the angle from 0 to x that the blades cover
  const covered = (x) => {
    const turns = round(x.div(period));
    return turns.mul(half.mul(2.0)).add(clamp(x.sub(turns.mul(period)), half.negate(), half));
  };
  const exposure = max(sweep, 0.001);
  const coverage = covered(angle.add(exposure)).sub(covered(angle)).div(exposure);
  const tipEdge = fwidth(r);
  material.opacityNode = coverage.mul(smoothstep(tipEdge.negate().add(spec.tip), tipEdge.add(spec.tip), r).oneMinus());
  // Matte anthracite blades with high-visibility yellow tips
  material.colorNode = mix(color(0x1e232a), color(0xffbe28), smoothstep(spec.tipPaint, spec.tipPaint + 0.07, r));
  material.mrtNode = transparentEffectMRT; // SSR & AO keep seeing what is behind the disc

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'RotorDisc';
  return { mesh, sweep };
}

let _heliLoftedMat = null;

/**
 * Creates the TSL procedural material for the 3D Lofted Sightseeing Helicopter:
 * - Renders wrap-around panoramic windscreen, chin bubble windows, sightseeing cabin side windows,
 *   and overhead skylight glass using anti-aliased `roundedRect` SDFs with rubber seals & frame pillars.
 * - Renders a sleek flush executive NYC Sightseeing livery (Pearl Aviation White upper cabin,
 *   Deep Midnight Navy belly/tailboom, and a sweeping Metallic Gold & Crimson accent stripe).
 * - Renders slatted turbine air intakes on the engine cowling and high-visibility yellow tips on rotor blades.
 */
function createLoftedHelicopterMaterial() {
  if (_heliLoftedMat) return _heliLoftedMat;

  const mat = new THREE.MeshStandardNodeMaterial();

  const partId = attribute('partId', 'float');
  const isCowling = step(abs(partId.sub(HELI_PARTS.COWLING)), 0.25);
  const isFin = step(abs(partId.sub(HELI_PARTS.FIN)), 0.25);
  const isSkid = step(abs(partId.sub(HELI_PARTS.SKID)), 0.25);
  const isRotor = step(abs(partId.sub(HELI_PARTS.ROTOR)), 0.25);
  const isExhaust = step(abs(partId.sub(HELI_PARTS.EXHAUST)), 0.25);
  const isFuselage = step(abs(partId.sub(HELI_PARTS.FUSELAGE)), 0.25);

  const p = attribute('position', 'vec3').toVar();
  const n = attribute('normal', 'vec3').toVar();

  // 1. Panoramic Wrap-Around Cockpit Windscreen & Sightseeing Side Cabin Windows (on Fuselage)
  // Front windscreen: z in [0.95, 2.52], y in [0.98, 1.88], split by narrow center post at x = 0
  const frontGlassOuter = roundedRect(vec2(p.z.sub(1.74), p.y.sub(1.42)), vec2(0.76, 0.42), 0.14)
    .mul(step(0.65, p.z));
  const centerPost = smoothstep(0.022, 0.036, abs(p.x));
  const aPillar = smoothstep(0.028, 0.044, abs(p.z.sub(1.06)));
  const bPillar = smoothstep(0.026, 0.042, abs(p.z.sub(0.08)));

  // Lower nose chin bubble windows (for pilot downward visibility)
  const chinWindow = roundedRect(vec2(abs(p.x).sub(0.28), p.y.sub(0.84)), vec2(0.19, 0.11), 0.04)
    .mul(smoothstep(1.95, 2.15, p.z))
    .mul(smoothstep(2.68, 2.52, p.z));

  // Wide panoramic passenger sightseeing side windows: z in [-0.78, 1.02], y in [1.02, 1.74]
  const sideWindow = roundedRect(vec2(p.z.sub(0.12), p.y.sub(1.38)), vec2(0.88, 0.34), 0.10)
    .mul(step(0.45, abs(n.x)));

  // Overhead cockpit eyebrow skylight windows
  const skylight = roundedRect(vec2(abs(p.x).sub(0.32), p.z.sub(1.25)), vec2(0.20, 0.38), 0.06)
    .mul(step(1.72, p.y));

  const rawWindowMask = max(
    max(frontGlassOuter.mul(centerPost), sideWindow),
    max(chinWindow, skylight)
  )
    .mul(aPillar)
    .mul(bPillar)
    .mul(isFuselage)
    .toVar();

  const evaluateHeliSurface = Fn(() => {
    // Rubber window weatherstripping seal around glass panes
    const rawSealMask = max(
      roundedRect(vec2(p.z.sub(1.74), p.y.sub(1.42)), vec2(0.80, 0.46), 0.15).mul(step(0.60, p.z)),
      roundedRect(vec2(p.z.sub(0.12), p.y.sub(1.38)), vec2(0.92, 0.38), 0.12).mul(step(0.40, abs(n.x)))
    )
      .mul(isFuselage)
      .toVar();

    // 2. Flush Executive NYC Sightseeing Livery (Aviation White + Midnight Navy + Sweeping Gold Ribbon)
    const navyCurveY = float(1.00).add(p.z.mul(-0.085));
    const edgeW = max(fwidth(p.y), 0.008);
    const isLowerNavy = smoothstep(navyCurveY.add(edgeW), navyCurveY.sub(edgeW), p.y);
    const goldStripeDist = abs(p.y.sub(navyCurveY.add(0.065)));
    const isGoldStripe = smoothstep(0.055, 0.038, goldStripeDist);
    const redPinDist = abs(p.y.sub(navyCurveY.add(0.145)));
    const isRedPin = smoothstep(0.022, 0.012, redPinDist);

    // Cabin door panel seams & handles
    const doorSeam1 = smoothstep(0.012, 0.004, abs(p.z.sub(1.06)));
    const doorSeam2 = smoothstep(0.012, 0.004, abs(p.z.sub(0.08)));
    const doorSeam3 = smoothstep(0.012, 0.004, abs(p.z.sub(-0.82)));
    const doorHandle = roundedRect(vec2(p.z.sub(0.24), p.y.sub(0.94)), vec2(0.065, 0.014), 0.006);
    const panelLines = max(max(doorSeam1, max(doorSeam2, doorSeam3)), doorHandle)
      .mul(step(0.55, abs(n.x)))
      .mul(smoothstep(0.55, 0.62, p.y))
      .mul(smoothstep(1.75, 1.65, p.y));

    const whitePaint = color(0xf4f7fb);
    const navyPaint = color(0x132c58);
    const goldPaint = color(0xffbe28);
    const redPaint = color(0xd8222b);

    const baseLivery = mix(
      mix(mix(whitePaint, navyPaint, isLowerNavy), goldPaint, isGoldStripe),
      redPaint,
      isRedPin
    ).mul(float(1.0).sub(panelLines.mul(0.45)));

    const glassCol = mix(color(0x102234), color(0x1e3c58), clamp(n.y.mul(0.5).add(0.5), 0.0, 1.0));
    const fuselageCol = mix(mix(baseLivery, color(0x14181e), rawSealMask), glassCol, rawWindowMask);

    // 3. Engine Cowling: Aviation White with Dark Slatted Turbine Intake Grille
    const intakeGrille = roundedRect(vec2(p.z.sub(-0.45), p.y.sub(2.18)), vec2(0.52, 0.13), 0.04)
      .mul(step(0.35, abs(n.x)));
    const louverSlats = step(0.45, fract(p.y.mul(55.0))).mul(0.4).add(0.35);
    const cowlingCol = mix(
      mix(whitePaint, goldPaint, smoothstep(2.02, 1.97, p.y)),
      color(0x181c22).mul(louverSlats),
      intakeGrille
    );

    // 4. Swept Tail Fin & Stabilizer: Deep Navy with Gold Tip Accent
    const finGoldBand = smoothstep(2.42, 2.45, p.y).mul(smoothstep(2.62, 2.59, p.y));
    const finCol = mix(navyPaint, goldPaint, finGoldBand);

    // 5. Rotor Blades: Matte Anthracite Carbon with High-Visibility Yellow Safety Tips
    const radialDist = length(vec2(p.x, p.z));
    const isBladeTip = smoothstep(4.35, 4.42, radialDist).add(
      smoothstep(0.65, 0.68, abs(p.y)).mul(step(radialDist, 0.35))
    );
    const rotorCol = mix(color(0x1e232a), goldPaint, clamp(isBladeTip, 0.0, 1.0));

    const skidCol = color(0x22272e);
    const exhaustBore = step(0.65, n.z.negate());
    const exhaustCol = mix(color(0x484f58), color(0x101318), exhaustBore);

    return mix(
      mix(
        mix(
          mix(
            mix(fuselageCol, cowlingCol, isCowling),
            finCol,
            isFin
          ),
          skidCol,
          isSkid
        ),
        rotorCol,
        isRotor
      ),
      exhaustCol,
      isExhaust
    );
  });

  mat.colorNode = evaluateHeliSurface();

  mat.roughnessNode = mix(mix(float(0.20), float(0.05), rawWindowMask), float(0.55), max(isSkid, isRotor));
  mat.metalnessNode = mix(mix(float(0.35), float(0.88), rawWindowMask), float(0.82), isExhaust);

  _heliLoftedMat = mat;
  return mat;
}

export {
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial,
  createRotorDisc,
  MAIN_ROTOR,
  TAIL_ROTOR
};
