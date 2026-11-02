import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, If, float, vec3, vec4, attribute, varying, vertexStage,
  positionGeometry, positionLocal, normalGeometry,
  abs, floor, fract, mod, round, step, fwidth, max, min, mix, clamp
} from 'three/tsl';
import { filteredPulse } from './tsl-materials.js';

const MAX_ESCAPES = 2400;
const MAX_LANDINGS = 7; // (buildings.js addSurveyedFireEscapes)
const STOREY = 3.5;
const NEAR_SHADOW_DIST = 115; // m: cast filigree sun shadows nearby; far cells skip shadow rasterization
const NEAR_SHADOW_DIST_SQ = NEAR_SHADOW_DIST * NEAR_SHADOW_DIST;
const FAR_GRID = 4; // 4x4 spatial cells (280 m each across the 1120 m stream box) for tight frustum culling
const FAR_SPAN = 560;
const FAR_CELL = (FAR_SPAN * 2) / FAR_GRID;
const NEAR_CAPACITY = 512;
const FAR_CELL_CAPACITY = 640;

// Pixel coverage, rather than a minimum one-pixel bar width, keeps distant ironwork open.
const filteredBar = Fn(([distance, halfWidth, footprint]) => {
  const w = max(footprint, 0.0001).toVar();
  return clamp(float(halfWidth).add(w.mul(0.5)).sub(abs(distance)).div(w), 0, min(1, float(halfWidth).mul(2).div(w)));
});
const repeatingBar = (coord, halfWidth, footprint) => filteredPulse(
  fract(coord.add(0.5)), float(0.5).sub(halfWidth), float(0.5).add(halfWidth), footprint
);
const union = (a, b) => {
  const va = a.toVar();
  const vb = b.toVar();
  return va.add(vb).sub(va.mul(vb));
};

// One instance per escape: masked vertical/landing planes plus flat horizontal stair treads.
// Parts 1: front & side balcony guards; 3: diagonal flight guards; 4: raised drop ladder (vertical planes y 0..1);
// 5: horizontal landing decks; 6: flat horizontal stair treads (solid geometry, skipping procedural mask ALU).
export function escapeGeometry() {
  const planes = [
    [3.4, 0, 0.55, 0, 1],
    [1.1, -1.7, 0, -Math.PI / 2, 1],
    [1.1, 1.7, 0, Math.PI / 2, 1],
    [2.4, 0, -0.17, 0, 3],
    [2.4, 0, 0.52, 0, 3],
    [0.34, -1.45, 0.56, 0, 4]
  ].map(([width, x, z, rotation, part]) => {
    const geometry = new THREE.PlaneGeometry(width, 1);
    geometry.translate(0, 0.5, 0);
    geometry.rotateY(rotation);
    geometry.translate(x, 0, z);
    geometry.setAttribute('escapePart', new THREE.Float32BufferAttribute([part, part, part, part], 1));
    geometry.setAttribute('escapeLevel', new THREE.Float32BufferAttribute([0, 0, 0, 0], 1));
    return geometry;
  });
  const quad = (corners, part, level) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setAttribute('escapePart', new THREE.Float32BufferAttribute([part, part, part, part], 1));
    geometry.setAttribute('escapeLevel', new THREE.Float32BufferAttribute([level, level, level, level], 1));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    return geometry;
  };
  const steps = 16;
  for (let level = 0; level < MAX_LANDINGS; level++) {
    const y = level * STOREY;
    planes.push(quad([[-1.7, y, -0.55], [-1.7, y, 0.55], [1.7, y, 0.55], [1.7, y, -0.55]], 5, level));
    if (level === MAX_LANDINGS - 1) continue;
    const s = level % 2 ? -1 : 1;
    for (let i = 0; i < steps; i++) {
      const x0 = s * (-1.2 + (2.4 * i) / steps);
      const x1 = s * (-1.2 + (2.4 * (i + 1)) / steps);
      const stepY = y + (STOREY * (i + 1)) / steps;
      const minX = Math.min(x0, x1);
      const maxX = Math.max(x0, x1);
      planes.push(quad([[minX, stepY, -0.15], [minX, stepY, 0.5], [maxX, stepY, 0.5], [maxX, stepY, -0.15]], 6, level));
    }
  }
  return mergeGeometries(planes);
}

function flagRange(attribute, count) {
  if (!count) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

export function createFireEscapeMaterial() {
  const steel = { color: 0x25292c, roughness: 0.65, metalness: 0.6 };
  const material = new THREE.MeshStandardNodeMaterial({ ...steel, side: THREE.DoubleSide, alphaToCoverage: true });
  const part = attribute('escapePart', 'float');
  const size = attribute('escapeSize', 'vec2'); // Storey and nominal escape height.
  const invStorey = float(1).div(size.x);
  const scale = size.x.mul(1 / STOREY);
  // From the bottom of the raised ladder (the instance origin) to the top of the last landing's guard
  const fullHeight = size.y.sub(1).add(scale.mul(3.2));

  // (after the instance transform, which only turns the escape about y and moves it: lift the vertices in place)
  material.positionNode = Fn(() => {
    const p = positionGeometry;
    const flat = step(4.5, part);
    // Decks on every landing, stair runs below all but the top one; unused upper storeys collapse to a point
    const landings = round(size.y.sub(1).mul(invStorey)).add(1);
    const shown = step(attribute('escapeLevel', 'float').add(step(5.5, part)).add(0.5), landings);
    const y = mix(p.y.mul(fullHeight), p.y.add(2.2).mul(scale), flat);
    return positionLocal.add(vec3(0, y.sub(p.y), 0)).mul(mix(1, shown, flat));
  })();

  // Precompute linear coordinates & per-instance ratios in the vertex stage so each fragment only evaluates its own part
  const heightNode = positionGeometry.y.mul(fullHeight).sub(scale.mul(2.2));
  const vEscapeCoord = varying(
    vertexStage(
      vec4(
        positionGeometry.x.add(1.7),
        heightNode.div(scale),
        heightNode.mul(invStorey),
        positionGeometry.z
      )
    ),
    'vEscapeCoord'
  );
  const vEscapeMeta = varying(
    vertexStage(
      vec4(
        part,
        abs(normalGeometry.z),
        floor(size.y.mul(invStorey)),
        invStorey.mul(0.05)
      )
    ),
    'vEscapeMeta'
  );

  material.opacityNode = Fn(() => {
    const across = vEscapeCoord.x.toVar();
    const hScaled = vEscapeCoord.y.toVar();
    const level = vEscapeCoord.z.toVar();
    const posZ = vEscapeCoord.w.toVar();
    const pId = vEscapeMeta.x;

    // Materialize hardware derivatives into local vars before branching to satisfy WGSL derivative uniformity.
    const dxDx = across.dFdx().toVar();
    const dxDy = across.dFdy().toVar();
    const dhDx = hScaled.dFdx().toVar();
    const dhDy = hScaled.dFdy().toVar();
    const fwX = abs(dxDx).add(abs(dxDy)).toVar();
    const fwHScaled = abs(dhDx).add(abs(dhDy)).toVar();
    const fwZ = fwidth(posZ).toVar();
    const fwLevel = fwidth(level).toVar();

    const alpha = float(0).toVar();

    If(pId.greaterThan(5.5), () => {
      // Flat horizontal stair treads are solid geometry: bypass all procedural ironwork ALU
      alpha.assign(1);
    })
      .ElseIf(pId.greaterThan(4.5), () => {
        // Landing decks: 10 cm grating framed around the panels, open in front where the flights pass
        const posX = across.sub(1.7);
        const grating = union(
          repeatingBar(posX.mul(10), 0.08, fwX.mul(10)),
          repeatingBar(posZ.mul(10), 0.08, fwZ.mul(10))
        );
        const edge = min(abs(abs(posX).sub(1.7)), abs(abs(posX).sub(1.2)), abs(abs(posZ).sub(0.55)), abs(posZ.add(0.18)));
        const frame = filteredBar(edge, 0.025, max(fwX, fwZ));
        const opening = step(abs(posX), 1.2).mul(step(-0.18, posZ));
        alpha.assign(union(grating, frame).mul(float(1).sub(opening.mul(step(0.025, edge)))));
      })
      .ElseIf(pId.greaterThan(3.5), () => {
        // Raised drop ladder below the first landing
        const ladderX = across.sub(0.08).div(0.34);
        const ladderY = hScaled.add(2.2).div(2.15);
        const fwLadderY = fwHScaled.div(2.15);
        const ladderRails = filteredBar(min(ladderX, float(1).sub(ladderX)), 0.065, fwX.div(0.34));
        const rungs = repeatingBar(ladderY.mul(8), 0.07, fwLadderY.mul(8));
        alpha.assign(union(ladderRails, rungs).mul(filteredBar(ladderY.sub(0.5), 0.5, fwLadderY)));
      })
      .ElseIf(pId.greaterThan(1.5), () => {
        // Diagonal flight guards (continuing above the next landing where the following flight reverses direction)
        const maxFlight = vEscapeMeta.z;
        const flight = (index) => {
          const parity = mod(index, 2);
          const x = mix(across, float(3.4).sub(across), parity).sub(0.5);
          const railY = hScaled.sub(index.mul(STOREY)).sub(x.mul(STOREY / 2.4));
          const slope = mix(float(STOREY / 2.4), float(-STOREY / 2.4), parity);
          const footprint = abs(dhDx.sub(dxDx.mul(slope))).add(abs(dhDy.sub(dxDy.mul(slope))));
          const bay = x.mul(14 / 2.4);
          const pickets = repeatingBar(bay, 0.08, fwX.mul(14 / 2.4)).mul(filteredBar(railY.sub(0.5), 0.5, footprint));
          const rails = filteredBar(railY.add(0.025), 0.055, footprint)
            .add(filteredBar(railY.sub(0.97), 0.03, footprint))
            .add(filteredBar(railY.sub(0.48), 0.018, footprint));
          const visible = step(0, index).mul(step(index.add(1), maxFlight));
          return union(pickets, rails).mul(visible);
        };
        alpha.assign(union(flight(floor(level)), flight(floor(level).sub(1))));
      })
      .Else(() => {
        // Front & side balcony guards + deck edge bands
        const front = vEscapeMeta.y;
        const deckHalf = vEscapeMeta.w;
        const along = mix(posZ.add(0.55), across, front);
        const bay = along.mul(mix(6 / 1.1, 20 / 3.4, front));
        const fwBay = mix(fwZ.mul(6 / 1.1), fwX.mul(20 / 3.4), front);
        const pickets = repeatingBar(bay, 0.08, fwBay);
        const guardHeight = filteredPulse(fract(level), 0, 1 / STOREY, fwLevel);
        const rails = repeatingBar(level.sub(0.97 / STOREY), 0.03 / STOREY, fwLevel)
          .add(repeatingBar(level.sub(0.48 / STOREY), 0.018 / STOREY, fwLevel));
        const guards = union(pickets.mul(guardHeight), rails);
        const deck = repeatingBar(level.sub(deckHalf.mul(0.8)), deckHalf, fwLevel);
        alpha.assign(union(deck, guards).mul(step(0, hScaled)));
      });

    return alpha;
  })().toVar();
  material.maskNode = material.opacityNode.greaterThan(0);
  material.maskShadowNode = material.opacityNode.greaterThan(0.5);
  return material;
}

export function createFireEscapes(group) {
  const baseGeometry = escapeGeometry();
  baseGeometry.computeBoundingBox();
  baseGeometry.computeBoundingSphere();
  const baseAttrs = Object.entries(baseGeometry.attributes);
  const material = createFireEscapeMaterial();

  const makeBucket = (name, capacity, castShadow, primaryMesh) => {
    const geo = new THREE.BufferGeometry();
    geo.setIndex(baseGeometry.index);
    for (const [attrName, attr] of baseAttrs) geo.setAttribute(attrName, attr);
    geo.boundingBox = baseGeometry.boundingBox;
    geo.boundingSphere = baseGeometry.boundingSphere;
    const sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    sizes.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('escapeSize', sizes);

    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.boundingSphere = new THREE.Sphere();
    mesh.frustumCulled = true;
    if (primaryMesh) mesh.userData.sharesPipelineWith = primaryMesh;
    group.add(mesh);

    return {
      mesh,
      sizes,
      max: capacity,
      count: 0,
      sphere: mesh.boundingSphere,
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
    };
  };

  const buckets = [];
  const nearBucket = makeBucket('FireEscapesNear', NEAR_CAPACITY, true, null);
  buckets.push(nearBucket);
  for (let i = 0; i < FAR_GRID * FAR_GRID; i++) {
    buckets.push(makeBucket('FireEscapesFar', FAR_CELL_CAPACITY, false, nearBucket.mesh));
  }

  const dummy = new THREE.Object3D();
  let total = 0;
  let originX = 0;
  let originZ = 0;

  return {
    meshes: buckets.map((b) => b.mesh),
    begin(focusX = 0, focusZ = 0) {
      total = 0;
      originX = focusX;
      originZ = focusZ;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        b.count = 0;
        b.minX = b.minY = b.minZ = Infinity;
        b.maxX = b.maxY = b.maxZ = -Infinity;
      }
    },
    add(fe) {
      if (total >= MAX_ESCAPES) return;
      const dx = fe.x - originX;
      const dz = fe.z - originZ;
      let b;
      if (dx * dx + dz * dz <= NEAR_SHADOW_DIST_SQ && nearBucket.count < nearBucket.max) {
        b = nearBucket;
      } else {
        const gx = Math.max(0, Math.min(FAR_GRID - 1, Math.floor((dx + FAR_SPAN) / FAR_CELL)));
        const gz = Math.max(0, Math.min(FAR_GRID - 1, Math.floor((dz + FAR_SPAN) / FAR_CELL)));
        b = buckets[1 + gz * FAR_GRID + gx];
        if (b.count >= b.max) return;
      }
      total++;
      const baseY = fe.y - (fe.storey / STOREY) * 2.2;
      const topY = baseY + fe.h + (fe.storey / STOREY) * 3.2;
      dummy.rotation.set(0, (fe.ry || 0) + fe.facing, 0);
      dummy.position.set(fe.x, baseY, fe.z);
      dummy.updateMatrix();
      const idx = b.count++;
      b.mesh.setMatrixAt(idx, dummy.matrix);
      b.sizes.setXY(idx, fe.storey, fe.h);
      if (fe.x - 2 < b.minX) b.minX = fe.x - 2;
      if (fe.x + 2 > b.maxX) b.maxX = fe.x + 2;
      if (baseY < b.minY) b.minY = baseY;
      if (topY > b.maxY) b.maxY = topY;
      if (fe.z - 2 < b.minZ) b.minZ = fe.z - 2;
      if (fe.z + 2 > b.maxZ) b.maxZ = fe.z + 2;
    },
    end() {
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.count === 0) {
          if (i === 0) {
            // Keep one underground stand-in on the primary mesh so precompileShaders() and the warm-up frame
            // always compile both beauty and shadow pipelines even if the player spawns away from pre-war blocks.
            dummy.rotation.set(0, 0, 0);
            dummy.position.set(originX, -10000, originZ);
            dummy.updateMatrix();
            b.mesh.setMatrixAt(0, dummy.matrix);
            b.sizes.setXY(0, STOREY, 1);
            b.mesh.count = 1;
            b.mesh.visible = true;
            b.sphere.center.set(originX, -10000, originZ);
            b.sphere.radius = 5;
            flagRange(b.mesh.instanceMatrix, 1);
            flagRange(b.sizes, 1);
          } else {
            b.mesh.count = 0;
            b.mesh.visible = false;
          }
          continue;
        }
        b.mesh.count = b.count;
        b.mesh.visible = true;
        const cx = (b.minX + b.maxX) * 0.5;
        const cy = (b.minY + b.maxY) * 0.5;
        const cz = (b.minZ + b.maxZ) * 0.5;
        b.sphere.center.set(cx, cy, cz);
        b.sphere.radius = Math.hypot(b.maxX - cx, b.maxY - cy, b.maxZ - cz) + 2.5;
        flagRange(b.mesh.instanceMatrix, b.count);
        flagRange(b.sizes, b.count);
      }
    }
  };
}
