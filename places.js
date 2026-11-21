// Sunseat – Cafés und Bars: laden (Overpass, sonst Kartenkacheln), Öffnungszeiten,
// Sonne am geschätzten Sitzplatz.
import { ShadowIndex, terraceSamples } from './shadow.js';
import { TreeIndex, inHamburg } from './trees.js';
import { cacheGet, cacheSet } from './db.js';

const OSM_MAX_AGE = 24 * 3600e3; // Cafés aus Overpass: einen Tag zwischenspeichern
import { fetchLod2, Lod2Index } from './lod2.js';

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

function toPlace(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  const sub = t.amenity;
  return {
    id: el.type[0] + el.id, osm: `${el.type}/${el.id}`, name: t.name, kind: sub === 'cafe' ? 'cafe' : 'bar', sub,
    lat, lon, tags: t, oh: parseHours(t.opening_hours, lat, lon),
    seating: t.outdoor_seating == null ? null : t.outdoor_seating !== 'no', source: 'osm',
  };
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
    this._fetchMissing(keys);
    const full = Promise.all(keys.map((k) => this.tiles.get(k))).then((r) => (r.every(Boolean) ? dedupe(r.flat()) : null));
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

  /**
   * Alle noch fehlenden Kacheln holen: erst aus dem Zwischenspeicher (24 h), den Rest in
   * EINER Overpass-Abfrage (Overpass erlaubt nur wenige parallele Abfragen).
   */
  _fetchMissing(keys) {
    const missing = keys.filter((k) => !this.tiles.has(k));
    if (!missing.length) return;
    const resolvers = new Map();
    for (const k of missing) this.tiles.set(k, new Promise((res) => resolvers.set(k, res)));
    (async () => {
      const need = [];
      for (const k of missing) {
        const cached = await cacheGet('osm:' + k, OSM_MAX_AGE);
        if (cached) resolvers.get(k)(cached.map(toPlace).filter(Boolean));
        else need.push(k);
      }
      if (!need.length) return;
      let s = 90, w = 180, n = -90, e = -180;
      for (const k of need) {
        const b = tileBBox(k);
        s = Math.min(s, b.s); w = Math.min(w, b.w); n = Math.max(n, b.n); e = Math.max(e, b.e);
      }
      let elements = null;
      try {
        const j = await overpass(`[out:json][timeout:40];nwr["amenity"~"^(cafe|bar|pub|biergarten)$"]["name"](${s},${w},${n},${e});out center tags;`);
        elements = j.elements;
      } catch { /* nicht erreichbar */ }
      for (const k of need) {
        if (!elements) {
          resolvers.get(k)(null);
          setTimeout(() => this.tiles.delete(k), 60000); // später erneut versuchen
          continue;
        }
        const b = tileBBox(k);
        const mine = elements.filter((el) => {
          const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
          return lat >= b.s && lat < b.n && lon >= b.w && lon < b.e;
        });
        cacheSet('osm:' + k, mine);
        resolvers.get(k)(mine.map(toPlace).filter(Boolean));
      }
    })();
  }

  /** Schatten-Index für alle Gebäude um die Orte herum. */
  async prepare(places) {
    const keys = new Set();
    for (const p of places) for (const k of this.sl.tilesAround(p.lat, p.lon)) keys.add(k);
    const list = [...keys].sort();
    // Bäume kommen später nach: dann neu rechnen (Schlüssel enthält die Zahl geladener Baumkacheln)
    const key = list.join(',') + '#' + this.sl.treeVersion(list);
    if (this.index?.key !== key) {
      const { buildings } = await this.sl.load(list);
      const old = this.index?.key?.split('#')[0] === list.join(',') ? this.index.index : null;
      this.index = { key, index: old || new ShadowIndex(buildings), trees: new TreeIndex(this.sl.treesFor(list)) };
    }
    return this.index;
  }

  _entry(place) {
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
    return c;
  }

  _day(c, dayKey, n) {
    let arr = c.days.get(dayKey);
    if (!arr) { arr = new Float32Array(n).fill(NaN); c.days.set(dayKey, arr); }
    return arr;
  }

  _compute(c, arr, suns, i) {
    const s = suns[i];
    if (s.altDeg <= 0.5) { arr[i] = -1; return; }
    let lit = 0;
    const { index, trees } = this.index;
    for (const p of c.samples) {
      if (index.isShaded(p.x, p.y, s.dx, s.dy, s.tanAlt, 1.2, p.ex)) continue;
      if (s.date && trees.isShaded(p.x, p.y, s, s.date)) continue;
      lit++;
    }
    arr[i] = lit / c.samples.length;
  }

  /** Sonnenanteil (0..1, -1 = Nacht) zu einem einzelnen Zeitschritt – günstig für viele Orte. */
  sunAt(place, dayKey, suns, i) {
    const c = this._entry(place);
    const arr = this._day(c, dayKey, suns.length);
    if (Number.isNaN(arr[i])) this._compute(c, arr, suns, i);
    return arr[i];
  }

  /** Begründung der Prognose je Sitzpunkt: von Gebäude oder Baum beschattet? (für Rückmeldungen) */
  diagnose(place, sun) {
    const c = this._entry(place);
    const { index, trees } = this.index;
    return {
      facadeDeg: c.facadeDeg,
      samples: c.samples.map((p) => {
        const [lat, lon] = this.sl.proj.toLatLon(p.x, p.y);
        const building = sun.altDeg > 0.5 && index.isShaded(p.x, p.y, sun.dx, sun.dy, sun.tanAlt, 1.2, p.ex);
        const tree = sun.altDeg > 0.5 && !!sun.date && trees.isShaded(p.x, p.y, sun, sun.date);
        return { lat: +lat.toFixed(6), lon: +lon.toFixed(6), building, tree, lit: sun.altDeg > 0.5 && !building && !tree };
      }),
    };
  }

  /** Sonnenanteil für alle Zeitschritte des Tages; dayKey identifiziert Tag und Ort der Schritte. */
  sunTimeline(place, dayKey, suns) {
    const c = this._entry(place);
    const arr = this._day(c, dayKey, suns.length);
    if (!c.full?.has(dayKey)) {
      for (let i = 0; i < suns.length; i++) if (Number.isNaN(arr[i])) this._compute(c, arr, suns, i);
      (c.full ??= new Set()).add(dayKey);
    }
    return { sun: arr, facadeDeg: c.facadeDeg, samples: c.samples };
  }
}

/**
 * Genaue Berechnung für die Umgebung eines Ortes: 3D-Stadtmodell (±250 m) statt OSM-Gebäuden,
 * außerhalb davon weiter OSM. Gibt null zurück, wenn der Ort nicht in Hamburg liegt.
 */
export async function preciseContext(places, place, signal) {
  const dLat = 250 / 110540, dLon = 250 / (111320 * Math.cos((place.lat * Math.PI) / 180));
  const b = { w: place.lon - dLon, e: place.lon + dLon, s: place.lat - dLat, n: place.lat + dLat };
  if (!inHamburg(b)) return null;
  const sl = places.sl;
  const around = sl.tilesAround(place.lat, place.lon);
  const { buildings } = await sl.load(around);
  const trees = sl.treesFor(around);
  const lodBuildings = await fetchLod2(b, sl.proj, signal);
  if (!lodBuildings.length) return null;
  const lod = new Lod2Index(lodBuildings);
  const cen = (r) => r.reduce((a, p) => [a[0] + p[0] / r.length, a[1] + p[1] / r.length], [0, 0]);
  const osm = new ShadowIndex(buildings.filter((bd) => { const [x, y] = cen(bd.outer[0]); return !lod.covers(x, y); }));
  return { lod, osm, trees: new TreeIndex(trees), id: Math.random().toString(36).slice(2) };
}

/** Sonnenanteil je Zeitschritt mit dem genauen Kontext (gecacht am Ort). */
export function preciseTimeline(places, place, ctx, dayKey, suns) {
  const key = ctx.id + ':' + dayKey;
  if (place._precise?.key === key) return place._precise.sun;
  const [x0, y0] = places.sl.proj.toXY(place.lat, place.lon);
  // Sitzpunkte wie gehabt (Fassade aus OSM), Schatten aus LoD2 + OSM außerhalb + Bäume
  const t = terraceSamples(places.index?.index || ctx.osm, x0, y0);
  const samples = t.samples.map(([x, y]) => {
    const ex = ctx.osm.buildingsAt(x, y);
    return { x, y, ex: ex.length ? new Set(ex) : null, lodEx: ctx.lod.buildingsAt(x, y) };
  });
  const sun = new Float32Array(suns.length);
  suns.forEach((s, i) => {
    if (s.altDeg <= 0.5) { sun[i] = -1; return; }
    let lit = 0;
    for (const p of samples) {
      if (ctx.lod.isShaded(p.x, p.y, s, 1.2, p.lodEx)) continue;
      if (ctx.osm.isShaded(p.x, p.y, s.dx, s.dy, s.tanAlt, 1.2, p.ex)) continue;
      if (s.date && ctx.trees.isShaded(p.x, p.y, s, s.date)) continue;
      lit++;
    }
    sun[i] = lit / samples.length;
  });
  place._precise = { key, sun };
  return sun;
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
