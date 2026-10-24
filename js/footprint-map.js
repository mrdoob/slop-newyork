// js/footprint-map.js
// A minimap and a full map for footprint cities, drawn from the same data as the 3D city (GEO.buildings, GEO.infill,
// GEO.roadGraph, GEO.green, GEO.frame.box & .boundary): the minimap follows the player north-up; the full map shows the whole area,
// zooms with the wheel, pans by dragging, names the street under the pointer and teleports the player where it is
// clicked. City-agnostic: colours and labels come in through `options`.
//
// new FootprintMap(geo, { mini, full, fullCanvas, hoverInfo, getPlayer, onTeleport, onToggle, colours })
//   mini        <canvas> for the minimap (clicking it opens the full map)
//   full        the full map's container (hidden when closed); fullCanvas its <canvas>; hoverInfo a text element
//   getPlayer   () => { x, z, heading } (heading: forward = (-sin h, -cos h)), drawn as an arrow
//   onTeleport  (x, z) => void, from a click on the full map
//   onToggle    (open) => void

const DEFAULT_COLOURS = {
  ground: '#d9d6cf', green: '#a9c79a', road: '#fbfaf7', roadEdge: '#bdb8ae', building: '#8f8a83', infill: '#b3a9c9',
  player: '#d8322a', boxEdge: 'rgba(40, 44, 52, 0.45)', label: '#2a2d33'
};
const PAD_M = 40; // m of ground drawn around the box

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
    this.ppm = Math.min(2, 2400 / Math.max(this.x1 - this.x0, this.z1 - this.z0)); // static layer pixels per metre
    this.base = this._drawBase();
    this.segs = this._streetSegments();
    this.view = null; // full map: { cx, cz, ppm } in CSS pixels per metre
    this._bindFull();
    options.mini.addEventListener('click', () => this.toggle(true));
  }

  // --- The static layer: ground, green, roads, buildings, stand-ins, drawn once ----------------------------------------
  _drawBase() {
    const { geo, c, ppm } = this;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((this.x1 - this.x0) * ppm);
    cv.height = Math.ceil((this.z1 - this.z0) * ppm);
    const g = cv.getContext('2d');
    const X = (x) => (x - this.x0) * ppm, Z = (z) => (z - this.z0) * ppm;
    g.fillStyle = c.ground;
    g.fillRect(0, 0, cv.width, cv.height);
    const poly = (flat, fill) => {
      g.beginPath();
      for (let i = 0; i < flat.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, X(flat[i]), Z(flat[i + 1]));
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    for (const [, ring] of geo.green || []) poly(ring, c.green);
    // Roads: an edge stroke under a lighter fill, at their drawn widths
    const RG = geo.roadGraph;
    const node = (i) => [RG.nodes[2 * i], RG.nodes[2 * i + 1]];
    const strokeLinks = (colour, extra) => {
      g.strokeStyle = colour;
      g.lineCap = g.lineJoin = 'round';
      for (const [a, b, , w, , , inner] of RG.links) {
        g.lineWidth = Math.max(1, (w + extra) * ppm);
        g.beginPath();
        g.moveTo(X(node(a)[0]), Z(node(a)[1]));
        for (let i = 0; i < inner.length; i += 2) g.lineTo(X(inner[i]), Z(inner[i + 1]));
        g.lineTo(X(node(b)[0]), Z(node(b)[1]));
        g.stroke();
      }
    };
    strokeLinks(c.roadEdge, 2);
    strokeLinks(c.road, 0);
    for (const b of geo.buildings) if (b[4] < 1) poly(b[1], c.building);
    for (const b of geo.infill || []) poly(b[1], c.infill);
    // The area's edge: the district outline when there is one (GEO.frame.boundary), else the box; beyond it, no data
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
    } else g.strokeRect(PAD_M * ppm, PAD_M * ppm, cv.width - 2 * PAD_M * ppm, cv.height - 2 * PAD_M * ppm);
    return cv;
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
    const s = this.ppm;
    g.fillStyle = this.c.ground;
    g.fillRect(0, 0, size, size);
    g.drawImage(this.base, (p.x - span / 2 - this.x0) * s, (p.z - span / 2 - this.z0) * s, span * s, span * s, 0, 0, size, size);
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
    g.imageSmoothingEnabled = k < 2;
    g.drawImage(this.base, r.width / 2 - (v.cx - this.x0) * v.ppm, r.height / 2 - (v.cz - this.z0) * v.ppm, this.base.width * k, this.base.height * k);
    const p = this.o.getPlayer();
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
