// js/footprint-map.js
// A minimap and a full map for footprint cities, drawn from the same data as the 3D city (GEO.buildings, GEO.infill,
// GEO.roadGraph, GEO.green, GEO.frame.box & .boundary): the minimap follows the player north-up; the full map shows the whole area,
// zooms with the wheel, pans by dragging, names the street under the pointer and teleports the player where it is
// clicked. City-agnostic: colours and labels come in through `options`.
// Drawing: the whole area once into a bitmap (≤ BASE_PX across) for the zoomed-out full map; the minimap and a zoomed-in
// full map draw the shapes in view straight from a grid index, so they stay sharp however big the area is. Stand-ins
// (GEO.infill) show only while they show in 3D (setInfill; options.showInfill, default true). Metro track above ground
// and stations (GEO.rail) draw over the roads; station names label the full map. Elevated roads (GEO.elevatedRoads)
// draw over the buildings they pass above.
//
// new FootprintMap(geo, { mini, full, fullCanvas, hoverInfo, getPlayer, onTeleport, onToggle, colours, showInfill })
//   mini        <canvas> for the minimap (clicking it opens the full map)
//   full        the full map's container (hidden when closed); fullCanvas its <canvas>; hoverInfo a text element
//   getPlayer   () => { x, z, heading } (heading: forward = (-sin h, -cos h)), drawn as an arrow
//   onTeleport  (x, z) => void, from a click on the full map
//   onToggle    (open) => void

const DEFAULT_COLOURS = {
  ground: '#d9d6cf', green: '#a9c79a', road: '#fbfaf7', roadEdge: '#bdb8ae', building: '#8f8a83', infill: '#b3a9c9',
  player: '#d8322a', boxEdge: 'rgba(40, 44, 52, 0.45)', label: '#2a2d33', rail: '#9a968e', station: '#0b5aa2'
};
const PAD_M = 40; // m of ground drawn around the box
const BASE_PX = 2400; // the zoomed-out bitmap's longest side
const CELL_M = 100; // grid index cell

class FootprintMap {
  constructor(geo, options) {
    this.geo = geo;
    this.o = options;
    this.c = { ...DEFAULT_COLOURS, ...(options.colours || {}) };
    this.open = false;
    // World extent of the box (+ padding), from the frame's [S, W, N, E] box
    const [s, w, n, e] = geo.frame.box;
    const kx = (Math.PI / 180) * 6378137 * Math.cos((geo.frame.lat0 * Math.PI) / 180), ky = (Math.PI / 180) * 6378137;
    this.x0 = (w - geo.frame.lon0) * kx - PAD_M;
    this.x1 = (e - geo.frame.lon0) * kx + PAD_M;
    this.z0 = -(n - geo.frame.lat0) * ky - PAD_M;
    this.z1 = -(s - geo.frame.lat0) * ky + PAD_M;
    this.ppm = Math.min(2, BASE_PX / Math.max(this.x1 - this.x0, this.z1 - this.z0)); // bitmap pixels per metre
    this.showInfill = options.showInfill ?? true;
    this.bases = {}; // bitmaps with / without stand-ins, made when first needed
    this._index();
    this.segs = this._streetSegments();
    this.view = null; // full map: { cx, cz, ppm } in CSS pixels per metre
    this._bindFull();
    options.mini.addEventListener('click', () => this.toggle(true));
  }

  // --- Shapes: green, roads, buildings, stand-ins, bucketed in CELL_M cells by bounding box ----------------------------
  _index() {
    const { geo } = this;
    const RG = geo.roadGraph;
    const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
    this.layers = { green: [], roads: [], rail: [], buildings: [], infill: [], elevated: [] };
    this.cells = new Map();
    const add = (layer, flat, extra) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < flat.length; i += 2) { x0 = Math.min(x0, flat[i]); x1 = Math.max(x1, flat[i]); z0 = Math.min(z0, flat[i + 1]); z1 = Math.max(z1, flat[i + 1]); }
      const item = { flat, extra };
      this.layers[layer].push(item);
      for (let i = Math.floor(x0 / CELL_M); i <= Math.floor(x1 / CELL_M); i++) {
        for (let j = Math.floor(z0 / CELL_M); j <= Math.floor(z1 / CELL_M); j++) {
          const k = `${i},${j}`;
          if (!this.cells.has(k)) this.cells.set(k, { green: [], roads: [], rail: [], buildings: [], infill: [], elevated: [] });
          this.cells.get(k)[layer].push(item);
        }
      }
    };
    for (const [, ring] of geo.green || []) add('green', ring);
    for (const [a, b, , w, , , inner] of RG.links) add('roads', [...node(a), ...inner, ...node(b)], w);
    for (const [, w, flat] of geo.rail?.lines || []) add('rail', flat, w);
    for (const [, w, flat] of geo.elevatedRoads?.lines || []) add('elevated', flat, w);
    for (const b of geo.buildings) if (b[4] < 1) add('buildings', b[1]);
    for (const b of geo.infill || []) add('infill', b[1]);
  }

  // The shapes of each layer meeting the world rectangle (all of them without one), each once (within a layer every shape
  // has one colour, so their order doesn't matter)
  _inView(rect) {
    if (!rect) return this.layers;
    const [x0, z0, x1, z1] = rect, out = { green: new Set(), roads: new Set(), rail: new Set(), buildings: new Set(), infill: new Set(), elevated: new Set() };
    for (let i = Math.floor(x0 / CELL_M); i <= Math.floor(x1 / CELL_M); i++) {
      for (let j = Math.floor(z0 / CELL_M); j <= Math.floor(z1 / CELL_M); j++) {
        const c = this.cells.get(`${i},${j}`);
        if (c) for (const k in out) for (const it of c[k]) out[k].add(it);
      }
    }
    return out;
  }

  // Draw the shapes in `rect` (world) with world -> pixel mappings X, Z at `ppm` pixels per metre
  _paint(g, X, Z, ppm, rect) {
    const { c, geo } = this;
    const L = this._inView(rect);
    const poly = (flat, fill) => {
      g.beginPath();
      for (let i = 0; i < flat.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(flat[i]), Z(flat[i + 1]));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    for (const { flat } of L.green) poly(flat, c.green);
    // Roads: an edge stroke under a lighter fill, at their drawn widths
    const strokeRoads = (colour, extra, list = L.roads) => {
      g.strokeStyle = colour;
      g.lineCap = g.lineJoin = 'round';
      for (const { flat, extra: w } of list) {
        g.lineWidth = Math.max(1, (w + extra) * ppm);
        g.beginPath();
        for (let i = 0; i < flat.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(flat[i]), Z(flat[i + 1]));
        g.stroke();
      }
    };
    strokeRoads(c.roadEdge, 2);
    strokeRoads(c.road, 0);
    g.strokeStyle = c.rail;
    for (const { flat, extra: w } of L.rail) {
      g.lineWidth = Math.max(1.5, w * ppm);
      g.beginPath();
      for (let i = 0; i < flat.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(flat[i]), Z(flat[i + 1]));
      g.stroke();
    }
    for (const { flat } of L.buildings) poly(flat, c.building);
    if (this.showInfill) for (const { flat } of L.infill) poly(flat, c.infill);
    strokeRoads(c.roadEdge, 2, L.elevated);
    strokeRoads(c.road, 0, L.elevated);
    // The area's edge: the district outline(s) when there is one (GEO.frame.boundary), else the box; beyond it, no data
    g.strokeStyle = c.boxEdge;
    g.lineWidth = 2;
    g.setLineDash([8, 6]);
    if (geo.frame.boundary?.length) {
      for (const ring of geo.frame.boundary) {
        g.beginPath();
        for (let i = 0; i < ring.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(ring[i]), Z(ring[i + 1]));
        g.closePath();
        g.stroke();
      }
    } else {
      const [x0, z0, x1, z1] = [this.x0 + PAD_M, this.z0 + PAD_M, this.x1 - PAD_M, this.z1 - PAD_M];
      g.strokeRect(X(x0), Z(z0), X(x1) - X(x0), Z(z1) - Z(z0));
    }
    g.setLineDash([]);
  }

  // The whole area as a bitmap at this.ppm (for the zoomed-out full map)
  get base() {
    const key = this.showInfill ? 'with' : 'without';
    if (!this.bases[key]) {
      const { ppm } = this;
      const cv = document.createElement('canvas');
      cv.width = Math.ceil((this.x1 - this.x0) * ppm);
      cv.height = Math.ceil((this.z1 - this.z0) * ppm);
      const g = cv.getContext('2d');
      g.fillStyle = this.c.ground;
      g.fillRect(0, 0, cv.width, cv.height);
      this._paint(g, (x) => (x - this.x0) * ppm, (z) => (z - this.z0) * ppm, ppm, null);
      this.bases[key] = cv;
    }
    return this.bases[key];
  }

  setInfill(on) {
    this.showInfill = on;
    this.renderFull();
  }

  // Street centre-line segments with names, for "which street is this" on hover
  _streetSegments() {
    const RG = this.geo.roadGraph;
    const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
    const out = [];
    for (const [a, b, n, w, , , inner] of RG.links) {
      const name = RG.names[n];
      if (!name) continue;
      const pts = [node(a)];
      for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
      pts.push(node(b));
      for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1], w / 2, name]);
    }
    return out;
  }

  streetAt(x, z, within = 12) {
    let best = null, bd = within;
    for (const [[x0, z0], [x1, z1], r, name] of this.segs) {
      const dx = x1 - x0, dz = z1 - z0, L2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
      const d = Math.hypot(x0 + dx * t - x, z0 + dz * t - z) - r;
      if (d < bd) { bd = d; best = name; }
    }
    return best;
  }

  // Stations (GEO.rail.stations): a blue disc each, with its name when `labels` (screen-space, drawn over the map)
  _stations(g, X, Z, w, h, size, labels) {
    for (const [name, en, x, z] of this.geo.rail?.stations || []) {
      const px = X(x), py = Z(z);
      if (px < -60 || py < -20 || px > w + 60 || py > h + 20) continue;
      g.beginPath();
      g.arc(px, py, size, 0, Math.PI * 2);
      g.fillStyle = this.c.station;
      g.fill();
      g.lineWidth = Math.max(1, size * 0.3);
      g.strokeStyle = '#fff';
      g.stroke();
      if (!labels) continue;
      g.font = '600 12px system-ui, sans-serif';
      g.textBaseline = 'middle';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      const text = en ? `${name} ${en}` : name;
      g.strokeText(text, px + size + 4, py);
      g.fillStyle = this.c.station;
      g.fillText(text, px + size + 4, py);
    }
  }

  _arrow(g, px, py, heading, size) {
    g.save();
    g.translate(px, py);
    g.rotate(-heading); // heading 0 faces -z = up on the map
    g.beginPath();
    g.moveTo(0, -size);
    g.lineTo(size * 0.62, size * 0.75);
    g.lineTo(0, size * 0.35);
    g.lineTo(-size * 0.62, size * 0.75);
    g.closePath();
    g.fillStyle = this.c.player;
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.fill();
    g.stroke();
    g.restore();
  }

  // --- Minimap: SPAN m across, centred on the player, north up --------------------------------------------------------
  updateMini(span = 320) {
    const cv = this.o.mini;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.round(cv.clientWidth * dpr) || 1;
    if (cv.width !== size) cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const p = this.o.getPlayer();
    const k = size / span; // pixels per metre
    g.fillStyle = this.c.ground;
    g.fillRect(0, 0, size, size);
    this._paint(g, (x) => (x - p.x) * k + size / 2, (z) => (z - p.z) * k + size / 2, k, [p.x - span / 2, p.z - span / 2, p.x + span / 2, p.z + span / 2]);
    this._stations(g, (x) => (x - p.x) * k + size / 2, (z) => (z - p.z) * k + size / 2, size, size, size * 0.035, false);
    this._arrow(g, size / 2, size / 2, p.heading, size * 0.055);
  }

  // --- Full map ----------------------------------------------------------------------------------------------------------
  toggle(open = !this.open) {
    if (open === this.open) return;
    this.open = open;
    this.o.full.hidden = !open;
    if (open) {
      const p = this.o.getPlayer();
      const r = this.o.fullCanvas.getBoundingClientRect();
      const fit = Math.min(r.width / (this.x1 - this.x0), r.height / (this.z1 - this.z0));
      this.view = { cx: (this.x0 + this.x1) / 2, cz: (this.z0 + this.z1) / 2, ppm: fit };
      this.player = p;
      this.renderFull();
    }
    this.o.onToggle?.(open);
  }

  _toWorld(px, py) {
    const r = this.o.fullCanvas.getBoundingClientRect(), v = this.view;
    return [v.cx + (px - r.width / 2) / v.ppm, v.cz + (py - r.height / 2) / v.ppm];
  }

  renderFull() {
    if (!this.open) return;
    const cv = this.o.fullCanvas;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.c.ground;
    g.fillRect(0, 0, r.width, r.height);
    const v = this.view, k = v.ppm / this.ppm;
    if (k <= 1.25 / dpr) {
      // zoomed out: the whole-area bitmap is at least as sharp as the screen
      g.drawImage(this.base, r.width / 2 - (v.cx - this.x0) * v.ppm, r.height / 2 - (v.cz - this.z0) * v.ppm, this.base.width * k, this.base.height * k);
    } else {
      const hw = r.width / 2 / v.ppm, hh = r.height / 2 / v.ppm;
      this._paint(g, (x) => (x - v.cx) * v.ppm + r.width / 2, (z) => (z - v.cz) * v.ppm + r.height / 2, v.ppm, [v.cx - hw, v.cz - hh, v.cx + hw, v.cz + hh]);
    }
    const p = this.o.getPlayer();
    this._stations(g, (x) => (x - v.cx) * v.ppm + r.width / 2, (z) => (z - v.cz) * v.ppm + r.height / 2, r.width, r.height, 5, true);
    this._arrow(g, r.width / 2 + (p.x - v.cx) * v.ppm, r.height / 2 + (p.z - v.cz) * v.ppm, p.heading, 11);
  }

  _bindFull() {
    const cv = this.o.fullCanvas;
    let drag = null;
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); // the point under the pointer stays put
      this.renderFull();
    }, { passive: false });
    // Pinch (two fingers): zoom about their midpoint; a pinch never teleports
    const fingers = new Map();
    let pinch = null;
    const zoomAt = (px, py, f) => {
      const [wx, wz] = this._toWorld(px, py);
      const v = this.view;
      v.ppm = Math.min(12, Math.max(0.15, v.ppm * f));
      const [nx, nz] = this._toWorld(px, py);
      v.cx += wx - nx;
      v.cz += wz - nz;
    };
    cv.addEventListener('pointerdown', (e) => {
      fingers.set(e.pointerId, [e.clientX, e.clientY]);
      cv.setPointerCapture(e.pointerId);
      if (fingers.size === 2) {
        const [[ax, ay], [bx, by]] = [...fingers.values()];
        pinch = Math.hypot(bx - ax, by - ay);
        if (drag) drag.moved = true;
        return;
      }
      drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    cv.addEventListener('pointercancel', (e) => { fingers.delete(e.pointerId); drag = null; pinch = null; });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      if (fingers.has(e.pointerId)) fingers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && fingers.size === 2) {
        const [[ax, ay], [bx, by]] = [...fingers.values()];
        const d = Math.hypot(bx - ax, by - ay);
        zoomAt((ax + bx) / 2 - r.left, (ay + by) / 2 - r.top, d / pinch);
        pinch = d;
        this.renderFull();
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved) {
          this.view.cx -= dx / this.view.ppm;
          this.view.cz -= dy / this.view.ppm;
          drag.x = e.clientX;
          drag.y = e.clientY;
          this.renderFull();
        }
      }
      const [x, z] = this._toWorld(e.clientX - r.left, e.clientY - r.top);
      const street = this.streetAt(x, z);
      if (this.o.hoverInfo) this.o.hoverInfo.textContent = `${street ? `${street} · ` : ''}click to teleport · drag to pan · wheel to zoom · T or Esc to close`;
    });
    cv.addEventListener('pointerup', (e) => {
      fingers.delete(e.pointerId);
      if (pinch) { if (fingers.size < 2) pinch = null; if (drag) drag.moved = true; return; }
      const wasDrag = !drag || drag.moved;
      drag = null;
      if (wasDrag) return;
      const r = cv.getBoundingClientRect();
      const [x, z] = this._toWorld(e.clientX - r.left, e.clientY - r.top);
      if (x < this.x0 || x > this.x1 || z < this.z0 || z > this.z1) return;
      this.o.onTeleport(x, z);
      this.toggle(false);
    });
    window.addEventListener('resize', () => this.renderFull());
  }
}

export { FootprintMap };
