import * as THREE from 'three/webgpu';
import { FloodLevel, floodTerrain, floodDepth, riverStage, riverSpill, floodSpotAt, spotWater, canalSpill } from './flood-model.js';
import { createFloodWaterMaterial } from '../render/tsl-materials.js';
import { landHeight, waterways } from './ground.js';
import { GEO } from './city-geodata.js';

// js/world/floods.js
// The floods of the Live weather's storms (flood-model.js) round the camera: a sheet of muddy water over the streets
// as deep as the model has it on a grid of the ground (the hollows, the low ground, the places that flood every year
// where the drains choke, the canals & drains spilling over), the Mololoa risen in its channel (and over its banks),
// and the depth under the player's feet or wheels for the controllers (wading, a car's drag, an engine drowned).
// ?flood=<0..1> floods the city to preview it.

const N = 150; // cells each way of the grid round the camera
const CELL = 6; // m
const SPAN = (N - 1) * CELL; // m the grid spans, vertex to vertex
const MOVE = 180; // m the camera goes before the grid is laid round it again
const DRY = -0.6; // m a dry cell's vertex sinks under the ground (the water's edge runs between wet & dry cells)
const REACH = 160; // m round the grid the rivers & canals are looked for

// The nearest of `points` (flat x, z, ground height triples) to each cell of the grid at (x0, z0): its distance into
// `dist` and how far the cell lies over its ground into `above`
function nearestBank(points, heights, x0, z0, dist, above) {
  const near = [];
  for (let k = 0; k < points.length; k += 3) {
    if (points[k] > x0 - REACH && points[k] < x0 + SPAN + REACH && points[k + 1] > z0 - REACH && points[k + 1] < z0 + SPAN + REACH) near.push(k);
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const c = i * N + j, px = x0 + j * CELL, pz = z0 + i * CELL;
      let best = Infinity, top = 0;
      for (const k of near) {
        const d = (points[k] - px) ** 2 + (points[k + 1] - pz) ** 2;
        if (d < best) { best = d; top = points[k + 2]; }
      }
      dist[c] = Math.sqrt(best);
      above[c] = heights[c] - top;
    }
  }
}

class Floods {
  /**
   * @param {object} o - scene; rivers (river-channels.js buildRiverChannels' result: the water mesh rises with the
   *   river); hold: a level to keep (?flood=)
   */
  constructor({ scene, rivers = null, hold = null }) {
    this.model = new FloodLevel();
    if (hold !== null) this.model.hold(hold);
    this.level = 0;
    this.shown = -1;
    // (the river's water: scene-culling.js may have cut its mesh into chunks, found by their material on first use)
    this.scene = scene;
    this.riverMaterial = rivers?.water?.material || null;
    this.riverMeshes = null;
    this.cx = Infinity;
    this.cz = Infinity;
    this.heights = new Float32Array(N * N);
    this.depths = new Float32Array(N * N);
    this.terrain = null;
    this.riverAbove = new Float32Array(N * N); // m over the nearest river bank, and how far it is
    this.riverDist = new Float32Array(N * N).fill(Infinity);
    this.canalAbove = new Float32Array(N * N); // ...and the nearest canal, drain or arroyo
    this.canalDist = new Float32Array(N * N).fill(Infinity);
    this.spots = new Float32Array(N * N); // the reported flood spots' weight (floodSpotAt)
    // the river's banks: every cross-section of the river channels
    this.riverPoints = [];
    for (const ch of waterways ? waterways.channels : []) {
      if (ch.kind !== 'river') continue;
      for (let i = 0; i < ch.s.length; i += 2) this.riverPoints.push(ch.s[i].x, ch.s[i].z, landHeight(ch.s[i].x, ch.s[i].z));
    }
    // the canals, the drains (the El Sabino) & the arroyos, every ~10 m along them
    this.canalPoints = [];
    for (const [kind, , , , flat] of GEO.waterways || []) {
      if (kind === 'river') continue;
      for (let i = 0; i + 3 < flat.length; i += 2) {
        const L = Math.hypot(flat[i + 2] - flat[i], flat[i + 3] - flat[i + 1]);
        for (let s = 0; s < L; s += 10) {
          const x = flat[i] + ((flat[i + 2] - flat[i]) * s) / L, z = flat[i + 1] + ((flat[i + 3] - flat[i + 1]) * s) / L;
          this.canalPoints.push(x, z, landHeight(x, z));
        }
      }
    }
    this._spot = { weight: 0, spot: null };

    const geo = new THREE.PlaneGeometry(SPAN, SPAN, N - 1, N - 1).rotateX(-Math.PI / 2);
    geo.setAttribute('depth', new THREE.BufferAttribute(new Float32Array(N * N), 1));
    this.mesh = new THREE.Mesh(geo, createFloodWaterMaterial());
    this.mesh.name = 'FloodWater';
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // The grid laid round (x, z): the ground's heights, its hollows & low ground, how the river & the canals lie from
  // each cell, the flood spots it falls in
  layAround(x, z) {
    this.cx = Math.round(x / CELL) * CELL;
    this.cz = Math.round(z / CELL) * CELL;
    const x0 = this.cx - SPAN / 2, z0 = this.cz - SPAN / 2;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const c = i * N + j;
        this.heights[c] = landHeight(x0 + j * CELL, z0 + i * CELL);
        this.spots[c] = floodSpotAt(x0 + j * CELL, z0 + i * CELL, this._spot).weight;
      }
    }
    this.terrain = floodTerrain(this.heights, N, CELL);
    nearestBank(this.riverPoints, this.heights, x0, z0, this.riverDist, this.riverAbove);
    nearestBank(this.canalPoints, this.heights, x0, z0, this.canalDist, this.canalAbove);
    this.mesh.position.set(this.cx, 0, this.cz);
    this.shown = -1;
  }

  /**
   * The frame: the flood's level from the weather `w` (weather.js conditions, the Live one or clear), the grid round
   * the camera, the water's surface (redrawn when the level has moved a centimetre)
   */
  update(dt, w, camera) {
    this.level = this.model.update(dt, w);
    const stage = riverStage(this.level);
    // the river in its channel: its water mesh rises (up to the banks' top: it spills on the grid beyond)
    if (this.riverMaterial && !this.riverMeshes) {
      this.riverMeshes = [];
      this.scene.traverse((o) => { if (o.isMesh && o.material === this.riverMaterial) this.riverMeshes.push([o, o.position.y]); });
    }
    for (const [mesh, y] of this.riverMeshes || []) mesh.position.y = y + Math.min(stage, 2.5);
    const flooding = this.level > 0.01;
    this.mesh.visible = flooding;
    if (!flooding) return;
    const p = camera.position;
    if (Math.hypot(p.x - this.cx, p.z - this.cz) > MOVE) this.layAround(p.x, p.z);
    if (Math.abs(this.level - this.shown) < 0.01) return;
    this.shown = this.level;
    const { hollow, low } = this.terrain;
    const pos = this.mesh.geometry.attributes.position;
    const depthAttr = this.mesh.geometry.attributes.depth;
    for (let c = 0; c < N * N; c++) {
      const spill = Math.max(riverSpill(stage, this.riverAbove[c], this.riverDist[c]), canalSpill(this.level, this.canalAbove[c], this.canalDist[c]),
        spotWater(this.spots[c], this.level));
      const d = floodDepth(hollow[c], low[c], this.level, spill);
      this.depths[c] = d;
      // (PlaneGeometry rotated flat: vertex c is row i = c / N from -z to +z, column j from -x to +x, as the grid)
      pos.setY(c, this.heights[c] + (d > 0.02 ? d : DRY));
      depthAttr.setX(c, d);
    }
    pos.needsUpdate = true;
    depthAttr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
  }

  // The water's depth (m) at (x, z): 0 where it is dry or off the grid
  depthAt(x, z) {
    if (this.level <= 0.01 || !this.terrain) return 0;
    const fx = (x - this.cx + SPAN / 2) / CELL, fz = (z - this.cz + SPAN / 2) / CELL;
    if (!(fx >= 0 && fz >= 0 && fx < N - 1 && fz < N - 1)) return 0;
    const j = Math.floor(fx), i = Math.floor(fz), tx = fx - j, tz = fz - i;
    const D = this.depths, k = i * N + j;
    return (D[k] * (1 - tx) + D[k + 1] * tx) * (1 - tz) + (D[k + N] * (1 - tx) + D[k + N + 1] * tx) * tz;
  }

  // The reported flood spot (flood-model.js FLOOD_SPOTS) (x, z) is in while it floods, or null
  spotAt(x, z) {
    if (this.level < 0.15) return null;
    const s = floodSpotAt(x, z, this._spot);
    return s.weight > 0.3 ? s.spot : null;
  }
}

export { Floods };
