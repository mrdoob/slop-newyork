import * as THREE from 'three/webgpu';
import { cityUniforms } from './tsl-materials.js';
import {
  Fn,
  If,
  float,
  vec2,
  vec3,
  color,
  attribute,
  varying,
  vertexStage,
  atan,
  abs,
  fract,
  floor,
  min,
  max,
  clamp,
  mix,
  step,
  smoothstep,
  select,
  sqrt,
  dot,
  pow,
  length,
  fwidth,
  normalView,
  positionViewDirection,
  instanceIndex
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from 'three/addons/geometries/LoftGeometry.js';
import { part, mirrorSection, roundedBox } from './vehicles.js';
import { CAR_PARTS, buildBodyLoft, carBodyHalfWidthAt, viewRayDerivatives, objectViewRay, throughGlass } from './cars.js';

// A 40-ft low-floor MTA bus lofted with the car body machinery: rounded plan-view corners, a raked windshield, a
// tight roof radius and arches over the wheels; bumpers, the folded front bike rack, stalk mirrors and the roof AC &
// battery pods are separate pieces of the same mesh (partId). Windows, doors, livery & lamps are painted by
// createLoftedBusMaterial(); destination signs are textured panels (buildBusSignGeometry).
const BUS_PARTS = {
  BODY: 0,
  TRIM: 1,
  POD: 2,
  FAIRING: 3
};

const BUS_SPEC = {
  name: 'bus',
  headlight: [0.89, 0.78], // midpoint of each swept Xcelsior LED headlamp cluster
  zFront: 5.9,
  zRear: -6.22,
  wheelRadius: 0.5,
  wheelZ: 3.6,
  wheelX: 1.12,
  archGap: 0.085,
  archFlare: 0.012,
  tuck: 0.035,
  stationStep: 0.92,
  lowerRound: 3.4,
  upperRound: 7.5,
  upperSamples: [0.35, 0.66, 0.89, 1],
  halfWidth: [[5.9, 1.3], [-6.22, 1.3]],
  sill: [[5.9, 0.35], [-6.22, 0.36]],
  shoulder: [[5.9, 0.98], [-6.22, 0.98]],
  edge: [[5.9, 2.94], [-6.22, 2.94]],
  crown: [[5.9, 0.04], [-6.22, 0.04]],
  tumble: [[5.9, 0.055], [-6.22, 0.055]],
  nose: { halfWidth: [0.28, 1.06, 2.2], edge: [0.26, 2.74, 2], crown: [0.26, 0.006, 2], sill: [0.08, 0.42, 2], shoulder: [0.2, 0.92, 2] },
  tail: { halfWidth: [0.22, 1.12, 2.2], edge: [0.2, 2.78, 2], crown: [0.2, 0.006, 2], sill: [0.1, 0.46, 2], shoulder: [0.18, 0.94, 2] },
  rake: 0.22, // how far the top of the windshield & sign header leans back
  window: [1.22, 2.42], // side window band (y)
  frontDoor: [4.36, 5.42], // curb-side (-x) low-floor entry & rear exit doors (z ranges)
  rearDoor: [-2.06, -1.02]
};

// Windshield & header rake at the nose (plus slight plan-view bow and upper-rear cap taper)
function busRake(y, z, x = 0) {
  const s = BUS_SPEC;
  const alongF = Math.min(1, Math.max(0, (z - (s.zFront - 1.15)) / 1.15));
  const upF = Math.min(1, Math.max(0, (y - 1.1) / 1.72));
  const noseBow = alongF * alongF * (0.028 * x * x + Math.max(0, 1.12 - y) * 0.035);
  const alongR = Math.min(1, Math.max(0, (s.zRear + 0.75 - z) / 0.75));
  const upR = Math.min(1, Math.max(0, (y - 1.38) / 1.5));
  const tailTaper = -0.055 * alongR * alongR * Math.pow(upR, 1.25);
  return s.rake * alongF * alongF * Math.pow(upF, 1.22) + noseBow + tailTaper;
}

function buildLoftedBusBodyGeometry() {
  const s = BUS_SPEC;
  const body = buildBodyLoft(s, 1);
  const pos = body.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setZ(i, z - busRake(y, z, x));
  }
  body.computeVertexNormals();
  const parts = [part(body, BUS_PARTS.BODY)];

  // Sculpted New Flyer Xcelsior full-length roof fairing (shroud): aerodynamic sloped nose behind the front sign,
  // raised battery/cooling fairing over the front half, stepped rear HVAC shroud, painted in upper-body livery
  const roofY = s.edge[0][1] + s.crown[0][1] - 0.03;
  const fairingStations = [
    [4.68, 0.92, 0.01, 0.005],
    [4.12, 1.08, 0.22, 0.035],
    [3.35, 1.13, 0.26, 0.04],
    [-0.35, 1.13, 0.26, 0.04],
    [-0.85, 1.12, 0.2, 0.035],
    [-5.55, 1.11, 0.19, 0.035],
    [-5.95, 0.98, 0.02, 0.008]
  ];
  const fairingSections = fairingStations.map(([z, hw, h, cr]) =>
    mirrorSection(
      [
        [hw, roofY],
        [hw - 0.035, roofY + h * 0.68],
        [hw - 0.12, roofY + h],
        [hw * 0.45, roofY + h + cr * 0.8]
      ],
      [0, roofY + h + cr],
      z
    )
  );
  parts.push(part(new LoftGeometry(fairingSections, { closed: false }), BUS_PARTS.FAIRING));

  // Recessed roof HVAC & battery cooling modules nested inside the roof shroud
  parts.push(part(roundedBox(0.88, 0.065, 2.5, 0.08, 0.025).translate(0, roofY + 0.22, -3.35), BUS_PARTS.POD));
  parts.push(part(roundedBox(0.84, 0.06, 2.7, 0.08, 0.025).translate(0, roofY + 0.27, 1.45), BUS_PARTS.POD));

  // Wraparound 3-piece energy-absorbing front & rear bumpers + folded Sportworks front bike rack
  const zNose = s.zFront - busRake(0.48, s.zFront, 0);
  parts.push(part(roundedBox(1.27, 0.13, 0.26, 0.075, 0.028).translate(0, 0.47, zNose - 0.02), BUS_PARTS.TRIM));
  parts.push(part(roundedBox(1.26, 0.125, 0.24, 0.065, 0.028).translate(0, 0.46, s.zRear + 0.03), BUS_PARTS.TRIM));
  const rackZ = zNose + 0.14;
  parts.push(part(roundedBox(0.54, 0.022, 0.045, 0.018, 0.007).translate(0, 0.96, rackZ + 0.03), BUS_PARTS.TRIM));
  parts.push(part(roundedBox(0.5, 0.02, 0.045, 0.016, 0.007).translate(0, 0.68, rackZ), BUS_PARTS.TRIM));
  for (const side of [-1, 1]) {
    parts.push(part(new THREE.BoxGeometry(0.032, 0.34, 0.032).rotateX(-0.1).translate(side * 0.49, 0.81, rackZ + 0.015), BUS_PARTS.TRIM));
    parts.push(part(new THREE.BoxGeometry(0.024, 0.28, 0.024).rotateX(-0.1).translate(side * 0.18, 0.81, rackZ + 0.015), BUS_PARTS.TRIM));
  }

  // Asymmetric Xcelsior transit mirrors: high-mount curb arm (-x) clearing boarding passengers, mid-mount driver arm (+x)
  for (const side of [-1, 1]) {
    const mountY = side < 0 ? 2.48 : 2.16;
    const headY = side < 0 ? 2.28 : 1.98;
    const stalk = new THREE.BoxGeometry(0.036, 0.036, 0.44)
      .rotateX(0.32)
      .rotateY(side * 0.42)
      .translate(side * 1.27, mountY - 0.06, s.zFront - 0.06);
    const head = roundedBox(0.072, 0.19, 0.055, 0.026, 0.01).translate(side * 1.37, headY, s.zFront + 0.08);
    parts.push(part(stalk, BUS_PARTS.TRIM), part(head, BUS_PARTS.TRIM));
  }

  // Enclosed 3D wheel-well housings (inward-facing arch ceiling + double-sided back liner) so no gap shows around the wheels
  const wellR = s.wheelRadius + s.archGap + 0.008;
  const wellDepth = 0.36;
  for (const side of [-1, 1]) {
    for (const z of [-s.wheelZ, s.wheelZ]) {
      const cyl = new THREE.CylinderGeometry(wellR, wellR, wellDepth, 10, 1, true, -0.28, Math.PI + 0.56)
        .scale(-1, 1, 1)
        .rotateZ(-Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.02), s.wheelRadius, z);
      const backOut = new THREE.CircleGeometry(wellR, 10, -0.28, Math.PI + 0.56)
        .rotateY(side * Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.19), s.wheelRadius, z);
      const backIn = new THREE.CircleGeometry(wellR, 10, -0.28, Math.PI + 0.56)
        .rotateY(-side * Math.PI * 0.5)
        .translate(side * (s.wheelX - 0.19), s.wheelRadius, z);
      parts.push(part(cyl, BUS_PARTS.TRIM), part(backOut, BUS_PARTS.TRIM), part(backIn, BUS_PARTS.TRIM));
    }
  }
  return mergeGeometries(parts);
}

/**
 * Destination sign panels for the bus's sign texture (route badge + destination): above the windshield, on the curb
 * side behind the front door, and the route number box on the upper-right rear cap. Same object space as the bus body.
 */
function buildBusSignGeometry() {
  const s = BUS_SPEC;
  const panels = [];
  const yF = 2.56;
  const z0 = s.zFront - busRake(yF - 0.13, s.zFront, 0);
  const z1 = s.zFront - busRake(yF + 0.13, s.zFront, 0);
  const front = new THREE.PlaneGeometry(1.94, 0.27);
  front.rotateX(-Math.atan2(z0 - z1, 0.26));
  front.translate(0, yF, (z0 + z1) * 0.5 + 0.014);
  panels.push(front);
  const sideZ = 3.74;
  const sideY = 2.26;
  const side = new THREE.PlaneGeometry(1.08, 0.19).rotateY(-Math.PI / 2);
  side.translate(-(carBodyHalfWidthAt(s, sideZ, sideY) + 0.007), sideY, sideZ);
  panels.push(side);
  const yR = 2.58;
  const zR0 = s.zRear - busRake(yR - 0.1, s.zRear, -0.45);
  const zR1 = s.zRear - busRake(yR + 0.1, s.zRear, -0.45);
  const rear = new THREE.PlaneGeometry(0.52, 0.21);
  const uv = rear.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.29);
  rear.rotateY(Math.PI);
  rear.rotateX(Math.atan2(zR1 - zR0, 0.2));
  rear.translate(-0.45, yR, (zR0 + zR1) * 0.5 - 0.012);
  panels.push(rear);
  return mergeGeometries(panels);
}

// Heavy-duty 22.5" transit bus wheel: tall 305/70R22.5 tyre sidewall with deep-dish white/silver steel wheel,
// 10 lug nuts, 5 hand-hole cutouts, and a protruding cast-iron axle hub (spins about x, centred on the origin)
function buildBusWheelGeo(side) {
  const r = BUS_SPEC.wheelRadius;
  const w = 0.3;
  const rimR = r * 0.59;
  const tyre = new THREE.LatheGeometry(
    [
      new THREE.Vector2(rimR, -w * 0.48),
      new THREE.Vector2(r * 0.95, -w * 0.44),
      new THREE.Vector2(r, -w * 0.28),
      new THREE.Vector2(r, w * 0.28),
      new THREE.Vector2(r * 0.95, w * 0.44),
      new THREE.Vector2(rimR, w * 0.48)
    ],
    22
  );
  const disc = new THREE.LatheGeometry(
    [
      new THREE.Vector2(rimR, w * 0.48),
      new THREE.Vector2(rimR * 0.92, w * 0.42),
      new THREE.Vector2(rimR * 0.72, w * 0.18),
      new THREE.Vector2(0.115, w * 0.22)
    ],
    22
  );
  const backDisc = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0, -w * 0.18),
      new THREE.Vector2(rimR * 0.75, -w * 0.18),
      new THREE.Vector2(rimR, -w * 0.48)
    ],
    14
  );
  const cap = new THREE.CylinderGeometry(0.095, 0.118, 0.13, 14).translate(0, w * 0.26, 0);
  const parts = [
    part(tyre, CAR_PARTS.TYRE),
    part(disc, CAR_PARTS.ALLOY),
    part(backDisc, CAR_PARTS.ALLOY),
    part(cap, CAR_PARTS.ALLOY)
  ];
  for (const g of parts) g.rotateZ(-side * Math.PI * 0.5);
  return mergeGeometries(parts);
}

let _busWheelMat = null;

function createBusWheelMaterial() {
  if (_busWheelMat) return _busWheelMat;
  const p = attribute('position', 'vec3');
  const partId = attribute('partId', 'float');
  const isTyre = step(abs(partId.sub(CAR_PARTS.TYRE)), 0.25);
  const radial = length(vec2(p.z, p.y));
  const theta = atan(p.y, p.z);
  // Footprints across the wheel's rings (radial) and around it (tangential), from the per-axis footprint in the (z, y)
  // wheel plane, so the disc stays sharp when it is seen at a grazing angle
  const fwZY = max(vec2(fwidth(p.z), fwidth(p.y)), vec2(0.0015)).toVar();
  const radDir = vec2(p.z, p.y).div(max(radial, 0.0001));
  const fwRing = abs(radDir.x).mul(fwZY.x).add(abs(radDir.y).mul(fwZY.y));
  const fwTan = abs(radDir.y).mul(fwZY.x).add(abs(radDir.x).mul(fwZY.y));
  const fwRound = max(fwRing, fwTan);
  const covAt = (r, d, w) => clamp(float(0.5).sub(d.sub(r).div(w)), 0.0, 1.0);
  // Exact box filter of a band |d| < h, so the thin rings narrow and lighten smoothly instead of fading out
  const band = (d, h, w) => clamp(min(d.add(h), w.mul(0.5)).sub(max(d.sub(h), w.mul(-0.5))).div(w), 0.0, 1.0);
  const detailFade = (w) => smoothstep(0.036, 0.008, w);

  // Fold 10 lug nuts & orange safety indicators into a single angular sector, anti-aliased and faded
  const a10 = fract(theta.mul(1.5915494).add(0.5)).sub(0.5).mul(0.6283185);
  const lugArc = radial.mul(a10);
  const dLug = length(vec2(radial.sub(0.175), lugArc));
  const lugs = covAt(0.015, dLug, fwRound).mul(detailFade(fwRound));
  const dTag = length(vec2(radial.sub(0.192), lugArc));
  const indicators = covAt(0.011, dTag, fwRound)
    .mul(float(1.0).sub(covAt(0.009, dLug, fwRound)))
    .mul(detailFade(fwRound));

  // Fold 5 hand-hole cutouts into a single angular sector, anti-aliased
  const a5 = fract(theta.sub(0.31).mul(0.7957747).add(0.5)).sub(0.5).mul(1.256637);
  const dVent = length(vec2(radial.sub(0.238), radial.mul(a5).mul(0.85)));
  const vents = covAt(0.03, dVent, fwRound).mul(smoothstep(0.06, 0.015, fwRound));

  const rimLip = band(radial.sub(0.282), 0.008, fwRing);
  const dishShade = smoothstep(0.16, 0.27, radial).mul(0.22).add(0.78);
  const steelBase = color(0xdce2e8).mul(dishShade).mul(float(1.0).sub(rimLip.mul(0.35)));
  const withVents = mix(steelBase, color(0x101317), vents.mul(0.92));
  const withHub = mix(withVents, color(0x22262b), covAt(0.115, radial, fwRing));
  const hubCapCenter = mix(withHub, color(0x3a4048), covAt(0.068, radial, fwRing));
  const withIndicators = mix(hubCapCenter, color(0xe84818), indicators.mul(0.85));
  const disc = mix(withIndicators, color(0x1e2228), lugs.mul(0.88));

  const scuffRib = band(radial.sub(0.41), 0.008, fwRing).mul(0.06);
  const sidewall = smoothstep(0.295, 0.36, radial).mul(float(1.0).sub(smoothstep(0.44, 0.495, radial).mul(0.22))).mul(0.28).add(0.72).add(scuffRib);
  const tread = smoothstep(0.38, 0.52, fract(theta.mul(7.64))).mul(smoothstep(0.45, 0.48, radial)).mul(detailFade(fwTan)).mul(0.07);
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = mix(disc, color(0x16181b).mul(sidewall.add(tread)), isTyre);
  mat.roughnessNode = mix(mix(float(0.32), float(0.78), max(vents, smoothstep(0.12, 0.1, radial))), float(0.86), isTyre);
  mat.metalnessNode = mix(mix(float(0.55), float(0.15), vents), float(0.02), isTyre);
  _busWheelMat = mat;
  return mat;
}

let _busLoftedMat = null;

const BUS_ROWS = { first: 3.4, pitch: 0.78, count: 12 }; // forward-facing seat backs from z = first towards the tail
const RIDER_SKIN = [0xc68863, 0x8a5535, 0xe0b090, 0x5a3424, 0xa96f4c];
const RIDER_CLOTHES = [0x1a1c22, 0x4a5060, 0x2a3a5a, 0x8a8478, 0x5a2a2a, 0x2f4a3a];

function pickHex(hexArray, t) {
  let acc = color(hexArray[0]);
  for (let i = 1; i < hexArray.length; i++) acc = mix(acc, color(hexArray[i]), step(float(i), t.mul(hexArray.length)));
  return acc;
}

/**
 * The bus's saloon seen through its windows, ray traced in object space from the glass fragment `o` along `d`: light
 * grey walls under the far windows (daylight through them), the ceiling with its light strips, the floor, the driver,
 * yellow stanchions along the aisle and rows of seat backs with riders in some of them (`hash` 0..1 varies the riders
 * per bus). Returns the albedo seen through the glass (before its tint).
 */
function busInterior(o, d, hash) {
  const s = BUS_SPEC;
  const xi = 1.16;
  const floorY = 0.42;
  const ceilY = 2.5;
  const zFront = s.zFront - 0.45;
  const zBack = s.zRear + 0.4;
  const [wy0, wy1] = s.window;
  const far = float(1e4);
  const sgn = step(0.0, d).mul(2.0).sub(1.0);
  const inv = vec3(1.0).div(d.add(sgn.mul(1e-5)));
  const ahead = (t) => select(t.greaterThan(0.0), t, far);

  // Leaving the saloon: the far side's windows (between mullions) or wall, ceiling or floor, windshield or rear wall
  const tSide = ahead(sgn.x.mul(xi).sub(o.x).mul(inv.x));
  const tUp = ahead(select(d.y.greaterThan(0.0), float(ceilY).sub(o.y), float(floorY).sub(o.y)).mul(inv.y));
  const tEnd = ahead(select(d.z.greaterThan(0.0), float(zFront).sub(o.z), float(zBack).sub(o.z)).mul(inv.z));
  const tBest = min(tSide, min(tUp, tEnd)).toVar();
  const h = o.add(d.mul(tBest));
  const isSide = step(tSide, min(tUp, tEnd));
  const isUp = step(tUp, min(tSide, tEnd)).mul(float(1.0).sub(isSide));
  const mullion = step(abs(fract(h.z.mul(0.76).add(0.18)).sub(0.5)), 0.03);
  const farWindow = step(wy0, h.y).mul(step(h.y, wy1)).mul(float(1.0).sub(mullion)).mul(isSide);
  const windshield = step(1.2, h.y).mul(step(0.0, d.z)).mul(float(1.0).sub(isSide)).mul(float(1.0).sub(isUp));
  const ceiling = mix(float(0.42), float(0.75), smoothstep(0.08, 0.04, abs(abs(h.x).sub(0.68))));
  const shell = mix(mix(vec3(0.28, 0.285, 0.29), vec3(ceiling), step(0.0, d.y).mul(isUp)), vec3(0.05), float(1.0).sub(step(0.0, d.y)).mul(isUp));
  const seeThrough = max(farWindow, windshield);
  const col = vec3(mix(shell, throughGlass(d), seeThrough)).toVar();
  const lit = vec3(mix(vec3(0.45), vec3(0.85), seeThrough)).toVar();
  const hit = (t, c) => {
    const nearer = step(t, tBest);
    tBest.assign(mix(tBest, t, nearer));
    col.assign(mix(col, c, nearer));
    lit.assign(mix(lit, vec3(0.45), nearer));
  };

  // Seat backs: the next few row planes along the ray. Riders sit in some seats (window or aisle), none on the curb
  // side by the rear door.
  const { first, pitch, count } = BUS_ROWS;
  const u = float(first).sub(o.z).div(pitch);
  const forward = step(0.0, d.z.negate()); // rows are numbered towards the tail
  const k0 = floor(u).add(forward);
  const dk = forward.mul(2.0).sub(1.0);
  for (let i = 0; i < 4; i++) {
    const k = k0.add(dk.mul(i));
    const zk = float(first).sub(k.mul(pitch));
    const t = ahead(zk.sub(o.z).mul(inv.z));
    const q = o.add(d.mul(t));
    const ax = abs(q.x);
    const inRows = step(0.0, k).mul(step(k, count - 1));
    const doorGap = step(q.x, 0.0).mul(step(-2.12, zk)).mul(step(zk, -0.98));
    const seat = step(0.32, ax).mul(step(ax, 1.12)).mul(step(0.9, q.y)).mul(step(q.y, 1.52));
    const r = fract(k.mul(0.618034).add(step(0.0, q.x).mul(0.37)).add(hash));
    const seated = step(0.5, r);
    const seatX = mix(float(0.84), float(0.52), step(0.82, r));
    const head = step(abs(ax.sub(seatX)), 0.085).mul(step(1.5, q.y)).mul(step(q.y, 1.74));
    const body = step(abs(ax.sub(seatX)), 0.19).mul(step(1.22, q.y)).mul(step(q.y, 1.5));
    const rider = max(head, body).mul(seated);
    const riderCol = mix(pickHex(RIDER_CLOTHES, fract(r.mul(5.3))), pickHex(RIDER_SKIN, fract(r.mul(3.1))).mul(0.7), head);
    const there = inRows.mul(float(1.0).sub(doorGap)).mul(max(seat, rider));
    hit(select(there.greaterThan(0.5), t, far), mix(color(0x2c3850), riderCol, rider));
  }
  // Yellow stanchions at every row along both sides of the aisle, and the grab rails along the ceiling
  for (const x of [0.3, -0.3]) {
    const t = ahead(float(x).sub(o.x).mul(inv.x));
    const q = o.add(d.mul(t));
    const dz = abs(fract(float(first).sub(q.z).div(pitch).add(0.5)).sub(0.5)).mul(pitch);
    const pole = step(dz, 0.022).mul(step(q.z, first + 0.4)).mul(step(floorY, q.y));
    const rail = step(abs(q.y.sub(2.12)), 0.018);
    const inside = step(zBack, q.z).mul(step(q.z, zFront)).mul(step(q.y, ceilY));
    hit(select(max(pole, rail).mul(inside).greaterThan(0.5), t, far), color(0xc8a018));
  }
  // The driver, behind the windshield on the left (+x)
  {
    const c = vec3(0.62, 1.66, 4.95);
    const oc = o.sub(c).div(vec3(0.08, 0.11, 0.095));
    const dd = d.div(vec3(0.08, 0.11, 0.095));
    const a = dot(dd, dd);
    const b = dot(oc, dd);
    const disc = b.mul(b).sub(a.mul(dot(oc, oc).sub(1.0)));
    hit(select(disc.greaterThan(0.0), ahead(b.negate().sub(sqrt(max(disc, 0.0))).div(a)), far), color(0x6b4430).mul(0.8));
  }
  return col.mul(lit);
}

/**
 * Creates the TSL procedural material for MTA New Flyer Xcelsior XD40/XE40 buses:
 * - Black wraparound front windshield & destination-sign mask with 5 amber roof brow marker LEDs, wipers & MTA badge
 * - Swept Xcelsior LED projector headlamp clusters, front/rear NY plates, 4-lamp vertical circular rear LED columns,
 *   stamped upper-rear air intake louvers & rear ad frame
 * - Framed side window band with upper transom bar, interior passenger seats, yellow vertical grab stanchions & ceiling
 *   lighting (illuminated at night), plus glazed dual-leaf curb-side front & rear doors
 * - Per-instance livery variety (zero extra draw calls via `busState.w` or `instanceIndex`):
 *   0/default: Current MTA NYC Transit Blue/Gold livery (deep royal blue, yellow-gold rear cap, gold/cyan upper swoop & speed lines)
 *   1: MTA +Select Bus Service+ (SBS) livery (vivid turquoise/cyan lower body & front fascia, royal blue upper, gold swoop)
 *   2: Classic MTA White & Blue Stripe livery (pearl white body, vivid blue belt stripe & cyan ribbon)
 */
function createLoftedBusMaterial() {
  if (_busLoftedMat) return _busLoftedMat;
  const s = BUS_SPEC;
  const p = attribute('position', 'vec3');
  const n = attribute('normal', 'vec3');
  const partId = attribute('partId', 'float');
  const state = attribute('busState', 'vec4');
  const isBody = step(abs(partId.sub(BUS_PARTS.BODY)), 0.25);
  const isTrim = step(abs(partId.sub(BUS_PARTS.TRIM)), 0.25);
  const isPod = step(abs(partId.sub(BUS_PARTS.POD)), 0.25);
  const isFairing = step(abs(partId.sub(BUS_PARTS.FAIRING)), 0.25);
  const isSkin = max(isBody, isFairing);
  const ax = abs(p.x);
  const az = abs(p.z);
  const one = float(1.0);

  // Per-axis screen footprint of the object-space position and its reciprocals (division-free analytic box-filter AA).
  // Each edge uses the footprint across itself and ramps over one footprint, so the long horizontal livery lines and
  // window edges stay sharp when the side is seen at a grazing angle (anisotropic filtering).
  const fwp = max(fwidth(p), vec3(0.0015)).toVar();
  const fwX = fwp.x;
  const fwY = fwp.y;
  const fwZ = fwp.z;
  const invX = float(1.0).div(fwX).toVar();
  const invY = float(1.0).div(fwY).toVar();
  const invZ = float(1.0).div(fwZ).toVar();
  const invXY = float(1.0).div(max(fwX, fwY)).toVar(); // small round features on the front & rear faces
  const invZY = float(1.0).div(max(fwZ, fwY)).toVar(); // ... and on the sides
  const cov = (d, inv) => clamp(float(0.5).sub(d.mul(inv)), 0.0, 1.0);
  const covAt = (r, d, inv) => clamp(float(0.5).sub(d.sub(r).mul(inv)), 0.0, 1.0);
  const covUp = (r, d, inv) => clamp(float(0.5).add(d.sub(r).mul(inv)), 0.0, 1.0);
  // Exact box filter of a band |d| < h: thin lines narrow and lighten smoothly below a pixel instead of fading out
  const band = (d, h, inv) => {
    const half = float(0.5).div(inv);
    return clamp(min(d.add(h), half).sub(max(d.sub(h), half.negate())).mul(inv), 0.0, 1.0);
  };
  const detailFade = (w) => smoothstep(0.055, 0.014, w);
  const fineFade = (w) => smoothstep(0.028, 0.007, w);

  // Box / rounded-box distances with the reciprocal footprint across their nearest edge (the dominant axis), given
  // the reciprocal footprints (ix, iy) of the two coordinates
  const boxEdge = (dx, dy, hx, hy, ix, iy) => {
    const ex = abs(dx).sub(hx);
    const ey = abs(dy).sub(hy);
    return { d: max(ex, ey), inv: mix(iy, ix, step(ey, ex)) };
  };
  const boxMask = (dx, dy, hx, hy, ix, iy) => {
    const e = boxEdge(dx, dy, hx, hy, ix, iy);
    return cov(e.d, e.inv);
  };
  const rBoxEdge = (dx, dy, hx, hy, r, ix, iy) => {
    const ex = abs(dx).sub(hx - r);
    const ey = abs(dy).sub(hy - r);
    return {
      d: length(vec2(max(ex, 0.0), max(ey, 0.0))).add(min(max(ex, ey), 0.0)).sub(r),
      inv: mix(iy, ix, step(ey, ex))
    };
  };

  // Decode per-instance variant once in the vertex stage: state.w - 1 when provided by traffic.js (> 0.5), else instanceIndex
  const rawIdx = mix(float(instanceIndex), max(float(0.0), state.w.sub(1.0)), step(0.5, state.w));
  const slot4 = fract(rawIdx.mul(0.25)).mul(4.0);
  const vVariant = varying(
    vertexStage(
      vec2(
        step(0.5, slot4).mul(step(slot4, 1.5)), // x = isSBS (slot 1, 25%)
        step(2.5, slot4) // y = isLegacy (slot 3, 25%); slots 0 & 2 (50%) = Current MTA Blue/Gold
      )
    )
  );
  const isSBS = vVariant.x;
  const isLegacy = vVariant.y;

  const front = smoothstep(0.15, 0.42, n.z).mul(smoothstep(s.zFront - 0.98, s.zFront - 0.9, p.z)).mul(isBody);
  const rear = smoothstep(0.15, 0.42, n.z.negate()).mul(smoothstep(s.zRear + 0.98, s.zRear + 0.9, p.z)).mul(isBody);
  const side = smoothstep(0.45, 0.72, abs(n.x)).mul(isSkin);
  const curb = step(p.x, 0.0);

  // 1. Front mask: unified black Xcelsior windshield + destination sign surround, split windshield glass & wipers
  const frontMaskEdge = rBoxEdge(p.x, p.y.sub(1.97), 1.22, 0.8, 0.15, invX, invY);
  const frontMask = cov(frontMaskEdge.d, frontMaskEdge.inv).mul(front);
  const frontGlassOuter = boxMask(p.x, p.y.sub(1.8), 1.15, 0.56, invX, invY).mul(frontMask);
  const centerDivider = one.sub(band(p.x, 0.015, invX));
  const inWiperY = smoothstep(1.23, 1.25, p.y).mul(smoothstep(1.97, 1.95, p.y));
  const wiperTilt = p.y.sub(1.24).mul(0.36);
  const wipers = max(band(p.x.sub(0.38).add(wiperTilt), 0.015, invX), band(p.x.add(0.14).sub(wiperTilt), 0.015, invX))
    .mul(inWiperY);
  const frontGlass = frontGlassOuter.mul(centerDivider).mul(one.sub(wipers.mul(0.85)));
  const signBand = boxMask(p.x, p.y.sub(2.56), 1.02, 0.16, invX, invY).mul(front);

  // 5 amber roof brow marker LEDs folded into 2 distance checks
  const browCenterX = min(ax, abs(ax.sub(0.13)));
  const browMarker = max(
    covAt(0.022, length(vec2(browCenterX.mul(0.7), p.y.sub(2.81).mul(1.4))), invXY),
    covAt(0.025, length(vec2(ax.sub(0.98).mul(0.65), p.y.sub(2.79).mul(1.4))), invXY)
  ).mul(front);

  // 2. Xcelsior Rear Face: solid engine/cooling hood, upper-left (+x) 2x3 air louvers, upper-right (-x) route sign bezel,
  // 3 centered red ID lamps, transit ad frame, engine door seam & 4-lamp circular corner stacks
  const rearSignBox = boxMask(p.x.add(0.45), p.y.sub(2.58), 0.31, 0.14, invX, invY).mul(rear);
  const rearLouverArea = boxMask(p.x.sub(0.42), p.y.sub(2.58), 0.44, 0.14, invX, invY)
    .mul(covUp(0.024, abs(p.x.sub(0.42)), invX))
    .mul(rear);
  const rearUpperSlats = mix(
    float(0.58),
    smoothstep(0.32, 0.46, fract(p.y.mul(22.0))).mul(0.55).add(0.25),
    fineFade(fwY)
  );
  const rearIdLamps = max(
    covAt(0.02, length(vec2(min(ax, abs(ax.sub(0.14))).mul(0.7), p.y.sub(2.79).mul(1.4))), invXY),
    covAt(0.023, length(vec2(ax.sub(0.96).mul(0.65), p.y.sub(2.74).mul(1.4))), invXY)
  ).mul(rear);
  const rearAd = boxEdge(p.x, p.y.sub(1.82), 0.63, 0.21, invX, invY);
  const rearAdInner = cov(rearAd.d, rearAd.inv).mul(rear);
  const rearAdFrame = covAt(0.03, rearAd.d, rearAd.inv).mul(rear);
  const rearSeam = max(
    band(p.y.sub(1.42), 0.008, invY).mul(smoothstep(0.95, 0.93, ax)),
    band(ax.sub(0.92), 0.008, invX).mul(smoothstep(0.58, 0.62, p.y)).mul(smoothstep(2.77, 2.73, p.y))
  ).mul(rear);
  const highBrake = boxMask(p.x, p.y.sub(1.48), 0.2, 0.018, invX, invY).mul(rear);

  // Side rear-corner radiator & exhaust louvers
  const sideRearGrille = max(
    boxMask(p.z.sub(s.zRear + 0.52), p.y.sub(0.88), 0.38, 0.3, invZ, invY),
    boxMask(p.z.sub(s.zRear + 0.48), p.y.sub(2.62), 0.26, 0.13, invZ, invY)
  ).mul(side);
  const slats = mix(
    float(0.56),
    smoothstep(0.38, 0.52, fract(p.y.mul(18.0))).mul(0.5).add(0.3),
    fineFade(fwY)
  );

  // 3. Side window band with black framing, upper transom bar, driver window, and curb-side doors
  const [wy0, wy1] = s.window;
  const winMid = (wy0 + wy1) / 2;
  const winHalf = (wy1 - wy0) / 2;
  const sideWin = rBoxEdge(p.z.add(0.78), p.y.sub(winMid), 4.92, winHalf, 0.065, invZ, invY);
  const sideBand = cov(sideWin.d, sideWin.inv).mul(side);
  const sideSeal = covAt(0.044, sideWin.d, sideWin.inv).mul(side);
  // Mullions and stanchions repeat every 1 / 0.76 m along z: filter in that repeat's units
  const invZRepeat = invZ.div(0.76);
  const mullion = one.sub(band(fract(p.z.mul(0.76).add(0.18)).sub(0.5), 0.038, invZRepeat));
  const transomBar = one.sub(band(p.y.sub(2.08), 0.015, invY).mul(0.88));
  const sideSignCutout = one.sub(boxMask(p.z.sub(3.74), p.y.sub(2.26), 0.56, 0.11, invZ, invY).mul(curb));
  const drvWin = boxEdge(p.z.sub(4.92), p.y.sub(winMid + 0.02), 0.52, winHalf, invZ, invY);
  const driverSeal = covAt(0.044, drvWin.d, drvWin.inv).mul(side).mul(one.sub(curb));
  const driverWin = cov(drvWin.d, drvWin.inv)
    .mul(covUp(0.02, abs(p.z.sub(4.92)), invZ))
    .mul(side)
    .mul(one.sub(curb));

  // Both curb-side doors evaluated via closest door center (zc = 4.89 or -1.54, half-width = 0.525)
  const dzDoor = min(abs(p.z.sub(4.89)), abs(p.z.add(1.54)));
  const doorSide = side.mul(curb);
  const doorFrame = boxMask(dzDoor, p.y.sub(1.42), 0.525, 1.02, invZ, invY).mul(doorSide);
  const doorGlass = boxMask(abs(dzDoor.sub(0.25)), p.y.sub(1.48), 0.19, 0.86, invZ, invY)
    .mul(one.sub(band(p.y.sub(1.18), 0.015, invY).mul(0.85)))
    .mul(doorSide);
  const sideGlassPanes = sideBand.mul(mullion).mul(transomBar).mul(sideSignCutout).mul(one.sub(doorFrame));
  const glass = clamp(max(frontGlass, max(max(sideGlassPanes, driverWin), doorGlass)), 0.0, 1.0);
  const seal = clamp(max(max(frontMask, rearSignBox), max(max(sideSeal, driverSeal), max(signBand, doorFrame))), 0.0, 1.0);

  // Black rubber wheel-arch fender flares (folded front/rear via az = abs(p.z) into 1 length() call, extending straight down to the 0.35 sill)
  const archR = s.wheelRadius + s.archGap;
  const archVec = vec2(az.sub(s.wheelZ), max(float(0.0), p.y.sub(s.wheelRadius)));
  const dArch = length(archVec);
  const archDir = archVec.div(max(dArch, 0.0001));
  const invArch = float(1.0).div(max(abs(archDir.x).mul(fwZ).add(abs(archDir.y).mul(fwY)), 0.0005));
  const archFlareMask = band(dArch.sub(archR + 0.0225), 0.0325, invArch)
    .mul(covUp(0.35, p.y, invY))
    .mul(side);

  // 4. Three Authentic MTA Liveries (Current Blue/Gold, Select Bus Service Cyan/Blue, Legacy White/Blue)
  const shadeY = smoothstep(0.34, 1.25, p.y).mul(0.16).add(0.84);
  const mtaRoyalBlue = color(0x16358a);
  const mtaSkyBlue = color(0x1a88e0);
  const sbsCyan = color(0x1fb8d0);
  const mtaGold = color(0xf0b21a);
  const mtaWhite = color(0xedf1f6);

  // Upper-front gold & sky-blue swoop arc (from z = 0.8..4.55 above the windows); filtered across its slope
  const uArc = p.z.sub(2.65).div(1.95);
  const arcTopY = float(2.86).sub(uArc.mul(uArc).mul(0.38));
  const invArc = float(1.0).div(fwY.add(abs(uArc).mul(0.39).mul(fwZ)));
  const inUpperArcZ = smoothstep(0.65, 0.85, p.z).mul(smoothstep(4.65, 4.45, p.z)).mul(covUp(2.42, p.y, invY)).mul(side);
  const upperGoldArc = band(p.y.sub(arcTopY).add(0.0375), 0.0375, invArc).mul(inUpperArcZ);
  const upperSkyFill = covAt(-0.075, p.y.sub(arcTopY), invArc).mul(inUpperArcZ);

  // Lower-mid gold & sky-blue diagonal ribbon (rising cleanly between the rear door z = -1.02 and front speed lines z = 0.8)
  const diagY = p.y.sub(p.z.add(0.9).mul(0.28));
  const invDiag = float(1.0).div(fwY.add(fwZ.mul(0.28)));
  const inMidDiag = smoothstep(0.38, 0.42, p.y)
    .mul(smoothstep(1.22, 1.18, p.y))
    .mul(smoothstep(-1.06, -1.02, p.z))
    .mul(side)
    .mul(one.sub(doorFrame));
  const midGoldBand = band(diagY.sub(0.8), 0.11, invDiag).mul(inMidDiag);
  const midSkyBand = band(diagY.sub(0.6), 0.09, invDiag).mul(inMidDiag);

  // Front lower speed-line stripes (sky blue) & rear corner speed-line stripes (gold) — faded to average once the
  // footprint across the stripes (mostly vertical) exceeds them
  const frontWave = smoothstep(0.36, 0.56, fract(p.y.add(float(5.5).sub(p.z).mul(0.11)).mul(13.0)));
  const frontSpeedLines = mix(float(0.55), frontWave, detailFade(fwY.add(fwZ.mul(0.11))))
    .mul(smoothstep(0.8, 2.4, p.z))
    .mul(smoothstep(5.55, 5.35, p.z))
    .mul(smoothstep(0.4, 0.43, p.y))
    .mul(smoothstep(1.2, 1.16, p.y))
    .mul(side)
    .mul(one.sub(isSBS));
  const rearWave = smoothstep(0.38, 0.58, fract(p.y.sub(p.z.sub(s.zRear).mul(0.26)).mul(10.5)));
  const rearSpeedLines = mix(float(0.52), rearWave, detailFade(fwY.add(fwZ.mul(0.26))))
    .mul(smoothstep(-3.3, -4.3, p.z))
    .mul(smoothstep(0.4, 0.43, p.y))
    .mul(smoothstep(2.4, 2.2, p.y))
    .mul(side);

  // Assemble Current (2016+) & SBS livery
  const lowerBelt = covAt(1.2, p.y, invY).mul(max(side, front));
  let modernLivery = mix(mtaRoyalBlue, sbsCyan, isSBS.mul(lowerBelt));
  modernLivery = mix(modernLivery, mix(mtaSkyBlue, sbsCyan, isSBS), max(upperSkyFill, max(midSkyBand, frontSpeedLines)));
  modernLivery = mix(modernLivery, mtaGold, max(max(upperGoldArc, midGoldBand), rearSpeedLines));
  modernLivery = mix(modernLivery, color(0xeaa818), rear);

  // Assemble Classic / Legacy White & Blue Stripe livery
  const blueStripe = band(p.y.sub(1.04), 0.145, invY);
  const cyanRibbon = band(p.y.sub(0.8325), 0.0125, invY);
  const legacyLivery = mix(mix(mtaWhite, color(0x0055b3), blueStripe), color(0x00a4e4), cyanRibbon);

  const skirt = covAt(0.415, p.y, invY);
  const livery = mix(mix(modernLivery, legacyLivery, isLegacy), color(0x181c22), skirt).mul(shadeY);

  // Front MTA circular badge, SBS front lettering band, wheelchair icon & front/rear NY license plates
  const dMta = length(vec2(p.x, p.y.sub(0.95)));
  const mtaOuter = covAt(0.102, dMta, invXY).mul(front);
  const mtaBlueCut = smoothstep(-0.015, -0.035, p.x.add(p.y.sub(0.95).mul(0.22))).add(
    mix(float(0.48), smoothstep(0.42, 0.62, fract(p.x.add(p.y.mul(0.25)).mul(16.0))), fineFade(fwX))
      .mul(band(p.y.sub(0.95), 0.042, invY))
      .mul(smoothstep(-0.03, -0.01, p.x))
  );
  const mtaDisc = mtaOuter.mul(one.sub(clamp(mtaBlueCut, 0.0, 1.0).mul(0.88)));
  const sbsFrontBand = boxMask(p.x, p.y.sub(0.78), 0.48, 0.032, invX, invY)
    .mul(mix(float(0.65), smoothstep(0.28, 0.45, fract(p.x.mul(14.0))), fineFade(fwX)))
    .mul(front)
    .mul(isSBS);
  const wheelchairBadge = boxMask(p.z.sub(5.52), p.y.sub(0.98), 0.065, 0.075, invZ, invY).mul(doorSide);
  const frontPlate = boxMask(p.x.sub(0.88), p.y.sub(1.02), 0.14, 0.065, invX, invY).mul(front);
  const rearPlateEdge = boxEdge(p.x, p.y.sub(0.76), 0.155, 0.07, invX, invY);
  const rearPlate = cov(rearPlateEdge.d, rearPlateEdge.inv).mul(rear);
  const rearPlateRecess = covAt(0.036, rearPlateEdge.d, rearPlateEdge.inv).mul(rear);
  const plate = max(frontPlate, rearPlate);
  const plateText = mix(float(0.55), smoothstep(0.35, 0.55, fract(p.x.mul(22.0))), fineFade(fwX))
    .mul(max(band(p.y.sub(0.76), 0.035, invY), band(p.y.sub(1.02), 0.03, invY)));
  const rearBumperStickers = boxMask(ax.sub(0.61), p.y.sub(0.68), 0.19, 0.055, invX, invY).mul(rear);

  // 5. Lamps: swept Xcelsior wedge headlamps (folded pair) + lower amber turn; 4-lamp vertical circular rear stack (folded)
  const lampTiltY = p.y.sub(float(0.74).add(ax.sub(0.76).mul(0.14)));
  const pod = boxMask(ax.sub(0.93), lampTiltY, 0.21, 0.064, invX, invY).mul(front);
  const headLamp = covAt(0.041, length(vec2(abs(ax.sub(0.91)).sub(0.07), lampTiltY)), invXY).mul(pod);
  const drlStrip = band(lampTiltY.add(0.038), 0.011, invY).mul(pod);
  const turnFront = boxMask(ax.sub(1.05), p.y.sub(0.62), 0.075, 0.022, invX, invY).mul(front);

  // Periodic vertical fold for the 4 circular rear lamps at y = 0.70, 0.90, 1.10, 1.30 (1 length() instead of 4)
  const inRearStack = smoothstep(0.59, 0.61, p.y).mul(smoothstep(1.41, 1.39, p.y)).mul(rear);
  const dRearLamp = length(vec2(ax.sub(1.03), fract(p.y.sub(0.6).mul(5.0)).sub(0.5).mul(0.2)));
  const rearBezel = covAt(0.066, dRearLamp, invXY).mul(inRearStack);
  const rearLens = covAt(0.049, dRearLamp, invXY).mul(inRearStack);
  const turnRear = rearLens.mul(step(1.2, p.y));
  const tailLamp = rearLens.mul(step(0.8, p.y)).mul(step(p.y, 1.2));
  const reverse = rearLens.mul(step(p.y, 0.8));
  const sideMarkers = covAt(0.025, length(vec2(az.sub(s.wheelZ + 0.68), p.y.sub(1.02))), invZY).mul(side);

  // 6. Tinted window glass over the saloon (seats, riders, stanchions & ceiling lights); these flat masks only shape
  // the cabin's glow at night
  const seatBack = smoothstep(1.64, 1.54, p.y)
    .mul(smoothstep(0.1, 0.2, abs(fract(p.z.mul(1.15)).sub(0.5))))
    .mul(smoothstep(3.85, 3.75, p.z));
  const grabRail = band(fract(p.z.mul(0.76).add(0.5)).sub(0.5), 0.026, invZRepeat).mul(smoothstep(2.3, 2.26, p.y));
  const ceilingStrip = smoothstep(2.12, 2.32, p.y).mul(smoothstep(4.45, 4.35, p.z));
  // Behind the glass: the saloon, traced along the view ray (only where there is glass)
  const busHash = varying(vertexStage(fract(rawIdx.mul(0.618034).add(0.21))));
  const saloon = Fn(() => {
    const derivatives = viewRayDerivatives(p);
    const c = vec3(0.0).toVar();
    If(glass.greaterThan(0.002), () => {
      c.assign(busInterior(p, objectViewRay(derivatives), busHash));
    });
    return c;
  })();
  const fresnel = pow(float(1.0).sub(clamp(dot(normalView, positionViewDirection), 0.0, 1.0)), 3.2);
  const glassTint = saloon.mul(vec3(0.38, 0.42, 0.43)).mul(float(1.0).sub(fresnel.mul(0.85)));

  // Composite body surface
  let body = mix(livery, color(0x12161b), max(seal, max(archFlareMask, max(rearSeam, rearPlateRecess))));
  body = mix(body, color(0x181c22).mul(slats), sideRearGrille);
  body = mix(body, color(0x282418).mul(rearUpperSlats), rearLouverArea);
  body = mix(body, color(0x1c222b), rearAdFrame);
  body = mix(body, color(0x162e48), rearAdInner);
  body = mix(body, color(0xf2f6fa), max(mtaDisc, sbsFrontBand));
  body = mix(body, color(0x1258b8), wheelchairBadge);
  body = mix(body, color(0x143884), rearBumperStickers);
  body = mix(body, color(0x12151a), max(pod, rearBezel));
  body = mix(body, color(0xf2f8ff), max(headLamp, drlStrip));
  body = mix(body, color(0xff9d14), max(turnFront, max(browMarker, sideMarkers)));
  body = mix(body, color(0x9e0e16), max(tailLamp, max(highBrake, rearIdLamps)));
  body = mix(body, color(0xd86e18), turnRear);
  body = mix(body, color(0xe8eef4), reverse);
  body = mix(body, mix(color(0xf2b518), color(0x182648), plateText.mul(0.65)), plate);
  body = mix(body, glassTint, glass);

  const col = mix(mix(body, color(0x191d22), isTrim), color(0xd0d5dc), isPod);

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = col;
  mat.roughnessNode = mix(
    mix(
      mix(float(0.16), float(0.06), max(glass, max(headLamp, rearLens))),
      float(0.68),
      max(isTrim, max(archFlareMask, seal.mul(one.sub(glass))))
    ),
    float(0.36),
    isPod
  );
  mat.metalnessNode = mix(mix(float(0.24), mix(float(0.16), float(0.36), fresnel), glass), float(0.06), max(isTrim, isPod));

  const brake = state.x;
  const blink = max(state.y.mul(step(0.0, p.x)), state.z.mul(step(p.x, 0.0)));
  const night = smoothstep(0.55, 1.15, cityUniforms.uInteriorGlow);
  const cabinGlow = glass
    .mul(side)
    .mul(ceilingStrip.mul(0.55).add(float(0.18)).sub(seatBack.mul(0.12)).add(grabRail.mul(0.15)))
    .mul(night);
  // Headlamps & DRL blades are visibly lit at all times of day (crossing bloom slightly in daylight, full beam at night)
  const headEmit = pod
    .mul(mix(float(0.25), float(0.42), night))
    .add(drlStrip.mul(mix(float(1.75), float(2.3), night)))
    .add(headLamp.mul(mix(float(2.45), float(3.2), night)));
  mat.emissiveNode = color(0xe8f4ff)
    .mul(headEmit)
    .add(color(0xfff0d4).mul(cabinGlow))
    .add(color(0xff9210).mul(max(browMarker, sideMarkers).mul(mix(float(0.65), float(1.15), night))))
    .add(color(0xff9a14).mul(max(turnFront, turnRear).mul(blink).mul(2.2)))
    .add(color(0xff0c14).mul(tailLamp.mul(brake.mul(1.6).add(0.75)).add(highBrake.mul(brake.mul(1.8))).add(rearIdLamps.mul(night))));

  _busLoftedMat = mat;
  return mat;
}

export {
  BUS_SPEC,
  buildLoftedBusBodyGeometry,
  buildBusSignGeometry,
  buildBusWheelGeo,
  createBusWheelMaterial,
  createLoftedBusMaterial
};
