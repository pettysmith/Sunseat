// Sunseat – Kartenansicht: Grundkarte, Sonne/Schatten als Fläche, Cafés als farbige Punkte.
import { shadowShapes } from './shadow.js';

/* global maplibregl */

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const PX_PER_M = 1.6;
const MAX_PX = 2048;

const COLORS = {
  sun: '#f2a51a', part: '#f5d58a', shade: '#6f8193', night: '#3b3f4a', closed: '#b0a89c',
};

function isDark() {
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
}

async function loadStyle() {
  const url = isDark() ? STYLES.dark : STYLES.light;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(r.status);
    return { style: await r.json(), basemap: true };
  } catch {
    // Ohne Grundkarte geht es auch: eigene Gebäude und Schatten reichen zur Orientierung
    return {
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': isDark() ? '#1d1a16' : '#efe9df' } }] },
      basemap: false,
    };
  }
}

export class SunMap {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.ready = null;
    this.canvas = document.createElement('canvas');
    this.selected = null;
    this.is3d = false;
  }

  async init(center) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { style, basemap } = await loadStyle();
      this.basemap = basemap;
      this.hasGlyphs = !!style.glyphs;
      this.map = new maplibregl.Map({
        container: this.container,
        style,
        center: [center.lon, center.lat],
        zoom: 16,
        maxPitch: 70,
        attributionControl: false,
        dragRotate: true,
        pitchWithRotate: true,
      });
      this.map.addControl(new maplibregl.AttributionControl({
        compact: true,
        customAttribution: (basemap ? '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> · ' : '')
          + 'Daten © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>',
      }));
      this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
      await new Promise((res) => (this.map.loaded() ? res() : this.map.once('load', res)));
      this._addLayers();
    })();
    return this.ready;
  }

  _firstSymbolLayer() {
    return this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  }

  _addLayers() {
    const m = this.map;
    const empty = { type: 'FeatureCollection', features: [] };
    const below = this._firstSymbolLayer();
    m.addSource('sunshade', {
      type: 'canvas', canvas: this.canvas, animate: false,
      coordinates: [[0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]],
    });
    m.addLayer({ id: 'sunshade', type: 'raster', source: 'sunshade',
      paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, below);

    m.addSource('buildings', { type: 'geojson', data: empty });
    m.addLayer({ id: 'buildings-flat', type: 'fill', source: 'buildings',
      paint: { 'fill-color': isDark() ? '#3a342c' : '#d9d0c3', 'fill-opacity': this.basemap ? 0.35 : 0.9, 'fill-outline-color': isDark() ? '#4a4238' : '#c4b8a6' } }, below);
    m.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'buildings', layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': isDark() ? '#4a4238' : '#e6ddd0',
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': ['get', 'minH'],
        'fill-extrusion-opacity': 0.85,
      } });

    m.addSource('area', { type: 'geojson', data: empty });
    m.addLayer({ id: 'area', type: 'line', source: 'area',
      paint: { 'line-color': isDark() ? '#f0a040' : '#d9822b', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } });

    m.addSource('terrace', { type: 'geojson', data: empty });
    m.addLayer({ id: 'terrace', type: 'circle', source: 'terrace',
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#2a2118', 'circle-stroke-width': 1.5 } });

    m.addSource('me', { type: 'geojson', data: empty });
    m.addLayer({ id: 'me', type: 'circle', source: 'me',
      paint: { 'circle-radius': 7, 'circle-color': '#2f7bf5', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

    m.addSource('cafes', { type: 'geojson', data: empty });
    m.addLayer({ id: 'cafes', type: 'circle', source: 'cafes',
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 9, 8],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['case', ['get', 'selected'], '#2a2118', '#ffffff'],
        'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
        'circle-opacity': ['case', ['get', 'dim'], 0.55, 1],
      } });
    if (this.hasGlyphs) {
      m.addLayer({ id: 'cafe-labels', type: 'symbol', source: 'cafes', minzoom: 15,
        layout: {
          'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top',
          'text-font': ['Noto Sans Regular'], 'text-optional': true, 'text-max-width': 9,
        },
        paint: { 'text-color': isDark() ? '#f3eadc' : '#2a2118', 'text-halo-color': isDark() ? '#17140f' : '#fffaf2', 'text-halo-width': 1.5 } });
    }
    m.moveLayer('terrace');
    m.on('click', 'cafes', (e) => {
      const f = e.features?.[0];
      if (f) this.onSelect?.(f.properties.id);
    });
    m.on('mouseenter', 'cafes', () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', 'cafes', () => { m.getCanvas().style.cursor = ''; });
  }

  /** Neue Umgebung: Gebäude, Umkreis, Standort. */
  setArea({ place, proj, buildings, radius, extent }) {
    if (!this.map) return;
    this.proj = proj;
    this.buildings = buildings;
    this.extent = extent;
    const toLL = (x, y) => { const [la, lo] = proj.toLatLon(x, y); return [lo, la]; };
    const feats = buildings.map((b) => ({
      type: 'Feature', properties: { h: b.h, minH: b.minH || 0 },
      geometry: { type: 'Polygon', coordinates: [...b.outer, ...b.inner].map((r) => r.map(([x, y]) => toLL(x, y))) },
    }));
    this.map.getSource('buildings').setData({ type: 'FeatureCollection', features: feats });
    const circle = [];
    for (let a = 0; a <= 64; a++) circle.push(toLL(Math.cos((a / 32) * Math.PI) * radius, Math.sin((a / 32) * Math.PI) * radius));
    this.map.getSource('area').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: circle } });
    this.map.getSource('me').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [place.lon, place.lat] } });

    const size = Math.min(MAX_PX, Math.round(2 * extent * PX_PER_M));
    this.canvas.width = size; this.canvas.height = size;
    this.map.getSource('sunshade').setCoordinates([toLL(-extent, extent), toLL(extent, extent), toLL(extent, -extent), toLL(-extent, -extent)]);
    this.map.jumpTo({ center: [place.lon, place.lat], zoom: radius > 600 ? 15 : 16 });
  }

  /** Sonne/Schatten für einen Sonnenstand zeichnen. */
  drawSun(sun) {
    if (!this.map || !this.buildings) return;
    const cv = this.canvas, g = cv.getContext('2d');
    const E = this.extent, s = cv.width / (2 * E);
    const X = (x) => (x + E) * s, Y = (y) => (E - y) * s;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cv.width, cv.height);
    if (sun.altDeg <= 0.5) {
      g.fillStyle = 'rgba(30,36,48,0.55)';
      g.fillRect(0, 0, cv.width, cv.height);
    } else {
      g.fillStyle = 'rgba(255,196,60,0.55)';       // Sonne
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = 'rgba(46,78,150,0.85)';        // Schatten
      g.beginPath();
      for (const poly of shadowShapes(this.buildings, sun)) {
        g.moveTo(X(poly[0][0]), Y(poly[0][1]));
        for (let i = 1; i < poly.length; i++) g.lineTo(X(poly[i][0]), Y(poly[i][1]));
        g.closePath();
      }
      g.fill('nonzero');
    }
    // Dächer ausstanzen, damit Gebäude neutral bleiben
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.beginPath();
    for (const b of this.buildings) {
      for (const ring of b.outer) {
        g.moveTo(X(ring[0][0]), Y(ring[0][1]));
        for (let i = 1; i < ring.length; i++) g.lineTo(X(ring[i][0]), Y(ring[i][1]));
        g.closePath();
      }
    }
    g.fill('nonzero');
    g.globalCompositeOperation = 'source-over';
    const src = this.map.getSource('sunshade');
    src.play();
    this.map.once('render', () => src.pause());
  }

  /** Cafés mit Zustand: [{id, lat, lon, name, cls, closed, samples:[[lat,lon]]}] */
  setCafes(items, selectedId) {
    if (!this.map) return;
    this.items = items;
    this.selected = selectedId;
    const color = (it) => (it.closed ? COLORS.closed : COLORS[it.cls] || COLORS.shade);
    this.map.getSource('cafes').setData({
      type: 'FeatureCollection',
      features: items
        .slice()
        .sort((a, b) => (a.id === selectedId) - (b.id === selectedId))
        .map((it) => ({
          type: 'Feature',
          properties: { id: it.id, name: it.name, color: color(it), selected: it.id === selectedId, dim: it.closed },
          geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
        })),
    });
    const sel = items.find((it) => it.id === selectedId);
    this.map.getSource('terrace').setData({
      type: 'FeatureCollection',
      features: sel ? sel.samples.map((p) => ({
        type: 'Feature', properties: { color: p.lit ? COLORS.sun : COLORS.shade },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })) : [],
    });
  }

  flyTo(lat, lon) {
    if (!this.map) return;
    this.map.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 18.3), duration: 500 });
  }

  toggle3d() {
    if (!this.map) return false;
    this.is3d = !this.is3d;
    this.map.setLayoutProperty('buildings-3d', 'visibility', this.is3d ? 'visible' : 'none');
    this.map.easeTo({ pitch: this.is3d ? 55 : 0, bearing: this.is3d ? this.map.getBearing() || -20 : 0, duration: 600 });
    return this.is3d;
  }

  resize() { this.map?.resize(); }
}
