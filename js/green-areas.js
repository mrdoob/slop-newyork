import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt, drape } from './terrain.js';

// js/green-areas.js
// Parks, gardens, lawns and woods as ground patches (GEO.green: [kind index into GEO.greenKinds, outer ring]), and
// trees (GEO.trees) handed to trees.js. Both follow the ground (GEO.terrain, js/terrain.js) when there is one.
// City-agnostic: everything comes in through `geo`.

// Colour (sRGB) and stacking height above the ground plane per kind; anything else draws like a park
const KINDS = {
  park: { colour: 0x8f9a80, y: 0.012 }, // Xinyi's "parks" are often paved plazas with planting: a muted green-grey
  garden: { colour: 0x6c8c4a, y: 0.018 },
  grass: { colour: 0x6a9142, y: 0.022 },
  forest: { colour: 0x4d6b35, y: 0.026 }
};

function buildGreenAreas(scene, geo) {
  const byKind = new Map();
  for (const [k, flat] of geo.green || []) {
    const kind = KINDS[geo.greenKinds[k]] ? geo.greenKinds[k] : 'park';
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push(new THREE.Vector2(flat[i], -flat[i + 1])); // shape plane (x, -z)
    if (pts.length < 3) continue;
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts));
    g.rotateX(-Math.PI / 2);
    g.deleteAttribute('uv');
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(g);
  }
  const group = new THREE.Group();
  group.name = 'green-areas';
  const ground = heightAt(geo);
  for (const [kind, parts] of byKind) {
    let g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (geo.terrain) g = drape(g, (x, z) => ground(x, z) + KINDS[kind].y, 16); // fine enough to lie on the hills
    else g.translate(0, KINDS[kind].y, 0);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color: KINDS[kind].colour, roughness: 0.95 }));
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  scene.add(group);
  return group;
}

// Tree sites for trees.js createTreeField: a tagged height sets the size, otherwise a typical street tree; species
// and size vary by position (the tree models are generic broadleaf species, not identified ones)
function treeSites(geo) {
  const ground = heightAt(geo);
  return (geo.trees || []).map(([x, z, , h]) => {
    const r = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
    return { x, z, y: ground(x, z), species: Math.floor(r * 3), scale: h ? Math.min(1.6, Math.max(0.4, h / 12)) : 0.7 + r * 0.3, tier: 0 };
  });
}

export { buildGreenAreas, treeSites };
