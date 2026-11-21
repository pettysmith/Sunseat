// Sunseat – Sonnen-Ebene: Gebäude aus den Vektorkacheln, Schatten für den
// aktuellen Sonnenstand, gezeichnet als Fläche unter den Kartenbeschriftungen.
import { VectorTile, Pbf } from './vendor/vector-tile.js';
import { makeProjection, shadowShapes, roofRings } from './shadow.js';

/* global maplibregl */

const Z = 14;                 // Kachelstufe mit vollen Gebäudedaten
export const MIN_ZOOM = 14;   // darunter wird nichts gerechnet
const MAX_SHADOW_M = 450;     // längster Schatten, der berücksichtigt wird
const OVERSCAN = 0.25;        // Rand um den sichtbaren Ausschnitt (je Seite)

const COLORS = {
  sun: 'rgba(255, 166, 20, 0.40)',
  dim: 'rgba(22, 27, 38, 0.17)',
  night: 'rgba(22, 27, 38, 0.30)',
};

const lon2x = (lon) => (lon + 180) / 360;
const lat2y = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const x2lon = (x) => x * 360 - 180;
const y2lat = (y) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;

export class SunLayer {
  /**
   * @param {maplibregl.Map} map
   * @param {string} tileUrl  Vorlage mit {z}/{x}/{y}
   * @param {{onStatus?:(s:string)=>void}} opts
   */
  constructor(map, tileUrl, { beforeId, onStatus } = {}) {
    this.map = map;
    this.tileUrl = tileUrl;
    this.onStatus = onStatus || (() => {});
    this.tiles = new Map();     // "x/y" -> Promise<Building[]>
    this.sun = null;
    this.proj = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    map.addSource('sunlayer', { type: 'canvas', canvas: this.canvas, animate: false, coordinates: [[0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]] });
    map.addLayer({ id: 'sunlayer', type: 'raster', source: 'sunlayer',
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, beforeId);
    this._frame = 0;
    map.on('moveend', () => this.refresh());
    map.on('resize', () => this.refresh());
  }

  setSun(sun) {
    this.sun = sun;
    this.refresh();
  }

  /** Neu zeichnen, höchstens einmal pro Bild. */
  refresh() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = 0; this._update(); });
  }

  async _update() {
    const map = this.map;
    if (!this.sun) return;
    if (map.getZoom() < MIN_ZOOM) {
      map.setLayoutProperty('sunlayer', 'visibility', 'none');
      this.onStatus('zoom');
      return;
    }
    const region = this._region();
    const need = this._tilesFor(region);
    const missing = need.filter((k) => !this.tiles.has(k));
    if (missing.length) this.onStatus('loading');
    let buildings, water;
    try {
      const tiles = await Promise.all(need.map((k) => this._tile(k)));
      buildings = tiles.flatMap((t) => t.buildings);
      water = tiles.flatMap((t) => t.water);
    } catch {
      this.onStatus('error');
      return;
    }
    // Inzwischen weitergeschoben? Dann zeichnet der nächste Durchlauf.
    if (this._regionKey(this._region()) !== this._regionKey(region)) { this.refresh(); return; }
    this._draw(region, buildings, water);
    map.setLayoutProperty('sunlayer', 'visibility', 'visible');
    this.onStatus('ok');
  }

  /** Sichtbarer Ausschnitt plus Rand, in Web-Mercator (0..1). */
  _region() {
    const map = this.map;
    const c = map.getCanvas();
    const w = c.clientWidth, h = c.clientHeight;
    const center = map.getCenter();
    const world = 512 * 2 ** map.getZoom();
    const cx = lon2x(center.lng), cy = lat2y(center.lat);
    const fw = (w * (1 + 2 * OVERSCAN)) / world, fh = (h * (1 + 2 * OVERSCAN)) / world;
    return { x0: cx - fw / 2, x1: cx + fw / 2, y0: cy - fh / 2, y1: cy + fh / 2, w, h, zoom: map.getZoom() };
  }

  _regionKey(r) { return [r.x0, r.y0, r.zoom].map((v) => v.toFixed(7)).join(','); }

  _tilesFor(r) {
    // Gebäude südlich (bzw. in Sonnenrichtung) außerhalb des Ausschnitts werfen Schatten hinein
    const lat = y2lat((r.y0 + r.y1) / 2);
    const mPerUnit = 40075016.7 * Math.cos((lat * Math.PI) / 180);
    const pad = MAX_SHADOW_M / mPerUnit;
    const n = 2 ** Z;
    const keys = [];
    for (let x = Math.floor((r.x0 - pad) * n); x <= Math.floor((r.x1 + pad) * n); x++)
      for (let y = Math.floor((r.y0 - pad) * n); y <= Math.floor((r.y1 + pad) * n); y++) keys.push(`${x}/${y}`);
    return keys;
  }

  _tile(key) {
    if (!this.tiles.has(key)) {
      const p = (async () => {
        const [x, y] = key.split('/').map(Number);
        const url = this.tileUrl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
        const r = await fetch(url);
        if (r.status === 204 || r.status === 404) return { buildings: [], water: [] };
        if (!r.ok) throw new Error('Kachel ' + r.status);
        const vt = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
        const layer = vt.layers.building;
        if (!this.proj) {
          this.proj = makeProjection(y2lat((y + 0.5) / 2 ** Z), x2lon((x + 0.5) / 2 ** Z));
        }
        const toRings = (poly) => poly.map((ring) => {
          const pts = ring.map(([lo, la]) => this.proj.toXY(la, lo));
          const a = pts[0], b = pts[pts.length - 1];
          if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]]);
          return pts;
        });
        const polysOf = (f) => {
          const gj = f.toGeoJSON(x, y, Z).geometry;
          return gj.type === 'Polygon' ? [gj.coordinates] : gj.type === 'MultiPolygon' ? gj.coordinates : [];
        };
        // Wasser bekommt keine Sonnenfarbe – dort sitzt niemand
        const water = [];
        const wl = vt.layers.water;
        for (let i = 0; wl && i < wl.length; i++) {
          for (const poly of polysOf(wl.feature(i))) {
            const rings = toRings(poly);
            water.push({ outer: [rings[0]], inner: rings.slice(1) });
          }
        }
        const out = [];
        for (let i = 0; layer && i < layer.length; i++) {
          const f = layer.feature(i);
          const h = +f.properties.render_height || 0;
          if (h <= 0) continue;
          const minH = +f.properties.render_min_height || 0;
          for (const poly of polysOf(f)) {
            const rings = toRings(poly);
            out.push({ outer: [rings[0]], inner: rings.slice(1), h, minH });
          }
        }
        return { buildings: out, water };
      })();
      p.catch(() => this.tiles.delete(key)); // bei Fehler später erneut versuchen
      this.tiles.set(key, p);
    }
    return this.tiles.get(key);
  }

  _draw(r, buildings, water) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(r.w * (1 + 2 * OVERSCAN) * dpr), H = Math.round(r.h * (1 + 2 * OVERSCAN) * dpr);
    const cv = this.canvas;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    const sx = W / (r.x1 - r.x0), sy = H / (r.y1 - r.y0);
    const proj = this.proj;
    const px = (p) => {
      const [la, lo] = proj.toLatLon(p[0], p[1]);
      return [(lon2x(lo) - r.x0) * sx, (lat2y(la) - r.y0) * sy];
    };
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);

    if (this.sun.altDeg <= 0.5) {
      g.fillStyle = COLORS.night;
      g.fillRect(0, 0, W, H);
    } else {
      // Ausschnitt in lokalen Metern, um nur relevante Gebäude zu nehmen
      const [ax, ay] = proj.toXY(y2lat(r.y1), x2lon(r.x0));
      const [bx, by] = proj.toXY(y2lat(r.y0), x2lon(r.x1));
      const pad = MAX_SHADOW_M;
      const near = buildings.filter((b) => {
        const ring = b.outer[0];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        return maxX > ax - pad && minX < bx + pad && maxY > ay - pad && minY < by + pad;
      });
      // Schatten und Dächer zusammen als ein Pfad: alles darin ist „keine Sonne am Boden“
      const shapes = shadowShapes(near, this.sun, MAX_SHADOW_M, { footprints: false }).concat(roofRings(near));
      g.fillStyle = COLORS.sun;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      this._fill(g, shapes, px);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = COLORS.dim;
      this._fill(g, shapes, px);
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      this._fill(g, roofRings(water), px);
      g.globalCompositeOperation = 'source-over';
    }
    const src = this.map.getSource('sunlayer');
    src.setCoordinates([[x2lon(r.x0), y2lat(r.y0)], [x2lon(r.x1), y2lat(r.y0)], [x2lon(r.x1), y2lat(r.y1)], [x2lon(r.x0), y2lat(r.y1)]]);
    src.play();
    this.map.once('render', () => src.pause());
  }

  _fill(g, polys, px) {
    g.beginPath();
    for (const poly of polys) {
      if (poly.length < 3) continue;
      const [x0, y0] = px(poly[0]);
      g.moveTo(x0, y0);
      for (let i = 1; i < poly.length; i++) { const [x, y] = px(poly[i]); g.lineTo(x, y); }
      g.closePath();
    }
    g.fill('nonzero');
  }
}
