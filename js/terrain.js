import * as THREE from 'three/webgpu';
import { float, color, mix, smoothstep, positionWorld, normalWorld, vec2, sin, fract, dot, floor } from 'three/tsl';
import { GEO } from './city-geodata.js';
import { cityUniforms } from './tsl-materials.js';

// js/terrain.js
// The hills around the valley (city-geodata.js `terrain`, from open elevation data, see tools/build-tepic-geodata.mjs):
// a heightfield over the flat city, zero under its streets and houses and rising beyond them (Cerro de San Juan to the
// west, Cerro de la Cruz to the north with its cross, the lomas). terrainHeight(x, z) gives its height anywhere, for
// the controllers (the player can't drive up a slope) and anything set down on the hills.

const T = GEO.terrain || null;
let heights = null;
if (T) {
  const bin = atob(T.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dm = new Int16Array(bytes.buffer);
  heights = new Float32Array(dm.length);
  for (let i = 0; i < dm.length; i++) heights[i] = dm[i] / 10;
}

/** Height (m) of the hills over the flat city at world (x, z): 0 in town and beyond the data */
function terrainHeight(x, z) {
  if (!heights) return 0;
  const fx = (x - T.x0) / T.cell, fz = (z - T.z0) / T.cell;
  if (fx < 0 || fz < 0 || fx >= T.w - 1 || fz >= T.h - 1) return 0;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const k = j * T.w + i;
  return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + T.w] * (1 - tx) + heights[k + T.w + 1] * tx) * tz;
}

// value noise for the hillside colouring
const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const vnoise = (p) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), u.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x), u.y);
};

function buildTerrain(scene) {
  const group = new THREE.Group();
  group.name = 'Hills';
  if (!heights) {
    scene.add(group);
    return { group };
  }
  const { w, h, cell, x0, z0 } = T;
  const SINK = 0.08; // the flat parts sit just under the streets & meadows
  const pos = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      pos[k * 3] = x0 + i * cell;
      pos[k * 3 + 1] = heights[k] - SINK;
      pos[k * 3 + 2] = z0 + j * cell;
    }
  }
  // only the cells that rise at all
  const index = [];
  for (let j = 0; j + 1 < h; j++) {
    for (let i = 0; i + 1 < w; i++) {
      const k = j * w + i;
      if (Math.max(heights[k], heights[k + 1], heights[k + w], heights[k + w + 1]) < 0.15) continue;
      index.push(k, k + w, k + 1, k + 1, k + w, k + w + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  // The hills in the dry season: ochre & red-brown grass, green scrub & trees in patches (thicker in the gullies and up
  // on Cerro de San Juan), bare reddish earth & rock where it's steepest
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0.0 });
  const slope = normalWorld.y;
  const y = positionWorld.y;
  const p = positionWorld.xz;
  const patch = vnoise(p.mul(0.004)).mul(0.55).add(vnoise(p.mul(0.035)).mul(0.45));
  const trees = vnoise(p.mul(0.09)).mul(0.5).add(vnoise(p.mul(0.4)).mul(0.5)); // clumps of trees, a few m across
  const dry = mix(color(0x9a6a3e), color(0x7f4f33), vnoise(p.mul(0.012)));
  const straw = color(0xa8834f);
  const scrub = mix(color(0x4a6128), color(0x34491f), vnoise(p.mul(0.05)));
  const forest = color(0x2e4520);
  const earth = color(0x8a5238);
  const rock = color(0x7a6c5e);
  let c = mix(dry, straw, smoothstep(0.55, 0.85, vnoise(p.mul(0.02))).mul(0.5));
  c = mix(c, scrub, smoothstep(0.42, 0.62, trees).mul(smoothstep(0.2, 0.55, patch)).mul(0.9));
  c = mix(c, forest, smoothstep(0.62, 0.8, patch).mul(smoothstep(150.0, 400.0, y)).mul(0.9));
  c = mix(c, earth, smoothstep(0.7, 0.55, slope).mul(0.6));
  c = mix(c, rock, smoothstep(0.5, 0.38, slope));
  mat.colorNode = c.mul(vnoise(p.mul(0.25)).mul(0.14).add(0.93));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  group.add(mesh);

  // the cross on the summit of Cerro de la Cruz (lit at night)
  if (T.cross) {
    const [cx, cz] = T.cross;
    let top = 0, tx = cx, tz = cz;
    for (let a = -60; a <= 60; a += 10) for (let b = -60; b <= 60; b += 10) {
      const hh = terrainHeight(cx + a, cz + b);
      if (hh > top) { top = hh; tx = cx + a; tz = cz + b; }
    }
    // The lookout on the summit: a round stone-walled terrace with a red floor, the big white cross with the Christ
    // before it, a small white cross on either side (lit at night)
    const crossMat = new THREE.MeshStandardNodeMaterial({ color: 0xf4f1ea, roughness: 0.6 });
    crossMat.emissiveNode = color(0xfff3dc).mul(smoothstep(0.35, 1.2, cityUniforms.uInteriorGlow)).mul(1.4);
    const wallMat = new THREE.MeshStandardNodeMaterial({ color: 0x9a948a, roughness: 0.9 });
    const floorMat = new THREE.MeshStandardNodeMaterial({ color: 0xb4553f, roughness: 0.8 });
    const summit = new THREE.Group();
    const R = 9;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R + 1.2, 14, 40), wallMat);
    wall.position.y = -6.5; // from well down the slope up to the floor
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.35, R - 0.35, 0.1, 40), floorMat);
    floor.position.y = 0.55;
    const parapet = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.9, 40, 1, true), wallMat);
    parapet.position.y = 1.0;
    const crossAt = (x, z, height, arm, thick) => {
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.BoxGeometry(thick, height, thick), crossMat);
      post.position.y = height / 2;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(arm, thick, thick), crossMat);
      bar.position.y = height * 0.72;
      post.castShadow = bar.castShadow = true;
      g.add(post, bar);
      g.position.set(x, 0.6, z);
      return g;
    };
    const big = crossAt(0, -1.5, 16, 7.5, 1.0);
    // the Christ before the cross, arms open
    const christ = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.75, 4.2, 12), crossMat);
    body.position.y = 2.1;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), crossMat);
    head.position.y = 4.6;
    const arms = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.4, 0.4), crossMat);
    arms.position.y = 3.7;
    christ.add(body, head, arms);
    christ.position.set(0, 0.6 + 2.8, -0.6); // on a pedestal of the cross's base
    const pedestal = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.8, 2.6), crossMat);
    pedestal.position.set(0, 0.6 + 1.4, -0.9);
    summit.add(wall, floor, parapet, big, christ, pedestal, crossAt(-5.5, 1.5, 3.4, 1.8, 0.3), crossAt(5.5, 1.5, 3.4, 1.8, 0.3));
    for (const m of [wall, parapet, christ, pedestal]) m.castShadow = true;
    summit.position.set(tx, top, tz);
    summit.rotation.y = Math.atan2(-tx, -tz); // local +z towards the city: the Christ stands on that side of the cross
    group.add(summit);
  }
  scene.add(group);
  return { group };
}

export { buildTerrain, terrainHeight };
