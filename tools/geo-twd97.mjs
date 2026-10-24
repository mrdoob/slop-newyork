// tools/geo-twd97.mjs
// Taiwan's TWD97 / TM2 (zone 121°E, k0 0.9999, false easting 250 km) grid, used by Taiwan's open map data, to latitude /
// longitude on GRS80 (the same as WGS-84 at the centimetre level here).

const A = 6378137;

// TWD97 TM2 (zone 121°E) easting/northing -> latitude/longitude (GRS80 transverse Mercator inverse)
export function tm2ToGeo(E, N) {
  const k0 = 0.9999, lon0 = (121 * Math.PI) / 180, e2 = 0.00669438002290, ep2 = e2 / (1 - e2);
  const x = E - 250000, M = N / k0;
  const mu = M / (A * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(phi1) ** 2, T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2), R1 = (A * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - ((N1 * Math.tan(phi1)) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
    ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = lon0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(phi1);
  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}
