import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, uniform, vec3, float, uv, smoothstep, length } from 'three/tsl';

// js/street-furniture.js
// Street furniture (GEO.furniture: [kind index into GEO.furnitureKinds, x, z, yaw, source, extra]) as low-poly
// instanced models, one InstancedMesh per kind; each model's front (+z) faces the road (yaw). The bikes at bike-share
// stations and racks come as items of their own (kinds bike_share, bike). City-agnostic: colours that belong to a city (bike-share livery, post
// boxes) come in through `options`.

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, n = 10) => new THREE.CylinderGeometry(rt, rb, h, n);

// A model: parts [geometry, colour, [x, y, z], [rx, ry, rz]?, glow?] merged into one geometry with vertex colours; parts
// with glow light up at night (lamp heads, kiosk screens, vending machines)
function model(parts) {
  const c = new THREE.Color();
  const geos = parts.map(([g, hex, [x, y, z], r, glow = 0]) => {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.deleteAttribute('uv');
    if (r) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...r)));
    geo.translate(x, y, z);
    c.setHex(hex);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    return geo;
  });
  return mergeGeometries(geos, false);
}

const METAL = 0x4b5056, STEEL = 0x8d9399, GLASS = 0x9fb6c4, DARK = 0x24272b, WHITE = 0xe9e9e4;
function models(o) {
  const wheel = (z) => [cyl(0.33, 0.33, 0.04, 14), DARK, [0, 0.34, z], [0, 0, Math.PI / 2]];
  const bike = (frame) => model([
    wheel(0.52), wheel(-0.52),
    [box(0.05, 0.05, 1.0), frame, [0, 0.62, 0], [0.25, 0, 0]], [box(0.05, 0.5, 0.05), frame, [0, 0.55, -0.18]],
    [box(0.18, 0.05, 0.25), DARK, [0, 0.86, -0.2]], [box(0.55, 0.04, 0.04), DARK, [0, 0.98, 0.42]], [box(0.3, 0.22, 0.25), frame, [0, 0.82, 0.56]]
  ]);
  return {
    street_lamp: model([[cyl(0.07, 0.11, 9), METAL, [0, 4.5, 0]], [box(0.08, 0.08, 1.7), METAL, [0, 8.95, 0.8]], [box(0.34, 0.12, 0.62), WHITE, [0, 8.86, 1.55], null, 1]]),
    bus_stop: model([[cyl(0.04, 0.04, 2.6), STEEL, [0, 1.3, 0]], [box(0.55, 0.75, 0.04), o.busSignColour, [0, 2.3, 0]]]),
    bus_shelter: model([
      [box(3.6, 0.1, 1.6), STEEL, [0, 2.6, -0.1]], [box(3.4, 1.9, 0.04), GLASS, [0, 1.45, -0.8]],
      [cyl(0.05, 0.05, 2.6), STEEL, [-1.7, 1.3, -0.8]], [cyl(0.05, 0.05, 2.6), STEEL, [1.7, 1.3, -0.8]],
      [box(2.2, 0.06, 0.4), STEEL, [0, 0.46, -0.5]], [cyl(0.04, 0.04, 2.6), STEEL, [2.2, 1.3, 0.5]], [box(0.55, 0.75, 0.04), o.busSignColour, [2.2, 2.3, 0.5]]
    ]),
    subway_entrance: model([
      [box(4.2, 0.25, 6.2), STEEL, [0, 3.1, 0]], [box(4.0, 2.9, 0.15), GLASS, [0, 1.5, -3]],
      [box(0.15, 2.9, 6), GLASS, [-2, 1.5, 0]], [box(0.15, 2.9, 6), GLASS, [2, 1.5, 0]],
      [box(0.4, 3.4, 0.4), METAL, [2.6, 1.7, 3.1]], [box(0.9, 0.7, 0.25), o.metroSignColour, [2.6, 3.6, 3.1]]
    ]),
    bicycle_rental: model([[box(0.55, 1.45, 0.4), o.bikeShareColour, [0, 0.72, 0]], [box(0.45, 0.35, 0.05), 0x6fa8d8, [0, 1.15, 0.21], null, 0.6]]),
    bike_share: bike(o.bikeShareColour),
    bike: bike(0x3b3f45),
    fire_hydrant: model([[cyl(0.12, 0.14, 0.62), o.hydrantColour, [0, 0.31, 0]], [cyl(0.15, 0.12, 0.08), o.hydrantColour, [0, 0.66, 0]],
      [cyl(0.05, 0.05, 0.36), o.hydrantColour, [0, 0.42, 0], [0, 0, Math.PI / 2]]]),
    flagpole: model([[cyl(0.04, 0.07, 10), STEEL, [0, 5, 0]], [new THREE.SphereGeometry(0.1, 8, 6), STEEL, [0, 10.05, 0]]]),
    drinking_water: model([[box(0.32, 0.95, 0.32), STEEL, [0, 0.47, 0]], [box(0.4, 0.06, 0.4), STEEL, [0, 0.97, 0]]]),
    post_box: model([[box(0.45, 1.1, 0.45), o.postBoxColours[0], [-0.26, 0.55, 0]], [box(0.45, 1.1, 0.45), o.postBoxColours[1] ?? o.postBoxColours[0], [0.26, 0.55, 0]]]),
    waste_basket: model([[cyl(0.24, 0.22, 0.8, 12), 0x2f4a3a, [0, 0.4, 0]]]),
    telephone: model([[box(0.8, 2.2, 0.8), 0x5a7d9a, [0, 1.1, 0]], [box(0.7, 1.6, 0.04), GLASS, [0, 1.1, 0.41]]]),
    vending_machine: model([[box(1.0, 1.8, 0.75), 0xc23b2f, [0, 0.9, 0]], [box(0.8, 1.0, 0.04), 0xf2f4f0, [0, 1.15, 0.38], null, 0.8]]),
    bicycle_parking: model([[box(2.4, 0.05, 0.05), STEEL, [0, 0.75, 0]], [cyl(0.03, 0.03, 0.75), STEEL, [-1.2, 0.37, 0]], [cyl(0.03, 0.03, 0.75), STEEL, [1.2, 0.37, 0]]]),
    scooter: model([
      [cyl(0.24, 0.24, 0.1, 12), DARK, [0, 0.24, 0.62], [0, 0, Math.PI / 2]], [cyl(0.24, 0.24, 0.1, 12), DARK, [0, 0.24, -0.62], [0, 0, Math.PI / 2]],
      [box(0.36, 0.42, 1.25), WHITE, [0, 0.5, -0.05]], [box(0.3, 0.12, 0.62), DARK, [0, 0.77, -0.25]],
      [box(0.36, 0.75, 0.12), WHITE, [0, 0.72, 0.55], [-0.25, 0, 0]], [box(0.62, 0.05, 0.05), DARK, [0, 1.12, 0.6]]
    ])
  };
}

const SCOOTER_PAINT = [0xe9e9e4, 0xe9e9e4, 0x2b2e33, 0x8d9399, 0xb5312a, 0x3c6e9e, 0x7d8a63, 0xd9c7a0];

function buildStreetFurniture(scene, geo, options = {}) {
  const o = {
    busSignColour: 0x1f5fa8, metroSignColour: 0x1d3c78, bikeShareColour: 0xf0b400, hydrantColour: 0xc8261e,
    postBoxColours: [0xc8261e], ...options
  };
  const kinds = geo.furnitureKinds || [];
  const geos = models(o);
  // Instances per model: [x, z, yaw, colour | null]
  const placed = new Map();
  const put = (name, x, z, yaw, colour = null) => {
    if (!geos[name]) return;
    if (!placed.has(name)) placed.set(name, []);
    placed.get(name).push([x, z, yaw, colour]);
  };
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [k, x, z, yaw] of geo.furniture || []) {
    const kind = kinds[k];
    if (kind === 'scooter') {
      put('scooter', x, z, yaw + (rand() - 0.5) * 0.15, SCOOTER_PAINT[Math.floor(rand() * SCOOTER_PAINT.length)]);
    } else {
      put(kind, x, z, yaw);
    }
  }
  const group = new THREE.Group();
  group.name = 'street-furniture';
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
  const night = uniform(0); // 0 day .. 1 night (setNight)
  material.emissiveNode = attribute('color', 'vec3').mul(attribute('glow', 'float')).mul(night).mul(2.2);
  const dummy = new THREE.Object3D();
  const colour = new THREE.Color();
  const SMALL = new Set(['fire_hydrant', 'waste_basket', 'drinking_water', 'bike', 'bike_share', 'scooter']);
  for (const [name, items] of placed) {
    const mesh = new THREE.InstancedMesh(geos[name], material, items.length);
    const tinted = items.some((it) => it[3] !== null);
    items.forEach(([x, z, yaw, c], i) => {
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (tinted) mesh.setColorAt(i, colour.setHex(c ?? 0xffffff));
    });
    mesh.name = `furniture-${name}`;
    mesh.castShadow = !SMALL.has(name);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  // Pools of lamplight on the ground under each lamp head, shown at night (additive, no lighting cost)
  const lamps = placed.get('street_lamp') || [];
  let pools = null;
  if (lamps.length) {
    const poolMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = length(uv().sub(0.5)).mul(2);
    poolMat.colorNode = vec3(1.0, 0.82, 0.55);
    poolMat.opacityNode = float(1).sub(smoothstep(0.0, 1.0, r)).pow(1.6).mul(0.32).mul(night);
    pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), poolMat, lamps.length);
    lamps.forEach(([x, z, yaw], i) => {
      dummy.position.set(x + Math.sin(yaw) * 1.55, 0.2, z + Math.cos(yaw) * 1.55); // under the head, 1.55 m towards the road
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      pools.setMatrixAt(i, dummy.matrix);
    });
    pools.name = 'furniture-lamplight';
    pools.renderOrder = 1;
    pools.visible = false;
    group.add(pools);
  }
  scene.add(group);
  return {
    group,
    counts: Object.fromEntries([...placed].map(([k, v]) => [k, v.length])),
    setNight(f) { night.value = f; if (pools) pools.visible = f > 0.01; }
  };
}

export { buildStreetFurniture };
