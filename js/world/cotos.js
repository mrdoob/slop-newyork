import * as THREE from 'three/webgpu';
import { color, float, mix, positionWorld, positionGeometry, fract, step, smoothstep } from 'three/tsl';
import { GEO } from './city-geodata.js';
import { groundHeight } from './ground.js';
import { cityUniforms } from '../render/tsl-materials.js';

// js/world/cotos.js
// Tepic's gated communities (fraccionamientos cerrados, cotos; city-geodata.js `cotos`, found by the data builder from
// the streets OpenStreetMap maps access=private): the barda round each one along the property line where it faces a
// public street, painted block 2.6 m high with a darker plinth and a pale coping, and at every entrance a guard booth
// (caseta) with its barrier arm (pluma), raised so the traffic gets through. The houses inside (one colour, one height)
// are drawn by buildings.js.

const WALL_H = 2.6; // m: a barda over head height, as the developers build them
const WALL_T = 0.25; // m: one 15 cm block plus render on both faces
const BOOTH = { w: 2.4, h: 2.7, d: 2.4 };
// the bardas' paint: cream, sand, terracotta, white, ochre (each coto its own)
const PAINTS = [0xefe3c8, 0xd9c7a3, 0xc8735f, 0xf3efe6, 0xe0a94a];

function buildCotos(scene) {
  const group = new THREE.Group();
  group.name = 'Cotos';
  const colliders = [];
  const list = GEO.cotos || [];
  if (!list.length) {
    scene.add(group);
    return { group, colliders };
  }

  // Wall segments & gates, flattened from the data
  const walls = []; // { cx, cz, len, yaw, y, paint }
  const gates = []; // { x, z, ux, uz, width }
  list.forEach(([lines, gateData], id) => {
    const paint = PAINTS[id % PAINTS.length];
    for (const pl of lines) {
      for (let i = 0; i + 3 < pl.length; i += 2) {
        const ax = pl[i], az = pl[i + 1], bx = pl[i + 2], bz = pl[i + 3];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.3) continue;
        const cx = (ax + bx) / 2, cz = (az + bz) / 2;
        // (a little longer than the segment, so the corners close)
        walls.push({ cx, cz, len: len + WALL_T, yaw: Math.atan2(-(bz - az), bx - ax), y: groundHeight(cx, cz), paint });
      }
    }
    for (let i = 0; i + 3 < gateData.length; i += 4) {
      const th = gateData[i + 2] / 1000;
      gates.push({ x: gateData[i], z: gateData[i + 1], ux: Math.cos(th), uz: Math.sin(th), width: Math.max(4, gateData[i + 3]) });
    }
  });

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const obb = (cx, cz, hx, hz, yaw, minY, maxY) => {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY, maxY, obb: { cx, cz, hx, hz, cs, sn } });
  };

  // (an InstancedMesh of no instances would bind an empty buffer on WebGPU: none is made)
  if (walls.length) {
    // The bardas: rendered block in the coto's paint (instance colour), a darker plinth, a pale coping, rain streaks
    const wallMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
    {
      const y = positionGeometry.y.add(0.5).mul(WALL_H); // over the wall's foot (it stands on the ground, at any height)
      const streak = fract(positionWorld.x.mul(0.37).add(positionWorld.z.mul(0.53)));
      let c = color(0xffffff).mul(smoothstep(0.0, 1.0, streak).mul(0.06).add(0.94));
      c = mix(c, c.mul(0.7), step(y, 0.4));
      c = mix(c, color(0xffffff), step(WALL_H - 0.12, y));
      wallMat.colorNode = c;
    }
    const wallInst = new THREE.InstancedMesh(unitBox, wallMat, walls.length);
    walls.forEach((w, i) => {
      dummy.position.set(w.cx, w.y + WALL_H / 2, w.cz);
      dummy.rotation.set(0, w.yaw, 0);
      dummy.scale.set(w.len, WALL_H, WALL_T);
      dummy.updateMatrix();
      wallInst.setMatrixAt(i, dummy.matrix);
      wallInst.setColorAt(i, tint.setHex(w.paint));
      obb(w.cx, w.cz, w.len / 2, WALL_T / 2 + 0.05, w.yaw, w.y, w.y + WALL_H);
    });
    wallInst.castShadow = true;
    wallInst.receiveShadow = true;
    group.add(wallInst);
  }

  if (gates.length) {
    // The casetas: white block with a band of tinted glass all round, a flat slab roof overhanging it; lit at night
    const boothMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.7 });
    {
      const y = positionGeometry.y.add(0.5).mul(BOOTH.h);
      const glass = step(1.05, y).mul(step(y, 2.15));
      boothMat.colorNode = mix(color(0xf1eee6), color(0x24323a), glass);
      boothMat.roughnessNode = mix(float(0.75), float(0.2), glass);
      boothMat.emissiveNode = color(0xfff0d0).mul(glass).mul(smoothstep(0.35, 1.2, cityUniforms.uInteriorGlow)).mul(0.6);
    }
    const roofMat = new THREE.MeshStandardNodeMaterial({ color: 0xd8d4ca, roughness: 0.85 });
    const postMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8e4da, roughness: 0.6 });
    // the arm: red & white bands along it
    const armMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.45 });
    armMat.colorNode = mix(color(0xf4f4f0), color(0xc4161c), step(0.5, fract(positionGeometry.x.mul(7.0))));
    const armGeo = unitBox.clone().translate(0.5, 0, 0); // pivots at its post

    const boothInst = new THREE.InstancedMesh(unitBox, boothMat, gates.length);
    const roofInst = new THREE.InstancedMesh(unitBox, roofMat, gates.length);
    const postInst = new THREE.InstancedMesh(unitBox, postMat, gates.length);
    const armInst = new THREE.InstancedMesh(armGeo, armMat, gates.length);
    gates.forEach((g, i) => {
      // across the street: s, to the booth's side
      const sx = -g.uz, sz = g.ux;
      const yaw = Math.atan2(-g.uz, g.ux);
      const half = g.width / 2;
      const bx = g.x + sx * (half + 0.4 + BOOTH.w / 2), bz = g.z + sz * (half + 0.4 + BOOTH.w / 2);
      const y = groundHeight(bx, bz);
      dummy.rotation.set(0, yaw, 0);
      dummy.position.set(bx, y + BOOTH.h / 2, bz);
      dummy.scale.set(BOOTH.d, BOOTH.h, BOOTH.w);
      dummy.updateMatrix();
      boothInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(bx, y + BOOTH.h + 0.09, bz);
      dummy.scale.set(BOOTH.d + 0.8, 0.18, BOOTH.w + 0.8);
      dummy.updateMatrix();
      roofInst.setMatrixAt(i, dummy.matrix);
      obb(bx, bz, BOOTH.d / 2, BOOTH.w / 2, yaw, y, y + BOOTH.h);
      // the post at the street's edge, the arm raised 75° from it over the roadway
      const px = g.x + sx * (half + 0.15), pz = g.z + sz * (half + 0.15);
      dummy.position.set(px, y + 0.5, pz);
      dummy.scale.set(0.3, 1.0, 0.3);
      dummy.updateMatrix();
      postInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(px, y + 0.95, pz);
      dummy.rotation.set(0, Math.atan2(sz, -sx), (75 * Math.PI) / 180, 'YZX'); // local x along -s, then tilted up
      dummy.scale.set(g.width - 0.4, 0.09, 0.09);
      dummy.updateMatrix();
      armInst.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(0, 0, 0, 'XYZ');
    });
    for (const m of [boothInst, roofInst, postInst, armInst]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
  }

  scene.add(group);
  console.info(`[cotos] ${list.length} gated communities: ${walls.length} wall segments, ${gates.length} gates`);
  return { group, colliders };
}

export { buildCotos };
