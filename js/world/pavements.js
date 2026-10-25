import * as THREE from 'three/webgpu';
import { PAVEMENTS } from './pavement-data.js';
import { createPavementMaterial } from '../render/tsl-materials.js';
import { drapeGeometry } from './drape.js';

// js/world/pavements.js
// The streets of Tepic that are not asphalt (pavement-data.js, from OpenStreetMap's surface tags and the colonias known
// to be cobbled): the empedrado of river stones, the adoquín, the earth streets and the poured concrete, laid curb to
// curb over the roadway as a strip per segment of the street's centreline, each run on half its width past its ends so
// the bends close (the pattern is in world space: overlapping strips match). Laid on the town's slopes like the road
// paint, a few millimetres over the asphalt and under the paint; the raised sidewalks hide the strips' edges.

const LIFT = 0.005; // over the asphalt (the paint is at 0.012)

function buildPavements(scene) {
  const position = [];
  const pave = [];
  const index = [];
  for (const [kind, width, pts] of PAVEMENTS) {
    const h = width * 0.5;
    // (each kind a hair apart: where two kinds meet they don't fight)
    const y = LIFT + kind * 0.0007;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.1) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const x0 = ax - ux * h, z0 = az - uz * h, x1 = bx + ux * h, z1 = bz + uz * h;
      const sx = -uz * h, sz = ux * h;
      const v = position.length / 3;
      position.push(x0 - sx, y, z0 - sz, x0 + sx, y, z0 + sz, x1 + sx, y, z1 + sz, x1 - sx, y, z1 - sz);
      pave.push(kind, kind, kind, kind);
      // counter-clockwise seen from above
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
  }
  if (!index.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(position.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geometry.setAttribute('pave', new THREE.Float32BufferAttribute(pave, 1));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(drapeGeometry(geometry), createPavementMaterial());
  mesh.name = 'Pavements';
  mesh.receiveShadow = true;
  scene.add(mesh);
  console.info(`[pavements] ${PAVEMENTS.length} streets of empedrado, adoquín, tierra & concreto`);
  return mesh;
}

export { buildPavements };
