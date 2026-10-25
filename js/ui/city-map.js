import { GEO } from '../world/city-geodata.js';
import {
  ROADS,
  BLOCKS,
  CITY_LANDMARKS,
  ISLAND_BOUNDS,
  getIslandBoundsAtZ,
  CITY_OUTLINE,
  getLocationLabel,
  isTypingInField
} from '../world/city-config.js';

// js/ui/city-map.js
// GTA 6-Style Live Radar Minimap + Full-Screen Interactive City Map.
// Synchronized 1:1 with the 3D world (1 unit = 1 m; x = east, z = south on the centro's street grid, GEO.frame.bearingDeg
// east of true north; both maps turn it back, true north up, so they match every other map of Tepic). They draw the very geography the city is built
// from (GEO, from OpenStreetMap & Overture Maps): the city outline, every curb island (block) with the building
// footprints standing on it, the parks, the highways, the real street centrelines (labelled along their course), the
// colonias and the points of interest.

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FRAME = (GEO && GEO.frame) || {};
const MIN_ZOOM = 0.05; // full map, pixels per metre: the whole valley
const MAX_ZOOM = 3.0; // single lots
const RADAR_SCALE = 0.32; // radar pixels per metre on the ground (zooms out with altitude)
const GRID_BEARING = Number.isFinite(FRAME.bearingDeg) ? FRAME.bearingDeg : 0; // the grid's north, degrees east of true north
// Both maps are drawn true north up, as on any other map of Tepic: the world (grid north up) turned clockwise by the
// grid's bearing on screen
const MAP_ROT = (GRID_BEARING * Math.PI) / 180;

// Map palette, shared by the radar & the atlas (in step with css/style.css): graphite ground with the streets a shade
// lighter than the blocks they run between, muted parks; white landmarks & player, cyan search hits and amber
// highways. A city of one- and two-storey houses: its real buildings drawn in warm, brighter
// tones so every house reads
const MAP = {
  streets: '#363f4b', // inside the city outline: the roadway left between the blocks
  shore: '#4f5b6b',
  park: '#19301f',
  parkEdge: '#24432f',
  block: '#1c2128',
  blockEdge: '#272e37',
  buildings: ['#5a4f45', '#6b5e50', '#7c6c5b'],
  buildingEdge: '#2a241f',
  mainRoads: '#3a434f',
  water: '#2f6fae', // the rivers, arroyos & reservoirs
  waterLabel: '#8cc1ee',
  highway: '#b27a35',
  airfield: '#5d6470', // the airport's runway, taxiways & apron
  search: '#5fd0ff',
  halo: 'rgba(8, 11, 15, 0.9)'
};

// The dry valley floor around the city
// Radar blips for crime.js: [colour, radius in px]
const BLIP_STYLES = {
  cop: ['#4d8dff', 3], cruiser: ['#4d8dff', 4.2], rojos: ['#ff4d4d', 3], verdes: ['#45d16b', 3], thief: ['#f2f2f2', 3.4],
  narcos: ['#c9a24a', 3.2], truck: ['#c9a24a', 4.4],
  money: ['#6fe39a', 2.6], health: ['#ff6b6b', 3], armor: ['#7fb0ff', 3], pistol: ['#ffd24a', 2.6], smg: ['#ffa53a', 2.6],
  rifle: ['#d6e04a', 2.8], bazooka: ['#ff7a2a', 3.4]
};
const MAP_BASE = '#101511';

// The city's colonias (GEO.places) at their real places (world metres)
const AREA_LABELS = (GEO.places || []).map((p) => [p.name.toUpperCase(), p.x, p.z]);

// ---------------------------------------------------------------------------------------------------------------------
// World-space vector layers: built once into Path2D objects (world metres) and drawn through a canvas transform
// ---------------------------------------------------------------------------------------------------------------------

// Point accessors for rings / polylines given as [{x, z}, ...] or flat [x0, z0, x1, z1, ...]
function accessor(pts) {
  const flat = typeof pts[0] === 'number';
  return {
    n: flat ? pts.length >> 1 : pts.length,
    X: flat ? (i) => pts[2 * i] : (i) => pts[i].x,
    Z: flat ? (i) => pts[2 * i + 1] : (i) => pts[i].z
  };
}

function boundsOf(pts) {
  const { n, X, Z } = accessor(pts);
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < n; i++) {
    const x = X(i);
    const z = Z(i);
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

// Appends a closed ring, always wound the same way as Path2D.rect (so overlapping rings of one path union under the
// nonzero fill rule instead of cancelling out)
function addRing(path, pts) {
  if (!pts || pts.length < 3) return;
  const { n, X, Z } = accessor(pts);
  if (n < 3) return;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += X(j) * Z(i) - X(i) * Z(j);
  if (a >= 0) {
    path.moveTo(X(0), Z(0));
    for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
  } else {
    path.moveTo(X(n - 1), Z(n - 1));
    for (let i = n - 2; i >= 0; i--) path.lineTo(X(i), Z(i));
  }
  path.closePath();
}

function addLine(path, pts) {
  if (!pts || pts.length < 2) return;
  const { n, X, Z } = accessor(pts);
  path.moveTo(X(0), Z(0));
  for (let i = 1; i < n; i++) path.lineTo(X(i), Z(i));
}

/**
 * A vector layer split into square tiles of Path2D, so a view only rasterizes the tiles it overlaps. Every item goes
 * to the tile holding its centre; a tile's bounds grow to cover its items.
 */
class TiledLayer {
  constructor(size = 500) {
    this.size = size;
    this.tiles = new Map();
  }

  pathFor(b) {
    const ix = Math.floor((b.minX + b.maxX) * 0.5 / this.size);
    const iz = Math.floor((b.minZ + b.maxZ) * 0.5 / this.size);
    const key = `${ix},${iz}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { path: new Path2D(), minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
      this.tiles.set(key, t);
    } else {
      t.minX = Math.min(t.minX, b.minX);
      t.maxX = Math.max(t.maxX, b.maxX);
      t.minZ = Math.min(t.minZ, b.minZ);
      t.maxZ = Math.max(t.maxZ, b.maxZ);
    }
    return t.path;
  }

  ring(pts) {
    if (pts && pts.length > 2) addRing(this.pathFor(boundsOf(pts)), pts);
  }

  line(pts) {
    if (pts && pts.length > 1) addLine(this.pathFor(boundsOf(pts)), pts);
  }

  rect(x0, z0, x1, z1) {
    this.pathFor({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 }).rect(x0, z0, x1 - x0, z1 - z0);
  }

  /** Calls fn(path) for every tile overlapping the view */
  each(v, fn) {
    for (const t of this.tiles.values()) {
      if (t.maxX < v.minX || t.minX > v.maxX || t.maxZ < v.minZ || t.minZ > v.maxZ) continue;
      fn(t.path);
    }
  }
}

let LAYERS = null;
function mapLayers() {
  if (LAYERS) return LAYERS;
  const L = {};

  // The city outline (the roadway deck colour: the streets are the gaps between the blocks)
  L.city = new Path2D();
  addRing(L.city, CITY_OUTLINE);

  // Parkland, the curb islands (blocks: raised sidewalks & lots) and the park blocks, exactly as city-grid.js /
  // buildings.js treat them
  L.parkLand = new TiledLayer();
  L.water = new TiledLayer();
  for (const park of GEO.parks || []) for (const ring of park.rings || []) (park.cat === 'water' ? L.water : L.parkLand).ring(ring);
  // The rivers & arroyos (GEO.waterways, above ground) by width: the Mololoa, the arroyos the blocks leave a gap for,
  // the canals & drains; and anchors for the rivers' names along their course, every ~1.2 km
  L.rivers = new TiledLayer(1000);
  L.streams = new TiledLayer(1000);
  L.drains = new TiledLayer(1000);
  L.riverNames = [];
  for (const [kind, , name, flags, pts] of GEO.waterways || []) {
    if (flags & 2) continue;
    (kind === 'river' ? L.rivers : kind === 'stream' ? L.streams : L.drains).line(pts);
    if (!name || (kind !== 'river' && kind !== 'stream')) continue;
    let along = 600;
    for (let i = 2; i + 1 < pts.length; i += 2) {
      const dx = pts[i] - pts[i - 2], dz = pts[i + 1] - pts[i - 1];
      along += Math.hypot(dx, dz);
      if (along < 1200) continue;
      along = 0;
      L.riverNames.push({ name, x: pts[i], z: pts[i + 1], angle: Math.atan2(dz, dx), river: kind === 'river' });
    }
  }
  // The airport: its apron & helipads, the runway and the taxiways (GEO.airport, drawn at their real widths)
  L.aprons = new TiledLayer(1000);
  L.runways = new TiledLayer(1000);
  L.taxiways = new TiledLayer(1000);
  const airport = GEO.airport || { aprons: [], helipads: [], runways: [], taxiways: [] };
  for (const ring of [...airport.aprons, ...airport.helipads]) L.aprons.ring(ring);
  for (const [, , pts] of airport.runways) L.runways.line(pts);
  for (const [, , pts] of airport.taxiways) L.taxiways.line(pts);
  L.blocks = new TiledLayer();
  L.parkBlocks = new TiledLayer();
  for (const b of BLOCKS) (b.park > 0.6 && !b.median ? L.parkBlocks : L.blocks).ring(b.poly);

  // Street network at low zoom (the wide streets, once the gaps between blocks are under a pixel) and the highways
  L.mainRoads = new TiledLayer(1000);
  L.highways = new Path2D();
  for (const r of ROADS) {
    if (r.highway) {
      if (!/Underpass|Tunnel/.test(r.name)) addLine(L.highways, r.pts);
    } else if (r.w >= 15) L.mainRoads.line(r.pts);
  }

  LAYERS = L;
  return L;
}

// Building footprints as generated by buildings.js, by height: up to 45 m, 95 m, taller
let FOOTPRINTS = null;
function footprintLayers(all) {
  if (!all || !all.length) return null;
  if (FOOTPRINTS && FOOTPRINTS.src === all && FOOTPRINTS.n === all.length) return FOOTPRINTS;
  const tones = [new TiledLayer(), new TiledLayer(), new TiledLayer()];
  for (const blk of all) {
    for (const f of blk.footprints || []) {
      const layer = tones[f.h > 95 ? 2 : f.h > 45 ? 1 : 0];
      if (f.pts) layer.ring(f.pts); // turned to follow a non-grid street
      else layer.rect(f.x0, f.z0, f.x1, f.z1);
    }
  }
  FOOTPRINTS = { src: all, n: all.length, tones, version: FOOTPRINTS ? FOOTPRINTS.version + 1 : 1 };
  return FOOTPRINTS;
}

// Street name labels: anchors every ~260 m along each straight run of a real centreline (fixed in the world, so labels
// never slide while the map pans), with the direction of the street there (never upside down: vertical names read
// upwards)
const ROAD_LABELS = [];
for (const r of ROADS) {
  const text = r.name;
  if (!text || /^Unnamed/.test(text)) continue;
  const anchors = [];
  const pts = r.pts;
  for (let i = 0; i + 1 < pts.length;) {
    // the straight run from pts[i]: consecutive segments within ~5° of its first one (the centreline has a vertex at
    // every intersection, so a long street is a chain of short blocks)
    const a = pts[i];
    const dir = Math.atan2(pts[i + 1].z - a.z, pts[i + 1].x - a.x);
    let j = i + 1;
    while (j + 1 < pts.length) {
      const d = Math.atan2(pts[j + 1].z - pts[j].z, pts[j + 1].x - pts[j].x);
      let turn = Math.abs(d - dir);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn > 0.09) break;
      j++;
    }
    const c = pts[j];
    i = j;
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (len < 20) continue;
    let ang = Math.atan2(c.z - a.z, c.x - a.x);
    if (ang >= Math.PI * 0.5 - 0.01) ang -= Math.PI;
    else if (ang < -Math.PI * 0.5 - 0.01) ang += Math.PI;
    const k = Math.max(1, Math.round(len / 260));
    for (let m = 0; m < k; m++) {
      const t = (m + 0.5) / k;
      anchors.push({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t, ang, len: len / k });
    }
  }
  if (!anchors.length) continue;
  ROAD_LABELS.push({
    text,
    lower: text.toLowerCase(),
    raw: r.name.toLowerCase(),
    road: r,
    major: r.highway || r.w >= 15,
    highway: r.highway,
    anchors,
    ...boundsOf(r.pts)
  });
}
const ROAD_NAME_COUNT = new Set(ROAD_LABELS.map((l) => l.text)).size;

/**
 * A map viewport: centre (cx, cz) in world metres, s pixels per metre, w x h CSS pixels on a canvas of pixel ratio dpr,
 * the world turned `rot` radians clockwise on screen (MAP_ROT: true north up). minX..maxZ bound what it can see.
 */
class MapView {
  constructor(cx, cz, s, w, h, dpr = 1, rot = MAP_ROT) {
    this.cx = cx;
    this.cz = cz;
    this.s = s;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.cos = Math.cos(rot);
    this.sin = Math.sin(rot);
    // the turned screen's bounds in the world
    const c = Math.abs(this.cos), n = Math.abs(this.sin);
    const hx = (w * c + h * n) / (2 * s), hz = (w * n + h * c) / (2 * s);
    this.minX = cx - hx;
    this.maxX = cx + hx;
    this.minZ = cz - hz;
    this.maxZ = cz + hz;
  }

  /** Canvas transform for world metres */
  world(ctx) {
    const { s, dpr, cos, sin } = this;
    const a = s * cos, b = s * sin;
    ctx.setTransform(a * dpr, b * dpr, -b * dpr, a * dpr,
      dpr * (this.w * 0.5 - a * this.cx + b * this.cz), dpr * (this.h * 0.5 - b * this.cx - a * this.cz));
  }

  /** Canvas transform for CSS pixels from the canvas centre (what toX / toY return) */
  screen(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * this.w * 0.5, this.dpr * this.h * 0.5);
  }

  toX(x, z) {
    return ((x - this.cx) * this.cos - (z - this.cz) * this.sin) * this.s;
  }

  toY(x, z) {
    return ((x - this.cx) * this.sin + (z - this.cz) * this.cos) * this.s;
  }

  sees(b) {
    return b && b.maxX >= this.minX && b.minX <= this.maxX && b.maxZ >= this.minZ && b.minZ <= this.maxZ;
  }
}

// A direction in the world (radians from +x towards +z) as drawn on the map, turned so text never reads upside down
function uprightAngle(ang) {
  let a = ang + MAP_ROT;
  while (a > Math.PI * 0.5 + 0.01) a -= Math.PI;
  while (a <= -Math.PI * 0.5 - 0.01) a += Math.PI;
  return a;
}

// Screen pixels (dx, dy) from the centre -> world metres (dx, dz) from the centre, at s pixels per metre
function screenToWorldDelta(dx, dy, s) {
  const c = Math.cos(MAP_ROT), n = Math.sin(MAP_ROT);
  return { x: (dx * c + dy * n) / s, z: (-dx * n + dy * c) / s };
}

// Pixels per metre that fit the bounds b in w x h CSS pixels with the margins mx, my (as drawn: turned by MAP_ROT)
function fitScale(b, w, h, mx, my) {
  const c = Math.abs(Math.cos(MAP_ROT)), n = Math.abs(Math.sin(MAP_ROT));
  const bw = b.maxX - b.minX, bd = b.maxZ - b.minZ;
  return Math.min(w / ((bw * c + bd * n) * mx + 1), h / ((bw * n + bd * c) * my + 1));
}

// Player heading arrow at the (already rotated) origin: white, on a dark halo
function drawPlayerArrow(ctx, tipY, halfWidth, tailY) {
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(halfWidth, tailY);
  ctx.lineTo(0, tailY * 0.45);
  ctx.lineTo(-halfWidth, tailY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

const overlaps = (boxes, b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

class CityMapSystem {
  constructor({ controllerManager, cameraSystem, trafficSystem, allBlocks = [], onTeleport, onToggle }) {
    this.controllerManager = controllerManager;
    this.cameraSystem = cameraSystem;
    this.trafficSystem = trafficSystem;
    this.allBlocks = allBlocks;
    this.onTeleport = onTeleport;
    this.onToggle = onToggle;

    this.miniCanvas = document.getElementById('minimap-canvas');
    this.miniCtx = this.miniCanvas ? this.miniCanvas.getContext('2d') : null;
    this.elMiniStreet = document.getElementById('minimap-street-label');
    this.miniStreetText = '';
    this.miniScale = RADAR_SCALE;
    this.miniCache = null; // { canvas, cx, cz, s, version }: the radar's ground layers, twice the radar's size
    const elCounts = document.getElementById('fullmap-counts');
    if (elCounts) elCounts.textContent = `${ROAD_NAME_COUNT} streets · ${BLOCKS.length.toLocaleString('en-US')} blocks`;

    // (the map is drawn true north up, so its compass, index.html, points straight up)

    this.modal = document.getElementById('fullmap-modal');
    this.fullCanvas = document.getElementById('fullmap-canvas');
    this.fullCanvasWrap = document.getElementById('fullmap-canvas-wrap');
    this.fullCtx = this.fullCanvas ? this.fullCanvas.getContext('2d') : null;
    this.fullDpr = 1;
    this.fullStatic = null; // the full map's ground layers & labels for the current view
    this.fullStaticKey = '';
    this.elHoverInfo = document.getElementById('fullmap-hover-info');
    this.elPlayerInfo = document.getElementById('fullmap-player-info');
    this.elSearchInput = document.getElementById('fullmap-search');
    if (this.elSearchInput) this.elSearchInput.placeholder = `Search ${ROAD_NAME_COUNT} streets & landmarks…`;

    this.isFullMapOpen = false;
    // Full map viewport state (world metres; zoom in CSS pixels per metre)
    this.viewCenterX = 0;
    this.viewCenterZ = 0;
    this.viewZoom = 0.22;
    this.isPanning = false;
    this.panPointerId = null;
    this.panStart = { x: 0, y: 0, cx: 0, cz: 0 };
    this.dragMoved = false;

    this.hoverWorld = null;
    this.searchHighlight = '';
    this.searchPath = null;
    this.textWidths = new Map();

    // Street names measured before the web font arrived would be spaced for the fallback font: measure & draw again
    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.textWidths.clear();
        this.miniCache = null;
        this.fullStaticKey = '';
      });
    }

    this.initEvents();
  }

  initEvents() {
    const closeBtn = document.getElementById('close-fullmap-btn');
    const miniCard = document.getElementById('minimap-card');
    const zoomInBtn = document.getElementById('map-zoom-in');
    const zoomOutBtn = document.getElementById('map-zoom-out');
    const centerPlayerBtn = document.getElementById('map-center-player');
    const fullCityBtn = document.getElementById('map-view-all');

    if (miniCard) {
      miniCard.addEventListener('click', () => this.toggleFullMap(true));
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.toggleFullMap(false));
    }

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        this.viewZoom = Math.min(MAX_ZOOM, this.viewZoom * 1.45);
        this.renderFullMap();
      });
    }
    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        this.viewZoom = Math.max(MIN_ZOOM, this.viewZoom / 1.45);
        this.renderFullMap();
      });
    }
    if (centerPlayerBtn) {
      centerPlayerBtn.addEventListener('click', () => {
        const ent = this.controllerManager.getActiveEntity();
        this.viewCenterX = ent.position.x;
        this.viewCenterZ = ent.position.z;
        this.viewZoom = 0.9; // Street-by-street detail zoom
        this.renderFullMap();
      });
    }
    if (fullCityBtn) {
      fullCityBtn.addEventListener('click', () => {
        // Fits the whole city outline
        const b = ISLAND_BOUNDS;
        const { w, h } = this.fullSize();
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        this.viewZoom = Math.max(MIN_ZOOM, fitScale(b, w, h, 1.15, 1.06));
        this.renderFullMap();
      });
    }

    if (this.elSearchInput) {
      this.elSearchInput.addEventListener('input', () => this.search(this.elSearchInput.value));
    }

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.isFullMapOpen) {
        this.toggleFullMap(false);
      } else if (e.code === 'KeyM' && !isTypingInField(e)) {
        this.toggleFullMap(!this.isFullMapOpen);
      }
    });

    if (this.fullCanvas) {
      this.fullCanvas.style.touchAction = 'none';
      this.fullCanvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.isFullMapOpen || this.panPointerId !== null) return;
        e.preventDefault();
        this.panPointerId = e.pointerId;
        this.fullCanvas.setPointerCapture(e.pointerId);
        this.isPanning = true;
        this.dragMoved = false;
        this.panStart.x = e.clientX;
        this.panStart.y = e.clientY;
        this.panStart.cx = this.viewCenterX;
        this.panStart.cz = this.viewCenterZ;
        if (this.fullCanvasWrap) this.fullCanvasWrap.classList.add('is-panning');
      });

      this.fullCanvas.addEventListener('pointermove', (e) => {
        if (!this.isFullMapOpen || !this.fullCanvas) return;
        if (this.isPanning ? e.pointerId !== this.panPointerId : e.pointerType !== 'mouse') return;
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (this.isPanning) {
          e.preventDefault();
          const dx = e.clientX - this.panStart.x;
          const dy = e.clientY - this.panStart.y;
          if (Math.hypot(dx, dy) > 5) this.dragMoved = true;
          const d = screenToWorldDelta(dx, dy, this.viewZoom);
          this.viewCenterX = this.panStart.cx - d.x;
          this.viewCenterZ = this.panStart.cz - d.z;
          this.renderFullMap();
          return;
        }

        if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
          const wPos = this.screenToWorld(mx, my, rect.width, rect.height);
          this.hoverWorld = wPos;
          if (this.elHoverInfo) {
            this.elHoverInfo.textContent = `${getLocationLabel(wPos.x, wPos.z)} · Click to teleport here`;
          }
        }
      });

      this.fullCanvas.addEventListener('pointerup', (e) => {
        if (e.pointerId !== this.panPointerId) return;
        const clicked = !this.dragMoved && Math.hypot(e.clientX - this.panStart.x, e.clientY - this.panStart.y) <= 5;
        this.cancelPan();
        if (clicked && this.isFullMapOpen && this.fullCanvas) {
          const rect = this.fullCanvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          if (mx >= 0 && mx <= rect.width && my >= 0 && my <= rect.height) {
            const wPos = this.clampToCity(this.screenToWorld(mx, my, rect.width, rect.height));
            if (this.onTeleport) {
              this.onTeleport(wPos.x, wPos.z);
            }
            this.renderFullMap();
          }
        }
      });
      for (const type of ['pointercancel', 'lostpointercapture']) {
        this.fullCanvas.addEventListener(type, (e) => {
          if (e.pointerId === this.panPointerId) this.cancelPan();
        });
      }
      window.addEventListener('blur', () => this.cancelPan());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.cancelPan();
      });

      // Wheel zoom about the cursor (the place under it stays put)
      this.fullCanvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this.fullCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = this.screenToWorld(mx, my, rect.width, rect.height);
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        this.viewZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.viewZoom * factor));
        const d = screenToWorldDelta(mx - rect.width * 0.5, my - rect.height * 0.5, this.viewZoom);
        this.viewCenterX = before.x - d.x;
        this.viewCenterZ = before.z - d.z;
        this.renderFullMap();
      }, { passive: false });
    }
  }

  /**
   * Street / landmark search: highlights every stretch of the matching streets and frames them (or flies to the
   * matching landmark)
   */
  search(text) {
    const q = String(text || '').trim().toLowerCase();
    this.searchHighlight = q;
    this.searchPath = null;
    if (q.length > 0) {
      const lmMatch = CITY_LANDMARKS.find((l) => l.name.toLowerCase().includes(q) || l.short.toLowerCase().includes(q));
      const roads = ROAD_LABELS.filter((l) => l.lower.includes(q) || l.raw.includes(q));
      if (roads.length) {
        this.searchPath = new Path2D();
        const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const l of roads) {
          addLine(this.searchPath, l.road.pts);
          b.minX = Math.min(b.minX, l.minX);
          b.maxX = Math.max(b.maxX, l.maxX);
          b.minZ = Math.min(b.minZ, l.minZ);
          b.maxZ = Math.max(b.maxZ, l.maxZ);
        }
        this.searchBounds = b;
      }
      if (lmMatch) {
        this.viewCenterX = lmMatch.x;
        this.viewCenterZ = lmMatch.z;
        this.viewZoom = Math.max(this.viewZoom, 0.9);
      } else if (roads.length) {
        const b = this.searchBounds;
        const { w, h } = this.fullSize();
        this.viewCenterX = (b.minX + b.maxX) * 0.5;
        this.viewCenterZ = (b.minZ + b.maxZ) * 0.5;
        const fit = fitScale(b, w, h, 1.3, 1.3);
        this.viewZoom = Math.max(0.05, Math.min(1.2, fit));
      }
    }
    this.renderFullMap();
  }

  cancelPan() {
    const id = this.panPointerId;
    this.panPointerId = null;
    this.isPanning = false;
    if (this.fullCanvasWrap) this.fullCanvasWrap.classList.remove('is-panning');
    if (id !== null && this.fullCanvas && this.fullCanvas.hasPointerCapture(id)) this.fullCanvas.releasePointerCapture(id);
  }

  toggleFullMap(open) {
    this.isFullMapOpen = Boolean(open);
    if (!this.isFullMapOpen) this.cancelPan();
    if (this.onToggle) this.onToggle(this.isFullMapOpen);
    if (!this.modal) return;
    this.modal.classList.toggle('hidden', !this.isFullMapOpen);
    if (this.isFullMapOpen) {
      // the HUD's popovers live in the top layer, above the map
      for (const pop of document.querySelectorAll('.popover[popover]')) {
        if (typeof pop.hidePopover === 'function' && pop.matches(':popover-open')) pop.hidePopover();
      }
      const ent = this.controllerManager.getActiveEntity();
      this.viewCenterX = ent.position.x;
      this.viewCenterZ = ent.position.z;
      this.resizeFullCanvas();
      this.renderFullMap();
    }
  }

  resizeFullCanvas() {
    if (!this.fullCanvas) return;
    // Layout size (the opening animation's transforms don't change it), at most ~6 megapixels however large the screen
    const w = this.fullCanvas.clientWidth || window.innerWidth;
    const h = this.fullCanvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6e6 / Math.max(1, w * h)));
    this.fullDpr = dpr;
    this.fullCanvas.width = Math.max(1, Math.floor(w * dpr));
    this.fullCanvas.height = Math.max(1, Math.floor(h * dpr));
  }

  // Full map size in CSS pixels
  fullSize() {
    const dpr = this.fullDpr || 1;
    if (!this.fullCanvas) return { w: 1200, h: 800 };
    return { w: this.fullCanvas.width / dpr, h: this.fullCanvas.height / dpr };
  }

  screenToWorld(sx, sy, width, height) {
    const d = screenToWorldDelta(sx - width * 0.5, sy - height * 0.5, this.viewZoom);
    return { x: this.viewCenterX + d.x, z: this.viewCenterZ + d.z };
  }

  // Teleports land in the city: inside the outline's extent at that z
  clampToCity(p) {
    const z = Math.max(ISLAND_BOUNDS.minZ + 25, Math.min(ISLAND_BOUNDS.maxZ - 25, p.z));
    const shore = getIslandBoundsAtZ(z);
    return { x: Math.max(shore.westX + 12, Math.min(shore.eastX - 12, p.x)), z };
  }

  textWidth(ctx, text) {
    const key = `${ctx.font}|${ctx.letterSpacing || ''}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  /**
   * The ground: the city outline, parkland, blocks, building footprints, the main streets at low zoom, highways and
   * the search highlight (world transform of view v)
   */
  drawWorld(ctx, v, isMinimap) {
    const L = mapLayers();
    const s = v.s;
    const px = (n) => n / s; // screen pixels -> metres (line widths)
    v.world(ctx);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1. The city outline (roadway deck colour: the streets are the gaps between the blocks)
    ctx.fillStyle = MAP.streets;
    ctx.fill(L.city);
    ctx.strokeStyle = MAP.shore;
    ctx.lineWidth = px(isMinimap ? 1.6 : 2.0);
    ctx.stroke(L.city);

    // 2. Parkland, blocks (curb islands) and park blocks
    ctx.fillStyle = MAP.park;
    L.parkLand.each(v, (p) => ctx.fill(p));
    ctx.fillStyle = MAP.block;
    L.blocks.each(v, (p) => ctx.fill(p));
    if (s >= 0.22) {
      ctx.strokeStyle = MAP.blockEdge;
      ctx.lineWidth = px(Math.min(1.2, 0.5 + s));
      L.blocks.each(v, (p) => ctx.stroke(p));
    }
    ctx.fillStyle = MAP.park;
    L.parkBlocks.each(v, (p) => ctx.fill(p));
    if (s >= 0.1) {
      ctx.strokeStyle = MAP.parkEdge;
      ctx.lineWidth = px(1);
      L.parkBlocks.each(v, (p) => ctx.stroke(p));
    }

    // 2b. Water: reservoirs & ponds, then the rivers, arroyos & drains (their real widths, never under a pixel or two)
    ctx.fillStyle = MAP.water;
    L.water.each(v, (p) => ctx.fill(p));
    ctx.strokeStyle = MAP.water;
    for (const [layer, width, minPx] of [[L.rivers, 10, 2.6], [L.streams, 3.8, 1.3], [L.drains, 2, 0.8]]) {
      ctx.lineWidth = Math.max(width, px(minPx));
      layer.each(v, (p) => ctx.stroke(p));
    }

    // 2c. The airport
    ctx.fillStyle = ctx.strokeStyle = MAP.airfield;
    L.aprons.each(v, (p) => ctx.fill(p));
    ctx.lineCap = 'butt';
    for (const [layer, width] of [[L.taxiways, 18], [L.runways, 45]]) {
      ctx.lineWidth = Math.max(width, px(width > 20 ? 3 : 1.2));
      layer.each(v, (p) => ctx.stroke(p));
    }
    ctx.lineCap = 'round';

    // 3. Building footprints, lowest first
    if (s >= 0.18) {
      const fp = footprintLayers(this.allBlocks);
      if (fp) {
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = MAP.buildings[i];
          fp.tones[i].each(v, (p) => ctx.fill(p));
        }
        if (s >= 0.6) {
          ctx.strokeStyle = MAP.buildingEdge;
          ctx.lineWidth = px(0.8);
          for (let i = 0; i < 3; i++) fp.tones[i].each(v, (p) => ctx.stroke(p));
        }
      }
    }

    // 4. Main streets as lines at low zoom
    if (s < 0.16) {
      ctx.strokeStyle = MAP.mainRoads;
      ctx.lineWidth = px(s < 0.05 ? 0.7 : 1.1);
      L.mainRoads.each(v, (p) => ctx.stroke(p));
    }

    // 5. Highways
    ctx.strokeStyle = MAP.highway;
    ctx.lineWidth = Math.max(px(isMinimap ? 2.4 : 1.6), 14);
    ctx.stroke(L.highways);

    // 6. Search highlight: every stretch of the matching streets
    if (this.searchPath && !isMinimap) {
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(px(3), 9);
      ctx.stroke(this.searchPath);
    }
  }

  /**
   * Street names along the streets (screen transform of view v): the best anchor of each street that fits its name,
   * one label per street per `sameNameGap` pixels, none overlapping another (or the boxes already in `placed`)
   */
  drawRoadLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 260, placed = [], majorOnly = false } = {}) {
    const s = v.s;
    const q = this.searchHighlight;
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const inset = (fontPx * 2.5) / s;
    const minX = v.minX + inset;
    const maxX = v.maxX - inset;
    const minZ = v.minZ + inset;
    const maxZ = v.maxZ - inset;
    const cands = [];
    for (const l of ROAD_LABELS) {
      if (l.maxX < minX || l.minX > maxX || l.maxZ < minZ || l.minZ > maxZ) continue;
      const hit = q.length > 0 && (l.lower.includes(q) || l.raw.includes(q));
      if (majorOnly && !l.major && !hit) continue;
      const width = this.textWidth(ctx, l.text);
      const need = (width + 14) / s;
      for (const a of l.anchors) {
        if (a.len < need || a.x < minX || a.x > maxX || a.z < minZ || a.z > maxZ) continue;
        const d = Math.hypot(a.x - v.cx, a.z - v.cz) * s;
        cands.push({ l, a, width, hit, score: (hit ? 1e6 : 0) + (l.highway ? 3000 : 0) + (l.major ? 2000 : 0) + Math.min(a.len * s, 400) - d * 0.5 });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    const byName = new Map();
    let n = 0;
    for (const c of cands) {
      if (n >= maxLabels) break;
      const X = v.toX(c.a.x, c.a.z);
      const Y = v.toY(c.a.x, c.a.z);
      const same = byName.get(c.l.text);
      if (same && same.some(([x, y]) => Math.hypot(x - X, y - Y) < sameNameGap)) continue;
      const hw = c.width * 0.5 + 3;
      const hh = fontPx * 0.5 + 2;
      const ang = uprightAngle(c.a.ang);
      const ca = Math.abs(Math.cos(ang));
      const sa = Math.abs(Math.sin(ang));
      const bx = hw * ca + hh * sa;
      const by = hw * sa + hh * ca;
      const box = [X - bx, Y - by, X + bx, Y + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      if (same) same.push([X, Y]);
      else byName.set(c.l.text, [[X, Y]]);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(ang);
      ctx.fillStyle = c.hit ? MAP.search : c.l.highway ? '#e3a857' : c.l.major ? '#e8ebf0' : '#9ba5b3';
      ctx.strokeText(c.l.text, 0, 0);
      ctx.fillText(c.l.text, 0, 0);
      ctx.restore();
      n++;
    }
    ctx.textBaseline = 'alphabetic';
  }

  // Where the radar's crime blips come from (crime.js blips())
  setBlipSource(fn) {
    this.blipSource = typeof fn === 'function' ? fn : null;
  }

  update() {
    // The full map covers the whole screen, radar included
    if (this.isFullMapOpen) {
      this.renderFullMap();
    } else {
      this.renderMinimap();
    }
  }

  // =========================================================================
  // 1. GTA 6-STYLE LIVE RADAR MINIMAP (BOTTOM-LEFT HUD)
  // =========================================================================
  renderMinimap() {
    if (!this.miniCtx || !this.miniCanvas) return;
    // Nothing to draw while the radar is hidden (narrow screens, clean view)
    if (!this.miniCanvas.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const ctx = this.miniCtx;
    // Radar size in CSS pixels, backed at the device pixel ratio (crisp street names on HiDPI screens)
    const w = this.miniCanvas.clientWidth;
    const h = this.miniCanvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.miniCanvas.width !== bw || this.miniCanvas.height !== bh) {
      this.miniCanvas.width = bw;
      this.miniCanvas.height = bh;
      this.miniCache = null;
    }

    const ent = this.controllerManager.getActiveEntity();
    const px = ent.position.x;
    const pz = ent.position.z;
    // Ground-level radar shows ~800 m of the city; it zooms out as the camera climbs (helicopter) over the town's floor
    const altitude = ent.position.y - this.controllerManager.floorHeight(px, pz);
    const target = Math.max(0.05, RADAR_SCALE / (1 + Math.max(0, altitude - 25) / 180));
    this.miniScale += (target - this.miniScale) * 0.08;
    const scale = this.miniScale;

    if (this.elMiniStreet) {
      const label = getLocationLabel(px, pz);
      if (label !== this.miniStreetText) {
        this.miniStreetText = label;
        this.elMiniStreet.textContent = label;
      }
    }

    // Ground layers & street names come from a cached render twice the radar's size, redrawn when the player nears its
    // edge or the zoom drifts (or the buildings arrive)
    const fp = footprintLayers(this.allBlocks);
    const version = fp ? fp.version : 0;
    let c = this.miniCache;
    // (the player's offset from the cache's centre as drawn: turned with the map, in metres)
    const off = (cc) => ({ x: (px - cc.cx) * Math.cos(MAP_ROT) - (pz - cc.cz) * Math.sin(MAP_ROT), y: (px - cc.cx) * Math.sin(MAP_ROT) + (pz - cc.cz) * Math.cos(MAP_ROT) });
    let o = c && off(c);
    if (!c || c.version !== version || Math.abs(scale / c.s - 1) > 0.12 ||
      Math.abs(o.x) > w / c.s - w / (2 * scale) - 8 / scale ||
      Math.abs(o.y) > h / c.s - h / (2 * scale) - 8 / scale) {
      if (!c) {
        c = this.miniCache = { canvas: document.createElement('canvas') };
        c.canvas.width = bw * 2;
        c.canvas.height = bh * 2;
        c.ctx = c.canvas.getContext('2d');
      }
      c.cx = px;
      c.cz = pz;
      c.s = scale;
      c.version = version;
      c.ctx.setTransform(1, 0, 0, 1, 0, 0);
      c.ctx.fillStyle = MAP_BASE;
      c.ctx.fillRect(0, 0, bw * 2, bh * 2);
      const cv = new MapView(px, pz, scale, w * 2, h * 2, dpr);
      this.drawWorld(c.ctx, cv, true);
      cv.screen(c.ctx);
      this.drawRoadLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 28, sameNameGap: 180 });
      o = { x: 0, y: 0 };
    }

    const v = new MapView(px, pz, scale, w, h, dpr);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP_BASE;
    ctx.fillRect(0, 0, bw, bh);
    const k = scale / c.s;
    ctx.drawImage(c.canvas, dpr * ((-w / c.s - o.x) * scale + w * 0.5), dpr * ((-h / c.s - o.y) * scale + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);

    v.screen(ctx);

    // Live moving traffic blips on radar
    if (this.trafficSystem && this.trafficSystem.cars) {
      ctx.fillStyle = 'rgba(226, 232, 240, 0.34)';
      for (let i = 0; i < this.trafficSystem.cars.length; i += 2) {
        const car = this.trafficSystem.cars[i];
        const cx = v.toX(car.x, car.z);
        const cy = v.toY(car.x, car.z);
        if (Math.abs(cx) < w * 0.5 && Math.abs(cy) < h * 0.5) {
          ctx.fillRect(cx - 1, cy - 1, 2, 2);
        }
      }
    }

    // Landmark blips
    for (const lm of CITY_LANDMARKS) {
      const lx = v.toX(lm.x, lm.z);
      const ly = v.toY(lm.x, lm.z);
      if (Math.abs(lx) < w * 0.48 && Math.abs(ly) < h * 0.48) {
        ctx.fillStyle = MAP.halo;
        ctx.beginPath();
        ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(lx, ly, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The police, gangs, thieves and pickups (crime.js blips: kind, x, z, ...), clamped to the radar's edge
    if (this.blipSource) {
      const blips = this.blipSource();
      for (let i = 0; i < blips.length; i += 3) {
        const style = BLIP_STYLES[blips[i]];
        if (!style) continue;
        const bx = Math.max(-w * 0.46, Math.min(w * 0.46, v.toX(blips[i + 1], blips[i + 2])));
        const by = Math.max(-h * 0.46, Math.min(h * 0.46, v.toY(blips[i + 1], blips[i + 2])));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        ctx.arc(bx, by, style[1] + 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = style[0];
        ctx.beginPath();
        ctx.arc(bx, by, style[1], 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Camera FOV Cone & Player Arrow at center (0, 0)
    const camDir = this.cameraSystem.currentLookAt.clone().sub(this.cameraSystem.currentPos);
    const camAngle = Math.atan2(camDir.x, camDir.z);

    ctx.save();
    ctx.rotate(-camAngle + Math.PI + MAP_ROT);
    const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 58);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 58, -Math.PI * 0.72, -Math.PI * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Player heading arrow
    ctx.save();
    ctx.rotate(-ent.heading + Math.PI + MAP_ROT);
    drawPlayerArrow(ctx, -9, 6.5, 7);
    ctx.restore();

    ctx.restore();
  }

  // =========================================================================
  // 2. FULL INTERACTIVE CITY STREET MAP MODAL ([M])
  // =========================================================================
  renderFullMap() {
    if (!this.fullCtx || !this.fullCanvas || !this.isFullMapOpen) return;
    const ctx = this.fullCtx;
    const dpr = this.fullDpr || 1;
    const { w, h } = this.fullSize();
    const v = new MapView(this.viewCenterX, this.viewCenterZ, this.viewZoom, w, h, dpr);

    const ent = this.controllerManager.getActiveEntity();
    if (this.elPlayerInfo) {
      const text = `You are at ${getLocationLabel(ent.position.x, ent.position.z)}`;
      if (text !== this.playerInfoText) {
        this.playerInfoText = text;
        this.elPlayerInfo.textContent = text;
      }
    }

    // Ground layers, names & landmark pins: re-rendered only when the view, the search or the buildings change
    const fp = footprintLayers(this.allBlocks);
    const key = `${v.cx}|${v.cz}|${v.s}|${this.fullCanvas.width}|${this.fullCanvas.height}|${this.searchHighlight}|${fp ? fp.version : 0}`;
    if (!this.fullStatic) this.fullStatic = document.createElement('canvas');
    if (key !== this.fullStaticKey) {
      this.fullStaticKey = key;
      const sc = this.fullStatic;
      if (sc.width !== this.fullCanvas.width || sc.height !== this.fullCanvas.height) {
        sc.width = this.fullCanvas.width;
        sc.height = this.fullCanvas.height;
      }
      this.renderFullMapStatic(sc.getContext('2d'), v);
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fullStatic, 0, 0);
    v.screen(ctx);

    // Live Player Blip & Heading Arrow, with a slow pulse to find it at a glance
    const px = v.toX(ent.position.x, ent.position.z);
    const py = v.toY(ent.position.x, ent.position.z);

    ctx.save();
    ctx.translate(px, py);
    const pulse = (performance.now() % 1800) / 1800;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.24 * (1 - pulse)})`;
    ctx.beginPath();
    ctx.arc(0, 0, 10 + pulse * 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(0, 0, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(-ent.heading + Math.PI + MAP_ROT);
    drawPlayerArrow(ctx, -11, 7.5, 8);
    ctx.restore();

    ctx.restore();
  }

  renderFullMapStatic(ctx, v) {
    const { w, h, s } = v;
    ctx.save();
    // 1. The valley floor
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP_BASE;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    // 2. The ground: the city outline, blocks, parks, footprints & highways
    this.drawWorld(ctx, v, false);

    v.screen(ctx);

    // 3. Iconic Landmark Pins & Collision-Free Labels (placed first: their boxes keep the other names clear)
    ctx.font = `700 11px ${FONT}`;
    const placed = [];
    const pins = [];
    for (const lm of CITY_LANDMARKS) {
      const lx = v.toX(lm.x, lm.z);
      const ly = v.toY(lm.x, lm.z);
      if (Math.abs(lx) > w * 0.48 || Math.abs(ly) > h * 0.48) continue;
      const labelW = this.textWidth(ctx, lm.short) + 6;
      const box = [lx + 6, ly - 8, lx + 8 + labelW, ly + 7];
      const showLabel = !overlaps(placed, box);
      placed.push([lx - 6, ly - 6, lx + 6, ly + 6]);
      if (showLabel) placed.push(box);
      pins.push({ lm, lx, ly, showLabel });
    }

    // 4. Colonia watermark titles (wherever they fit), letter-spaced like a printed atlas
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tracking = 'letterSpacing' in ctx;
    for (const [label, x, z] of s < 0.035 || s > 1.2 ? [] : AREA_LABELS) {
      const dx = v.toX(x, z);
      const dy = v.toY(x, z);
      if (Math.abs(dx) > w * 0.47 || Math.abs(dy) > h * 0.47) continue;
      ctx.font = `700 10.5px ${FONT}`;
      ctx.fillStyle = 'rgba(168, 178, 192, 0.46)';
      if (tracking) ctx.letterSpacing = '1.8px';
      const half = this.textWidth(ctx, label) * 0.5 + 4;
      const box = [dx - half, dy - 8, dx + half, dy + 8];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      ctx.fillText(label, dx, dy);
    }
    if (tracking) ctx.letterSpacing = '0px';

    // 4b. The rivers' names along their course (the arroyos' only closer in), in italics
    const L = mapLayers();
    for (const r of s < 0.04 ? [] : L.riverNames) {
      if (!r.river && s < 0.25) continue;
      const dx = v.toX(r.x, r.z);
      const dy = v.toY(r.x, r.z);
      if (Math.abs(dx) > w * 0.46 || Math.abs(dy) > h * 0.46) continue;
      ctx.font = `italic 600 ${r.river ? 11 : 10}px ${FONT}`;
      const half = this.textWidth(ctx, r.name) * 0.5 + 3;
      // (the label's box, turned with the river: its axis-aligned bounds)
      const ang = uprightAngle(r.angle);
      const c = Math.abs(Math.cos(ang)), sn = Math.abs(Math.sin(ang));
      const bx = half * c + 7 * sn, by = half * sn + 7 * c;
      const box = [dx - bx, dy - by, dx + bx, dy + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(ang); // (never upside down)
      ctx.lineWidth = 3;
      ctx.strokeStyle = MAP.halo;
      ctx.strokeText(r.name, 0, 0);
      ctx.fillStyle = MAP.waterLabel;
      ctx.fillText(r.name, 0, 0);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';

    // 5. Street names along their real course (collision-free at all zoom levels)
    const fontPx = Math.max(9, Math.min(12, Math.round(9.5 * Math.sqrt(Math.max(s, 0.4)))));
    this.drawRoadLabels(ctx, v, { fontPx, maxLabels: 420, sameNameGap: 300, placed, majorOnly: s < 0.3 });

    ctx.font = `700 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (const { lm, lx, ly, showLabel } of pins) {
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(lx, ly, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
      ctx.fill();
      if (showLabel) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = MAP.halo;
        ctx.strokeText(lm.short, lx + 9, ly + 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(lm.short, lx + 9, ly + 4);
      }
    }

    // 6. Scale bar (true metres); the true-north compass sits with the map controls (index.html)
    this.drawScaleBar(ctx, v);
    ctx.restore();
  }

  drawScaleBar(ctx, v) {
    const target = 120 / v.s; // metres in ~120 px
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const step = [1, 2, 5, 10].map((m) => m * pow).filter((m) => m <= target).pop() || pow;
    const len = step * v.s;
    const x0 = -v.w * 0.5 + 24;
    const y0 = v.h * 0.5 - 26;
    const label = step >= 1000 ? `${step / 1000} km` : `${step} m`;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 6);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + len, y0);
    ctx.lineTo(x0 + len, y0 - 6);
    ctx.strokeStyle = MAP.halo;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236, 239, 244, 0.92)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `650 11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    ctx.strokeText(label, x0 + len + 8, y0 + 3);
    ctx.fillStyle = 'rgba(236, 239, 244, 0.95)';
    ctx.fillText(label, x0 + len + 8, y0 + 3);
  }
}

export { CityMapSystem };
