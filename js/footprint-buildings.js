import * as THREE from 'three/webgpu';
import { attribute, positionWorld, normalWorld, cameraPosition, abs, fract, floor, sin, step, smoothstep, mix, max, min, vec3, float, uniform } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt } from './terrain.js';

// js/footprint-buildings.js
// Extrudes real building footprints (GEO.buildings from a tools/build-*-geodata.mjs build) into one merged mesh.
// City-agnostic: everything about the city comes in through `geo`.
//
// geo.buildings rows: [id, outer [x, z, ...], holes [[x, z, ...], ...], top m, base m, source index, kind index,
// wall colour | 0, roof shape index, roof height m, roof colour | 0, facade index, top scale]; geo.heightSources names the sources
// ('estimate' = inferred, not measured), geo.kinds the OSM types, geo.roofShapes & geo.facades the styles.
//
// Walls rise to the roof's eaves; pitched roofs (pyramidal, hipped) and domes sit on top, flat roofs are the walls' cap
// (in the roof colour where OSM gives one). The facade shader draws one style per building (punched windows with
// balcony slabs, glass curtain wall, podium window bands, plain walls) in storeys of LEVEL_M, and shopfronts on the
// ground floor. Buildings whose height is an estimate carry an `estimate` attribute; setShowEstimates(true) tints them
// so they are never mistaken for measured data.
// On terrain (GEO.terrain, js/terrain.js) each building stands at the lowest ground under its outline (its uphill side
// sinks into the slope rather than its downhill side floating); storeys & shopfronts count from there (`ground` attribute).
// geo.infill (optional, same row shape): stand-in buildings whose footprint is inferred too, not mapped. They form a
// separate mesh (infillMesh, setShowInfill), built the first time they show (geo.infillShown false: not at load), and
// tint violet where estimates tint orange.

const LEVEL_M = 3.2; // storey height, matches tools/geo-height.mjs
const GROUND_FLOOR_M = 4.2; // shopfront storey
const GLASS_FADE = [250, 900]; // m: window patterns fade to their average tone over this distance (no moiré far away)
const CURTAIN_FADE = [90, 260]; // ...sooner for the fine 1.5 m curtain-wall mullions
const HIP_TOP = 0.3; // hipped roofs: the ridge ring is the footprint shrunk to this share about its centroid

// Base facade colours by OSM building type
const KIND_COLOURS = {
  apartments: 0xcfc5b6, residential: 0xd6ccbd, house: 0xd9cfbf, commercial: 0x9eabb6, office: 0x8f9fae,
  retail: 0xc7bfb2, department_store: 0xbdb5a8, school: 0xd8c7a4, university: 0xd8c7a4, public: 0xc9c3b7,
  civic: 0xc9c3b7, government: 0xc2bcae, hotel: 0xa9b2b8, roof: 0x8b9095, construction: 0xa39d92, yes: 0xc4beb4
};
const DEFAULT_COLOUR = 0xc4beb4;
const ROOF_COLOUR = 0x8e9093; // concrete roof deck where OSM gives no roof colour
const NEUTRAL = new THREE.Color(0xc8c4bc);
const OSM_COLOUR_SOFTEN = 0.4; // OSM colour values are often pure CSS names ('red', 'navy'): keep the hue, mute it

// Small deterministic shade variation per building (by OSM id) so neighbouring facades of one type differ
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const ringPts = (f) => {
  const out = [];
  for (let i = 0; i < f.length; i += 2) out.push([f[i], f[i + 1]]);
  return out;
};
function shapeOf(outer, holes) {
  const v2 = (f) => ringPts(f).map(([x, z]) => new THREE.Vector2(x, -z)); // shape plane (x, -z)
  const shape = new THREE.Shape(v2(outer));
  for (const h of holes) shape.holes.push(new THREE.Path(v2(h)));
  return shape;
}
function centroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cz += (pts[j][1] + pts[i][1]) * f;
  }
  return Math.abs(a) < 1e-9 ? [pts[0][0], pts[0][1], 0] : [cx / (3 * a), cz / (3 * a), Math.abs(a / 2)];
}

// Pitched roof from the eaves (y0) to the top (y1): pyramidal (apex) or hipped (shrunken ridge ring with a flat cap)
function pitchedRoof(pts, y0, y1, shape) {
  const [cx, cz] = centroid(pts);
  const pos = [];
  const tri = (a, b, c) => {
    // keep every face looking up (outwards)
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]); // y of (b - a) × (c - a)
    if (ny >= 0) pos.push(...a, ...b, ...c);
    else pos.push(...a, ...c, ...b);
  };
  const k = shape === 'pyramidal' ? 0 : HIP_TOP;
  const inner = pts.map(([x, z]) => [cx + (x - cx) * k, y1, cz + (z - cz) * k]);
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const a = [pts[i][0], y0, pts[i][1]], b = [pts[j][0], y0, pts[j][1]];
    if (k === 0) tri(a, b, [cx, y1, cz]);
    else { tri(a, b, inner[j]); tri(a, inner[j], inner[i]); }
  }
  if (k > 0) {
    const faces = THREE.ShapeUtils.triangulateShape(inner.map(([x, , z]) => new THREE.Vector2(x, z)), []);
    for (const [a, b, c] of faces) tri(inner[a], inner[b], inner[c]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
function domeRoof(pts, area, y0, y1) {
  const [cx, cz] = centroid(pts);
  const r = Math.sqrt(area / Math.PI);
  const g = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  g.deleteAttribute('uv');
  g.scale(r, Math.max(0.5, y1 - y0), r);
  g.translate(cx, y0, cz);
  return g;
}

function buildFootprintBuildings(scene, geo) {
  const estimateIndex = geo.heightSources.indexOf('estimate');
  const roofShapes = geo.roofShapes || ['flat'];
  const facades = geo.facades || ['punched'];
  const NONE = Math.max(0, facades.indexOf('none'));
  let parts = []; // the pieces of the rows being built (geometryOf)
  const wallColour = new THREE.Color();
  const roofColour = new THREE.Color();
  const stats = { total: 0, bySource: Object.fromEntries(geo.heightSources.map((s) => [s, 0])), maxTop: 0, infill: 0 };
  const counted = new Set(); // OSM buildings, not the pieces a landmark shape splits one into (id_base, id_m1, ...)
  // est: 0 mapped / tagged height, 1 estimated height, 2 stand-in (footprint & height inferred: geo.infill)
  const ground = heightAt(geo);
  let groundY = 0; // the building being painted's ground height
  const paint = (g, wall, roof, capVertices, est, facade, base) => {
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) (i < capVertices ? roof : wall).toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('estimate', new THREE.BufferAttribute(new Float32Array(n).fill(est), 1));
    g.setAttribute('facade', new THREE.BufferAttribute(new Float32Array(n).fill(facade), 1));
    g.setAttribute('base', new THREE.BufferAttribute(new Float32Array(n).fill(base), 1));
    g.setAttribute('ground', new THREE.BufferAttribute(new Float32Array(n).fill(groundY), 1));
    if (groundY) g.translate(0, groundY, 0);
    parts.push(g);
  };
  const drawable = ([, outer, , top, base]) => top - base > 0 && outer.length >= 6;
  // One merged geometry for a list of rows (the mapped buildings, or the stand-ins)
  const geometryOf = (rows, isInfill) => {
    parts = [];
    for (const [id, outer, holes, top, base, source, kind, osmColour, roofIdx = 0, roofH = 0, osmRoofColour = 0, facadeIdx = 0, topScale = 1] of rows) {
      if (!drawable([id, outer, holes, top, base])) continue;
      groundY = Infinity;
      for (let i = 0; i < outer.length; i += 2) groundY = Math.min(groundY, ground(outer[i], outer[i + 1]));
      const shape = roofShapes[roofIdx] || 'flat';
      const eaves = shape === 'flat' ? top : Math.max(base + 0.5, top - roofH);
      let g;
      try {
        g = new THREE.ExtrudeGeometry(shapeOf(outer, holes), { depth: eaves - base, bevelEnabled: false, curveSegments: 1 });
      } catch {
        // a footprint whose holes can't be triangulated (degenerate or crossing rings): drawn solid instead
        g = new THREE.ExtrudeGeometry(shapeOf(outer, []), { depth: eaves - base, bevelEnabled: false, curveSegments: 1 });
      }
      g.rotateX(-Math.PI / 2); // extrusion axis -> +y, shape (x, -z) -> world (x, z)
      g.translate(0, base, 0);
      g.deleteAttribute('uv');
      if (topScale !== 1) {
        // tapered / flared walls: the footprint scales about its centroid from 1 at the base to topScale at the eaves
        const [cx, cz] = centroid(ringPts(outer));
        const p = g.attributes.position;
        for (let v = 0; v < p.count; v++) {
          const k = 1 + (topScale - 1) * ((p.getY(v) - base) / (eaves - base));
          p.setX(v, cx + (p.getX(v) - cx) * k);
          p.setZ(v, cz + (p.getZ(v) - cz) * k);
        }
        g.computeVertexNormals();
      }
      if (osmColour) wallColour.setStyle(osmColour).lerp(NEUTRAL, OSM_COLOUR_SOFTEN);
      else wallColour.setHex(KIND_COLOURS[geo.kinds[kind]] ?? DEFAULT_COLOUR);
      wallColour.offsetHSL(0, 0, (hash01(id) - 0.5) * 0.08);
      if (osmRoofColour) roofColour.setStyle(osmRoofColour).lerp(NEUTRAL, OSM_COLOUR_SOFTEN * 0.5);
      else roofColour.setHex(ROOF_COLOUR).lerp(wallColour, 0.25);
      const est = isInfill ? 2 : source === estimateIndex ? 1 : 0;
      // ExtrudeGeometry lists its caps first (group 0), then the walls
      paint(g, wallColour, roofColour, g.groups.length ? g.groups[0].count : 0, est, facadeIdx, base);
      if (shape !== 'flat') {
        const pts = ringPts(outer);
        const area = centroid(pts)[2];
        const roof = shape === 'dome' || shape === 'onion' ? domeRoof(pts, area, eaves, top) : pitchedRoof(pts, eaves, top, shape);
        paint(roof, roofColour, roofColour, 0, est, NONE, base);
      }
      const osmId = id.split('_')[0];
      if (!isInfill && !counted.has(osmId)) {
        counted.add(osmId);
        stats.total++;
        stats.bySource[geo.heightSources[source]]++;
      }
      stats.maxTop = Math.max(stats.maxTop, top);
    }
    if (!parts.length) return null;
    const merged = mergeGeometries(parts, false);
    merged.computeBoundingSphere();
    for (const g of parts) g.dispose();
    // Drop the per-building pieces: closures made below share this scope with `paint`, which holds `parts`, so without this
    // every pre-merge geometry (and its THREE.Shape) would stay in memory for the page's life
    parts = [];
    return merged;
  };
  const geometry = geometryOf(geo.buildings, false);
  stats.infill = (geo.infill || []).filter(drawable).length;

  // --- Facade shader ------------------------------------------------------------------------------------------------
  const showEstimates = uniform(0);
  const night = uniform(0); // 0 day .. 1 night: lit windows, shopfronts & signs (setNight)
  const f = attribute('facade', 'float');
  const bBase = attribute('base', 'float');
  const is = (name) => {
    const i = facades.indexOf(name);
    return i < 0 ? float(0) : float(1).sub(step(0.5, abs(f.sub(i))));
  };
  const punched = is('punched'), curtain = is('curtain'), podium = is('podium'), plain = is('plain'), none = is('none');
  const wall = step(abs(normalWorld.y), float(0.5)).mul(float(1).sub(none));
  const y = positionWorld.y.sub(attribute('ground', 'float')); // height above the building's own ground
  const along = positionWorld.x.mul(normalWorld.z.negate()).add(positionWorld.z.mul(normalWorld.x));
  const fy = fract(y.div(LEVEL_M));
  const band = (v, lo, hi) => step(lo, v).mul(step(v, hi));
  // Punched windows (3.2 m bays) with a balcony slab / floor band under each storey
  const pu = fract(along.div(3.2));
  const punchedWin = band(fy, 0.36, 0.82).mul(band(pu, 0.2, 0.8));
  const slab = step(fy, 0.07);
  // Curtain wall: glass between 1.5 m mullions and floor spandrels
  const cu = fract(along.div(1.5));
  const frame = max(max(step(cu, 0.045), step(0.955, cu)), step(fy, 0.1));
  // Podium: long window bands; plain: a few small high windows
  const podiumWin = band(fy, 0.28, 0.9).mul(band(fract(along.div(6.0)), 0.04, 0.96));
  const plainWin = band(fy, 0.58, 0.76).mul(band(fract(along.div(8.0)), 0.42, 0.58));
  const pattern = punched.mul(punchedWin).add(curtain.mul(float(1).sub(frame))).add(podium.mul(podiumWin)).add(plain.mul(plainWin));
  const patternAvg = punched.mul(0.27).add(curtain.mul(0.82)).add(podium.mul(0.57)).add(plain.mul(0.03));
  // Ground floor: shopfronts under a sign band (buildings standing on the ground, not plain sheds)
  const groundFloor = step(bBase, 1.0).mul(step(y, GROUND_FLOOR_M)).mul(float(1).sub(plain)).mul(float(1).sub(none));
  const gu = fract(along.div(4.5));
  const shop = band(y, 0.35, 3.45).mul(band(gu, 0.07, 0.93));
  const sign = band(y, 3.55, 4.1);
  const dist = positionWorld.distance(cameraPosition);
  const near = mix(float(1).sub(smoothstep(GLASS_FADE[0], GLASS_FADE[1], dist)), float(1).sub(smoothstep(CURTAIN_FADE[0], CURTAIN_FADE[1], dist)), curtain);
  const glass = wall.mul(mix(mix(patternAvg, pattern, near), shop, groundFloor));

  const baseCol = attribute('color', 'vec3');
  const estimate = attribute('estimate', 'float');
  // Highlight: estimated heights orange, stand-ins (inferred footprints) violet
  const tintCol = mix(vec3(1.0, 0.45, 0.15), vec3(0.55, 0.35, 0.95), step(1.5, estimate));
  const tinted = mix(baseCol, tintCol, min(estimate, 1).mul(showEstimates).mul(0.75));
  // Wall: floor slabs show as darker bands on punched facades; curtain-wall frames take the building colour
  const wallCol = mix(tinted, tinted.mul(0.72), punched.mul(slab).mul(wall).mul(near).mul(float(1).sub(groundFloor)));
  // Glass: dark tinted panes; curtain walls a deeper blue-green (they mirror the sky through the environment map);
  // lit shop interiors on the ground floor
  const paneCol = mix(tinted.mul(vec3(0.3, 0.35, 0.4)), vec3(0.24, 0.32, 0.38), curtain);
  const shopCol = vec3(0.42, 0.36, 0.27);
  const glassCol = mix(paneCol, shopCol, groundFloor);
  // Sign band: a colour per shop bay
  const h = fract(sin(floor(along.div(4.5)).mul(12.9898).add(bBase.mul(3.1))).mul(43758.5453));
  const signCol = mix(mix(vec3(0.75, 0.12, 0.1), vec3(0.95, 0.85, 0.75), step(0.45, h)), vec3(0.12, 0.3, 0.62), step(0.8, h));
  const isSign = sign.mul(groundFloor).mul(wall);
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = mix(mix(wallCol, glassCol, glass), signCol, isSign);
  material.roughnessNode = mix(float(0.86), mix(float(0.22), float(0.06), curtain), glass);
  material.metalnessNode = mix(float(0.0), mix(float(0.3), float(0.6), curtain.mul(float(1).sub(groundFloor))), glass);
  // Night: about half the windows lit (per window bay & storey, warm or cool white), every shopfront lit, signs glowing;
  // far away, where windows blend into the wall, the average
  const bay = floor(along.div(mix(float(3.2), float(3.0), curtain)));
  const storey = floor(y.div(LEVEL_M));
  const lit = fract(sin(bay.mul(91.17).add(storey.mul(47.3)).add(bBase.mul(13.7))).mul(24634.6345));
  // each building its own share of lit windows (5–65%), keyed on its colour (every building's differs slightly)
  const share = fract(sin(baseCol.dot(vec3(127.1, 311.7, 74.7))).mul(43758.5453)).mul(0.6).add(0.05);
  const on = mix(share.mul(0.6), step(lit, share), near);
  const roomCol = mix(vec3(1.0, 0.74, 0.45), vec3(0.8, 0.9, 1.0), step(0.75, fract(lit.mul(7.3))));
  const windowsGlow = roomCol.mul(on).mul(glass).mul(float(1).sub(groundFloor)).mul(0.55);
  // shops: about a quarter shuttered for the night, the rest lit at varying brightness
  const shopLit = fract(sin(floor(along.div(4.5)).mul(53.7).add(bBase.mul(7.1)).add(share.mul(91.3))).mul(17453.13));
  const shopGlow = vec3(1.0, 0.84, 0.6).mul(glass).mul(groundFloor).mul(step(0.25, shopLit)).mul(shopLit.mul(0.45).add(0.15));
  material.emissiveNode = windowsGlow.add(shopGlow).add(signCol.mul(isSign).mul(1.2)).mul(night);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'footprint-buildings';
  scene.add(mesh);
  // Stand-ins: their own mesh, built the first time they show (an area may start with them hidden: no memory spent then)
  let infillMesh = null;
  const showInfill = (on) => {
    if (on && !infillMesh && stats.infill) {
      infillMesh = new THREE.Mesh(geometryOf(geo.infill, true), material);
      infillMesh.castShadow = true;
      infillMesh.receiveShadow = true;
      infillMesh.name = 'footprint-buildings-infill';
      scene.add(infillMesh);
    }
    if (infillMesh) infillMesh.visible = on;
  };
  showInfill(geo.infillShown ?? true);
  return {
    mesh,
    get infillMesh() { return infillMesh; },
    stats,
    setShowEstimates(on) { showEstimates.value = on ? 1 : 0; },
    setShowInfill: showInfill,
    setNight(f) { night.value = f; }
  };
}

export { buildFootprintBuildings };
