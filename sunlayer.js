// Sunseat – Sonnen-Ebene: Gebäude aus den Vektorkacheln, Schatten für den
// aktuellen Sonnenstand, gezeichnet als Fläche unter den Kartenbeschriftungen.
import { VectorTile, Pbf } from './vendor/vector-tile.js';
import { makeProjection, shadowShapes, roofRings } from './shadow.js';
import { fetchTrees, toLocal, treeShadows } from './trees.js';

/* global maplibregl */

const Z = 14;                 // Kachelstufe mit vollen Gebäudedaten
export const MIN_ZOOM = 14;   // darunter wird nichts gerechnet
const MAX_SHADOW_M = 450;     // längster Schatten, der berücksichtigt wird
const OVERSCAN = 0.25;        // Rand um den sichtbaren Ausschnitt (je Seite)

const COLORS = {
  sun: 'rgba(255, 166, 20, 0.40)',
  sunCloudy: 'rgba(255, 166, 20, 0.14)',
  dimSolid: 'rgb(22, 27, 38)',
  dimAlpha: 0.17,
  night: 'rgba(22, 27, 38, 0.30)',
};

const lon2x = (lon) => (lon + 180) / 360;
const lat2y = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const x2lon = (x) => x * 360 - 180;
const y2lat = (y) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;

function centroid(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

export class SunLayer {
  /**
   * @param {maplibregl.Map} map
   * @param {string} tileUrl  Vorlage mit {z}/{x}/{y}
   * @param {{onStatus?:(s:string)=>void}} opts
   */
  constructor(map, tileUrl, { beforeId, onStatus, onTrees } = {}) {
    this.map = map;
    this.tileUrl = tileUrl;
    this.onStatus = onStatus || (() => {});
    this.onTrees = onTrees || (() => {});
    this.treeTiles = new Map(); // Kachel -> { trees | null (lädt) }
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

  /** Genaues 3D-Modell (LoD2) für ein Teilgebiet; ersetzt dort die OSM-Gebäude. */
  setLod2(lod) {
    this.lod2 = lod;
    this.refresh();
  }

  /** Bei bedecktem Himmel die Sonnenfläche deutlich zurücknehmen. */
  setCloudy(cloudy) {
    if (this.cloudy === cloudy) return;
    this.cloudy = cloudy;
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
      // Bäume nur für den sichtbaren Bereich (+100 m); sie kommen später nach und lösen dann ein Neuzeichnen aus
      const treeKeys = this._tilesFor(region, 100);
      this._requestTrees(treeKeys);
      this._trees = this.treesFor(treeKeys);
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
  /** Kachel-Schlüssel um einen Punkt (mit Rand für lange Schatten). */
  tilesAround(lat, lon, padM = MAX_SHADOW_M) {
    const n = 2 ** Z;
    const mPerUnit = 40075016.7 * Math.cos((lat * Math.PI) / 180);
    const x = lon2x(lon), y = lat2y(lat), pad = padM / mPerUnit;
    const keys = [];
    for (let tx = Math.floor((x - pad) * n); tx <= Math.floor((x + pad) * n); tx++)
      for (let ty = Math.floor((y - pad) * n); ty <= Math.floor((y + pad) * n); ty++) keys.push(`${tx}/${ty}`);
    return keys;
  }

  /** Kacheln laden: { buildings, water, pois } zusammengefasst. */
  async load(keys) {
    const tiles = await Promise.all(keys.map((k) => this._tile(k)));
    return {
      buildings: tiles.flatMap((t) => t.buildings),
      pois: tiles.flatMap((t) => t.pois),
    };
  }

  /** Bäume (Hamburger Baumkataster) nachladen, ohne auf sie zu warten; höchstens zwei Abfragen gleichzeitig. */
  _requestTrees(keys) {
    for (const k of keys) if (!this.treeTiles.has(k)) { this.treeTiles.set(k, null); (this._treeQueue ||= []).push(k); }
    this._pumpTrees();
  }

  _pumpTrees() {
    this._treeActive ||= 0;
    while (this._treeActive < 2 && this._treeQueue?.length) {
      const key = this._treeQueue.shift();
      const [x, y] = key.split('/').map(Number);
      const n = 2 ** Z;
      this._treeActive++;
      fetchTrees({ w: x2lon(x / n), e: x2lon((x + 1) / n), n: y2lat(y / n), s: y2lat((y + 1) / n) })
        .then(async (raw) => {
          if (!this.proj) await this._tile(key).catch(() => {}); // Projektion kommt mit der ersten Gebäudekachel
          this.treeTiles.set(key, toLocal(raw, this.proj));
          if (raw.length) { this.refresh(); this.onTrees(); }
        })
        .catch(() => this.treeTiles.set(key, []))
        .finally(() => { this._treeActive--; this._pumpTrees(); });
    }
  }

  /** Bereits geladene Bäume in diesen Kacheln (sofort, ohne zu warten). */
  treesFor(keys) {
    return keys.flatMap((k) => this.treeTiles.get(k) || []);
  }

  /** Anzahl geladener Baumkacheln (für Caches, die neu rechnen müssen, wenn Bäume dazukommen). */
  treeVersion(keys) {
    return keys.filter((k) => this.treeTiles.get(k)).length;
  }

  /** Sichtbare Kacheln (ohne Rand). */
  visibleTiles() {
    const b = this.map.getBounds();
    const n = 2 ** Z, keys = [];
    for (let x = Math.floor(lon2x(b.getWest()) * n); x <= Math.floor(lon2x(b.getEast()) * n); x++)
      for (let y = Math.floor(lat2y(b.getNorth()) * n); y <= Math.floor(lat2y(b.getSouth()) * n); y++) keys.push(`${x}/${y}`);
    return keys;
  }

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

  _tilesFor(r, padM = MAX_SHADOW_M) {
    // Gebäude südlich (bzw. in Sonnenrichtung) außerhalb des Ausschnitts werfen Schatten hinein
    const lat = y2lat((r.y0 + r.y1) / 2);
    const mPerUnit = 40075016.7 * Math.cos((lat * Math.PI) / 180);
    const pad = padM / mPerUnit;
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
        if (r.status === 204 || r.status === 404) return { buildings: [], water: [], pois: [] };
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
        // Cafés und Bars aus den Kacheln (Ersatz, falls Overpass nicht antwortet)
        const pois = [];
        const pl = vt.layers.poi;
        for (let i = 0; pl && i < pl.length; i++) {
          const f = pl.feature(i);
          const sub = f.properties.subclass;
          const kind = sub === 'cafe' ? 'cafe' : (sub === 'bar' || sub === 'pub' || sub === 'biergarten') ? 'bar' : null;
          if (!kind || !f.properties.name) continue;
          const g = f.toGeoJSON(x, y, Z).geometry;
          if (g.type !== 'Point') continue;
          pois.push({ id: 't' + f.id, name: f.properties.name, kind, sub, lon: g.coordinates[0], lat: g.coordinates[1], tags: {} });
        }
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
        return { buildings: out, water, pois };
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
      // Alles, was keine Sonne am Boden hat (Schatten + Dächer), in eine Maske zeichnen.
      // In kleinen Portionen gefüllt: ein einziger Riesenpfad mit zehntausenden
      // überlappenden Flächen ist beim Füllen extrem langsam.
      const mask = (this.mask ||= document.createElement('canvas'));
      if (mask.width !== W || mask.height !== H) { mask.width = W; mask.height = H; }
      const m = mask.getContext('2d');
      m.globalCompositeOperation = 'source-over';
      m.clearRect(0, 0, W, H);
      m.fillStyle = '#000';
      const P = this._affine(r, px);
      // Im LoD2-Gebiet die OSM-Gebäude durch das 3D-Modell ersetzen
      const lod = this.lod2;
      const osm = lod ? near.filter((b) => { const [cx, cy] = centroid(b.outer[0]); return !lod.covers(cx, cy); }) : near;
      // Dächer: Außenring und Höfe gegenläufig, damit „nonzero“ die Höfe frei lässt
      this._chunks(m, roofRings(osm), P, 120);
      if (lod) { this._chunks(m, lod.footprints(), P, 120); this._chunks(m, lod.shadowPolys(this.sun), P, 150, W, H); }
      // Schattenvierecke, alle gleich orientiert
      this._chunks(m, shadowShapes(osm, this.sun, MAX_SHADOW_M, { footprints: false }), P, 150, W, H);
      // Baumkronen (nur belaubt)
      if (this._trees?.length && this.sun.date) this._chunks(m, treeShadows(this._trees, this.sun, this.sun.date), P, 150, W, H);

      g.fillStyle = this.cloudy ? COLORS.sunCloudy : COLORS.sun;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(mask, 0, 0);
      m.globalCompositeOperation = 'source-in';
      m.fillStyle = COLORS.dimSolid;
      m.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = COLORS.dimAlpha;
      g.drawImage(mask, 0, 0);
      g.globalAlpha = 1;
      // Wasser neutral lassen
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      this._chunks(g, roofRings(water), P, 120);
      g.globalCompositeOperation = 'source-over';
    }
    const src = this.map.getSource('sunlayer');
    src.setCoordinates([[x2lon(r.x0), y2lat(r.y0)], [x2lon(r.x1), y2lat(r.y0)], [x2lon(r.x1), y2lat(r.y1)], [x2lon(r.x0), y2lat(r.y1)]]);
    src.play();
    this.map.once('render', () => src.pause());
  }

  /** Lokale Meter -> Canvas-Pixel als affine Näherung (genau genug über wenige Kilometer). */
  _affine(r, px) {
    const [cx, cy] = this.proj.toXY(y2lat((r.y0 + r.y1) / 2), x2lon((r.x0 + r.x1) / 2));
    const o = px([cx, cy]), ex = px([cx + 1000, cy]), ey = px([cx, cy + 1000]);
    const ax = (ex[0] - o[0]) / 1000, ay = (ex[1] - o[1]) / 1000, bx = (ey[0] - o[0]) / 1000, by = (ey[1] - o[1]) / 1000;
    return (x, y) => [o[0] + (x - cx) * ax + (y - cy) * bx, o[1] + (x - cx) * ay + (y - cy) * by];
  }

  /** Polygone in Portionen füllen (nonzero); Polygone ganz außerhalb von W×H werden übersprungen. */
  _chunks(g, polys, P, size, W = Infinity, H = Infinity) {
    let n = 0;
    g.beginPath();
    for (const poly of polys) {
      if (poly.length < 3) continue;
      const pts = poly.map(([x, y]) => P(x, y));
      if (W !== Infinity) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (maxX < 0 || maxY < 0 || minX > W || minY > H) continue;
      }
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      if (++n % size === 0) { g.fill('nonzero'); g.beginPath(); }
    }
    g.fill('nonzero');
  }

}
