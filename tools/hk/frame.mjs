// tools/hk/frame.mjs — Hong Kong local frame for the simulation.
//
// The New York build turns its axes 29.02° off true north because Manhattan's grid does. Hong Kong has no single grid:
// the roads follow the coast, the hills and the reclamations, so this world is simply **true north up** —
// x = east (m), z = south (m), north = −z — the same convention the rest of the engine already uses for physics,
// lane normals and camera headings.
//
// Projection: a local tangent plane (equirectangular) around the origin. Over the ~9 km the seed network spans,
// the error against a proper HK1980 / WGS84 projection is well under a metre, which is finer than the seed data itself.
// Swapping in real HK1980 Grid coordinates later only means replacing toWorld()/toLatLon().

export const ORIGIN = { lat: 22.282, lon: 114.158, name: '中環 皇后像廣場 Statue Square, Central' };

const RAD = Math.PI / 180;
// Metres per degree on the WGS84 ellipsoid at the origin's latitude (standard series expansions).
export const MPD_LAT = 111132.92 - 559.82 * Math.cos(2 * ORIGIN.lat * RAD) + 1.175 * Math.cos(4 * ORIGIN.lat * RAD);
export const MPD_LON = 111412.84 * Math.cos(ORIGIN.lat * RAD) - 93.5 * Math.cos(3 * ORIGIN.lat * RAD);

/** [lon, lat] (degrees) -> [x, z] (metres, x east, z south) */
export const toWorld = ([lon, lat]) => [(lon - ORIGIN.lon) * MPD_LON, -(lat - ORIGIN.lat) * MPD_LAT];
/** [x, z] (metres) -> [lon, lat] (degrees) */
export const toLatLon = ([x, z]) => [ORIGIN.lon + x / MPD_LON, ORIGIN.lat - z / MPD_LAT];

export const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
export const flat = (pts) => pts.flatMap(([x, z]) => [round(x), round(z)]);

/** Ramer–Douglas–Peucker on [[x, z], …] — the same simplification the NYC pipeline uses on centre lines. */
export function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bestD = eps;
    const [ax, az] = points[a];
    const [bx, bz] = points[b];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = points[i];
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
      const d = Math.hypot(ax + t * dx - px, az + t * dz - pz);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Ring area in m² (positive = counter-clockwise in the x/z plane). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/** Even-odd point in ring. */
export function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

export function bboxOf(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

/** Distance from a point to a polyline (metres). */
export function distToLine(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return best;
}

/** Deterministic 32-bit PRNG so a rebuild produces byte-identical data. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
