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

const SINK = 0.08; // the flat parts of the hills' mesh sit just under the streets & meadows

/**
 * Height (m) of the hills over the flat city at world (x, z), on the very triangles the mesh draws (each grid cell
 * split from its +x corner to its +z corner): 0 in town and beyond the data
 */
function terrainHeight(x, z) {
  if (!heights) return 0;
  const fx = (x - T.x0) / T.cell, fz = (z - T.z0) / T.cell;
  if (fx < 0 || fz < 0 || fx >= T.w - 1 || fz >= T.h - 1) return 0;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const k = j * T.w + i;
  const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + T.w], h11 = heights[k + T.w + 1];
  return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

/** The ground's height for anything standing on the hills (0 in the flat city) */
function hillGround(x, z) {
  const h = terrainHeight(x, z);
  return h > SINK ? h - SINK : 0;
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

  buildHillPaths(group);

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

// The ways up the hills (city-geodata.js terrain.paths): ribbons laid on the hillside (each edge on the ground under
// it), cobbled, paved or earth; the cobbled calzadas with a dry-stone wall on their downhill side and a lamp every 30 m
function buildHillPaths(group) {
  const paths = T.paths || [];
  const STEP = 2.5;
  const PATH_LIFT = 0.04;
  const ribbons = [[], [], []]; // positions per surface
  const walls = [];
  const lamps = [];
  for (const [surface, width, flat] of paths) {
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    // resample every STEP m
    const samples = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.01) continue;
      const n = Math.max(1, Math.ceil(L / STEP));
      for (let k = 0; k < n; k++) samples.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, (bx - ax) / L, (bz - az) / L]);
    }
    if (pts.length > 1) {
      const [ax, az] = pts[pts.length - 2], [bx, bz] = pts[pts.length - 1];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      samples.push([bx, bz, (bx - ax) / L, (bz - az) / L]);
    }
    const hw = width / 2;
    const out = ribbons[surface];
    let run = 0;
    for (let k = 0; k + 1 < samples.length; k++) {
      const a = samples[k], b = samples[k + 1];
      const ha = terrainHeight(a[0], a[1]), hb = terrainHeight(b[0], b[1]);
      run += STEP;
      if (Math.max(ha, hb) < 0.3) continue; // in town: the streets are there already
      const corner = (s, side) => {
        const x = s[0] - s[3] * side * hw, z = s[1] + s[2] * side * hw;
        return [x, terrainHeight(x, z) - SINK + PATH_LIFT, z]; // just over the hill's mesh, where walkers stand
      };
      const a0 = corner(a, -1), a1 = corner(a, 1), b0 = corner(b, -1), b1 = corner(b, 1);
      out.push(...a0, ...a1, ...b0, ...a1, ...b1, ...b0); // counter-clockwise from above
      if (surface === 0 && width >= 4) {
        // the wall on the downhill side, from the hillside below up to knee height over the path
        const below = (side) => terrainHeight(a[0] - a[3] * side * (hw + 3), a[1] + a[2] * side * (hw + 3));
        const side = below(-1) < below(1) ? -1 : 1;
        const wa = side < 0 ? a0 : a1, wb = side < 0 ? b0 : b1;
        walls.push([wa, wb]);
        if (run % 30 < STEP) lamps.push([wa[0] - a[3] * side * -0.5, wa[1], wa[2] + a[2] * side * -0.5]);
      }
    }
  }
  const surfaces = [
    // cobbles: rounded river stones in a dark joint
    (() => {
      const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
      const q = positionWorld.xz.mul(3.2);
      const cell = fract(q.add(vec2(0.0, floor(q.x).mul(0.5))));
      const stone = smoothstep(0.08, 0.2, cell.x).mul(smoothstep(0.92, 0.8, cell.x)).mul(smoothstep(0.08, 0.2, cell.y)).mul(smoothstep(0.92, 0.8, cell.y));
      const tone = vnoise(floor(q).mul(1.7));
      mat.colorNode = mix(color(0x4e4840), mix(color(0x8b8173), color(0xa89c8a), tone), stone);
      return mat;
    })(),
    new THREE.MeshStandardNodeMaterial({ color: 0xb3ada2, roughness: 0.85 }),
    new THREE.MeshStandardNodeMaterial({ color: 0x8a6448, roughness: 0.97 })
  ];
  for (const mat of surfaces) {
    // (drawn over the hillside a few centimetres under them without fighting it)
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -2;
  }
  ribbons.forEach((list, k) => {
    if (!list.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, surfaces[k]);
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  if (walls.length) {
    // a dry-stone wall 0.45 m thick: its outer face reaching 1.2 m down the slope, 0.8 m over the path
    const pos = [];
    for (const [a, b] of walls) {
      const top = 0.8, bot = -1.2;
      const quad = (p0, p1, y0, y1) => {
        pos.push(p0[0], p0[1] + y0, p0[2], p1[0], p1[1] + y0, p1[2], p0[0], p0[1] + y1, p0[2]);
        pos.push(p0[0], p0[1] + y1, p0[2], p1[0], p1[1] + y0, p1[2], p1[0], p1[1] + y1, p1[2]);
      };
      quad(a, b, bot, top);
      quad(b, a, bot, top);
      // coping
      pos.push(a[0], a[1] + top, a[2], b[0], b[1] + top, b[2], a[0], a[1] + top + 0.08, a[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, side: THREE.DoubleSide });
    const q = vec2(positionWorld.x.add(positionWorld.z), positionWorld.y).mul(vec2(2.2, 3.4));
    const c = fract(q.add(vec2(floor(q.y).mul(0.5), 0.0)));
    const stone = smoothstep(0.05, 0.14, c.x).mul(smoothstep(0.95, 0.86, c.x)).mul(smoothstep(0.06, 0.16, c.y)).mul(smoothstep(0.94, 0.84, c.y));
    mat.colorNode = mix(color(0x4a453d), mix(color(0x857b6c), color(0xa39784), vnoise(floor(q).mul(1.3))), stone);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (lamps.length) {
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.1, 4.2, 8).translate(0, 2.1, 0);
    const globeGeo = new THREE.SphereGeometry(0.22, 10, 8).translate(0, 4.35, 0);
    const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x1f2124, roughness: 0.5, metalness: 0.5 });
    const globeMat = new THREE.MeshBasicNodeMaterial();
    globeMat.colorNode = mix(color(0xd8d6cc), color(0xffe2a8).mul(1.9), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
    const globes = new THREE.InstancedMesh(globeGeo, globeMat, lamps.length);
    const m = new THREE.Matrix4();
    lamps.forEach(([x, y, z], i) => {
      m.makeTranslation(x, y - PATH_LIFT, z);
      poles.setMatrixAt(i, m);
      globes.setMatrixAt(i, m);
    });
    poles.castShadow = true;
    group.add(poles, globes);
  }
}

export { buildTerrain, terrainHeight, hillGround };
