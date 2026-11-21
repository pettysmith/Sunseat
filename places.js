// Sunseat – Cafés und Bars: laden (Overpass, sonst Kartenkacheln), Öffnungszeiten,
// Sonne am geschätzten Sitzplatz.
import { ShadowIndex, terraceSamples } from './shadow.js';

/* global opening_hours */

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const SUNNY = 0.6; // Anteil der Sitzpunkte in der Sonne, ab dem „Sonne“ gilt
export const KIND_LABEL = { cafe: 'Café', bar: 'Bar' };
const SUB_LABEL = { cafe: 'Café', bar: 'Bar', pub: 'Kneipe', biergarten: 'Biergarten' };

const n2 = 2 ** 14;
const tileBBox = (key) => {
  const [x, y] = key.split('/').map(Number);
  const lon = (v) => (v / n2) * 360 - 180;
  const lat = (v) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - v / n2) * 2 * Math.PI)) - 90;
  return { s: lat(y + 1), w: lon(x), n: lat(y), e: lon(x + 1) };
};

async function overpass(query) {
  let last;
  for (const url of OVERPASS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('Overpass ' + r.status);
      return await r.json();
    } catch (e) { last = e; } finally { clearTimeout(t); }
  }
  throw last;
}

function parseHours(value, lat, lon) {
  if (!value || typeof opening_hours === 'undefined') return null;
  try {
    return new opening_hours(value, { lat, lon, address: { country_code: 'de', state: 'Hamburg' } }, { locale: 'de' });
  } catch {
    return 'invalid';
  }
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((p) => !seen.has(p.id) && seen.add(p.id));
}

export class Places {
  constructor(sunLayer) {
    this.sl = sunLayer;
    this.tiles = new Map();     // Kachel -> Promise<Ort[] | null> (Overpass)
    this.fastTiles = new Map(); // Kachel -> Promise<Ort[]> (Kartenkacheln)
    this.index = null;         // { key, index }
    this.cache = new Map();    // place.id -> { indexKey, samples, days: Map }
  }

  /**
   * Orte in den Kacheln, in zwei Stufen:
   * fast – sofort aus den Kartenkacheln (Name, Art, Lage),
   * full – aus OpenStreetMap über Overpass (mit Öffnungszeiten); null, wenn nicht erreichbar.
   */
  inTiles(keys) {
    const fast = Promise.all(keys.map((k) => this._fast(k))).then((r) => dedupe(r.flat()));
    const full = Promise.all(keys.map((k) => this._full(k))).then((r) => (r.every(Boolean) ? dedupe(r.flat()) : null));
    return { fast, full };
  }

  _fast(key) {
    if (!this.fastTiles.has(key)) {
      const p = this.sl.load([key]).then(({ pois }) => pois.map((x) => ({ ...x, oh: null, seating: null, source: 'tiles' })));
      p.catch(() => this.fastTiles.delete(key));
      this.fastTiles.set(key, p);
    }
    return this.fastTiles.get(key);
  }

  _full(key) {
    if (!this.tiles.has(key)) {
      const b = tileBBox(key);
      const p = overpass(`[out:json][timeout:25];nwr["amenity"~"^(cafe|bar|pub|biergarten)$"]["name"](${b.s},${b.w},${b.n},${b.e});out center tags;`)
        .then((j) => j.elements.map((el) => {
          const t = el.tags || {};
          const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
          if (lat == null) return null;
          const sub = t.amenity;
          return {
            id: el.type[0] + el.id, osm: `${el.type}/${el.id}`, name: t.name, kind: sub === 'cafe' ? 'cafe' : 'bar', sub,
            lat, lon, tags: t, oh: parseHours(t.opening_hours, lat, lon),
            seating: t.outdoor_seating == null ? null : t.outdoor_seating !== 'no', source: 'osm',
          };
        }).filter(Boolean))
        .catch(() => { setTimeout(() => this.tiles.delete(key), 60000); return null; }); // später erneut versuchen
      this.tiles.set(key, p);
    }
    return this.tiles.get(key);
  }

  /** Schatten-Index für alle Gebäude um die Orte herum. */
  async prepare(places) {
    const keys = new Set();
    for (const p of places) for (const k of this.sl.tilesAround(p.lat, p.lon)) keys.add(k);
    const key = [...keys].sort().join(',');
    if (this.index?.key !== key) {
      const { buildings } = await this.sl.load([...keys]);
      this.index = { key, index: new ShadowIndex(buildings) };
    }
    return this.index;
  }

  /** Sonnenanteil (0..1, -1 = Nacht) je Zeitschritt; dayKey identifiziert Tag und Ort der Schritte. */
  sunTimeline(place, dayKey, suns) {
    const { key: indexKey, index } = this.index;
    let c = this.cache.get(place.id);
    if (!c || c.indexKey !== indexKey) {
      const [x, y] = this.sl.proj.toXY(place.lat, place.lon);
      const t = terraceSamples(index, x, y);
      const samples = t.samples.map(([sx, sy]) => {
        const ex = index.buildingsAt(sx, sy);
        return { x: sx, y: sy, ex: ex.length ? new Set(ex) : null };
      });
      c = { indexKey, samples, facadeDeg: t.facadeDeg, days: new Map() };
      this.cache.set(place.id, c);
    }
    if (!c.days.has(dayKey)) {
      const arr = new Float32Array(suns.length);
      suns.forEach((s, i) => {
        if (s.altDeg <= 0.5) { arr[i] = -1; return; }
        let lit = 0;
        for (const p of c.samples) if (!index.isShaded(p.x, p.y, s.dx, s.dy, s.tanAlt, 1.2, p.ex)) lit++;
        arr[i] = lit / c.samples.length;
      });
      c.days.set(dayKey, arr);
    }
    return { sun: c.days.get(dayKey), facadeDeg: c.facadeDeg, samples: c.samples };
  }
}

/** Öffnungsstatus je Zeitschritt: 1 offen, 0 geschlossen, 2 unbekannt. */
export function openTimeline(place, steps) {
  const out = new Uint8Array(steps.length).fill(2);
  if (!place.oh || place.oh === 'invalid' || !steps.length) return out;
  try {
    const from = new Date(steps[0]); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    out.fill(0);
    for (const [a, b, unknown] of place.oh.getOpenIntervals(from, to)) {
      steps.forEach((t, i) => { if (t >= a && t < b) out[i] = unknown ? 2 : 1; });
    }
  } catch { out.fill(2); }
  return out;
}

export function subLabel(place) { return SUB_LABEL[place.sub] || KIND_LABEL[place.kind]; }

/** Wochenübersicht der Öffnungszeiten: [{day:'Mo', text:'08:00–18:00'}] */
export function weekHours(place, ref = new Date()) {
  if (!place.oh || place.oh === 'invalid') return null;
  const names = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const monday = new Date(ref); monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const f = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const rows = [];
  for (let k = 0; k < 7; k++) {
    const a = new Date(monday); a.setDate(a.getDate() + k);
    const b = new Date(a); b.setDate(b.getDate() + 1);
    let text;
    try {
      const iv = place.oh.getOpenIntervals(a, b);
      text = iv.length ? iv.map(([s, e]) => `${f(s)}–${e - b === 0 ? '24:00' : f(e)}`).join(', ') : 'geschlossen';
    } catch { text = '–'; }
    rows.push({ day: names[a.getDay()], text, today: a.toDateString() === ref.toDateString() });
  }
  return rows;
}
