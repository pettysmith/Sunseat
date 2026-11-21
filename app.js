import {
  makeProjection, ShadowIndex, buildingsFromOverpass, terraceSamples, sunVector, compass,
} from './shadow.js';
import { SunMap } from './map.js';

/* global SunCalc, opening_hours */

const DEFAULT_PLACE = { lat: 53.5636, lon: 9.9662, label: 'Sternschanze', source: 'default' };
const STEP_MIN = 10;
const SUNNY = 0.6;           // ab diesem Anteil der Sitzpunkte gilt „Sonne“
const CLOUDY_MIN = 15;       // weniger Sonnenminuten pro Stunde = „bewölkt“
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric' });
const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const fmtDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' });
const hhmm = (d) => fmtTime.format(d);

const store = {
  get(k, d) { try { const v = localStorage.getItem('sunseat.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sunseat.' + k, JSON.stringify(v)); } catch { /* egal */ } },
};

const state = {
  place: null,
  cafes: [],
  index: null,
  weather: null,       // Map 'YYYY-MM-DDTHH' -> {cloud, sunMin}
  dayOffset: 0,
  step: 0,
  days: new Map(),     // dayOffset -> Tagesverlauf
  filters: store.get('filters', { open: false, sun: false, noSeat: true, radius: 500 }),
  loadId: 0,
  view: store.get('view', 'map'),
  selected: null,
  map: null,
  drawnKey: null,
};

/* ---------- Ort ---------- */

function placeFromUrl() {
  const p = new URLSearchParams(location.search);
  const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
  if (isFinite(lat) && isFinite(lon)) return { lat, lon, label: p.get('name') || 'Gewählter Ort', source: 'url' };
  return null;
}

function getGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('kein GPS'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, label: 'Mein Standort', source: 'gps' }),
      reject,
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

function setPlace(place) {
  state.place = place;
  const acc = place.accuracy ? ` (±${Math.round(place.accuracy)} m)` : '';
  $('locLabel').textContent = `📍 ${place.label}${acc}`;
  if (place.source !== 'gps' && place.source !== 'default') {
    const u = new URL(location.href);
    u.searchParams.set('lat', place.lat.toFixed(5));
    u.searchParams.set('lon', place.lon.toFixed(5));
    u.searchParams.set('name', place.label);
    history.replaceState(null, '', u);
  } else if (location.search) {
    history.replaceState(null, '', location.pathname);
  }
  $('search').hidden = true;
  load();
}

async function useGps() {
  setStatus('Suche deinen Standort …');
  try {
    setPlace(await getGps());
  } catch {
    setPlace({ ...DEFAULT_PLACE, note: 'Kein Standortzugriff, deshalb siehst du die Sternschanze. Tippe oben auf den Ort, um ihn zu ändern. ' });
  }
}

/* ---------- Daten ---------- */

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 70000);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('Overpass ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; } finally { clearTimeout(t); }
  }
  throw lastErr;
}

function osmQuery(lat, lon, r) {
  const rb = r + 250;
  return `[out:json][timeout:60];
nwr["amenity"~"^(cafe|ice_cream)$"](around:${r},${lat},${lon});
out center tags;
(
  way["building"](around:${rb},${lat},${lon});
  way["building:part"](around:${rb},${lat},${lon});
  relation["building"]["type"="multipolygon"](around:${rb},${lat},${lon});
);
out geom qt;`;
}

async function loadWeather(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + '&hourly=cloud_cover,sunshine_duration&timezone=Europe%2FBerlin&forecast_days=7';
  const r = await fetch(u);
  if (!r.ok) throw new Error('Open-Meteo ' + r.status);
  const j = await r.json();
  const m = new Map();
  j.hourly.time.forEach((t, i) => m.set(t.slice(0, 13), {
    cloud: j.hourly.cloud_cover[i],
    sunMin: j.hourly.sunshine_duration[i] != null ? j.hourly.sunshine_duration[i] / 60 : null,
  }));
  return m;
}

function hourKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/** Open-Meteo-Summen gelten für die vorangehende Stunde: 12:20 gehört zum Wert von 13:00. */
function weatherAt(d) {
  if (!state.weather) return null;
  const cloud = state.weather.get(hourKey(d));
  const next = new Date(d); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const sum = state.weather.get(hourKey(next));
  if (!cloud && !sum) return null;
  return { cloud: cloud?.cloud ?? sum?.cloud, sunMin: sum?.sunMin ?? cloud?.sunMin };
}

function daySunshineHours(date) {
  if (!state.weather) return null;
  let total = 0, any = false;
  const d = new Date(date); d.setHours(1, 0, 0, 0);
  for (let h = 1; h <= 24; h++) {
    const w = state.weather.get(hourKey(d));
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

function seatingOf(tags) {
  const v = tags.outdoor_seating;
  if (v == null) return 'unknown';
  return v === 'no' ? 'no' : 'yes';
}

function distance(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function load() {
  const id = ++state.loadId;
  const { lat, lon } = state.place;
  state.days.clear();
  $('list').replaceChildren();
  setStatus('Lade Cafés und Gebäude aus OpenStreetMap … (dauert meist 5–20 Sekunden)');
  const weatherP = loadWeather(lat, lon).catch(() => null);
  let osm;
  try {
    osm = await overpass(osmQuery(lat, lon, state.filters.radius));
  } catch (e) {
    if (id !== state.loadId) return;
    setStatus('OpenStreetMap ist gerade nicht erreichbar. Versuch es gleich noch einmal.', true, true);
    return;
  }
  if (id !== state.loadId) return;
  setStatus('Berechne Schatten …');
  await new Promise((r) => setTimeout(r, 0));

  const proj = makeProjection(lat, lon);
  const buildings = buildingsFromOverpass(osm.elements, proj);
  const index = new ShadowIndex(buildings);
  const cafes = [];
  for (const el of osm.elements) {
    const t = el.tags || {};
    if (t.amenity !== 'cafe' && t.amenity !== 'ice_cream') continue;
    const clat = el.lat ?? el.center?.lat, clon = el.lon ?? el.center?.lon;
    if (clat == null) continue;
    const [x, y] = proj.toXY(clat, clon);
    const terr = terraceSamples(index, x, y);
    const samples = terr.samples.map(([sx, sy]) => {
      const ex = index.buildingsAt(sx, sy);
      return { x: sx, y: sy, ex: ex.length ? new Set(ex) : null };
    });
    cafes.push({
      id: el.type[0] + el.id, osmType: el.type, osmId: el.id,
      name: t.name || (t.amenity === 'ice_cream' ? 'Eisdiele ohne Namen' : 'Café ohne Namen'),
      kind: t.amenity === 'ice_cream' ? 'Eisdiele' : 'Café',
      lat: clat, lon: clon, tags: t,
      dist: distance(state.place, { lat: clat, lon: clon }),
      seating: seatingOf(t),
      oh: makeOpeningHours(t, clat, clon),
      samples, facadeDeg: terr.facadeDeg, mode: terr.mode,
    });
  }
  cafes.forEach((c, k) => { c._i = k; });
  state.cafes = cafes;
  state.proj = proj;
  state.buildings = buildings;
  state.extent = state.filters.radius + 250;
  state.selected = null;
  state.drawnKey = null;
  state.areaSet = false;
  state.index = index;
  state.estimatedShare = buildings.length ? buildings.filter((b) => b.estimated).length / buildings.length : 0;
  state.weather = await weatherP;
  if (id !== state.loadId) return;

  // Startzeit wählen: heute jetzt, oder morgen, wenn heute keine Sonne mehr kommt
  const now = new Date();
  const today = dayInfo(0);
  let note = state.place.note || '';
  if (now > today.sunset) {
    state.dayOffset = 1;
    note += 'Heute ist die Sonne schon untergegangen. Du siehst morgen. ';
  } else state.dayOffset = 0;
  selectDay(state.dayOffset, true);
  setStatus(note + summaryText(), !!state.place.note);
  if (state.view === 'map') showView('map');
}

/* ---------- Tagesverlauf ---------- */

function dayDate(offset) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d;
}

function dayInfo(offset) {
  if (state.days.has(offset)) return state.days.get(offset);
  const { lat, lon } = state.place;
  const noon = dayDate(offset);
  const times = SunCalc.getTimes(noon, lat, lon);
  const start = new Date(times.sunrise); start.setMinutes(Math.floor(start.getMinutes() / STEP_MIN) * STEP_MIN, 0, 0);
  const steps = [];
  for (let t = start.getTime(); t <= times.sunset.getTime() + STEP_MIN * 60000; t += STEP_MIN * 60000) steps.push(new Date(t));
  const suns = steps.map((d) => sunVector(SunCalc.getPosition(d, lat, lon)));
  const idx = state.index;
  const perCafe = state.cafes.map((c) => {
    const sun = new Float32Array(steps.length);
    const open = new Uint8Array(steps.length); // 0 zu, 1 offen, 2 unbekannt
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
  const info = { offset, steps, suns, perCafe, sunrise: times.sunrise, sunset: times.sunset, noon };
  state.days.set(offset, info);
  return info;
}

function openCode(c, d) {
  if (!c.oh || c.oh === 'invalid') return 2;
  try {
    if (c.oh.getUnknown(d)) return 2;
    return c.oh.getState(d) ? 1 : 0;
  } catch { return 2; }
}

/* ---------- Filter & Auswertung ---------- */

function visible(c, day, i) {
  const f = state.filters;
  if (f.noSeat && c.seating === 'no') return false;
  const pc = day.perCafe[c._i];
  if (f.open && pc.open[i] === 0) return false;
  if (f.sun && !(pc.sun[i] >= SUNNY)) return false;
  return true;
}

function sunnyCount(day, i) {
  let n = 0;
  state.cafes.forEach((c, k) => {
    const pc = day.perCafe[k];
    if (state.filters.noSeat && c.seating === 'no') return;
    if (pc.open[i] === 0) return;
    if (pc.sun[i] >= SUNNY) n++;
  });
  return n;
}

function bestStep(day) {
  // Bei Gleichstand gewinnt die Zeit näher am Mittag
  const noon = SunCalc.getTimes(day.noon, state.place.lat, state.place.lon).solarNoon;
  let best = 0, bestN = -1, bestD = Infinity;
  day.steps.forEach((t, i) => {
    const n = sunnyCount(day, i), d = Math.abs(t - noon);
    if (n > bestN || (n === bestN && d < bestD)) { bestN = n; best = i; bestD = d; }
  });
  return best;
}

function nearestStep(day, d) {
  let best = 0, bd = Infinity;
  day.steps.forEach((s, i) => { const x = Math.abs(s - d); if (x < bd) { bd = x; best = i; } });
  return best;
}

function sunDescription(sun, steps, i, day) {
  const v = sun[i];
  const fmtEnd = (j) => (j >= steps.length - 1 || sun[j] < 0) ? `bis Sonnenuntergang ${hhmm(day.sunset)}` : `bis ${hhmm(steps[j])}`;
  if (v < 0) {
    if (steps[i] < day.sunrise) {
      const j = sun.findIndex((x) => x >= SUNNY);
      return { cls: 'night', label: 'Vor Sonnenaufgang', sub: j >= 0 ? `Sonne ab ${hhmm(steps[j])}` : 'keine Sonne an diesem Tag' };
    }
    return { cls: 'night', label: 'Sonne untergegangen', sub: '' };
  }
  if (v >= SUNNY) {
    let j = i; while (j < sun.length && sun[j] >= SUNNY) j++;
    return { cls: 'sun', label: v === 1 ? 'Sonne' : 'Fast ganz Sonne', sub: fmtEnd(j) };
  }
  let j = i; while (j < sun.length && !(sun[j] >= SUNNY)) j++;
  const later = j < sun.length && sun[j] >= 0 ? `Sonne ab ${hhmm(steps[j])}` : 'danach keine Sonne mehr';
  if (v > 0) return { cls: 'part', label: 'Halbschatten', sub: later };
  return { cls: 'shade', label: 'Schatten', sub: later };
}

function openDescription(c, d, code) {
  if (!c.oh) return { cls: 'unk', label: 'Öffnungszeiten unbekannt' };
  if (c.oh === 'invalid' || code === 2) return { cls: 'unk', label: 'Öffnungszeiten unklar' };
  let next = null;
  try { next = c.oh.getNextChange(d); } catch { /* egal */ }
  const when = (n) => {
    if (!n) return '';
    if (n.toDateString() === d.toDateString()) return hhmm(n);
    if (n - d < 6 * 864e5) return `${fmtWeekday.format(n)} ${hhmm(n)}`;
    return `am ${fmtDate.format(n)}`;
  };
  if (code === 1) return { cls: 'open', label: next ? `geöffnet bis ${when(next)}` : 'geöffnet' };
  return { cls: 'closed', label: next ? `geschlossen · öffnet ${when(next)}` : 'geschlossen' };
}

function sunMinutesOfDay(sun) {
  let n = 0; for (const v of sun) if (v >= SUNNY) n++;
  return n * STEP_MIN;
}

function fmtDuration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function summaryText() {
  const day = dayInfo(state.dayOffset);
  const n = state.cafes.length;
  if (!n) return 'Keine Cafés in diesem Umkreis gefunden. Probier einen größeren Umkreis.';
  const best = bestStep(day), bn = sunnyCount(day, best);
  const which = state.dayOffset === 0 ? 'heute' : state.dayOffset === 1 ? 'morgen' : `am ${fmtWeekday.format(day.noon)}`;
  const found = n === 1 ? '1 Café gefunden.' : `${n} Cafés gefunden.`;
  if (!bn) return `${found} ${which[0].toUpperCase() + which.slice(1)} liegt laut Berechnung keine geöffnete Terrasse in der Sonne.`;
  return `${found} Die meisten Sonnenplätze ${which}: ${bn === 1 ? 'einer' : bn} um ${hhmm(day.steps[best])}.`;
}

/* ---------- Darstellung ---------- */

function setStatus(text, warn = false, retry = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
  if (retry) {
    const b = document.createElement('button');
    b.textContent = 'Nochmal';
    b.className = 'retry';
    b.onclick = () => load();
    el.append(' ', b);
  }
}

function renderDays() {
  const wrap = $('days');
  wrap.replaceChildren();
  for (let o = 0; o < 7; o++) {
    const d = dayDate(o);
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.className = 'day' + (o === state.dayOffset ? ' active' : '');
    b.setAttribute('aria-selected', o === state.dayOffset);
    const h = daySunshineHours(d);
    const name = o === 0 ? 'Heute' : o === 1 ? 'Morgen' : fmtDay.format(d);
    b.innerHTML = `<span>${name}</span><small>${h == null ? '' : '☀ ' + h.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' h'}</small>`;
    b.onclick = () => selectDay(o);
    wrap.append(b);
  }
}

function selectDay(offset, initial = false) {
  state.dayOffset = offset;
  const day = dayInfo(offset);
  const now = new Date();
  if (offset === 0 && now >= day.steps[0] && now <= day.sunset) state.step = nearestStep(day, now);
  else state.step = bestStep(day);
  const slider = $('time');
  slider.max = day.steps.length - 1;
  slider.value = state.step;
  renderDays();
  drawHisto();
  render();
  if (!initial) setStatus(summaryText());
}

function drawHisto() {
  const day = dayInfo(state.dayOffset);
  const cv = $('histo');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const counts = day.steps.map((_, i) => sunnyCount(day, i));
  const max = Math.max(1, ...counts);
  const css = getComputedStyle(document.documentElement);
  const sunC = css.getPropertyValue('--sun').trim();
  const cloudC = css.getPropertyValue('--cloud').trim();
  const thumb = 14; // Platz links/rechts wie der Regler-Knopf
  const bw = (w - thumb * 2) / counts.length;
  counts.forEach((n, i) => {
    const bh = (n / max) * (h - 4);
    const wx = weatherAt(day.steps[i]);
    g.fillStyle = wx && wx.sunMin != null && wx.sunMin < CLOUDY_MIN ? cloudC : sunC;
    g.fillRect(thumb + i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  });
}

function render() {
  const day = dayInfo(state.dayOffset);
  const i = state.step;
  const t = day.steps[i];
  const sun = day.suns[i];
  const now = new Date();
  const isPast = t < now - STEP_MIN * 60000;
  $('timeLabel').textContent = `${state.dayOffset === 0 ? 'Heute' : fmtWeekday.format(t)}, ${hhmm(t)}${isPast ? ' (vorbei)' : ''}`;
  $('sunLabel').textContent = sun.altDeg > 0
    ? `Sonne ${Math.round(sun.altDeg)}° hoch aus ${compass(sun.bearingDeg)}`
    : 'Sonne unter dem Horizont';
  const isNow = state.dayOffset === 0 && Math.abs(t - now) < STEP_MIN * 60000;
  $('nowBtn').hidden = isNow;

  const wx = weatherAt(t);
  const cloudy = wx && wx.sunMin != null && wx.sunMin < CLOUDY_MIN;
  const wEl = $('weather');
  if (wx) {
    const sm = wx.sunMin != null ? ` · Sonnenschein in dieser Stunde ca. ${Math.round(wx.sunMin)} min` : '';
    wEl.textContent = `${cloudy ? '☁️ Wahrscheinlich bedeckt. ' : ''}Bewölkung ${Math.round(wx.cloud)} %${sm}`;
    wEl.classList.toggle('cloudy', !!cloudy);
  } else {
    wEl.textContent = state.weather ? 'Für diese Zeit gibt es keine Wettervorhersage.' : 'Wetter gerade nicht verfügbar. Gezeigt wird die Sonne bei klarem Himmel.';
    wEl.classList.remove('cloudy');
  }

  const rows = state.cafes.filter((c) => visible(c, day, i));
  const rank = (c) => {
    const pc = day.perCafe[c._i];
    const v = pc.sun[i], closed = pc.open[i] === 0;
    if (closed) return 4;
    if (v >= SUNNY) return 0;
    if (v > 0) return 1;
    for (let j = i + 1; j < pc.sun.length; j++) if (pc.sun[j] >= SUNNY) return 2 + j / 1000;
    return 3;
  };
  rows.sort((a, b) => rank(a) - rank(b) || a.dist - b.dist);

  state.rows = rows;
  state.cloudy = cloudy;
  if (state.view === 'list') renderList();
  else renderMap();
}

function cardFor(c, day, i, cloudy) {
  const t = day.steps[i];
  const tpl = $('cardTpl').content;
  const pct = (j) => (j / (day.steps.length - 1)) * 100;
  const pc = day.perCafe[c._i];
  const el = tpl.cloneNode(true).firstElementChild;
  el.dataset.id = c.id;
  const a = el.querySelector('.name');
  a.textContent = c.name;
  a.href = `https://maps.apple.com/?q=${encodeURIComponent(c.name)}&ll=${c.lat},${c.lon}`;
  el.querySelector('.dist').textContent = c.dist < 1000 ? `${Math.round(c.dist / 10) * 10} m` : `${(c.dist / 1000).toFixed(1)} km`;

  const sd = sunDescription(pc.sun, day.steps, i, day);
  const od = openDescription(c, t, pc.open[i]);
  const chips = el.querySelector('.chips');
  const sunChip = chip(`${sd.label}${sd.sub ? ' · ' + sd.sub : ''}`, 'c-' + sd.cls + (cloudy && sd.cls === 'sun' ? ' muted' : ''));
  if (cloudy && sd.cls === 'sun') sunChip.title = 'Der Platz liegt frei, aber es ist wahrscheinlich bewölkt.';
  chips.append(sunChip, chip(od.label, 'c-' + od.cls));
  el.classList.add('is-' + sd.cls);
  if (pc.open[i] === 0) el.classList.add('is-closed');
  if (c.id === state.selected) el.classList.add('selected');

  // Tagesleiste: oben Sonne, unten Öffnungszeit
  const stopsSun = [], stopsOpen = [];
  for (let j = 0; j < day.steps.length; j++) {
    const v = pc.sun[j];
    const col = v < 0 ? 'var(--night)' : v >= SUNNY ? 'var(--sun)' : v > 0 ? 'var(--part)' : 'var(--shade)';
    const oc = pc.open[j] === 1 ? 'var(--open)' : pc.open[j] === 0 ? 'var(--closed)' : 'transparent';
    const a0 = pct(Math.max(0, j - 0.5)), a1 = pct(Math.min(day.steps.length - 1, j + 0.5));
    stopsSun.push(`${col} ${a0}%`, `${col} ${a1}%`);
    stopsOpen.push(`${oc} ${a0}%`, `${oc} ${a1}%`);
  }
  el.querySelector('.bar-sun').style.background = `linear-gradient(90deg, ${stopsSun.join(',')})`;
  el.querySelector('.bar-open').style.background = `linear-gradient(90deg, ${stopsOpen.join(',')})`;
  el.querySelector('.bar-now').style.left = `${pct(i)}%`;
  const scale = el.querySelectorAll('.bar-scale span');
  scale[0].textContent = `↑ ${hhmm(day.sunrise)}`;
  scale[1].textContent = `${hhmm(day.sunset)} ↓`;

  const meta = el.querySelector('.meta');
  const total = sunMinutesOfDay(pc.sun);
  const parts = [];
  parts.push(total ? `${fmtDuration(total)} Sonne an diesem Tag` : 'an diesem Tag keine Sonne');
  if (c.facadeDeg != null) parts.push(`Plätze vermutlich nach ${compass(c.facadeDeg)}`);
  else parts.push('frei stehend');
  parts.push(c.seating === 'yes' ? 'Außenplätze: ja' : c.seating === 'no' ? 'Außenplätze: nein' : 'Außenplätze: unbekannt');
  if (c.kind === 'Eisdiele') parts.unshift('Eisdiele');
  meta.textContent = parts.join(' · ') + ' · ';
  const edit = document.createElement('a');
  edit.href = `https://www.openstreetmap.org/edit?${c.osmType}=${c.osmId}`;
  edit.target = '_blank'; edit.rel = 'noopener';
  edit.textContent = 'in OSM bearbeiten';
  meta.append(edit);
  el.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    selectCafe(c.id, true);
  });
  return el;
}

function renderList() {
  const day = dayInfo(state.dayOffset);
  const list = $('list');
  const frag = document.createDocumentFragment();
  for (const c of state.rows) frag.append(cardFor(c, day, state.step, state.cloudy));
  list.replaceChildren(frag);
  if (!state.rows.length && state.cafes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Mit diesen Filtern bleibt nichts übrig.';
    list.append(li);
  }
}

/* ---------- Karte ---------- */

async function ensureMap() {
  if (!state.map) {
    state.map = new SunMap($('map'), { onSelect: (id) => selectCafe(id, false) });
  }
  await state.map.init(state.place);
  if (!state.areaSet && state.buildings) {
    state.map.setArea({ place: state.place, proj: state.proj, buildings: state.buildings, radius: state.filters.radius, extent: state.extent });
    state.areaSet = true;
    state.drawnKey = null;
  }
  state.map.resize();
}

function renderMap() {
  const m = state.map;
  const day = dayInfo(state.dayOffset);
  const i = state.step;
  if (m && m.map && state.areaSet) {
    const key = state.dayOffset + ':' + i + ':' + state.loadId;
    if (key !== state.drawnKey) { m.drawSun(day.suns[i]); state.drawnKey = key; }
    const items = state.rows.map((c) => {
      const pc = day.perCafe[c._i];
      const v = pc.sun[i];
      const cls = v < 0 ? 'night' : v >= SUNNY ? 'sun' : v > 0 ? 'part' : 'shade';
      const samples = c.id === state.selected ? c.samples.map((p) => {
        const [la, lo] = state.proj.toLatLon(p.x, p.y);
        const s = day.suns[i];
        const lit = s.altDeg > 0.5 && !state.index.isShaded(p.x, p.y, s.dx, s.dy, s.tanAlt, 1.2, p.ex);
        return { lat: la, lon: lo, lit };
      }) : [];
      return { id: c.id, lat: c.lat, lon: c.lon, name: c.name, cls, closed: pc.open[i] === 0, samples };
    });
    m.setCafes(items, state.selected);
  }
  const box = $('mapCard');
  const sel = state.rows.find((c) => c.id === state.selected);
  if (sel) box.replaceChildren(cardFor(sel, day, i, state.cloudy));
  else {
    const li = document.createElement('li');
    li.className = 'hint';
    const n = state.rows.filter((c) => day.perCafe[c._i].sun[i] >= SUNNY && day.perCafe[c._i].open[i] !== 0).length;
    li.textContent = state.cafes.length
      ? `${n === 1 ? 'Ein Café liegt' : n + ' Cafés liegen'} gerade in der Sonne. Tippe auf einen Punkt für Details.`
      : '';
    box.replaceChildren(li);
  }
}

function selectCafe(id, fromList) {
  state.selected = id;
  const c = state.cafes.find((x) => x.id === id);
  if (fromList) showView('map');
  else render();
  if (c && state.map) state.map.flyTo(c.lat, c.lon);
}

async function showView(view) {
  state.view = view;
  store.set('view', view);
  document.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('mapView').hidden = view !== 'map';
  $('list').hidden = view !== 'list';
  if (view === 'map' && state.place) {
    try { await ensureMap(); } catch (e) { console.error(e); }
  }
  if (state.cafes.length || state.rows) render();
}

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip ' + cls;
  s.textContent = text;
  return s;
}

/* ---------- Suche ---------- */

async function search(q) {
  const ul = $('searchResults');
  ul.replaceChildren();
  const li0 = document.createElement('li'); li0.textContent = 'Suche …'; ul.append(li0);
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=de&accept-language=de'
      + '&viewbox=9.70,53.75,10.35,53.39&q=' + encodeURIComponent(q);
    const r = await fetch(u);
    const j = await r.json();
    ul.replaceChildren();
    if (!j.length) { const li = document.createElement('li'); li.textContent = 'Nichts gefunden.'; ul.append(li); return; }
    for (const p of j) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.display_name.split(',').slice(0, 3).join(',');
      b.onclick = () => setPlace({ lat: +p.lat, lon: +p.lon, label: p.display_name.split(',')[0], source: 'search' });
      li.append(b); ul.append(li);
    }
  } catch {
    ul.replaceChildren();
    const li = document.createElement('li'); li.textContent = 'Suche gerade nicht erreichbar.'; ul.append(li);
  }
}

/* ---------- Start ---------- */

function bind() {
  $('locBtn').onclick = () => { const s = $('search'); s.hidden = !s.hidden; if (!s.hidden) $('searchInput').focus(); };
  $('searchForm').onsubmit = (e) => { e.preventDefault(); const q = $('searchInput').value.trim(); if (q) search(q); };
  document.querySelector('[data-gps]').onclick = () => { $('search').hidden = true; useGps(); };
  document.querySelectorAll('[data-place]').forEach((b) => {
    b.onclick = () => { const [lat, lon, label] = b.dataset.place.split(','); setPlace({ lat: +lat, lon: +lon, label, source: 'preset' }); };
  });
  $('time').oninput = (e) => { state.step = +e.target.value; render(); };
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => showView(b.dataset.view); });
  $('btn3d').onclick = () => { const on = state.map?.toggle3d(); $('btn3d').setAttribute('aria-pressed', !!on); };
  $('nowBtn').onclick = () => {
    const day = dayInfo(0);
    const now = new Date();
    selectDay(now > day.sunset ? 1 : 0);
  };
  const f = state.filters;
  $('fOpen').checked = f.open; $('fSun').checked = f.sun; $('fNoSeat').checked = f.noSeat; $('fRadius').value = String(f.radius);
  const onFilter = () => {
    const oldR = f.radius;
    f.open = $('fOpen').checked; f.sun = $('fSun').checked; f.noSeat = $('fNoSeat').checked; f.radius = +$('fRadius').value;
    store.set('filters', f);
    if (f.radius !== oldR) { load(); return; }
    if (state.cafes.length) { drawHisto(); render(); }
  };
  ['fOpen', 'fSun', 'fNoSeat', 'fRadius'].forEach((id) => $(id).addEventListener('change', onFilter));
  window.addEventListener('resize', () => { if (state.cafes.length) drawHisto(); });
  document.addEventListener('visibilitychange', () => {
    // Nach längerer Pause wieder auf „jetzt“ springen
    if (document.visibilityState === 'visible' && state.cafes.length && state.lastHidden && Date.now() - state.lastHidden > 15 * 60000) selectDay(0);
    if (document.visibilityState === 'hidden') state.lastHidden = Date.now();
  });
}

bind();
showView(state.view);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
const fromUrl = placeFromUrl();
if (fromUrl) setPlace(fromUrl); else useGps();
