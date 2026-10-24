// js/world/ground.js
// The ground everything stands on, as heights over the world's y = 0. Two grids from tools/build-tepic-geodata.mjs:
// - GEO.terrain, the hills around the valley over its flat floor (zero under the town);
// - GEO.ground, the town's own slopes (its blurred elevation over the datum, the town's lowest point), used only with
//   ?slopes=1 while the world isn't yet built on it.
// No three.js here, so node --test imports it directly.
import { GEO } from './city-geodata.js';

const SINK = 0.08; // the flat parts of the hills' mesh sit just under the streets & meadows

// A grid's heights (dm, Int16 little-endian, base64) in metres
function decodeHeights(grid) {
  const bin = atob(grid.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dm = new Int16Array(bytes.buffer);
  const heights = new Float32Array(dm.length);
  for (let i = 0; i < dm.length; i++) heights[i] = dm[i] / 10;
  return heights;
}

// Height on a grid at (x, z), on the very triangles a mesh of it draws (each cell split from its +x corner to its +z
// corner), `outside` beyond it
function gridSampler(grid, heights, outside) {
  const { x0, z0, cell, w, h } = grid;
  return (x, z) => {
    const fx = (x - x0) / cell, fz = (z - z0) / cell;
    if (!(fx >= 0 && fz >= 0 && fx < w - 1 && fz < h - 1)) return outside;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * w + i;
    const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + w], h11 = heights[k + w + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  };
}

function createGround(geo, { slopes = false } = {}) {
  const hillHeights = geo.terrain ? decodeHeights(geo.terrain) : null;
  /** Height (m) of the hills over the valley floor at (x, z): 0 in town and beyond the data */
  const terrainHeight = hillHeights ? gridSampler(geo.terrain, hillHeights, 0) : () => 0;
  /** The hills' ground for anything standing on them (0 in town) */
  const hillGround = (x, z) => {
    const h = terrainHeight(x, z);
    return h > SINK ? h - SINK : 0;
  };

  const town = slopes && geo.ground ? gridSampler(geo.ground, decodeHeights(geo.ground), geo.ground.floor) : null;
  /** Height (m) of the town's floor at (x, z): its slopes with ?slopes=1, else 0 (the flat city) */
  const townHeight = town || (() => 0);
  /** Height (m) of the ground at (x, z): the town's floor and the hills over it */
  const groundHeight = town ? (x, z) => town(x, z) + hillGround(x, z) : hillGround;
  /**
   * The ground's gradient at (x, z) into out: [rise per metre east (+x), rise per metre south (+z)], central differences
   * over a metre (the grids' triangles are 25-75 m, so this is their plane's tilt but for a metre at their edges)
   */
  const groundSlope = (x, z, out = [0, 0]) => {
    out[0] = (groundHeight(x + 0.5, z) - groundHeight(x - 0.5, z));
    out[1] = (groundHeight(x, z + 0.5) - groundHeight(x, z - 0.5));
    return out;
  };

  return {
    slopes: Boolean(town),
    datum: geo.ground ? geo.ground.datum : null,
    hillHeights,
    terrainHeight,
    hillGround,
    townHeight,
    groundHeight,
    groundSlope
  };
}

const SLOPES = typeof location !== 'undefined' && new URLSearchParams(location.search).get('slopes') === '1';
const ground = createGround(GEO, { slopes: SLOPES });
const { hillHeights, terrainHeight, hillGround, townHeight, groundHeight, groundSlope } = ground;

export { SINK, SLOPES, createGround, hillHeights, terrainHeight, hillGround, townHeight, groundHeight, groundSlope };
