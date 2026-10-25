import * as THREE from 'three/webgpu';
import { waterways } from './ground.js';
import { cutHoles } from './waterways.js';
import { drapeGeometry } from './drape.js';
import { createRiverBankMaterial, createRiverWaterMaterial, createCurbMaterial } from '../render/tsl-materials.js';

// js/world/river-channels.js
// Draws the river channels of waterways.js (the Río Mololoa, its old bed, the arroyos): their stone banks & silty bed,
// the water in them and the bridges' decks seen from below, laid on the town's slopes (drape.js), and opens the road
// deck over them (cutRiverHoles), so the channels are seen sunk into the ground instead of under the asphalt.

// A BufferGeometry from waterways.js meshData() triangles (heights over the town's floor), laid on the floor
function draped(data) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
  if (data.wet) geo.setAttribute('wet', new THREE.BufferAttribute(data.wet, 1));
  const out = drapeGeometry(geo);
  if (out !== geo) geo.dispose();
  out.computeVertexNormals(); // (flat: every triangle its own)
  out.computeBoundingSphere();
  return out;
}

function buildRiverChannels(scene) {
  const group = new THREE.Group();
  group.name = 'Rivers';
  let waterMesh = null;
  if (waterways) {
    const { banks, water, bridges } = waterways.meshData();
    const add = (data, material, shadows) => {
      if (!data.position.length) return null;
      const mesh = new THREE.Mesh(draped(data), material);
      mesh.receiveShadow = true;
      mesh.castShadow = shadows;
      group.add(mesh);
      return mesh;
    };
    add(banks, createRiverBankMaterial(), false);
    waterMesh = add(water, createRiverWaterMaterial(), false); // (it rises with a flood, floods.js)
    const slab = createCurbMaterial();
    slab.side = THREE.DoubleSide;
    add(bridges, slab, true);
  }
  scene.add(group);
  return { group, water: waterMesh };
}

/** The road deck's geometry (non-indexed or indexed, as city-grid.js leaves it) with the channels' holes taken out */
function cutRiverHoles(geometry) {
  if (!waterways) return geometry;
  const names = Object.keys(geometry.attributes).sort((a, b) => (a === 'position' ? -1 : b === 'position' ? 1 : 0));
  const attrs = names.map((n) => geometry.attributes[n]);
  const out = cutHoles(attrs.map((a) => a.array), attrs.map((a) => a.itemSize), geometry.index ? geometry.index.array : null, waterways.holes());
  const cut = new THREE.BufferGeometry();
  names.forEach((n, k) => cut.setAttribute(n, new THREE.BufferAttribute(out[k], attrs[k].itemSize, attrs[k].normalized)));
  cut.computeBoundingBox();
  cut.computeBoundingSphere();
  geometry.dispose();
  return cut;
}

export { buildRiverChannels, cutRiverHoles };
