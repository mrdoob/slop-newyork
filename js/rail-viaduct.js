import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';

// js/rail-viaduct.js
// Metro track above ground (GEO.rail, tools/geo-transit.mjs): elevated guideways as a concrete box deck with parapets on
// piers, track at grade as a low bed. City-agnostic: everything comes from `geo`, colours through `options`.
//
// GEO.rail.lines: [elevated 0|1, deck width m, [x, z, ...], [deck top height m above the street per point]]
// GEO.rail.piers: [x, z, yaw, deck underside height m] (placed by the build: one row per twin track, none in a
// carriageway); GEO.rail.deckDepth. Heights are estimates in the data: OSM maps a layer, not a height.

const PARAPET_H = 1.1;
const PARAPET_T = 0.25;
const PIER_W = 1.6;
const BED_H = 0.25; // track bed at grade

function buildRailViaduct(scene, geo, options = {}) {
  const lines = geo.rail?.lines || [];
  if (!lines.length) return null;
  const ground = heightAt(geo);
  const DECK_T = geo.rail.deckDepth ?? 1.5;
  const pos = [], idx = [];
  // A box-section strip along a polyline: for each point, offsets ±hw at heights [y0, y1] (per point) -> 4 faces
  const strip = (pts, hw, y0, y1, offset = 0) => {
    const n = pts.length, base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i];
      // miter: the mean of the neighbouring segments' normals
      const [ax, az] = pts[Math.max(0, i - 1)], [bx, bz] = pts[Math.min(n - 1, i + 1)];
      const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (const s of [-1, 1]) {
        const ox = x + nx * (offset + s * hw), oz = z + nz * (offset + s * hw);
        pos.push(ox, y0[i], oz, ox, y1[i], oz); // bottom, top
      }
    }
    // vertex k of point i: base + i*4 + k, k: 0 left-bottom, 1 left-top, 2 right-bottom, 3 right-top
    const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
    for (let i = 0; i + 1 < n; i++) {
      const p = base + i * 4, q = p + 4;
      quad(p + 1, q + 1, q + 3, p + 3); // top
      quad(p, p + 2, q + 2, q); // bottom
      quad(p, q, q + 1, p + 1); // left side
      quad(p + 2, p + 3, q + 3, q + 2); // right side
    }
    // end caps
    const e = base + (n - 1) * 4;
    quad(base, base + 1, base + 3, base + 2);
    quad(e, e + 2, e + 3, e + 1);
  };
  for (const [elevated, w, flat, hs] of lines) {
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    const g = pts.map(([x, z]) => ground(x, z));
    if (!elevated || Math.max(...hs) < 0.5) {
      strip(pts, w / 2, g.map((y) => y), g.map((y) => y + BED_H));
      continue;
    }
    const top = hs.map((h, i) => g[i] + Math.max(h, BED_H));
    const bottom = top.map((y, i) => Math.max(g[i], y - DECK_T));
    strip(pts, w / 2, bottom, top);
    for (const s of [-1, 1]) strip(pts, PARAPET_T / 2, top, top.map((y) => y + PARAPET_H), s * (w / 2 - PARAPET_T / 2));
  }
  const piers = (geo.rail.piers || []).map(([x, z, yaw, under]) => { const gy = ground(x, z); return [x, z, gy, gy + under, yaw]; });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(idx);
  const flatShaded = geometry.toNonIndexed();
  flatShaded.computeVertexNormals();
  geometry.dispose();
  const concrete = new THREE.MeshStandardNodeMaterial({ color: options.colour ?? 0xbab7af, roughness: 0.9 });
  const group = new THREE.Group();
  group.name = 'rail-viaduct';
  const deck = new THREE.Mesh(flatShaded, concrete);
  deck.castShadow = deck.receiveShadow = true;
  group.add(deck);
  if (piers.length) {
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(PIER_W, 1, PIER_W * 1.4).translate(0, 0.5, 0), concrete, piers.length);
    const d = new THREE.Object3D();
    piers.forEach(([x, z, gy, yb, yaw], i) => {
      d.position.set(x, gy, z);
      d.rotation.set(0, yaw, 0);
      d.scale.set(1, yb - gy, 1);
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
    });
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  scene.add(group);
  return { group, stats: { lines: lines.length, piers: piers.length } };
}

export { buildRailViaduct };
