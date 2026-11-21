// Sunseat – Karte: Grundkarte, weiche Sonnen-/Schattenflächen, Café-Pins.
import { shadowShapes } from './shadow.js';

/* global maplibregl */

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const PX_PER_M = 1.6;
const MAX_PX = 2048;

const dark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;

async function loadStyle() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(dark() ? STYLES.dark : STYLES.light, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(r.status);
    return { style: await r.json(), basemap: true };
  } catch {
    // Ohne Grundkarte: eigene Gebäude und Schatten reichen zur Orientierung
    return {
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark() ? '#1f1d1a' : '#f3efe6' } }] },
      basemap: false,
    };
  }
}

export class SunMap {
  constructor(container, { onSelect, onBackgroundClick } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onBackgroundClick = onBackgroundClick;
    this.canvas = document.createElement('canvas');
    this.markers = new Map();
    this.is3d = false;
    this.ready = null;
  }

  init(center) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { style, basemap } = await loadStyle();
      this.basemap = basemap;
      this.map = new maplibregl.Map({
        container: this.container, style,
        center: [center.lon, center.lat], zoom: 16, maxPitch: 70,
        attributionControl: false,
      });
      this.map.addControl(new maplibregl.AttributionControl({
        compact: true,
        customAttribution: (basemap ? '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · ' : '')
          + '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }), 'bottom-left');
      await new Promise((res) => (this.map.loaded() ? res() : this.map.once('load', res)));
      this._addLayers();
      const zoomClass = () => this.container.classList.toggle('show-names', this.map.getZoom() >= 16.3);
      this.map.on('zoom', zoomClass); zoomClass();
      this.map.on('click', (e) => {
        if (!e.originalEvent.target.closest?.('.pin')) this.onBackgroundClick?.();
      });
    })();
    return this.ready;
  }

  _addLayers() {
    const m = this.map;
    const empty = { type: 'FeatureCollection', features: [] };
    const firstSymbol = m.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    // Basiskarten-3D-Gebäude ausblenden, wir haben eigene mit unseren Höhen
    for (const l of m.getStyle().layers) if (l.type === 'fill-extrusion') m.setLayoutProperty(l.id, 'visibility', 'none');

    m.addSource('sunshade', { type: 'canvas', canvas: this.canvas, animate: false, coordinates: [[0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]] });
    m.addLayer({ id: 'sunshade', type: 'raster', source: 'sunshade', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } }, firstSymbol);

    m.addSource('buildings', { type: 'geojson', data: empty });
    if (!this.basemap) {
      m.addLayer({ id: 'buildings-flat', type: 'fill', source: 'buildings',
        paint: { 'fill-color': dark() ? '#36322c' : '#e4ddd1', 'fill-outline-color': dark() ? '#4a443b' : '#d3c9b9' } }, firstSymbol);
    }
    m.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings', layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': dark() ? '#4a443b' : '#efe8dc',
        'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'minH'],
        'fill-extrusion-opacity': 0.92, 'fill-extrusion-vertical-gradient': true,
      } });

    m.addSource('terrace', { type: 'geojson', data: empty });
    m.addLayer({ id: 'terrace', type: 'circle', source: 'terrace',
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  }

  setArea({ place, proj, buildings, radius, extent }) {
    if (!this.map) return;
    this.proj = proj; this.buildings = buildings; this.extent = extent; this.radius = radius;
    const toLL = (x, y) => { const [la, lo] = proj.toLatLon(x, y); return [lo, la]; };
    this.map.getSource('buildings').setData({
      type: 'FeatureCollection',
      features: buildings.map((b) => ({
        type: 'Feature', properties: { h: b.h, minH: b.minH || 0 },
        geometry: { type: 'Polygon', coordinates: [...b.outer, ...b.inner].map((r) => r.map(([x, y]) => toLL(x, y))) },
      })),
    });
    const size = Math.min(MAX_PX, Math.round(2 * extent * PX_PER_M));
    this.canvas.width = size; this.canvas.height = size;
    this.map.getSource('sunshade').setCoordinates([toLL(-extent, extent), toLL(extent, extent), toLL(extent, -extent), toLL(-extent, -extent)]);

    if (!this.me) {
      const el = document.createElement('div');
      el.className = 'me-dot';
      this.me = new maplibregl.Marker({ element: el }).setLngLat([place.lon, place.lat]).addTo(this.map);
    } else this.me.setLngLat([place.lon, place.lat]);
    for (const { marker } of this.markers.values()) marker.remove();
    this.markers.clear();
    this.map.jumpTo({ center: [place.lon, place.lat], zoom: radius > 600 ? 15.2 : 16 });
  }

  /** Weiche Sonnen- und Schattenflächen, nach außen ausgeblendet. */
  drawSun(sun) {
    if (!this.map || !this.buildings) return;
    const cv = this.canvas, g = cv.getContext('2d');
    const E = this.extent, s = cv.width / (2 * E);
    const X = (x) => (x + E) * s, Y = (y) => (E - y) * s;
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cv.width, cv.height);
    if (sun.altDeg <= 0.5) {
      g.fillStyle = dark() ? 'rgba(10,14,40,0.55)' : 'rgba(40,50,110,0.28)';
      g.fillRect(0, 0, cv.width, cv.height);
    } else {
      g.fillStyle = dark() ? 'rgba(255,190,70,0.20)' : 'rgba(255,200,60,0.30)';
      g.fillRect(0, 0, cv.width, cv.height);
      const shapes = shadowShapes(this.buildings, sun);
      g.filter = 'blur(1.5px)';
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      this._path(g, shapes, X, Y);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = dark() ? 'rgba(20,30,80,0.45)' : 'rgba(70,90,170,0.26)';
      this._path(g, shapes, X, Y);
      g.filter = 'none';
    }
    // Dächer ausstanzen
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    this._path(g, this.buildings.flatMap((b) => b.outer.map((r) => r.slice(0, -1))), X, Y);
    // Rand weich ausblenden
    g.globalCompositeOperation = 'destination-in';
    const r0 = (this.radius + 60) * s, r1 = (E - 10) * s;
    const grad = g.createRadialGradient(cv.width / 2, cv.height / 2, r0, cv.width / 2, cv.height / 2, Math.max(r1, r0 + 1));
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, cv.width, cv.height);
    g.restore();
    const src = this.map.getSource('sunshade');
    src.play();
    this.map.once('render', () => src.pause());
  }

  _path(g, polys, X, Y) {
    g.beginPath();
    for (const poly of polys) {
      if (poly.length < 3) continue;
      g.moveTo(X(poly[0][0]), Y(poly[0][1]));
      for (let i = 1; i < poly.length; i++) g.lineTo(X(poly[i][0]), Y(poly[i][1]));
      g.closePath();
    }
    g.fill('nonzero');
  }

  /** items: [{id, lat, lon, name, emoji, cls, closed, hidden, samples:[{lat,lon,lit}]}] */
  setCafes(items, selectedId) {
    if (!this.map) return;
    const seen = new Set();
    for (const it of items) {
      seen.add(it.id);
      let m = this.markers.get(it.id);
      if (!m) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'pin';
        el.innerHTML = '<span class="pin-bubble"><span class="pin-icon"></span><span class="pin-name"></span></span><span class="pin-tip"></span>';
        el.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect?.(it.id); });
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([it.lon, it.lat]).addTo(this.map);
        m = { marker, el, key: '' };
        this.markers.set(it.id, m);
      }
      const sel = it.id === selectedId;
      const key = [it.cls, it.closed, sel, it.hidden, it.name].join('|');
      if (key !== m.key) {
        m.key = key;
        m.el.className = `pin pin-${it.cls}${it.closed ? ' pin-closed' : ''}${sel ? ' pin-selected' : ''}`;
        m.el.hidden = !!it.hidden && !sel;
        m.el.querySelector('.pin-icon').textContent = it.cls === 'sun' && !it.closed ? '☀️' : it.emoji;
        m.el.querySelector('.pin-name').textContent = it.name;
        m.el.setAttribute('aria-label', it.name);
        m.el.style.zIndex = sel ? 30 : it.cls === 'sun' && !it.closed ? 20 : it.cls === 'part' ? 15 : 10;
      }
    }
    for (const [id, m] of this.markers) if (!seen.has(id)) { m.marker.remove(); this.markers.delete(id); }
    const sel = items.find((it) => it.id === selectedId);
    this.map.getSource('terrace').setData({
      type: 'FeatureCollection',
      features: sel ? sel.samples.map((p) => ({
        type: 'Feature', properties: { color: p.lit ? '#ffb020' : '#5b6fb0' },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })) : [],
    });
  }

  setPadding(bottom, top = 0) {
    this.padding = { top, bottom, left: 0, right: 0 };
    this.map?.setPadding(this.padding);
  }

  flyTo(lat, lon, zoom = 18) {
    this.map?.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), zoom), duration: 600 });
  }

  recenter(lat, lon) {
    this.map?.easeTo({ center: [lon, lat], zoom: 16, bearing: 0, duration: 600 });
  }

  toggle3d() {
    if (!this.map) return false;
    this.is3d = !this.is3d;
    this.map.setLayoutProperty('buildings-3d', 'visibility', this.is3d ? 'visible' : 'none');
    this.map.easeTo({ pitch: this.is3d ? 58 : 0, bearing: this.is3d ? (this.map.getBearing() || -25) : 0, duration: 700 });
    return this.is3d;
  }

  resize() { this.map?.resize(); }
}
