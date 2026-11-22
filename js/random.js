// Seeded random numbers & hashes: the city, its trees & its people come out the same on every load

/** mulberry32: a generator of numbers in [0, 1) from a 32-bit seed */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Park & Miller's minimal standard generator: numbers in (0, 1) from an integer seed in [1, 2^31 - 2] */
function minStdRandom(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

/** A hash in [0, 1) of (x, z) (or of x alone), with k picking one of several per point */
function prand(x, z = 0, k = 0) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** A hash in [0, 1) of (x, y, z) */
function hashPos(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export { mulberry32, minStdRandom, prand, hashPos };
