import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CITY_OUTLINE, BLOCKS } from './city-config.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createParkLawnMaterial,
  createParkPavingMaterial,
  createParkLampGlobeMaterial,
  createParkLampPoolMaterial
} from '../render/tsl-materials.js';
import { GEO } from './city-geodata.js';
import { SLOPES, liftAt, groundSlope } from './ground.js';
import { drapeMeshes } from './drape.js';

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let parkTreeSites;
let parkLampSites;
let pavedPlazaRects;
let sidewalkBlocks;

// js/world/city-grid.js
// Builds the city's ground: the valley floor, the roadway deck over the city outline, the raised sidewalks &
// curbstones of every real curb island (city-config.js BLOCKS), the open country between the roads, and the parks &
// plazas with their walks, lawns, trees and lamps. All of it is built flat at y = 0 and laid on the town's slopes at
// the end (drape.js), its lamps & trees set on the ground under them.

/**
 * Merges static non-instanced THREE.Mesh objects sharing the same material into a single
 * batched BufferGeometry per material to minimize WebGPU render & shadow pass draw calls.
 */
function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  if (!mergeGeometries) return;
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * Helper to convert an array of world {x, z} polygon vertices into a horizontal THREE.Shape
 * in (x, -z) space so that rotating by rotateX(-Math.PI / 2) maps (x, -z, 0) -> (x, 0, z)
 * with an upward (+Y) surface normal.
 */
function createWorldXZShape(pts) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  return shape;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

/**
 * A curb as much as shows of it around a sidewalk slab inset into it: the walls of `outer` from the ground up to
 * `height`, and the top as the ring between `outer` and `inner` (the same polygon offset inward, vertex by vertex).
 * Laid on the slopes its full top would be cut up along the ground's lattice under the slab for nothing.
 */
function createCurbRingGeometry(outer, inner, height) {
  const position = [];
  const normal = [];
  const tri = (a, b, c, nx, ny, nz) => {
    // wound to face (nx, ny, nz)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const face = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (face < 0) [b, c] = [c, b];
    position.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) normal.push(nx, ny, nz);
  };
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const p = outer[i], q = outer[(i + 1) % n], pi = inner[i], qi = inner[(i + 1) % n];
    // the wall faces away from the inner ring
    let ox = -(q.z - p.z), oz = q.x - p.x;
    const len = Math.hypot(ox, oz) || 1;
    ox /= len; oz /= len;
    if ((pi.x + qi.x - p.x - q.x) * ox + (pi.z + qi.z - p.z - q.z) * oz > 0) { ox = -ox; oz = -oz; }
    const p0 = [p.x, 0, p.z], q0 = [q.x, 0, q.z], p1 = [p.x, height, p.z], q1 = [q.x, height, q.z];
    tri(p0, q0, q1, ox, 0, oz);
    tri(p0, q1, p1, ox, 0, oz);
    const pin = [pi.x, height, pi.z], qin = [qi.x, height, qi.z];
    tri(p1, q1, qin, 0, 1, 0);
    tri(p1, qin, pin, 0, 1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((position.length / 3) * 2), 2));
  return geo;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d); null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? 1 : -1; // positive area: the inside lies left of each edge, i.e. along (-dz, dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += out[j].x * out[i].z - out[i].x * out[j].z;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

/**
 * Tags every vertex of a mesh using the shared park paving material with its paving style (uv.x, see
 * createParkPavingMaterial: 0 hex asphalt pavers, 1 light granite plaza pavers, 2 bluestone slabs).
 */
function setPavingStyle(geo, style) {
  const uvAttr = geo.attributes.uv;
  for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, style, 0);
  uvAttr.needsUpdate = true;
  return geo;
}

function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'CityGrid';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  // Ground footprints that traffic and pedestrians must keep clear of (medians, plazas, monuments, parks)
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  // =========================================================================
  // 1. THE VALLEY FLOOR
  // =========================================================================
  let valleyMesh;
  {
    // Dry valley floor out to the horizon around the detailed box (the roads deck sits on it). On the town's slopes the
    // hills' mesh (terrain.js) is the ground over all of its grid, and the floor rings it at the far floor's height
    const groundMat = new THREE.MeshStandardNodeMaterial({ color: 0x56653c, roughness: 0.96, metalness: 0.0 });
    let groundGeo;
    const T = GEO.terrain;
    if (SLOPES && T && GEO.ground) {
      const R = 30000;
      const ring = createWorldXZShape([{ x: -R, z: -R }, { x: R, z: -R }, { x: R, z: R }, { x: -R, z: R }]);
      const x1 = T.x0 + (T.w - 1) * T.cell, z1 = T.z0 + (T.h - 1) * T.cell;
      ring.holes.push(createWorldXZShape([{ x: T.x0, z: T.z0 }, { x: x1, z: T.z0 }, { x: x1, z: z1 }, { x: T.x0, z: z1 }]));
      groundGeo = new THREE.ShapeGeometry(ring, 1);
      groundGeo.rotateX(-Math.PI / 2);
    } else {
      groundGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
      groundGeo.rotateX(-Math.PI / 2);
    }
    valleyMesh = new THREE.Mesh(groundGeo, groundMat);
    valleyMesh.position.set(0, (SLOPES && GEO.ground ? GEO.ground.floor : 0) - 0.03, 0);
    valleyMesh.receiveShadow = true;
    group.add(valleyMesh);
  }

  // =========================================================================
  // 2. ROADWAY ASPHALT DECK (Y = 0.0) over the city outline
  // =========================================================================
  const roadMat = createRoadSurfaceMaterial();
  const roadMesh = createFlatPolygonMesh(CITY_OUTLINE, 0.0, roadMat, true);
  group.add(roadMesh);

  // =========================================================================
  // 3. MEADOW MATERIAL (the open country between the roads)
  // =========================================================================
  const meadowMat = createParkLawnMaterial(true);

  // =========================================================================
  // 4. RAISED SIDEWALKS & GRANITE CURBSTONES: every real curb island of the city (city-config.js BLOCKS, from the
  //    street centreline at its curb-to-curb widths). Rectangular islands are instanced slabs; the rest (the irregular
  //    blocks, the planted medians) are extruded from their outlines
  // =========================================================================
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const medianHedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x366e3b, roughness: 0.82 });
  const blockSidewalks = []; // { cx, cz, w, d, block } axis-aligned slabs (irregular islands: their lot cover)
  const roadSidewalks = []; // the curbs road-network.js bounds the roads with (medians go in as footprints)
  const slabGeos = [];
  const curbGeos = [];
  const hedgeGeos = [];
  const SW_TOP = 0.22;
  const COVER_GROW = Math.max(0.5, ((GEO.frame && GEO.frame.sidewalk) || 4.6) - 0.2);
  for (const b of BLOCKS) {
    if (b.park > 0.6 && !b.median) continue; // parks build their own perimeter sidewalk (section 7)
    if (b.rect) {
      const slab = { cx: (b.minX + b.maxX) * 0.5, cz: (b.minZ + b.maxZ) * 0.5, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b };
      blockSidewalks.push(slab);
      if (SLOPES) {
        // laid on the slopes with the extruded islands (an instanced box can't bend)
        slabGeos.push(new THREE.BoxGeometry(slab.w - 0.5, 0.19, slab.d - 0.5).translate(slab.cx, 0.125, slab.cz).toNonIndexed());
        curbGeos.push(new THREE.BoxGeometry(slab.w, 0.17, slab.d).translate(slab.cx, 0.095, slab.cz).toNonIndexed());
        slab.draped = true;
      }
      if (b.median) addFootprint(slab.cx, slab.cz, slab.w, slab.d);
      else roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    } else {
      // curb (granite) ring under a sidewalk slab inset by 0.25 m, like the instanced pair below
      const inner = offsetPolygonInward(b.poly, 0.25);
      curbGeos.push(SLOPES && inner ? createCurbRingGeometry(b.poly, inner, 0.18) : createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat).geometry);
      if (inner) slabGeos.push(createExtrudedPolygonMesh(inner, 0.03, SW_TOP - 0.03, sidewalkMat).geometry);
      // rect cover for the consumers that work on rectangles: the lot rects grown back out to (just short of) the curb,
      // by the city's sidewalk width (2.2 m in Tepic: more would reach into the lanes)
      for (const [x0, x1, z0, z1] of b.rects) {
        const r = { minX: x0 - COVER_GROW, maxX: x1 + COVER_GROW, minZ: z0 - COVER_GROW, maxZ: z1 + COVER_GROW };
        blockSidewalks.push({ cx: (r.minX + r.maxX) * 0.5, cz: (r.minZ + r.maxZ) * 0.5, w: r.maxX - r.minX, d: r.maxZ - r.minZ, block: b, cover: true });
        if (!b.median) roadSidewalks.push(r);
      }
      if (b.median) addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    // Planted medians down the middle of the boulevards: a clipped hedge on the slab
    if (b.median && Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 2.2) {
      const hedge = offsetPolygonInward(b.poly, 1.0);
      if (hedge) hedgeGeos.push(createExtrudedPolygonMesh(hedge, SW_TOP, 0.55, medianHedgeMat).geometry);
    }
  }
  const mergeInto = (geos, mat, cast = false) => {
    for (let i = 0; i < geos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 400), false), mat);
      m.receiveShadow = true;
      m.castShadow = cast;
      group.add(m);
    }
  };
  mergeInto(curbGeos, curbMat, true);
  mergeInto(slabGeos, sidewalkMat);
  mergeInto(hedgeGeos, medianHedgeMat, true);

  const rectSlabs = blockSidewalks.filter((s) => !s.cover && !s.draped);
  const swInstanced = new THREE.InstancedMesh(unitBox, sidewalkMat, rectSlabs.length);
  const curbInstanced = new THREE.InstancedMesh(unitBox, curbMat, rectSlabs.length);
  swInstanced.receiveShadow = true;
  curbInstanced.receiveShadow = true;
  curbInstanced.castShadow = true;

  rectSlabs.forEach((blk, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(blk.cx, 0.125, blk.cz);
    dummy.scale.set(blk.w - 0.5, 0.19, blk.d - 0.5);
    dummy.updateMatrix();
    swInstanced.setMatrixAt(i, dummy.matrix);

    dummy.position.set(blk.cx, 0.095, blk.cz);
    dummy.scale.set(blk.w, 0.17, blk.d);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(i, dummy.matrix);
  });
  swInstanced.instanceMatrix.needsUpdate = true;
  curbInstanced.instanceMatrix.needsUpdate = true;
  if (rectSlabs.length) group.add(swInstanced, curbInstanced); // (none left on the slopes: an empty buffer can't bind)

  // 6. Park furniture shared by the parks (section 7): paving, granite copings, lampposts & trees
  const pavingMat = createParkPavingMaterial();
  const graniteMat = new THREE.MeshStandardNodeMaterial({ color: 0x86837c, roughness: 0.8 }); // bed copings
  const lampMatrices = []; // cast-iron lampposts with glass globes
  const treeSites = []; // { x, y, z, scale, species } park trees planted by street-details.js (section 7)
  const pavedRects = []; // park slab bounds, exported so street trees (street-details.js) stay off them

  function addLamp(x, y, z) {
    lampMatrices.push(new THREE.Matrix4().makeTranslation(x, y + liftAt(x, z), z));
  }

  // 7. THE PARKS: every park block's curb island paved like a park walk, a granite-coped lawn inset from it under
  //    scattered trees, lampposts on the perimeter; the open country around the city as meadow
  const PARK_Y = 0.26; // hex-paver walks (sidewalk tops are at 0.22)
  const BED_Y = 0.41; // lawn top inside the granite bed copings
  const inPolygon = (x, z, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  };
  const prand = (x, z, k = 0) => {
    const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };
  const genericParks = BLOCKS.filter((b) => b.park > 0.6 && !b.median && !b.rural && b.area > 250);
  // Open country between the roads around an inland city: meadow flush with the road, no walks, lamps or trees
  {
    const fieldGeos = [];
    for (const b of BLOCKS) if (b.rural) fieldGeos.push(createFlatPolygonMesh(b.poly, 0.03, meadowMat, true).geometry);
    for (let i = 0; i < fieldGeos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(fieldGeos.slice(i, i + 400), false), meadowMat);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  for (const b of genericParks) {
    const slab = offsetPolygonInward(b.poly, 0.1) || b.poly;
    group.add(createExtrudedPolygonMesh(b.poly, 0.0, PARK_Y - 0.04, curbMat, true, false));
    const top = createExtrudedPolygonMesh(slab, 0.0, PARK_Y, pavingMat, true, false);
    setPavingStyle(top.geometry, 0);
    group.add(top);
    pavedRects.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    const bed = offsetPolygonInward(b.poly, Math.min(5, Math.min(b.maxX - b.minX, b.maxZ - b.minZ) * 0.2));
    if (!bed) continue;
    group.add(createExtrudedPolygonMesh(bed, 0.2, BED_Y - 0.21, graniteMat, true, false));
    // (no lawn mesh in the bed: the New York code merged the park lawns inside its Battery block, which never ran
    // here, so Tepic's parks have always shown the bare granite bed; adding the lawn would change how they look)
    const lawnTop = offsetPolygonInward(bed, 0.3);
    // trees on a jittered grid inside the bed
    const SP = 11;
    for (let gx = b.minX + SP * 0.5; gx < b.maxX; gx += SP) {
      for (let gz = b.minZ + SP * 0.5; gz < b.maxZ; gz += SP) {
        const tx = gx + (prand(gx, gz) - 0.5) * SP * 0.7;
        const tz = gz + (prand(gz, gx, 1) - 0.5) * SP * 0.7;
        if (prand(tx, tz, 9) < 0.3) continue; // glades
        const inner = lawnTop || bed;
        if (!inPolygon(tx, tz, inner)) continue;
        const r = prand(tx, tz, 2);
        treeSites.push({ x: tx, y: BED_Y + liftAt(tx, tz), z: tz, scale: 0.9 + prand(tx, tz, 3) * 0.4, species: r < 0.55 ? 0 : (r < 0.75 ? 1 : 2) });
      }
    }
    // lampposts every ~34 m along the walk
    for (let i = 0; i < slab.length; i++) {
      const a = slab[i];
      const c = slab[(i + 1) % slab.length];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      for (let t = 17; t < len - 8; t += 34) {
        const px = a.x + ((c.x - a.x) * t) / len;
        const pz = a.z + ((c.z - a.z) * t) / len;
        addLamp(px, PARK_Y, pz);
      }
    }
  }

  // Instanced park furniture: cast-iron lampposts with globes
  if (lampMatrices.length) {
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.15, 0.2, 0.7, 8).translate(0, 0.35, 0),
      new THREE.CylinderGeometry(0.055, 0.085, 3.1, 8).translate(0, 2.25, 0),
      new THREE.CylinderGeometry(0.13, 0.07, 0.2, 8).translate(0, 3.85, 0)
    ]);
    const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c201d, roughness: 0.45, metalness: 0.6 });
    const globeGeo = new THREE.SphereGeometry(0.27, 12, 8).translate(0, 4.17, 0);
    const poleInst = new THREE.InstancedMesh(poleGeo, poleMat, lampMatrices.length);
    const globeInst = new THREE.InstancedMesh(globeGeo, createParkLampGlobeMaterial(), lampMatrices.length);
    lampMatrices.forEach((m, i) => {
      poleInst.setMatrixAt(i, m);
      globeInst.setMatrixAt(i, m);
    });
    poleInst.instanceMatrix.needsUpdate = true;
    globeInst.instanceMatrix.needsUpdate = true;
    poleInst.castShadow = true;
    poleInst.computeBoundingSphere();
    globeInst.computeBoundingSphere();
    group.add(poleInst, globeInst);

    // Warm pools of lamplight on the walks & bed copings after dusk (additive decal, black by day)
    const poolInst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createParkLampPoolMaterial(), lampMatrices.length);
    const poolM = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0), normal = new THREE.Vector3(), tilt = new THREE.Quaternion();
    const at = new THREE.Vector3(), size = new THREE.Vector3(14, 1, 14), slope = [0, 0];
    lampMatrices.forEach((m, i) => {
      // tilted with the ground: a flat 14 m pool would stand off a sloping walk on one side
      if (SLOPES) groundSlope(m.elements[12], m.elements[14], slope);
      tilt.setFromUnitVectors(up, normal.set(-slope[0], 1, -slope[1]).normalize());
      poolInst.setMatrixAt(i, poolM.compose(at.set(m.elements[12], m.elements[13] + 0.17, m.elements[14]), tilt, size));
    });
    poolInst.instanceMatrix.needsUpdate = true;
    poolInst.computeBoundingSphere();
    group.add(poolInst);
  }

  // Park & plaza tree and lamp sites, read by street-details.js after the city grid is built
  parkTreeSites = treeSites;
  parkLampSites = lampMatrices.map((m) => ({ x: m.elements[12], y: m.elements[13] + 4.17, z: m.elements[14] }));
  pavedPlazaRects = pavedRects;
  sidewalkBlocks = blockSidewalks; // { cx, cz, w, d } raised sidewalk slabs (cross-street tree rows)

  // Batch static sub-meshes by material to reduce per-frame WebGPU draw calls
  batchStaticGroupMeshes(group, new Set([roadMat, meadowMat]));
  // ...and lay them on the town's slopes; the valley floor beyond the hills' grid stays flat
  drapeMeshes(group, new Set([valleyMesh]));

  scene.add(group);

  // Raised sidewalk blocks bound the roads (the planted medians are obstacles in the roadway, handed over with the
  // footprints). No shore highways or viaducts here: no highway lanes, no extra colliders
  const sidewalks = roadSidewalks;
  return { group, sidewalks, footprints, highwayLanes: [], colliders: [] };
}

export {
  buildCityGrid,
  parkTreeSites,
  parkLampSites,
  pavedPlazaRects,
  sidewalkBlocks
};
