import * as THREE from 'three/webgpu';

// js/basemap-overlay.js
// A reference map draped on the ground under the city, for checking roads & footprints by eye against another source.
// Web-Mercator tiles (any XYZ / WMTS GoogleMapsCompatible service) covering GEO.frame.box are fetched only when the
// overlay is first shown, drawn into one canvas texture and laid on a ground plane placed in the world frame.
// City-agnostic: the tile URL, zoom and credit come in through `options`; nothing is stored.

const A = 6378137.0, E2 = 6.69437999014e-3; // WGS-84, as tools/geo-frame.mjs

// Local tangent plane at the frame origin (north-up frames: x east, z south), as tools/geo-frame.mjs makeFrame()
function frameOf(geo) {
  const { lat0, lon0 } = geo.frame;
  const phi = (lat0 * Math.PI) / 180, sin = Math.sin(phi);
  const kx = (Math.PI / 180) * (A / Math.sqrt(1 - E2 * sin * sin)) * Math.cos(phi);
  const ky = (Math.PI / 180) * ((A * (1 - E2)) / Math.pow(1 - E2 * sin * sin, 1.5));
  return (lon, lat) => [(lon - lon0) * kx, -(lat - lat0) * ky];
}
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const lonOf = (x, z) => (x / 2 ** z) * 360 - 180;
const latOf = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function buildBasemapOverlay(scene, geo, options) {
  const { url, zoom = 17, y = 0.03, credit = '' } = options;
  const toWorld = frameOf(geo);
  const [s, w, n, e] = geo.frame.box;
  const x0 = Math.floor(tileX(w, zoom)), x1 = Math.floor(tileX(e, zoom));
  const y0 = Math.floor(tileY(n, zoom)), y1 = Math.floor(tileY(s, zoom));
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
  const size = 256;
  // Corners of the tile block in the world (the block is small enough for Mercator to be linear across it)
  const [wx0, wz0] = toWorld(lonOf(x0, zoom), latOf(y0, zoom));
  const [wx1, wz1] = toWorld(lonOf(x1 + 1, zoom), latOf(y1 + 1, zoom));
  const canvas = document.createElement('canvas');
  canvas.width = cols * size;
  canvas.height = rows * size;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(wx1 - wx0, wz1 - wz0), new THREE.MeshBasicNodeMaterial({ map: texture }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.set((wx0 + wx1) / 2, y, (wz0 + wz1) / 2);
  plane.visible = false;
  plane.name = 'basemap-overlay';
  plane.renderOrder = -1;
  scene.add(plane);

  let loading = null;
  function load(onProgress) {
    if (loading) return loading;
    const ctx = canvas.getContext('2d');
    let done = 0;
    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        jobs.push(new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { ctx.drawImage(img, (tx - x0) * size, (ty - y0) * size, size, size); texture.needsUpdate = true; resolve(); };
          img.onerror = () => resolve(); // a missing tile stays blank
          img.src = url(zoom, tx, ty);
        }).then(() => onProgress && onProgress(++done / (cols * rows))));
      }
    }
    loading = Promise.all(jobs);
    return loading;
  }
  return {
    plane,
    credit,
    tiles: cols * rows,
    async setVisible(on, onProgress) {
      plane.visible = on;
      if (on) await load(onProgress);
    }
  };
}

export { buildBasemapOverlay };
