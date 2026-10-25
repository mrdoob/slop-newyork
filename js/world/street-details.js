import * as THREE from 'three/webgpu';
import { Fn, float, color, positionGeometry, uniform, mod, step, smoothstep, mix, attribute, texture } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIGNAL_TIMING, blockAt, BLOCKS, nearestRoads } from './city-config.js';
import { cityUniforms, createTreeGrateMaterial, atlasSlotUV, createWireMaterial, WIRE_FADE } from '../render/tsl-materials.js';
import { PropBreaker } from '../sim/mayhem.js';
import { createTreeField } from './trees.js';
import { lotTrees } from './lot-greenery.js';
import { medianTrees } from './medians.js';
import { parkTreeSites, sidewalkBlocks, parkLampSites, medianRuns } from './city-grid.js';
import { liftAt } from './ground.js';
import { GEO } from './city-geodata.js';

// js/world/street-details.js
// Populates the city's streets with street furniture using InstancedMesh:
// - Mast-arm traffic signals at the road network's signalised junctions (addJunctionSignals)
// - Cobra-head streetlights along the curbs and post-top lamps in the centro
// - The CFE's concrete poles down one side of every street (crossarm, insulators, a transformer here and there, a
//   streetlight on the arm) strung with their lines and the cables sagging across to the houses
// - A few fire hydrants (rare in Tepic), park & street trees, palms down the camellones
// - A post with the two streets' name plates on a corner of every junction (addJunctionSignals: their names are drawn
//   into a small atlas for the junctions near the camera, redrawn as it moves)
// Each prop stands on the ground at its base (ground.js liftAt: the town's slopes, y = 0 in the flat city).

/**
 * TSL 3-Aspect Traffic Signal Lens Material (red on top, amber, green: the lenses at 0.36, 0, -0.36 in the head)
 * Driven by the shared signal clock and SIGNAL_TIMING (city-config.js), which js/sim/traffic.js obeys.
 */
function createTrafficSignalLensMaterial(isAvenueHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    // which lens, from its height in the head (not in the world: the heads stand on the ground, at any height)
    const ly = positionGeometry.y;
    const isTopRed = step(0.18, ly);
    const isBottomGreen = float(1.0).sub(step(-0.18, ly));
    const isMidAmber = float(1.0).sub(isTopRed).mul(float(1.0).sub(isBottomGreen));

    // Avenue phase: Green, then Amber from avenueAmber, Red from avenueRed
    // Street phase: Red until avenueRed, then Green, Amber from streetAmber
    const greenActive = isAvenueHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isAvenueHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isAvenueHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isTopRed.mul(redActive)
      .add(isMidAmber.mul(amberActive))
      .add(isBottomGreen.mul(greenActive));

    const lensHue = mix(
      mix(color(0x18ff68), color(0xffaa10), isMidAmber),
      color(0xff2424),
      isTopRed
    );
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

function buildStreetDetails(scene) {
  const group = new THREE.Group();
  group.name = 'StreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that traffic and pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // Shared materials
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b4046,
    roughness: 0.45,
    metalness: 0.78
  });
  const aveSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const streetSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  // Cobra-head LED streetlight lens & pedestrian post-top globe: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const pedGlobeGlow = new THREE.MeshBasicNodeMaterial();
  pedGlobeGlow.colorNode = mix(color(0xd4d2c8), color(0xffe4b0).mul(1.95), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));

  // 12-inch three-section signal head (origin at its centre, y = 5.42): housing, a tunnel visor over each lens
  // and a hanger to the mast arm, lenses on both faces (+-z) so it reads from both approaches; the lens material
  // picks red / amber / green from each lens's height in the head (0.36 / 0 / -0.36)
  const HEAD_W = 0.4;
  const HEAD_H = 1.12;
  const HEAD_D = 0.28;
  const LENS_R = 0.145;
  const LENS_Y = [0.36, 0, -0.36];
  const bothFaces = (geo) => [geo, geo.clone().rotateY(Math.PI)];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    new THREE.BoxGeometry(0.07, 0.2, 0.07).translate(0, HEAD_H / 2 + 0.1, 0),
    ...LENS_Y.flatMap((ly) => bothFaces(
      new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.24, 14, 1, true, Math.PI / 2, Math.PI)
        .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.12)
    ))
  ].map((g) => g.toNonIndexed()));
  const signalLensGeo = mergeGeometries(LENS_Y.flatMap((ly) => bothFaces(new THREE.CircleGeometry(LENS_R, 18).translate(0, ly, HEAD_D / 2 + 0.004))));
  // Cobra-head luminaire on the end of the arm: flattened grey housing, flat lens underneath
  const lampHousingGeo = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.7, 0.2, 0.3);
  const lampLensGeo = new THREE.CircleGeometry(1, 16).rotateX(Math.PI / 2).scale(0.6, 1, 0.24).translate(0, -0.005, 0);
  // Cast-iron pedestrian post-top globe lightpole (fluted base + shaft + decorative capital + opal globe)
  const pedLampPostGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.11, 0.16, 0.85, 10).translate(0, 0.425, 0),
    new THREE.CylinderGeometry(0.065, 0.085, 2.75, 10).translate(0, 2.22, 0),
    new THREE.CylinderGeometry(0.14, 0.07, 0.16, 10).translate(0, 3.62, 0)
  ].map((g) => g.toNonIndexed()));
  const pedGlobeGeo = new THREE.SphereGeometry(0.23, 12, 10).translate(0, 3.84, 0);

  // =========================================================================
  // 1. POLES, LAMPS & THE PROPS THE PLAYER CAN KNOCK OVER
  // =========================================================================
  const poleMatrices = [];
  const armMatrices = [];
  const audioSignals = []; // WALK panels heard by audio-sources.js (the junction signals have none)
  const lampHeadMatrices = [];
  const pedPostMatrices = [];
  const cobraLampSites = [];
  const streetPointSites = [];
  const placedPoles = [];
  // Street furniture the player can knock over (mayhem.js): its instances in the meshes below, resolved once built
  const breakables = [];

  // On (or within m of) a paved park (city-grid.js section 7): its own island, tested on its outline (the parks'
  // bounding boxes took in whole colonias round a long diagonal park like the Parque Lineal)
  const isPavedPark = (b) => !!b && b.park > 0.6 && !b.rural && !b.median;
  const inPlaza = (x, z, m = 1.0) =>
    isPavedPark(blockAt(x, z)) || isPavedPark(blockAt(x + m, z)) || isPavedPark(blockAt(x - m, z)) ||
    isPavedPark(blockAt(x, z + m)) || isPavedPark(blockAt(x, z - m));

  // True only when (x, z) and its surrounding pad-meter footprint sit on a real curb island (never in a road or median)
  const isOnCurbIsland = (x, z, pad = 0.55) => {
    const b = blockAt(x, z);
    if (!b || b.median) return false;
    if (pad <= 0) return true;
    const b1 = blockAt(x - pad, z);
    const b2 = blockAt(x + pad, z);
    const b3 = blockAt(x, z - pad);
    const b4 = blockAt(x, z + pad);
    return !!(b1 && !b1.median && b2 && !b2.median && b3 && !b3.median && b4 && !b4.median);
  };

  // True only when (x, z) is on a non-park, non-median, non-plaza sidewalk with `pad` clearance from all curbs
  const isOnSidewalk = (x, z, pad = 0.55) => {
    if (!isOnCurbIsland(x, z, pad)) return false;
    const b = blockAt(x, z);
    return !(b.park > 0.6) && !inPlaza(x, z, 1.0);
  };

  // Poles indexed in 8 m cells (a city-wide list scanned per candidate costs seconds with tens of thousands of poles)
  const POLE_CELL = 8;
  const poleCells = new Map();
  const poleKey = (ix, iz) => ix * 1000003 + iz;
  placedPoles.push = (...pts) => {
    for (const p of pts) {
      const k = poleKey(Math.floor(p.x / POLE_CELL), Math.floor(p.z / POLE_CELL));
      let list = poleCells.get(k);
      if (!list) poleCells.set(k, (list = []));
      list.push(p);
    }
    return Array.prototype.push.apply(placedPoles, pts);
  };
  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    const r = Math.ceil(minDist / POLE_CELL);
    const ix = Math.floor(x / POLE_CELL), iz = Math.floor(z / POLE_CELL);
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b++) {
        const list = poleCells.get(poleKey(ix + a, iz + b));
        if (!list) continue;
        for (const p of list) {
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz < md2) return false;
        }
      }
    }
    return true;
  };

  // =========================================================================
  // 2. MID-BLOCK AVENUE & STREET ORNAMENTAL ACORN & COBRA STREETLIGHTS
  //    Placed directly along the true curb edges of every city block (BLOCKS)
  //    and verified with blockAt(x, z) so no pole ever stands in any roadway.
  // =========================================================================
  const allBlocks = BLOCKS || [];

  for (const b of allBlocks) {
    if (!b || !b.poly || b.poly.length < 3 || b.median || b.park > 0.6) continue;

    const poly = b.poly;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 24) continue;

      const ux = dx / len;
      const uz = dz / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;

      // Determine inward normal (into the sidewalk block) and outward normal (into the street roadway)
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) continue;
      const outX = -inx;
      const outZ = -inz;
      // Confirm this curb edge fronts an open roadway
      if (blockAt(mx + outX * 2.5, mz + outZ * 2.5)) continue;

      // Every street gets cobra lamps on its longer frontages; the post-top globes stay in the centro
      const isAvenueEdge = len >= 40 && (Math.abs(uz) > 0.5 || Math.hypot(mx, mz) > 650);
      const postTops = Math.hypot(mx, mz) < 650;
      if (isAvenueEdge) {
        const armYaw = Math.atan2(-outZ, outX);
        const cobraFracs = inx > 0 ? [0.26, 0.72] : [0.32, 0.78];
        for (const f of cobraFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const lx = cx + inx * 1.08;
          const lz = cz + inz * 1.08;
          const headX = lx + outX * 2.6;
          const headZ = lz + outZ * 2.6;
          if (
            !isOnSidewalk(lx, lz, 0.55) ||
            blockAt(cx + outX * 2.5, cz + outZ * 2.5) ||
            blockAt(headX, headZ) ||
            !isClearOfPoles(lx, lz, 6.5)
          ) {
            continue;
          }
          placedPoles.push({ x: lx, z: lz });
          addFootprint(lx, lz, 0.45, 0.45);
          const g = liftAt(lx, lz); // the whole lamp stands on the ground at its pole
          const cobraProp = { kind: 'cobra', x: lx, z: lz, yaw: armYaw, ground: 0.1 + g, base: g, idx: { pole: poleMatrices.length, arm: armMatrices.length, head: lampHeadMatrices.length } };
          breakables.push(cobraProp);

          // Tall ornamental streetlight pole
          dummy.position.set(lx, 4.3 + g, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.12, 8.4, 0.12);
          dummy.updateMatrix();
          poleMatrices.push(dummy.matrix.clone());

          // Upper luminaire bracket arm overhanging the street
          dummy.position.set(lx + outX * 1.15, 8.2 + g, lz + outZ * 1.15);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(2.3, 0.09, 0.09);
          dummy.updateMatrix();
          armMatrices.push(dummy.matrix.clone());

          // Cobra-head LED luminaire on the end of the arm, lens facing the street
          dummy.position.set(headX, 8.08 + g, headZ);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          lampHeadMatrices.push(dummy.matrix.clone());
          dummy.rotation.set(0, 0, 0);

          cobraLampSites.push({
            x: headX,
            y: 8.02 + g,
            z: headZ,
            g,
            tx: lx + outX * 3.4,
            tz: lz + outZ * 3.4
          });
          cobraProp.light = cobraLampSites[cobraLampSites.length - 1];
        }

        // Cast-iron pedestrian post-top globe lightpoles along avenue sidewalks (with PointLights)
        const pedFracs = !postTops ? [] : len >= 48 ? [0.16, 0.50, 0.84] : [0.24, 0.76];
        for (const f of pedFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.42;
          const pz = cz + inz * 1.42;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.2)
          ) {
            continue;
          }
          placedPoles.push({ x: px, z: pz });
          addFootprint(px, pz, 0.4, 0.4);

          const g = liftAt(px, pz);
          dummy.position.set(px, 0.18 + g, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          breakables.push({ kind: 'post', x: px, z: pz, yaw: 0, ground: 0.18 + g, base: g, idx: { post: pedPostMatrices.length }, lightIndex: streetPointSites.length });
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02 + g,
            z: pz,
            g,
            color: 0xffe0aa,
            intensity: 30,
            dist: 14.5
          });
        }
      } else if (len >= 36 && postTops) {
        // Cross-street cast-iron pedestrian post-top globe lightpoles along north and south block curbs
        const crossFracs = len >= 115 ? [0.20, 0.40, 0.60, 0.80] : [0.24, 0.50, 0.76];
        for (const f of crossFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.22;
          const pz = cz + inz * 1.22;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.5)
          ) {
            continue;
          }
          placedPoles.push({ x: px, z: pz });
          addFootprint(px, pz, 0.4, 0.4);

          const g = liftAt(px, pz);
          dummy.position.set(px, 0.18 + g, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          breakables.push({ kind: 'post', x: px, z: pz, yaw: 0, ground: 0.18 + g, base: g, idx: { post: pedPostMatrices.length }, lightIndex: streetPointSites.length });
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02 + g,
            z: pz,
            g,
            color: 0xffe0aa,
            intensity: 28,
            dist: 14.0
          });
        }
      }
    }
  }

  // =========================================================================
  // 2b. THE CFE'S POLES & OVERHEAD WIRES
  //     Tepic's power runs overhead: a concrete pole of the Comisión Federal de Electricidad every ~30 m down one
  //     side of every street (the curb whose outward normal points the same half of the compass, so one of the two
  //     facing curbs), 11 m tall, a crossarm with three insulators carrying the primaries, the secondary and the
  //     phone & cable lines under it, a pole-top transformer on one in five and a streetlight on an arm over the
  //     street. The lines span pole to pole, along each curb and on across the junctions, and the service cables sag
  //     from the poles to the houses on both sides. Local pole frame: x out over the street, z along it, y up.
  // =========================================================================
  const cfePoles = []; // { x, z, g, ux, uz, outX, outZ, across (m to the far curb, 0 if none), edge, i }
  const cfeEdges = [];
  const CFE_SP = 30;
  const CFE_H = 11;
  for (const b of allBlocks) {
    if (!b || !b.poly || b.poly.length < 3 || b.median || b.park > 0.6 || b.rural) continue;
    const poly = b.poly;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (len < 18) continue;
      const ux = (p1.x - p0.x) / len;
      const uz = (p1.z - p0.z) / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b || blockAt(mx - inx * 2.5, mz - inz * 2.5)) continue;
      const outX = -inx;
      const outZ = -inz;
      if (outX * 0.8 + outZ * 0.6 <= 0) continue; // the other curb of this street carries them
      const n = Math.floor((len - 12) / CFE_SP) + 1;
      const step = n > 1 ? (len - 12) / (n - 1) : 0;
      const edge = [];
      for (let k = 0; k < n; k++) {
        const d = n > 1 ? 6 + k * step : len / 2;
        const px = p0.x + ux * d + inx * 0.45;
        const pz = p0.z + uz * d + inz * 0.45;
        if (!isOnSidewalk(px, pz, 0.3) || !isClearOfPoles(px, pz, 2.5)) continue;
        // the far curb across the street (the houses the cables cross to)
        let across = 0;
        for (let sx = 3; sx <= 30; sx += 1.5) {
          if (blockAt(px + outX * sx, pz + outZ * sx)) {
            across = sx;
            break;
          }
        }
        const pole = { x: px, z: pz, g: liftAt(px, pz), ux, uz, outX, outZ, across, edge: cfeEdges.length, i: cfePoles.length };
        placedPoles.push({ x: px, z: pz });
        edge.push(pole);
        cfePoles.push(pole);
      }
      cfeEdges.push(edge);
    }
  }
  // A point of pole p's frame in the world
  const cfePoint = (p, x, y, z = 0) => new THREE.Vector3(p.x + p.outX * x + p.ux * z, p.g + y, p.z + p.outZ * x + p.uz * z);
  const cfeHash = (p, k) => hashPos(p.x, k, p.z);
  // Spans: along each curb, and from the end poles on to the nearest pole of another curb straight ahead (within 42 m)
  const cfeSpans = [];
  {
    const CELL = 21;
    const grid = new Map();
    const keyOf = (x, z) => Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
    for (const p of cfePoles) {
      const k = keyOf(p.x, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
    const linked = new Set();
    for (const edge of cfeEdges) {
      for (let k = 0; k + 1 < edge.length; k++) cfeSpans.push([edge[k], edge[k + 1]]);
      for (const [end, sign] of edge.length ? [[edge[edge.length - 1], 1], [edge[0], -1]] : []) {
        let best = null;
        let bestD = 42;
        for (let a = -2; a <= 2; a++) {
          for (let c = -2; c <= 2; c++) {
            for (const q of grid.get(keyOf(end.x + a * CELL, end.z + c * CELL)) || []) {
              if (q.edge === end.edge) continue;
              const dx = q.x - end.x, dz = q.z - end.z;
              const d = Math.hypot(dx, dz);
              if (d < 4 || d >= bestD || (dx * end.ux + dz * end.uz) * sign < d * 0.94) continue;
              best = q;
              bestD = d;
            }
          }
        }
        if (!best) continue;
        const key = Math.min(end.i, best.i) + ':' + Math.max(end.i, best.i);
        if (linked.has(key)) continue;
        linked.add(key);
        cfeSpans.push([end, best]);
      }
    }
  }
  // The streetlight on the arm: a cobra head like the avenues', lit at night from the same pool (section 8)
  for (const p of cfePoles) {
    if (cfeHash(p, 2.2) < 0.35) continue; // not every pole carries one
    const yaw = Math.atan2(-p.outZ, p.outX);
    const arm = cfePoint(p, 0.9, 8.1);
    dummy.position.copy(arm);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1.8, 0.08, 0.08);
    dummy.updateMatrix();
    armMatrices.push(dummy.matrix.clone());
    const head = cfePoint(p, 1.85, 8.0);
    dummy.position.copy(head);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    lampHeadMatrices.push(dummy.matrix.clone());
    dummy.rotation.set(0, 0, 0);
    cobraLampSites.push({ x: head.x, y: head.y - 0.06, z: head.z, g: p.g, tx: p.x + p.outX * 3.4, tz: p.z + p.outZ * 3.4 });
  }

  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true) {
    if (matrices.length === 0) return null;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    return inst;
  }

  const poleInst = addMatrixArrayInstanced(unitCyl, poleMetalMat, poleMatrices);
  const armInst = addMatrixArrayInstanced(unitBox, poleMetalMat, armMatrices);
  const lampHousingInst = addMatrixArrayInstanced(lampHousingGeo, poleMetalMat, lampHeadMatrices);
  const lampLensInst = addMatrixArrayInstanced(lampLensGeo, lampBulbGlow, lampHeadMatrices, false);
  const pedPostInst = addMatrixArrayInstanced(pedLampPostGeo, poleMetalMat, pedPostMatrices);
  const pedGlobeInst = addMatrixArrayInstanced(pedGlobeGeo, pedGlobeGlow, pedPostMatrices, false);
  // knock-over props hide their instances (mayhem.js): their meshes keep their own shadows (no static stand-ins)
  for (const m of [poleInst, armInst, lampHousingInst, lampLensInst, pedPostInst, pedGlobeInst]) if (m) m.userData.keepOwnShadow = true;
  for (const b of breakables) {
    const parts = [];
    const add = (mesh, index) => { if (mesh && index >= 0) parts.push({ mesh, index }); };
    if (b.kind === 'cobra') {
      add(poleInst, b.idx.pole);
      add(armInst, b.idx.arm);
      add(lampHousingInst, b.idx.head);
      add(lampLensInst, b.idx.head);
    } else if (b.kind === 'post') {
      add(pedPostInst, b.idx.post);
      add(pedGlobeInst, b.idx.post);
      b.light = streetPointSites[b.lightIndex];
    }
    b.parts = parts;
  }

  // The CFE poles' meshes: concrete shafts, the galvanised crossarms & racks, porcelain insulators, transformers
  const cfeColliders = [];
  if (cfePoles.length) {
    const shaftGeo = new THREE.CylinderGeometry(0.09, 0.16, CFE_H, 8).translate(0, CFE_H / 2, 0);
    const steelGeo = mergeGeometries([
      new THREE.BoxGeometry(2.3, 0.1, 0.1).translate(0.3, 10.55, 0),
      // the crossarm's braces & the racks of the secondary and the phone line
      new THREE.BoxGeometry(0.05, 0.75, 0.05).translate(-0.3, 10.2, 0).rotateZ(0),
      new THREE.BoxGeometry(0.05, 0.75, 0.05).translate(0.9, 10.2, 0),
      new THREE.BoxGeometry(0.28, 0.32, 0.06).translate(0.14, 9.0, 0),
      new THREE.BoxGeometry(0.22, 0.18, 0.05).translate(0.12, 7.6, 0)
    ].map((g) => g.toNonIndexed()));
    const insulatorGeo = mergeGeometries([-0.7, 0.3, 1.3].map((x) => new THREE.CylinderGeometry(0.045, 0.07, 0.24, 8).translate(x, 10.72, 0).toNonIndexed()));
    const transformerGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.3, 0.3, 0.95, 12).translate(0.42, 9.65, 0),
      new THREE.CylinderGeometry(0.31, 0.31, 0.06, 12).translate(0.42, 10.16, 0),
      new THREE.CylinderGeometry(0.035, 0.035, 0.22, 6).translate(0.32, 10.27, 0.12),
      new THREE.CylinderGeometry(0.035, 0.035, 0.22, 6).translate(0.32, 10.27, -0.12)
    ].map((g) => g.toNonIndexed()));
    const concreteMat = new THREE.MeshStandardNodeMaterial({ color: 0x9d998f, roughness: 0.92 });
    const galvMat = new THREE.MeshStandardNodeMaterial({ color: 0x7c8084, roughness: 0.5, metalness: 0.6 });
    const porcelainMat = new THREE.MeshStandardNodeMaterial({ color: 0xcfcabd, roughness: 0.35 });
    const tankMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a9094, roughness: 0.55, metalness: 0.35 });
    const all = [];
    const transformers = [];
    for (const p of cfePoles) {
      dummy.position.set(p.x, p.g, p.z);
      dummy.rotation.set(0, Math.atan2(-p.outZ, p.outX), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      all.push(dummy.matrix.clone());
      if (cfeHash(p, 4.7) < 0.2) transformers.push(dummy.matrix.clone());
      // concrete stops a car (main.js adds these to the player's colliders)
      cfeColliders.push({ minX: p.x - 0.17, maxX: p.x + 0.17, minZ: p.z - 0.17, maxZ: p.z + 0.17, minY: p.g, maxY: p.g + CFE_H });
    }
    dummy.rotation.set(0, 0, 0);
    addMatrixArrayInstanced(shaftGeo, concreteMat, all);
    addMatrixArrayInstanced(steelGeo, galvMat, all);
    addMatrixArrayInstanced(insulatorGeo, porcelainMat, all);
    addMatrixArrayInstanced(transformerGeo, tankMat, transformers);
  }

  // The lines & the service cables, built in 200 m cells (each hidden beyond WIRE_FADE in update())
  const wireCells = [];
  if (cfeSpans.length) {
    const CELL = 200;
    const cells = new Map();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const addWire = (a, b, sag, r) => {
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const key = Math.floor(mx / CELL) * 100003 + Math.floor(mz / CELL);
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { pos: [], wire: [], idx: [], x: (Math.floor(mx / CELL) + 0.5) * CELL, z: (Math.floor(mz / CELL) + 0.5) * CELL }));
      const L = a.distanceTo(b);
      const segs = Math.max(3, Math.min(8, Math.ceil(L / 5)));
      const base = c.pos.length / 3;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        // a parabola close enough to the catenary for these sags
        p.copy(a).lerp(b, t).addScaledVector(up, -4 * sag * t * (1 - t));
        tan.copy(b).sub(a).addScaledVector(up, -4 * sag * (1 - 2 * t)).normalize();
        for (const w of [r, -r]) {
          c.pos.push(p.x, p.y, p.z);
          c.wire.push(tan.x, tan.y, tan.z, w);
        }
        if (s < segs) {
          const v = base + s * 2;
          c.idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      }
    };
    // pole to pole: the three primaries on the insulators, the secondary & the phone / cable line
    for (const [a, b] of cfeSpans) {
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      for (const x of [-0.7, 0.3, 1.3]) addWire(cfePoint(a, x, 10.82), cfePoint(b, x, 10.82), 0.012 * L, 0.009);
      addWire(cfePoint(a, 0.28, 9.0), cfePoint(b, 0.28, 9.0), 0.025 * L, 0.014);
      addWire(cfePoint(a, 0.24, 7.6), cfePoint(b, 0.24, 7.6), 0.035 * L, 0.012);
      if (cfeHash(a, 6.6) < 0.5) addWire(cfePoint(a, 0.24, 7.3), cfePoint(b, 0.24, 7.3), 0.045 * L, 0.016);
    }
    // the service cables: down to a house on this side, and across the street to one on the other
    for (const q of cfePoles) {
      const from = cfePoint(q, 0.28, 9.0);
      const near = cfeHash(q, 7.1);
      if (near < 0.75) {
        const along = (near - 0.375) * 20;
        const tx = q.x - q.outX * 2.4 + q.ux * along, tz = q.z - q.outZ * 2.4 + q.uz * along;
        const blk = blockAt(tx, tz);
        if (blk && !(blk.park > 0.6)) addWire(from, new THREE.Vector3(tx, liftAt(tx, tz) + 4.3, tz), 0.35, 0.008);
      }
      const far = cfeHash(q, 8.3);
      if (q.across && far < 0.6) {
        const along = (far - 0.3) * 16;
        const d = q.across + 2.4;
        const tx = q.x + q.outX * d + q.ux * along, tz = q.z + q.outZ * d + q.uz * along;
        const blk = blockAt(tx, tz);
        if (blk && !(blk.park > 0.6)) addWire(from, new THREE.Vector3(tx, liftAt(tx, tz) + 4.6, tz), 0.5, 0.008);
      }
    }
    const wireMat = createWireMaterial();
    for (const c of cells.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
      geo.setAttribute('wire', new THREE.Float32BufferAttribute(c.wire, 4));
      geo.setIndex(c.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(c.idx, 1) : new THREE.Uint16BufferAttribute(c.idx, 1));
      geo.computeBoundingSphere();
      geo.boundingSphere.radius += 1; // (the ribbons widen in the vertex shader)
      const mesh = new THREE.Mesh(geo, wireMat);
      mesh.name = 'CfeWires';
      mesh.renderOrder = 2; // (update() hides the far cells after the warm-up frame has compiled them)
      group.add(mesh);
      wireCells.push({ mesh, x: c.x, z: c.z });
    }
    if (wireCells.length > 1) for (const c of wireCells.slice(1)) c.mesh.userData.sharesPipelineWith = wireCells[0].mesh;
  }
  console.info(`[cfe] ${cfePoles.length} poles, ${cfeSpans.length} spans in ${wireCells.length} cells`);

  // =========================================================================
  // 6. FIRE HYDRANTS ALONG CURBS (INSTANCED)
  // =========================================================================
  // A hydrant near a corner of one block in fourteen, on the sidewalk by the curb (Tepic has few: a New York corner's
  // hydrant on every block read as another city)
  const hydrantPositions = [];
  {
    let k = 0;
    for (const b of allBlocks) {
      if (b.median || b.park > 0.6 || b.poly.length < 4 || (k++ % 14)) continue;
      const a = b.poly[0], c = b.poly[1];
      const L = Math.hypot(c.x - a.x, c.z - a.z);
      if (L < 12) continue;
      const ux = (c.x - a.x) / L, uz = (c.z - a.z) / L;
      let inx = -uz, inz = ux;
      if (blockAt(a.x + ux * 4 + inx * 1.2, a.z + uz * 4 + inz * 1.2) !== b) { inx = uz; inz = -ux; }
      const hx = a.x + ux * 4 + inx * 0.9, hz = a.z + uz * 4 + inz * 0.9;
      if (isOnSidewalk(hx, hz, 0.4) && isClearOfPoles(hx, hz, 1.5)) hydrantPositions.push([hx, hz]);
    }
  }
  const hydrantMat = new THREE.MeshStandardNodeMaterial({ color: 0xb8241e, roughness: 0.5, metalness: 0.4 });
  const hydrantInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.26, 0.85, 8), hydrantMat, Math.max(1, hydrantPositions.length));
  hydrantPositions.forEach(([hx, hz], i) => {
    dummy.position.set(hx, 0.64 + liftAt(hx, hz), hz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    hydrantInst.setMatrixAt(i, dummy.matrix);
  });
  hydrantInst.count = hydrantPositions.length;
  hydrantInst.userData.keepOwnShadow = true;
  hydrantInst.instanceMatrix.needsUpdate = true;
  if (hydrantPositions.length) group.add(hydrantInst);
  hydrantPositions.forEach(([hx, hz], i) => breakables.push({ kind: 'hydrant', x: hx, z: hz, yaw: 0, ground: 0.215 + liftAt(hx, hz), base: liftAt(hx, hz), parts: [{ mesh: hydrantInst, index: i }] }));

  // =========================================================================
  // 7. TREES: PARKS & PLAZAS, STREET TREES, THE CAMELLONES' PALMS
  //    Tepic's laureles de la India, jacarandas, mangos, tabachines & Washingtonia palms (js/world/trees.js)
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species (0 laurel, 1 jacaranda, 2 mango, 3 tabachín, 4 palm), whitewash? }
  // A sidewalk tree: mostly laureles (clipped), then tabachines, jacarandas & mangos, each planted by the house before it
  const streetSpecies = (r) => (r < 0.5 ? 0 : r < 0.7 ? 3 : r < 0.85 ? 1 : 2);

  // A. The parks & the plazas (sites laid out by city-grid.js)
  for (const s of parkTreeSites || []) treePositions.push(s);

  // B. Street trees on the raised sidewalks of every rectangular block (city-config.js BLOCKS via the slabs city-grid.js
  //    laid): along their long w / e fronts, here and there (Tepic's streets are no avenue of planes: a tree where a
  //    neighbour planted one, its trunk painted white with cal), in a bare square pit. Never in plazas or parks.
  const sidewalkTreePositions = [];
  const SIDEWALK_Y = 0.22;
  const swBlocks = sidewalkBlocks || [];
  const onSidewalk = (x, z) => {
    const b = blockAt(x, z);
    return !!b && !(b.park > 0.6) && !b.median;
  };
  // Street trees turn in 90° steps with the crown squeezed across the sidewalk, away from the facades
  function addStreetTree(x, z, scale, species, acrossX, extra = {}) {
    if (!onSidewalk(x, z) || inPlaza(x, z, 1.5) || !isClearOfPoles(x, z, 2.2)) return;
    const q = Math.floor(hashPos(x, 8.8, z) * 3.999);
    const g = liftAt(x, z);
    const t = { x, y: SIDEWALK_Y + g, g, z, scale, species, yaw: q * Math.PI * 0.5, tier: acrossX ? 1 : 2, ...extra };
    if (acrossX === (q % 2 === 0)) t.sx = extra.squeeze || 0.82;
    else t.sz = extra.squeeze || 0.82;
    treePositions.push(t);
    sidewalkTreePositions.push(t);
  }
  const AVE_SP = 17;
  for (const s of swBlocks) {
    const b = s.block;
    if (!b || b.median || b.park > 0.6) continue;
    const x0 = s.cx - s.w * 0.5;
    const x1 = s.cx + s.w * 0.5;
    const z0 = s.cz - s.d * 0.5;
    if (s.d >= 20) {
      const thin = 0.72;
      for (const [x, side] of [[x0 + 1.3, -1], [x1 - 1.3, 1]]) {
        const n = Math.floor((s.d - 10) / AVE_SP) + 1;
        const zs = z0 + (s.d - (n - 1) * AVE_SP) * 0.5;
        for (let i = 0; i < n; i++) {
          const tz = zs + i * AVE_SP;
          if (hashPos(x, 3.1, tz) < thin) continue;
          addStreetTree(x, tz, 0.62 + hashPos(tz, 3.1, x) * 0.16, streetSpecies(hashPos(x, side, tz)), true,
            { grate: false, whitewash: hashPos(tz, 6.2, x) < 0.65 });
        }
      }
    }
  }

  // C. The camellones: the long, narrow curb islands between the two roadways of a boulevard (mean width 2 x area /
  //    perimeter under 9 m), planted down their middle every ~11 m with Washingtonia palms, some laureles & tabachines
  for (const b of allBlocks) {
    if (b.rural || b.park > 0.6 || b.poly.length < 3) continue;
    let per = 0;
    for (let i = 0; i < b.poly.length; i++) {
      const a = b.poly[i], c = b.poly[(i + 1) % b.poly.length];
      per += Math.hypot(c.x - a.x, c.z - a.z);
    }
    const width = (2 * b.area) / Math.max(per, 1);
    if (width >= 9 || width < 1.8 || per / 2 < 25) continue;
    const SP = 11;
    const planted = [];
    for (let i = 0; i < b.poly.length; i++) {
      const a = b.poly[i], c = b.poly[(i + 1) % b.poly.length];
      const L = Math.hypot(c.x - a.x, c.z - a.z);
      if (L < SP * 0.6) continue;
      const ux = (c.x - a.x) / L, uz = (c.z - a.z) / L;
      // into the island: the side of the edge its own block lies on
      let inx = -uz, inz = ux;
      const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
      if (blockAt(mx + inx * width * 0.5, mz + inz * width * 0.5) !== b) { inx = uz; inz = -ux; }
      for (let d = SP * 0.5; d < L - 2; d += SP) {
        const x = a.x + ux * d + inx * width * 0.5, z = a.z + uz * d + inz * width * 0.5;
        if (blockAt(x, z) !== b || inPlaza(x, z, 1.5) || !isClearOfPoles(x, z, 2.0)) continue;
        if (planted.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < SP * SP * 0.5)) continue;
        const r = hashPos(x, 9.7, z);
        const species = r < 0.62 ? 4 : r < 0.85 ? 0 : 3;
        const scale = species === 4 ? 0.85 + hashPos(z, 2.7, x) * 0.45 : 0.62 + hashPos(z, 2.7, x) * 0.16;
        const t = { x, y: SIDEWALK_Y + liftAt(x, z), z, scale, species, tier: 1, whitewash: species !== 4 && r < 0.78 };
        planted.push(t);
        treePositions.push(t);
      }
    }
  }
  // D. The yards & vacant lots: the mangos, laureles & tabachines standing over the open ground inside the blocks
  //    (lot-greenery.js), clear of the walls, thick in the yards & round the lots, sparse out in a field's middle
  //    The Libramiento's camellón has its own rows, either side of the ciclovía (medians.js)
  const medianBlocks = new Set();
  for (const run of medianRuns || []) for (const p of run) medianBlocks.add(blockAt(p.x, p.z));
  for (const t of medianTrees(medianRuns || [])) {
    t.y = SIDEWALK_Y + 0.012 + liftAt(t.x, t.z);
    treePositions.push(t);
  }
  const yardTrees = lotTrees(allBlocks, GEO.houses || [], { stride: GEO.houseStride || 8, sidewalk: (GEO.frame && GEO.frame.sidewalk) || 2.2, skip: medianBlocks });
  for (const t of yardTrees) {
    t.y = SIDEWALK_Y + 0.012 + liftAt(t.x, t.z);
    treePositions.push(t);
  }
  console.info(`[streetDetails] ${treePositions.length} trees (${sidewalkTreePositions.length} street trees, ${yardTrees.length} in the yards & lots)`);

  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x484642, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });

  // Curbside tree pit surrounds & dark soil beds (the cast-iron grates, t.grate, are New York's: none in Tepic)
  // (pits run along the curb: t.pitRot = PI/2 on cross streets)
  const pitCurbGeo = new THREE.BoxGeometry(1.3, 0.22, 1.3);
  const pitSoilGeo = new THREE.BoxGeometry(1.0, 0.23, 1.0);
  const pitGrateGeo = new THREE.RingGeometry(0.24, 0.82, 12, 1).rotateX(-Math.PI / 2);
  const gratedTrees = sidewalkTreePositions.filter((t) => t.grate !== false);

  const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, sidewalkTreePositions.length);
  const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, sidewalkTreePositions.length);
  const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, Math.max(1, gratedTrees.length));
  pitCurbInst.receiveShadow = true;
  pitSoilInst.receiveShadow = true;
  pitGrateInst.receiveShadow = true;
  pitGrateInst.count = gratedTrees.length;

  sidewalkTreePositions.forEach((t, i) => {
    dummy.rotation.set(0, t.pitRot || 0, 0);
    dummy.scale.set(t.pitS || 1, 1, 1);
    dummy.position.set(t.x, 0.19 + t.g, t.z);
    dummy.updateMatrix();
    pitCurbInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(t.x, 0.20 + t.g, t.z);
    dummy.updateMatrix();
    pitSoilInst.setMatrixAt(i, dummy.matrix);
  });
  gratedTrees.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, 0.225 + t.g, t.z);
    dummy.updateMatrix();
    pitGrateInst.setMatrixAt(i, dummy.matrix);
  });
  pitCurbInst.instanceMatrix.needsUpdate = true;
  pitSoilInst.instanceMatrix.needsUpdate = true;
  pitGrateInst.instanceMatrix.needsUpdate = true;
  for (const pit of [pitCurbInst, pitSoilInst, pitGrateInst]) pit.computeBoundingSphere();
  group.add(pitCurbInst, pitSoilInst, pitGrateInst);

  function hashPos(x, y, z) {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // Procedural trees (js/world/trees.js): species skeletons with leaf-spray cards, one instanced mesh per species, variant &
  // level of detail, each tree's level following the camera
  const treeField = createTreeField(scene, treePositions);
  group.add(treeField.group);

  // =========================================================================
  // 8. CLUSTERED STREETLIGHTS & STREET FURNITURE LIGHT POOLS
  // =========================================================================
  for (const s of parkLampSites || []) {
    streetPointSites.push({ x: s.x, y: s.y, z: s.z, g: liftAt(s.x, s.z), color: 0xffe4b4, intensity: 32, dist: 14.0 });
  }

  const STREETLIGHT_SPOT_POOL = 36;
  const STREET_POINT_POOL = 48;
  const STREETLIGHT_DIST = 115;
  const STREETLIGHT_DIST_SQ = STREETLIGHT_DIST * STREETLIGHT_DIST;
  const STREET_POINT_DIST = 110;
  const STREET_POINT_DIST_SQ = STREET_POINT_DIST * STREET_POINT_DIST;

  const streetLightsGroup = new THREE.Group();
  streetLightsGroup.name = 'StreetClusteredLights';
  scene.add(streetLightsGroup);

  const streetlightSpotPool = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // Cobra-head LED luminaire: wide downward spread (0.96 rad half-angle) illuminating both road and sidewalk
    const spot = new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    streetLightsGroup.add(spot, spot.target);
    streetlightSpotPool.push(spot);
  }

  const streetPointPool = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const pt = new THREE.PointLight(0xffe4b4, 0, 12, 1.35);
    pt.position.set(0, -1000, 0);
    streetLightsGroup.add(pt);
    streetPointPool.push(pt);
  }

  const activeCobras = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  let cornerSigns = null; // (built by addJunctionSignals once the road network is known)
  function update(camera) {
    if (!camera) return;
    if (cornerSigns) cornerSigns.update(camera.position);
    // The overhead wires: the cells within their fade distance
    for (const c of wireCells) {
      const dx = c.x - camera.position.x, dz = c.z - camera.position.z;
      c.mesh.visible = Math.sqrt(dx * dx + dz * dz) - 150 < WIRE_FADE;
    }
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // Streetlights fade in smoothly as dusk approaches (matching lampBulbGlow smoothstep(0.4, 1.1, uInteriorGlow))
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < STREET_POINT_POOL; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8];
    const fwdZ = -me[10];

    let cobraCount = 0;
    for (let i = 0; i < cobraLampSites.length; i++) {
      const s = cobraLampSites[i];
      if (s.broken) continue;
      const dx = s.x - cx;
      const dy = s.g - cy; // from the lamp's foot (the town's slopes put it well over y = 0)
      const dz = s.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > STREETLIGHT_DIST_SQ) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STREETLIGHT_DIST) continue;
      s._effDist = effDist;
      activeCobras[cobraCount++] = s;
    }
    activeCobras.length = cobraCount;
    if (cobraCount > 1) activeCobras.sort((a, b) => a._effDist - b._effDist);

    const cobraCutoff = cobraCount > STREETLIGHT_SPOT_POOL
      ? Math.min(STREETLIGHT_DIST, activeCobras[STREETLIGHT_SPOT_POOL]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(cobraCount, STREETLIGHT_SPOT_POOL);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeCobras[i];
      const fade = smoothFade(s._effDist, cobraCutoff * 0.62, cobraCutoff);
      const spot = streetlightSpotPool[i];
      spot.position.set(s.x, s.y, s.z);
      spot.target.position.set(s.tx, s.g, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < STREETLIGHT_SPOT_POOL; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    let ptCount = 0;
    for (let i = 0; i < streetPointSites.length; i++) {
      const s = streetPointSites[i];
      if (s.broken) continue;
      const dx = s.x - cx;
      const dy = s.g - cy;
      const dz = s.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > STREET_POINT_DIST_SQ) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STREET_POINT_DIST) continue;
      s._effDist = effDist;
      activePoints[ptCount++] = s;
    }
    activePoints.length = ptCount;
    if (ptCount > 1) activePoints.sort((a, b) => a._effDist - b._effDist);

    const ptCutoff = ptCount > STREET_POINT_POOL
      ? Math.min(STREET_POINT_DIST, activePoints[STREET_POINT_POOL]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, STREET_POINT_POOL);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      pt.position.set(s.x, s.y, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < STREET_POINT_POOL; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  // Knock-over stand-ins, in each prop's own frame (base at the origin, +x towards the street)
  const at = (x, y, z, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
  const breaker = new PropBreaker(scene, breakables.filter((b) => b.parts && b.parts.length), {
    cobra: [
      { geometry: unitCyl, material: poleMetalMat, matrix: at(0, 4.2, 0, 0.12, 8.4, 0.12) },
      { geometry: unitBox, material: poleMetalMat, matrix: at(1.15, 8.1, 0, 2.3, 0.09, 0.09) },
      { geometry: lampHousingGeo, material: poleMetalMat, matrix: at(2.6, 7.98, 0) },
      { geometry: lampLensGeo, material: lampBulbGlow, matrix: at(2.6, 7.98, 0) }
    ],
    post: [
      { geometry: pedLampPostGeo, material: poleMetalMat },
      { geometry: pedGlobeGeo, material: pedGlobeGlow }
    ],
    hydrant: [{ geometry: hydrantInst.geometry, material: hydrantMat, matrix: at(0, 0.425, 0) }]
  });

  /**
   * Mexican mast-arm traffic signals at the road network's signalised junctions (built once the network exists, see
   * main.js): on each approach a black pole at the right-hand curb, an arm over the lanes, a black three-light head
   * over them facing the traffic (lit with that road's phase, like the grid's heads at the same height) and a green
   * blade with the name of the street crossing it. Each pole's collider goes into `colliders` (the player's).
   */
  function addJunctionSignals(network, colliders = null) {
    if (!network) return 0;
    const housingMat = new THREE.MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
    const mastMat = new THREE.MeshStandardNodeMaterial({ color: 0x2e3236, roughness: 0.45, metalness: 0.6 });
    const poles = [], arms = [], heads = [], aveLenses = [], stLenses = [], blades = [];
    const names = [];
    const nameSlot = new Map();
    const slotOf = (name) => {
      if (!nameSlot.has(name)) { nameSlot.set(name, names.length); names.push(name); }
      return nameSlot.get(name);
    };
    const roadName = (x, z) => {
      const r = nearestRoads(x, z, 12).find((q) => q.road.name);
      return r ? r.road.name : '';
    };
    for (const n of network.nodes) {
      if (!n.signal || !n.in) continue;
      for (const e of n.in) {
        if (!e.lanes || !e.lanes.length) continue;
        const ex = e.sx + e.dx * e.len, ez = e.sz + e.dz * e.len; // its stop line, on the centreline
        let off = e.half + 1.1;
        let px = ex + e.rx * off, pz = ez + e.rz * off;
        if (!isOnCurbIsland(px, pz, 0.3)) {
          off = e.half + 1.7;
          px = ex + e.rx * off;
          pz = ez + e.rz * off;
          if (!isOnCurbIsland(px, pz, 0.3)) continue;
        }
        const mid = e.lanes.reduce((t, o) => t + o, 0) / e.lanes.length; // over the middle of its lanes
        const reach = off - mid;
        if (reach < 1.5) continue;
        placedPoles.push({ x: px, z: pz });
        const g = liftAt(px, pz); // pole, arm, head & blade on the ground at the pole
        colliders?.push({ minX: px - 0.2, maxX: px + 0.2, minZ: pz - 0.2, maxZ: pz + 0.2, minY: g, maxY: 6.6 + g });
        const yaw = Math.atan2(e.dx, e.dz);
        const armYaw = Math.atan2(e.rz, -e.rx); // the arm runs from the pole to the left (−r)
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(px, 3.3 + g, pz);
        dummy.scale.set(0.17, 6.6, 0.17);
        dummy.updateMatrix();
        poles.push(dummy.matrix.clone());
        dummy.rotation.set(0, armYaw, 0);
        dummy.position.set(px - e.rx * (reach + 0.4) * 0.5, 6.1 + g, pz - e.rz * (reach + 0.4) * 0.5);
        dummy.scale.set(reach + 0.4, 0.13, 0.13);
        dummy.updateMatrix();
        arms.push(dummy.matrix.clone());
        // the head over the lanes, its lenses facing the approach
        dummy.rotation.set(0, yaw, 0);
        dummy.position.set(ex + e.rx * mid, 5.42 + g, ez + e.rz * mid);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        heads.push(dummy.matrix.clone());
        (e.axisIndex === 0 ? aveLenses : stLenses).push(dummy.matrix.clone());
        // the green blade with the cross street's name, on the arm between the pole and the head
        const own = roadName(ex - e.dx * 15, ez - e.dz * 15);
        let cross = '';
        for (const f of n.in) {
          if (f === e || Math.abs(f.dx * e.dx + f.dz * e.dz) > 0.5) continue;
          const nm = roadName(f.sx + f.dx * (f.len - 15), f.sz + f.dz * (f.len - 15));
          if (nm && nm !== own) { cross = nm; break; }
        }
        if (cross && reach > 3.2) {
          const bx = px - e.rx * reach * 0.55, bz = pz - e.rz * reach * 0.55;
          dummy.rotation.set(0, yaw, 0);
          dummy.position.set(bx, 6.55 + g, bz);
          dummy.scale.set(Math.min(3.4, reach - 1.2), 0.5, 0.05);
          dummy.updateMatrix();
          blades.push({ m: dummy.matrix.clone(), slot: slotOf(cross.toUpperCase()) });
        }
        dummy.rotation.set(0, 0, 0);
      }
    }
    const add = (geo, mat, list, shadow = true) => {
      if (!list.length) return null;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.castShadow = shadow;
      inst.receiveShadow = shadow;
      group.add(inst);
      return inst;
    };
    add(unitCyl, mastMat, poles);
    add(unitBox, mastMat, arms);
    add(signalHousingGeo, housingMat, heads);
    add(signalLensGeo, aveSignalLensMat, aveLenses, false);
    add(signalLensGeo, streetSignalLensMat, stLenses, false);
    // street name blades: an atlas of the names, a slot per blade
    if (blades.length) {
      const COLS = 4, SW = 512, SH = 64;
      const rows = Math.ceil(names.length / COLS);
      const c = document.createElement('canvas');
      c.width = COLS * SW;
      c.height = rows * SH;
      const ctx = c.getContext('2d');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      names.forEach((name, k) => {
        const x0 = (k % COLS) * SW, y0 = Math.floor(k / COLS) * SH;
        ctx.fillStyle = '#0b6b3a';
        ctx.fillRect(x0, y0, SW, SH);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.strokeRect(x0 + 5, y0 + 5, SW - 10, SH - 10);
        ctx.fillStyle = '#ffffff';
        let px = 34;
        do { ctx.font = `700 ${px}px Overpass, Inter, Arial, sans-serif`; px--; } while (px > 12 && ctx.measureText(name).width > SW - 30);
        ctx.fillText(name, x0 + SW / 2, y0 + SH / 2 + 2);
      });
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const geo = unitBox.clone();
      const slots = new THREE.InstancedBufferAttribute(new Float32Array(blades.map((b) => b.slot)), 1);
      geo.setAttribute('bladeSlot', slots);
      const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35 });
      mat.colorNode = texture(tex, atlasSlotUV(attribute('bladeSlot', 'float'), COLS, rows));
      add(geo, mat, blades.map((b) => b.m));
    }
    console.info(`[signals] ${heads.length} mast-arm signal heads, ${blades.length} street name blades at the signalised junctions`);
    cornerSigns = buildCornerSigns(network, roadName, colliders);
    return heads.length;
  }

  // The name plates on the corners: a 2.8 m post on the curb at one corner of every junction (three or more ways, no
  // signals: those carry their blades) with a blue plate along each of the two streets. 3,442 street names won't fit
  // one texture, so the plates within NEAR m of the camera get the slots of a small atlas (least recently seen names
  // are drawn over first) and the plates' instanced mesh is refilled whenever the camera has moved REFRESH m.
  function buildCornerSigns(network, roadName, colliders) {
    const NEAR = 260, REFRESH = 50, CELL = 100;
    const corners = []; // { x, z, g, a: [yaw, name], b: [yaw, name] }
    for (const n of network.nodes) {
      if (n.signal || n.shape || !n.in || n.in.length < 2) continue;
      for (const e of n.in) {
        if (!e.lanes || !e.lanes.length) continue;
        const ex = e.sx + e.dx * e.len, ez = e.sz + e.dz * e.len;
        const px = ex + e.rx * (e.half + 0.8) + e.dx * 1.2, pz = ez + e.rz * (e.half + 0.8) + e.dz * 1.2;
        if (!isOnCurbIsland(px, pz, 0.25) || !isClearOfPoles(px, pz, 1.2)) continue;
        const own = roadName(ex - e.dx * 15, ez - e.dz * 15);
        let cross = null;
        for (const f of n.in) {
          if (f === e || Math.abs(f.dx * e.dx + f.dz * e.dz) > 0.5) continue;
          const nm = roadName(f.sx + f.dx * (f.len - 15), f.sz + f.dz * (f.len - 15));
          if (nm && nm !== own) {
            cross = [Math.atan2(-f.dz, f.dx), nm];
            break;
          }
        }
        if (!own || !cross) continue;
        placedPoles.push({ x: px, z: pz });
        corners.push({ x: px, z: pz, g: liftAt(px, pz), a: [Math.atan2(-e.dz, e.dx), own], b: cross });
        colliders?.push({ minX: px - 0.06, maxX: px + 0.06, minZ: pz - 0.06, maxZ: pz + 0.06, minY: corners[corners.length - 1].g, maxY: corners[corners.length - 1].g + 2.8 });
        break; // one corner per junction
      }
    }
    if (!corners.length) return null;
    // the posts: all of them, static
    const postMat = new THREE.MeshStandardNodeMaterial({ color: 0x3c4046, roughness: 0.5, metalness: 0.6 });
    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.04, 2.8, 6).translate(0, 1.4, 0), postMat, corners.length);
    corners.forEach((c, i) => {
      dummy.position.set(c.x, c.g, c.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
    });
    posts.castShadow = true;
    group.add(posts);
    const grid = new Map();
    for (const c of corners) {
      const k = Math.floor(c.x / CELL) * 100003 + Math.floor(c.z / CELL);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(c);
    }
    // the atlas: COLS x ROWS slots of SW x SH px
    const COLS = 5, ROWS = 52, SW = 384, SH = 48, SLOTS = COLS * ROWS;
    const canvas = document.createElement('canvas');
    canvas.width = COLS * SW;
    canvas.height = ROWS * SH;
    const ctx = canvas.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const slotOfName = new Map();
    const nameInSlot = new Array(SLOTS).fill(null);
    const lastSeen = new Float64Array(SLOTS);
    let stamp = 0;
    const draw = (k, name) => {
      const x0 = (k % COLS) * SW, y0 = Math.floor(k / COLS) * SH;
      ctx.fillStyle = '#1b3f8b';
      ctx.fillRect(x0, y0, SW, SH);
      ctx.strokeStyle = '#f4f4f0';
      ctx.lineWidth = 3;
      ctx.strokeRect(x0 + 4, y0 + 4, SW - 8, SH - 8);
      ctx.fillStyle = '#f4f4f0';
      let px = 26;
      do { ctx.font = `700 ${px}px Overpass, Inter, Arial, sans-serif`; px--; } while (px > 10 && ctx.measureText(name).width > SW - 22);
      ctx.fillText(name, x0 + SW / 2, y0 + SH / 2 + 1);
    };
    const slotFor = (name) => {
      let k = slotOfName.get(name);
      if (k === undefined) {
        // the slot whose name was seen longest ago
        k = 0;
        for (let i = 1; i < SLOTS; i++) if (lastSeen[i] < lastSeen[k]) k = i;
        if (nameInSlot[k] !== null) slotOfName.delete(nameInSlot[k]);
        nameInSlot[k] = name;
        slotOfName.set(name, k);
        draw(k, name);
        tex.needsUpdate = true;
      }
      lastSeen[k] = stamp;
      return k;
    };
    const MAX = SLOTS * 2;
    const geo = unitBox.clone();
    const slotAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    slotAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('plateSlot', slotAttr);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4 });
    mat.colorNode = texture(tex, atlasSlotUV(attribute('plateSlot', 'float'), COLS, ROWS));
    const plates = new THREE.InstancedMesh(geo, mat, MAX);
    plates.count = 0;
    plates.frustumCulled = false;
    group.add(plates);
    let lastX = Infinity, lastZ = Infinity;
    function update(at) {
      if (Math.hypot(at.x - lastX, at.z - lastZ) < REFRESH) return;
      lastX = at.x;
      lastZ = at.z;
      stamp++;
      const near = [];
      const r = Math.ceil(NEAR / CELL);
      const ix = Math.floor(at.x / CELL), iz = Math.floor(at.z / CELL);
      for (let a = -r; a <= r; a++) {
        for (let b = -r; b <= r; b++) {
          for (const c of grid.get((ix + a) * 100003 + iz + b) || []) {
            const d = Math.hypot(c.x - at.x, c.z - at.z);
            if (d < NEAR) near.push([d, c]);
          }
        }
      }
      near.sort((p, q) => p[0] - q[0]);
      let n = 0;
      const names = new Set();
      for (const [, c] of near) {
        if (n + 2 > MAX) break;
        // never more names than slots in one refresh
        if (!names.has(c.a[1]) || !names.has(c.b[1])) {
          if (names.size + 2 > SLOTS) break;
          names.add(c.a[1]);
          names.add(c.b[1]);
        }
        for (const [[yaw, name], y] of [[c.a, 2.62], [c.b, 2.36]]) {
          dummy.position.set(c.x, c.g + y, c.z);
          dummy.rotation.set(0, yaw, 0);
          // (along its street, a little out from the post)
          dummy.translateX(0.48);
          dummy.scale.set(0.92, 0.22, 0.025);
          dummy.updateMatrix();
          plates.setMatrixAt(n, dummy.matrix);
          slotAttr.array[n] = slotFor(name);
          n++;
        }
      }
      dummy.rotation.set(0, 0, 0);
      plates.count = n;
      plates.instanceMatrix.needsUpdate = true;
      slotAttr.needsUpdate = true;
    }
    console.info(`[signs] ${corners.length} corners with the two streets' name plates`);
    return { update };
  }

  return { group, footprints, colliders: cfeColliders, signalClock, audioSignals, update, breaker, addJunctionSignals };
}

export { buildStreetDetails };
