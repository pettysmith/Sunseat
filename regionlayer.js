// Sunseat – Ebene für weiten Zoom: Tag, Dämmerung, Nacht und (ab Zoom 4) Sonne oder Wolken.
// Sonnenhöhe wird an einem groben Raster über dem Ausschnitt berechnet, das Wetter an
// höchstens 7 × 7 Punkten (eine Open-Meteo-Abfrage); dazwischen wird weich interpoliert.

/* global SunCalc */

export const REGION_MAX_ZOOM = 14;   // darüber übernimmt die Gebäudeschatten-Ebene
const WEATHER_MIN_ZOOM = 4;          // darunter wäre ein 7 × 7-Raster zu grob
const GRID = 7;

const lon2x = (lon) => (lon + 180) / 360;
const lat2y = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const x2lon = (x) => x * 360 - 180;
const y2lat = (y) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90;
const clampLat = (v) => Math.max(-84, Math.min(84, v));

const utcKey = (d) => d.toISOString().slice(0, 13);

export class RegionLayer {
  constructor(map, { beforeId } = {}) {
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = 1;
    this.date = new Date();
    this.weather = null;       // { key, bounds:[w,s,e,n], pts:[{lat,lon,byHour:Map}] }
    map.addSource('region', { type: 'canvas', canvas: this.canvas, animate: false, coordinates: [[0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]] });
    map.addLayer({ id: 'region', type: 'raster', source: 'region', maxzoom: REGION_MAX_ZOOM,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, beforeId);
    map.on('moveend', () => { this.refresh(); this._loadWeather(); });
    this._frame = 0;
    this._loadWeather();
  }

  setDate(date) { this.date = date; this.refresh(); }

  refresh() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = 0; this._draw(); });
  }

  /** Wetter an einem 7 × 7-Raster über dem Ausschnitt (UTC-Stunden, 7 Tage). */
  async _loadWeather() {
    const map = this.map;
    if (map.getZoom() < WEATHER_MIN_ZOOM || map.getZoom() >= REGION_MAX_ZOOM) return;
    const b = map.getBounds();
    const w = b.getWest(), e = b.getEast(), s = clampLat(b.getSouth()), n = clampLat(b.getNorth());
    // Raster auf ein grobes Gitter einrasten, damit kleine Verschiebungen dieselbe Abfrage nutzen
    const step = Math.max(0.05, (e - w) / 12);
    const lo = (v) => Math.floor(v / step) * step, hi = (v) => Math.ceil(v / step) * step;
    const bw = lo(w), bs = lo(s), be = hi(e), bn = hi(n);
    const key = [bw, bs, be, bn].map((v) => v.toFixed(3)).join(',');
    if (this.weather?.key === key || this._loading === key) return;
    this._loading = key;
    const lats = [], lons = [];
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      lats.push((bs + ((bn - bs) * j) / (GRID - 1)).toFixed(3));
      lons.push((((bw + ((be - bw) * i) / (GRID - 1)) + 540) % 360 - 180).toFixed(3));
    }
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&hourly=sunshine_duration&forecast_days=7&timezone=GMT`;
      const res = await fetch(u);
      if (!res.ok) throw new Error(res.status);
      const arr = await res.json();
      const list = Array.isArray(arr) ? arr : [arr];
      this.weather = {
        key, bounds: [bw, bs, be, bn],
        pts: list.map((d) => new Map(d.hourly.time.map((t, k) => [t.slice(0, 13), d.hourly.sunshine_duration[k]]))),
      };
      this.refresh();
    } catch { /* ohne Wetter: nur Tag und Nacht */ } finally { this._loading = null; }
  }

  /** Anteil Sonnenschein (0..1) an einer Stelle; null ohne Daten. Summen gelten für die vorangehende Stunde. */
  _sunshine(lat, lon, keyNext) {
    const W = this.weather;
    if (!W) return null;
    const [w, s, e, n] = W.bounds;
    if (lon < w || lon > e || lat < s || lat > n) return null;
    const fx = ((lon - w) / (e - w)) * (GRID - 1), fy = ((lat - s) / (n - s)) * (GRID - 1);
    const i0 = Math.min(GRID - 2, Math.floor(fx)), j0 = Math.min(GRID - 2, Math.floor(fy));
    const tx = fx - i0, ty = fy - j0;
    const v = (i, j) => { const m = W.pts[j * GRID + i]; const x = m?.get(keyNext); return x == null ? null : x / 3600; };
    const a = v(i0, j0), b = v(i0 + 1, j0), c = v(i0, j0 + 1), d = v(i0 + 1, j0 + 1);
    if ([a, b, c, d].some((x) => x == null)) return null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  _draw() {
    const map = this.map;
    const z = map.getZoom();
    if (z >= REGION_MAX_ZOOM) return;
    const c = map.getCanvas();
    // Grobe Auflösung genügt (wird von der Karte weich vergrößert)
    const W = Math.max(8, Math.round(c.clientWidth / 3)), H = Math.max(8, Math.round(c.clientHeight / 3));
    const b = map.getBounds();
    let x0 = lon2x(Math.max(-180, b.getWest())), x1 = lon2x(Math.min(180, b.getEast()));
    const y0 = lat2y(clampLat(b.getNorth())), y1 = lat2y(clampLat(b.getSouth()));
    if (x1 <= x0) { x0 = 0; x1 = 1; }
    const cv = this.canvas;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    const img = g.createImageData(W, H);
    const d = this.date;
    const next = new Date(d); next.setUTCMinutes(0, 0, 0); next.setUTCHours(next.getUTCHours() + 1);
    const keyNext = utcKey(next);
    const useWeather = z >= WEATHER_MIN_ZOOM;
    for (let j = 0; j < H; j++) {
      const lat = y2lat(y0 + ((y1 - y0) * (j + 0.5)) / H);
      for (let i = 0; i < W; i++) {
        const lon = x2lon(x0 + ((x1 - x0) * (i + 0.5)) / W);
        const alt = (SunCalc.getPosition(d, lat, lon).altitude * 180) / Math.PI;
        let r, gg, bb, a;
        if (alt < -6) { r = 18; gg = 24; bb = 46; a = 0.42; }                  // Nacht
        else if (alt < 0) { const t = (alt + 6) / 6; r = 18; gg = 24; bb = 46; a = 0.42 - t * 0.22; } // Dämmerung
        else {
          const sh = useWeather ? this._sunshine(lat, lon, keyNext) : null;
          if (sh == null) { r = 0; gg = 0; bb = 0; a = 0; }                    // Tag, Wetter unbekannt: neutral
          else { // Sonne warm, Wolken grau
            r = Math.round(120 + 135 * sh); gg = Math.round(126 + 44 * sh); bb = Math.round(138 - 108 * sh); a = 0.18 + 0.12 * sh;
          }
        }
        const o = (j * W + i) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = Math.round(a * 255);
      }
    }
    g.putImageData(img, 0, 0);
    const src = map.getSource('region');
    src.setCoordinates([[x2lon(x0), y2lat(y0)], [x2lon(x1), y2lat(y0)], [x2lon(x1), y2lat(y1)], [x2lon(x0), y2lat(y1)]]);
    src.play();
    map.once('render', () => src.pause());
  }
}
