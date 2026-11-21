// Sunseat – Daten laden und Sonne pro Café und Zeitschritt berechnen (ohne Oberfläche).
import { makeProjection, ShadowIndex, buildingsFromOverpass, terraceSamples, sunVector } from './shadow.js';

/* global SunCalc, opening_hours */

export const STEP_MIN = 10;
export const SUNNY = 0.6;        // ab diesem Anteil der Sitzpunkte gilt „Sonne“
export const CLOUDY_MIN = 15;    // weniger Sonnenminuten pro Stunde = „bewölkt“
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export async function fetchOsm(lat, lon, r) {
  const rb = r + 250;
  const query = `[out:json][timeout:60];
nwr["amenity"~"^(cafe|ice_cream)$"](around:${r},${lat},${lon});
out center tags;
(
  way["building"](around:${rb},${lat},${lon});
  way["building:part"](around:${rb},${lat},${lon});
  relation["building"]["type"="multipolygon"](around:${rb},${lat},${lon});
);
out geom qt;`;
  let lastErr;
  for (const url of OVERPASS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 70000);
    try {
      const r2 = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!r2.ok) throw new Error('Overpass ' + r2.status);
      return await r2.json();
    } catch (e) { lastErr = e; } finally { clearTimeout(t); }
  }
  throw lastErr;
}

export async function fetchWeather(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + '&hourly=cloud_cover,sunshine_duration,temperature_2m&timezone=Europe%2FBerlin&forecast_days=7';
  const r = await fetch(u);
  if (!r.ok) throw new Error('Open-Meteo ' + r.status);
  const j = await r.json();
  const m = new Map();
  j.hourly.time.forEach((t, i) => m.set(t.slice(0, 13), {
    cloud: j.hourly.cloud_cover?.[i],
    sunMin: j.hourly.sunshine_duration?.[i] != null ? j.hourly.sunshine_duration[i] / 60 : null,
    temp: j.hourly.temperature_2m?.[i],
  }));
  return m;
}

export async function searchPlaces(q) {
  const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=de&accept-language=de'
    + '&viewbox=9.70,53.75,10.35,53.39&q=' + encodeURIComponent(q);
  const r = await fetch(u);
  if (!r.ok) throw new Error('Nominatim ' + r.status);
  return (await r.json()).map((p) => ({
    lat: +p.lat, lon: +p.lon,
    label: p.display_name.split(',')[0],
    detail: p.display_name.split(',').slice(1, 3).join(',').trim(),
  }));
}

function hourKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/** Open-Meteo-Summen gelten für die vorangehende Stunde: 12:20 gehört zum Wert von 13:00. */
export function weatherAt(weather, d) {
  if (!weather) return null;
  const cur = weather.get(hourKey(d));
  const next = new Date(d); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const sum = weather.get(hourKey(next));
  if (!cur && !sum) return null;
  return { cloud: cur?.cloud ?? sum?.cloud, sunMin: sum?.sunMin ?? cur?.sunMin, temp: cur?.temp ?? sum?.temp };
}

export function isCloudy(wx) {
  return !!(wx && wx.sunMin != null && wx.sunMin < CLOUDY_MIN);
}

export function daySunshineHours(weather, date) {
  if (!weather) return null;
  let total = 0, any = false;
  const d = new Date(date); d.setHours(1, 0, 0, 0);
  for (let h = 1; h <= 24; h++) {
    const w = weather.get(hourKey(d));
    if (w && w.sunMin != null) { total += w.sunMin; any = true; }
    d.setHours(d.getHours() + 1);
  }
  return any ? total / 60 : null;
}

function makeOpeningHours(tags, lat, lon) {
  const v = tags.opening_hours;
  if (!v) return null;
  try {
    return new opening_hours(v, { lat, lon, address: { country_code: 'de', state: 'Hamburg' } }, { locale: 'de' });
  } catch {
    return 'invalid';
  }
}

export function distance(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Overpass-Antwort -> Gebäude, Schatten-Index und Cafés mit geschätzten Sitzpunkten. */
export function buildArea(osm, place, radius) {
  const proj = makeProjection(place.lat, place.lon);
  const buildings = buildingsFromOverpass(osm.elements, proj);
  const index = new ShadowIndex(buildings);
  const cafes = [];
  for (const el of osm.elements) {
    const t = el.tags || {};
    if (t.amenity !== 'cafe' && t.amenity !== 'ice_cream') continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const [x, y] = proj.toXY(lat, lon);
    const terr = terraceSamples(index, x, y);
    const samples = terr.samples.map(([sx, sy]) => {
      const ex = index.buildingsAt(sx, sy);
      const [slat, slon] = proj.toLatLon(sx, sy);
      return { x: sx, y: sy, lat: slat, lon: slon, ex: ex.length ? new Set(ex) : null };
    });
    const ice = t.amenity === 'ice_cream';
    cafes.push({
      id: el.type[0] + el.id, osmType: el.type, osmId: el.id,
      name: t.name || (ice ? 'Eisdiele ohne Namen' : 'Café ohne Namen'),
      kind: ice ? 'Eisdiele' : 'Café',
      emoji: ice ? '🍦' : t.cuisine?.includes('cake') || t.shop === 'bakery' ? '🍰' : '☕',
      lat, lon, tags: t,
      dist: distance(place, { lat, lon }),
      seating: t.outdoor_seating == null ? 'unknown' : t.outdoor_seating === 'no' ? 'no' : 'yes',
      oh: makeOpeningHours(t, lat, lon),
      samples, facadeDeg: terr.facadeDeg,
    });
  }
  cafes.sort((a, b) => a.dist - b.dist);
  cafes.forEach((c, k) => { c._i = k; });
  return { proj, buildings, index, cafes, radius, extent: radius + 250 };
}

export function dayDate(offset) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d;
}

function openCode(c, d) {
  if (!c.oh || c.oh === 'invalid') return 2;
  try {
    if (c.oh.getUnknown(d)) return 2;
    return c.oh.getState(d) ? 1 : 0;
  } catch { return 2; }
}

/** Sonne (Anteil 0..1, -1 = Nacht) und Öffnung (0 zu, 1 offen, 2 unbekannt) für jeden 10-min-Schritt eines Tages. */
export function computeDay(area, place, offset) {
  const noon = dayDate(offset);
  const times = SunCalc.getTimes(noon, place.lat, place.lon);
  const start = new Date(times.sunrise);
  start.setMinutes(Math.floor(start.getMinutes() / STEP_MIN) * STEP_MIN, 0, 0);
  const steps = [];
  for (let t = start.getTime(); t <= times.sunset.getTime() + STEP_MIN * 60000; t += STEP_MIN * 60000) steps.push(new Date(t));
  const suns = steps.map((d) => sunVector(SunCalc.getPosition(d, place.lat, place.lon)));
  const idx = area.index;
  const perCafe = area.cafes.map((c) => {
    const sun = new Float32Array(steps.length);
    const open = new Uint8Array(steps.length);
    for (let i = 0; i < steps.length; i++) {
      const s = suns[i];
      if (s.altDeg <= 0.5) sun[i] = -1;
      else {
        let lit = 0;
        for (const p of c.samples) if (!idx.isShaded(p.x, p.y, s.dx, s.dy, s.tanAlt, 1.2, p.ex)) lit++;
        sun[i] = lit / c.samples.length;
      }
      open[i] = openCode(c, steps[i]);
    }
    return { sun, open };
  });
  return { offset, steps, suns, perCafe, sunrise: times.sunrise, sunset: times.sunset, solarNoon: times.solarNoon, noon };
}

export function sampleLit(area, sample, sun) {
  return sun.altDeg > 0.5 && !area.index.isShaded(sample.x, sample.y, sun.dx, sun.dy, sun.tanAlt, 1.2, sample.ex);
}

export function sunClass(v) {
  return v < 0 ? 'night' : v >= SUNNY ? 'sun' : v > 0 ? 'part' : 'shade';
}

export function sunMinutes(sunArr) {
  let n = 0; for (const v of sunArr) if (v >= SUNNY) n++;
  return n * STEP_MIN;
}
