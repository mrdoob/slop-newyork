// tools/geo-frame.mjs
// The simulation's 1:1 world frame, shared by every city's build: 1 unit = 1 m, x = frame east, z = frame south
// (north = -z). Longitude/latitude go onto the local tangent plane at (lat0, lon0) on the WGS-84 ellipsoid, are turned
// by `theta` (radians, clockwise from true north: a city grid's bearing, or 0 for north-up) and shifted so `origin`
// (a point in the turned frame) is the world origin.
//
// `theta` and `origin` are plain fields so a build may calibrate them after creating the frame (NYC measures its
// avenue bearing and the 5th Ave & 42nd St intersection from the street centerline); toWorld reads them on each call.

const A = 6378137.0; // WGS-84 semi-major axis (m)
const E2 = 6.69437999014e-3; // WGS-84 first eccentricity squared

export function makeFrame({ lat0, lon0, theta = 0, origin = [0, 0] }) {
  const PHI0 = (lat0 * Math.PI) / 180;
  const SIN0 = Math.sin(PHI0);
  const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0); // prime-vertical radius of curvature
  const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5); // meridional radius of curvature
  const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0); // metres per degree of longitude at lat0
  const KY = (Math.PI / 180) * MRAD; // metres per degree of latitude at lat0
  const frame = { lat0, lon0, theta, origin, KX, KY };
  // Local tangent plane (east, north) metres
  frame.enu = (lon, lat) => [(lon - lon0) * KX, (lat - lat0) * KY];
  // Turned frame: u = frame east, v = frame south
  frame.gridUV = (lon, lat) => {
    const [e, n] = frame.enu(lon, lat);
    const c = Math.cos(frame.theta);
    const s = Math.sin(frame.theta);
    return [e * c - n * s, -(e * s + n * c)];
  };
  frame.toWorld = (lon, lat) => {
    const [u, v] = frame.gridUV(lon, lat);
    return [u - frame.origin[0], v - frame.origin[1]];
  };
  return frame;
}
