import * as THREE from 'three/webgpu';
import { attribute, positionWorld, normalWorld, cameraPosition, abs, fract, step, smoothstep, mix, vec3, float, uniform } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// js/footprint-buildings.js
// Extrudes real building footprints (GEO.buildings from a tools/build-*-geodata.mjs build) into one merged mesh.
// City-agnostic: everything about the city comes in through `geo`.
//
// geo.buildings rows: [id, outer [x, z, ...], holes [[x, z, ...], ...], top m, base m, source index, kind index,
// colour | 0]; geo.heightSources names the sources ('estimate' = inferred, not measured), geo.kinds the OSM types.
//
// The facade shader draws a storey grid (one band per LEVEL_M) so heights read as floor counts. Buildings whose
// height is an estimate carry an `estimate` attribute; setShowEstimates(true) tints them so they are never mistaken
// for measured data.

const LEVEL_M = 3.2; // storey height, matches tools/geo-height.mjs
const BAY_M = 3.0; // window bay width along a facade

// Base facade colours by OSM building type
const KIND_COLOURS = {
  apartments: 0xcfc5b6, residential: 0xd6ccbd, house: 0xd9cfbf, commercial: 0x9eabb6, office: 0x8f9fae,
  retail: 0xc7bfb2, department_store: 0xbdb5a8, school: 0xd8c7a4, university: 0xd8c7a4, public: 0xc9c3b7,
  civic: 0xc9c3b7, government: 0xc2bcae, hotel: 0xa9b2b8, roof: 0x8b9095, construction: 0xa39d92, yes: 0xc4beb4
};
const DEFAULT_COLOUR = 0xc4beb4;
const NEUTRAL = new THREE.Color(0xc8c4bc);
const OSM_COLOUR_SOFTEN = 0.4; // OSM building:colour values are often pure CSS names ('red', 'navy'): keep the hue, mute it
const GLASS_FADE = [250, 900]; // m: the storey grid fades to its average tone over this distance (no moiré far away)

// Small deterministic shade variation per building (by OSM id) so neighbouring facades of one type differ
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function shapeOf(outer, holes) {
  const pts = (f) => {
    const out = [];
    for (let i = 0; i < f.length; i += 2) out.push(new THREE.Vector2(f[i], -f[i + 1])); // shape plane (x, -z)
    return out;
  };
  const shape = new THREE.Shape(pts(outer));
  for (const h of holes) shape.holes.push(new THREE.Path(pts(h)));
  return shape;
}

function buildFootprintBuildings(scene, geo) {
  const estimateIndex = geo.heightSources.indexOf('estimate');
  const parts = [];
  const colour = new THREE.Color();
  const stats = { total: 0, bySource: Object.fromEntries(geo.heightSources.map((s) => [s, 0])), maxTop: 0 };
  for (const [id, outer, holes, top, base, source, kind, osmColour] of geo.buildings) {
    const depth = top - base;
    if (!(depth > 0) || outer.length < 6) continue;
    const g = new THREE.ExtrudeGeometry(shapeOf(outer, holes), { depth, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2); // extrusion axis -> +y, shape (x, -z) -> world (x, z)
    g.translate(0, base, 0);
    g.deleteAttribute('uv');
    if (osmColour) colour.setStyle(osmColour).lerp(NEUTRAL, OSM_COLOUR_SOFTEN);
    else colour.setHex(KIND_COLOURS[geo.kinds[kind]] ?? DEFAULT_COLOUR);
    colour.offsetHSL(0, 0, (hash01(id) - 0.5) * 0.08);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colour.toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('estimate', new THREE.BufferAttribute(new Float32Array(n).fill(source === estimateIndex ? 1 : 0), 1));
    parts.push(g);
    stats.total++;
    stats.bySource[geo.heightSources[source]]++;
    stats.maxTop = Math.max(stats.maxTop, top);
  }
  const geometry = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  geometry.computeBoundingSphere();

  // Facade: storey bands of glass on walls (roofs stay plain), tinted when the height is estimated
  const showEstimates = uniform(0);
  const wall = step(abs(normalWorld.y), float(0.5));
  const along = positionWorld.x.mul(normalWorld.z.negate()).add(positionWorld.z.mul(normalWorld.x));
  const fy = fract(positionWorld.y.div(LEVEL_M));
  const fu = fract(along.div(BAY_M));
  const grid = step(0.32, fy).mul(step(fy, 0.86)).mul(step(0.14, fu)).mul(step(fu, 0.86));
  const near = float(1).sub(smoothstep(GLASS_FADE[0], GLASS_FADE[1], positionWorld.distance(cameraPosition)));
  const glass = wall.mul(mix(float(0.54 * 0.72), grid, near)); // far away: the grid's glass share
  const base = attribute('color', 'vec3');
  const estimate = attribute('estimate', 'float');
  const tinted = mix(base, vec3(1.0, 0.45, 0.15), estimate.mul(showEstimates).mul(0.75));
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = mix(tinted, tinted.mul(vec3(0.32, 0.38, 0.45)), glass.mul(0.85));
  material.roughnessNode = mix(float(0.85), float(0.18), glass);
  material.metalnessNode = mix(float(0.0), float(0.35), glass);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'footprint-buildings';
  scene.add(mesh);
  return {
    mesh,
    stats,
    setShowEstimates(on) { showEstimates.value = on ? 1 : 0; }
  };
}

export { buildFootprintBuildings };
