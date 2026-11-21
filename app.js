// Sunseat – Sonnen-Karte mit Cafés und Bars
import { SunLayer, MIN_ZOOM } from './sunlayer.js';
import { addFeedback, allFeedback, feedbackFor, markReplaced } from './db.js';
import { loadProfiles, covers, sunFraction, timeline } from './profiles.js';
import { sunVector, compass } from './shadow.js';
import { Places, SUNNY, openTimeline, subLabel, weekHours, preciseContext, preciseTimeline } from './places.js';

/* global maplibregl, SunCalc */

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const TILES = 'https://tiles.openfreemap.org/planet';
const START = { lng: 9.9662, lat: 53.5636, zoom: 16.4 }; // Sternschanze
const STEP = 5;              // Minuten
const PLACES_ZOOM = 15;      // ab hier alle Cafés und Bars
const OVERVIEW_ZOOM = 13;    // ab hier die Orte in der Sonne
const MAX_LIST = 120;
const PROFILE_ZOOM = 10;     // ab hier vorab berechnete Sonnenplätze (Hamburg)
const MAX_TILES = 40;        // mehr Kacheln (sehr großer Bildschirm, weit herausgezoomt) werden nicht geladen

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric' });
const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const fmtDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' });
const hhmm = (d) => fmtTime.format(d);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('sunseat.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sunseat.' + k, JSON.stringify(v)); } catch { /* egal */ } },
};

const state = {
  dayOffset: 0, steps: [], suns: [], idx: 0, dayKey: '',
  clouds: null, cloudsAt: null,
  filters: { open: false, sun: false, cafe: false, bar: false, seat: false, ...store.get('filters3', {}) },
  places: [], source: 'osm', rows: [], selected: null, placesKey: '',
  detent: 'medium',
};

/* ================= Karte ================= */

// Jedes Gerät startet mit seiner eigenen Ansicht: zuletzt gesehene Stelle auf diesem Gerät,
// danach der eigene Standort. Positionen aus Links anderer Geräte werden ignoriert.
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const lastView = store.get('view', null);
const map = new maplibregl.Map({
  container: 'map', style: STYLE,
  center: lastView ? [lastView.lng, lastView.lat] : [START.lng, START.lat], zoom: lastView?.zoom ?? START.zoom,
  minZoom: 10, maxZoom: 19,
  dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

let layer, places, me;

map.on('load', async () => {
  for (const l of map.getStyle().layers) if (/housenum|poi/i.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  let tileUrl;
  try { tileUrl = (await (await fetch(TILES)).json()).tiles[0]; } catch { notice('Kartendaten nicht erreichbar'); return; }
  layer = new SunLayer(map, tileUrl, { beforeId: firstLabel, onStatus, onTrees: () => { clearTimeout(state.treeTimer); state.treeTimer = setTimeout(refreshPlaces, 400); } });
  places = new Places(layer);
  addPlaceLayers();
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  selectDay(0);
  loadClouds();
  loadProfiles().then((pr) => { state.profiles = pr; if (pr) refreshPlaces(); });
  refreshPlaces();
});

map.on('moveend', () => {
  const c = map.getCenter();
  store.set('view', { lng: +c.lng.toFixed(5), lat: +c.lat.toFixed(5), zoom: +map.getZoom().toFixed(2) });
  updateSun();
  refreshPlaces();
  if (!state.cloudsAt || distKm(c, state.cloudsAt) > 5) loadClouds();
});

function addPlaceLayers() {
  map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'places-hit', type: 'circle', source: 'places', paint: { 'circle-radius': 16, 'circle-opacity': 0 } });
  map.addLayer({
    id: 'places', type: 'circle', source: 'places',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, ['case', ['get', 'selected'], 7, 4.5], 16, ['case', ['get', 'selected'], 9, 6.5]],
      'circle-color': ['match', ['get', 'state'], 'sun', '#f5a524', 'part', '#f8c56a', 'cloudsun', '#fbe6c0', 'closed', '#ffffff', '#8a8f99'],
      'circle-stroke-color': ['case', ['get', 'selected'], '#111318', ['==', ['get', 'state'], 'closed'], '#8a8f99', ['==', ['get', 'state'], 'cloudsun'], '#f5a524', '#ffffff'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, ['case', ['get', 'selected'], 2.5, 1.5], 16, ['case', ['get', 'selected'], 3, 2]],
    },
  });
  map.addLayer({
    id: 'places-label', type: 'symbol', source: 'places', minzoom: 16.5,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12,
      'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-max-width': 9, 'text-optional': true,
      'symbol-sort-key': ['get', 'rank'],
    },
    paint: { 'text-color': '#111318', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
  });
  map.on('click', 'places-hit', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    if (String(f.properties.id).startsWith('h:')) goToProfilePlace(state.profiles.places.find((x) => x.id === f.properties.id));
    else select(f.properties.id);
  });
  map.on('mouseenter', 'places-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'places-hit', () => { map.getCanvas().style.cursor = ''; });
}

function onStatus(s) {
  if (s === 'zoom') notice(map.getZoom() >= OVERVIEW_ZOOM || profileMode() ? '' : 'Näher heranzoomen, um die Sonne zu sehen');
  else if (s === 'loading') notice('Lade Gebäude …');
  else if (s === 'error') notice('Gebäudedaten nicht erreichbar');
  else notice('');
}

let noticeTimer;
function notice(text) {
  clearTimeout(noticeTimer);
  const el = $('notice');
  if (!text) { noticeTimer = setTimeout(() => { el.hidden = true; }, 150); return; }
  el.textContent = text;
  el.hidden = false;
}

/* ================= Zeit ================= */

function dayStart(offset) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d;
}

function selectDay(offset) {
  const c = map.getCenter();
  const times = SunCalc.getTimes(dayStart(offset), c.lat, c.lng);
  const now = new Date();
  state.dayOffset = offset;
  // Heute reicht der Regler immer bis „jetzt“, auch vor Sonnenaufgang oder nach Sonnenuntergang
  let from = times.sunrise, to = times.sunset;
  if (offset === 0) { if (now < from) from = now; if (now > to) to = now; }
  const start = new Date(from);
  start.setMinutes(Math.floor(start.getMinutes() / STEP) * STEP, 0, 0);
  state.steps = [];
  for (let t = start.getTime(); t <= to.getTime() + STEP * 60000 - 1; t += STEP * 60000) state.steps.push(new Date(t));
  state.suns = state.steps.map((t) => ({ ...sunVector(SunCalc.getPosition(t, c.lat, c.lng)), date: t }));
  state.dayKey = `${offset}:${start.getTime()}:${state.steps.length}:${c.lat.toFixed(2)},${c.lng.toFixed(2)}`;
  state.sunrise = times.sunrise; state.sunset = times.sunset;
  const target = offset === 0 ? now : times.solarNoon;
  state.idx = nearestIdx(target);
  const s = $('slider');
  s.max = state.steps.length - 1;
  s.value = state.idx;
  $('rise').textContent = `Aufgang ${hhmm(times.sunrise)}`;
  $('set').textContent = `Untergang ${hhmm(times.sunset)}`;
  renderDays();
  updateSun();
  renderPlaces();
}

function nearestIdx(t) {
  return state.steps.reduce((best, s, i) => (Math.abs(s - t) < Math.abs(state.steps[best] - t) ? i : best), 0);
}

function renderDays() {
  const nav = $('days');
  nav.replaceChildren();
  for (let o = 0; o < 7; o++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o === 0 ? 'Heute' : o === 1 ? 'Morgen' : fmtDay.format(dayStart(o));
    b.setAttribute('aria-current', o === state.dayOffset);
    b.onclick = () => selectDay(o);
    nav.append(b);
  }
}

const SIDE = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];
const LONG = { N: 'Norden', NNO: 'Nordnordost', NO: 'Nordost', ONO: 'Ostnordost', O: 'Osten', OSO: 'Ostsüdost', SO: 'Südost', SSO: 'Südsüdost', S: 'Süden', SSW: 'Südsüdwest', SW: 'Südwest', WSW: 'Westsüdwest', W: 'Westen', WNW: 'Westnordwest', NW: 'Nordwest', NNW: 'Nordnordwest' };

function updateSun() {
  if (!layer || !state.steps.length) return;
  const t = state.steps[state.idx];
  const sun = state.suns[state.idx];
  layer.setSun(sun);
  $('time').textContent = hhmm(t);
  $('sun').textContent = sun.altDeg > 0 ? `Sonne ${Math.round(sun.altDeg)}° aus ${LONG[compass(sun.bearingDeg)]}` : 'Sonne unter dem Horizont';
  $('now').setAttribute('aria-pressed', state.dayOffset === 0 && Math.abs(t - new Date()) <= STEP * 60000);
  const pct = (state.idx / Math.max(1, state.steps.length - 1)) * 100;
  $('slider').style.setProperty('--track', `linear-gradient(90deg, var(--sun) ${pct}%, var(--separator) ${pct}%)`);
  renderCloud(t);
}

/* ================= Bewölkung ================= */

async function loadClouds() {
  const c = map.getCenter();
  state.cloudsAt = { lat: c.lat, lng: c.lng };
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat.toFixed(3)}&longitude=${c.lng.toFixed(3)}&hourly=cloud_cover,sunshine_duration&timezone=auto&forecast_days=7`;
    const j = await (await fetch(u)).json();
    state.clouds = new Map(j.hourly.time.map((t, i) => [t.slice(0, 13), {
      cloud: j.hourly.cloud_cover?.[i],
      sunMin: j.hourly.sunshine_duration?.[i] != null ? j.hourly.sunshine_duration[i] / 60 : null,
    }]));
  } catch { state.clouds = null; }
  if (state.steps.length) { updateSun(); renderPlaces(); }
}

const hourKey = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
};

/** Wetter zur Zeit t. Sonnenscheindauer ist bei Open-Meteo die Summe der vorangehenden Stunde. */
function weatherAt(t) {
  if (!state.clouds) return null;
  const cur = state.clouds.get(hourKey(t));
  const next = new Date(t); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const sum = state.clouds.get(hourKey(next));
  if (!cur && !sum) return null;
  const cloud = cur?.cloud ?? sum?.cloud;
  const sunMin = sum?.sunMin ?? cur?.sunMin;
  // Bewölkt: weniger als 15 Minuten Sonnenschein in dieser Stunde (ersatzweise ab 85 % Bewölkung)
  const cloudy = sunMin != null ? sunMin < 15 : cloud >= 85;
  return { cloud, sunMin, cloudy };
}

function renderCloud(t) {
  const w = weatherAt(t);
  state.cloudy = !!w?.cloudy;
  layer?.setCloudy(state.cloudy);
  $('cloud').textContent = !w ? '' : w.cloudy ? `Bewölkt (${Math.round(w.cloud)} %)` : `Bewölkung ${Math.round(w.cloud)} %`;
  $('cloud').classList.toggle('cloudy', state.cloudy);
}

function distKm(a, b) {
  const dx = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180), dy = (a.lat - b.lat) * 111;
  return Math.hypot(dx, dy);
}

/* ================= Orte ================= */

let placesRun = 0;
async function refreshPlaces() {
  if (!places) return;
  const run = ++placesRun;
  // Weit herausgezoomt in Hamburg: vorab berechnete Profile, nichts live laden
  if (profileMode()) { renderPlaces(); return; }
  const keys = map.getZoom() >= OVERVIEW_ZOOM ? layer.visibleTiles() : [];
  if (!keys.length || keys.length > MAX_TILES) {
    state.places = [];
    state.placesKey = '';
    renderPlaces();
    return;
  }
  const key = keys.join(',');
  if (key !== state.placesKey) {
    state.placesKey = key;
    state.fullDone = false;
    state.haveOsm = false;
    $('listMeta').textContent = 'Lade …';
    const { fast, full } = places.inTiles(keys);
    state.fastP = fast
      .then((list) => { if (state.placesKey === key && !state.haveOsm) { state.places = list; state.source = 'tiles'; } })
      .catch(() => { if (state.placesKey === key) $('listMeta').textContent = 'Nicht erreichbar'; });
    full.then(async (list) => {
      if (state.placesKey !== key) return;
      state.fullDone = true;
      if (list) { state.places = list; state.source = 'osm'; state.haveOsm = true; }
      try { await places.prepare(visiblePlaces(Infinity)); } catch { /* egal */ }
      if (state.placesKey === key) renderPlaces();
    });
  }
  await state.fastP;
  if (run !== placesRun) return;
  $('listMeta').textContent = 'Berechne …';
  try { await places.prepare(visiblePlaces(Infinity)); } catch { return; }
  if (run !== placesRun) return;
  renderPlaces();
}

function visiblePlaces(limit = MAX_LIST) {
  const b = map.getBounds();
  const c = map.getCenter();
  return state.places
    .filter((p) => b.contains([p.lon, p.lat]) || p.id === state.selected)
    .map((p) => ({ p, d: distKm(c, { lat: p.lat, lng: p.lon }) }))
    .sort((a, b2) => a.d - b2.d)
    .slice(0, limit)
    .map((x) => x.p);
}

/** Sonne und Öffnung eines Ortes für den gewählten Tag (gecacht). */
function info(p) {
  if (!places?.index) return null;
  let { sun, facadeDeg } = places.sunTimeline(p, state.dayKey, state.suns);
  // Im Gebiet des 3D-Stadtmodells genauer rechnen
  const ctx = state.precise?.ctx;
  let precise = false;
  if (ctx) {
    const [x, y] = layer.proj.toXY(p.lat, p.lon);
    if (ctx.lod.covers(x, y, 60)) { sun = preciseTimeline(places, p, ctx, state.dayKey, state.suns); precise = true; }
  }
  if (precise) return { sun, open: openArr(p), facadeDeg, precise };
  return { sun, open: openArr(p), facadeDeg };
}

function openArr(p) {
  p._open ??= new Map();
  if (!p._open.has(state.dayKey)) p._open.set(state.dayKey, openTimeline(p, state.steps));
  return p._open.get(state.dayKey);
}

function sunState(v) { return v < 0 ? 'night' : v >= SUNNY ? 'sun' : v > 0 ? 'part' : 'shade'; }

function sunText(sun, i) {
  const v = sun[i], st = sunState(v), steps = state.steps;
  if (st === 'night') return { st, text: 'Keine Sonne' };
  if (st === 'sun') {
    let j = i; while (j < sun.length && sun[j] >= SUNNY) j++;
    return { st, text: j >= sun.length ? 'Sonne bis Sonnenuntergang' : `Sonne bis ${hhmm(steps[j])}` };
  }
  let j = i; while (j < sun.length && !(sun[j] >= SUNNY)) j++;
  const later = j < sun.length ? `Sonne ab ${hhmm(steps[j])}` : 'Keine Sonne mehr';
  return { st, text: st === 'part' ? `Halbschatten · ${later}` : `Schatten · ${later}` };
}

function openText(p, t, code) {
  if (!p.oh) return { cls: '', text: state.source === 'tiles' ? '' : 'Keine Öffnungszeiten' };
  if (p.oh === 'invalid' || code === 2) return { cls: '', text: 'Öffnungszeiten unklar' };
  let next = null;
  try { next = p.oh.getNextChange(t); } catch { /* egal */ }
  const when = (n) => {
    if (!n) return '';
    if (n.toDateString() === t.toDateString()) return hhmm(n);
    if (n - t < 6 * 864e5) return `${fmtWeekday.format(n)} ${hhmm(n)}`;
    return `am ${fmtDate.format(n)}`;
  };
  if (code === 1) return { cls: 'is-open', text: next ? `Geöffnet bis ${when(next)}` : 'Geöffnet' };
  return { cls: 'is-closed', text: next ? `Geschlossen · öffnet ${when(next)}` : 'Geschlossen' };
}

function passes(p, inf, i) {
  const f = state.filters;
  if (f.cafe !== f.bar && !f[p.kind]) return false;
  if (f.seat && p.seating !== true) return false;
  if (f.open && inf.open[i] !== 1) return false;
  if (f.sun && !(inf.sun[i] >= SUNNY)) return false;
  return true;
}

function renderPlaces() {
  if (!state.steps.length) return;
  if (profileMode()) { renderProfiles(); return; }
  const i = state.idx, t = state.steps[i];
  const zoom = map.getZoom();
  const zoomOk = zoom >= PLACES_ZOOM;
  const overview = !zoomOk && zoom >= OVERVIEW_ZOOM && state.places.length > 0;
  let inView = zoomOk ? visiblePlaces() : [];
  if (overview && places?.index) {
    // Weit herausgezoomt: nur Orte, die gerade Sonne haben (günstig: nur dieser Zeitpunkt)
    inView = visiblePlaces(Infinity).filter((p) => places.sunAt(p, state.dayKey, state.suns, i) >= SUNNY && openArr(p)[i] !== 0);
  }
  const rows = [];
  let unknownHours = 0;
  for (const [k, p] of inView.entries()) {
    // Volle Tageskurve nur für die Liste; für weitere Punkte reicht der aktuelle Zeitpunkt
    const inf = k < MAX_LIST || zoomOk ? info(p) : { sun: Object.assign([], { [i]: places.sunAt(p, state.dayKey, state.suns, i) }), open: openArr(p), lite: true };
    if (!inf) continue;
    if (state.filters.open && inf.open[i] === 2) unknownHours++;
    if (!passes(p, inf, i) && p.id !== state.selected) continue;
    rows.push({ p, inf });
  }
  const rank = ({ inf }) => {
    const v = inf.sun[i], closed = inf.open[i] === 0;
    if (closed) return 5;
    if (v >= SUNNY) return 0;
    if (v > 0) return 1;
    for (let j = i + 1; j < inf.sun.length; j++) if (inf.sun[j] >= SUNNY) return 2;
    return 3;
  };
  rows.sort((a, b) => rank(a) - rank(b));
  state.rows = rows;
  // Aus der Übersicht angetippter Ort: nach dem Heranzoomen den passenden Live-Ort öffnen
  const pend = state.pendingSelect;
  if (pend && zoomOk && !state.selected) {
    const hit = state.places.find((x) => x.name === pend.name && metersBetween(x, pend) < 60);
    if (hit) { state.pendingSelect = null; select(hit.id); return; }
    if (Date.now() - pend.at > 30000) state.pendingSelect = null;
  }

  // Karte
  map.getSource('places')?.setData({
    type: 'FeatureCollection',
    features: rows.map(({ p, inf }, k) => {
      let st = inf.open[i] === 0 ? 'closed' : sunState(inf.sun[i]);
      if (state.cloudy && (st === 'sun' || st === 'part')) st = 'cloudsun';
      return { type: 'Feature', properties: { id: p.id, name: p.name, state: st, selected: p.id === state.selected, rank: k },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] } };
    }),
  });

  if (state.selected) { renderDetail(); return; }

  // Liste
  const sunny = rows.filter(({ inf }) => inf.sun[i] >= SUNNY && inf.open[i] !== 0).length;
  if (overview) {
    $('listTitle').textContent = rows.length ? `${rows.length} ${rows.length === 1 ? 'Sonnenplatz' : 'Sonnenplätze'}` : 'Keine Sonnenplätze';
    $('listMeta').textContent = state.cloudy ? 'bewölkt' : 'im Ausschnitt';
  } else {
    $('listTitle').textContent = !zoomOk ? 'Cafés und Bars' : rows.length ? `${rows.length} ${rows.length === 1 ? 'Ort' : 'Orte'}` : 'Keine Orte';
    $('listMeta').textContent = zoomOk && rows.length ? (state.cloudy ? `${sunny} frei, bewölkt` : `${sunny} in der Sonne`) : '';
  }
  const ul = $('list');
  ul.replaceChildren();
  const note = (text) => { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; ul.append(li); };
  if (!zoomOk && !overview) {
    note(zoom < OVERVIEW_ZOOM || state.placesKey === '' ? 'Zum Anzeigen näher heranzoomen.' : 'Lade …');
    return;
  }
  if (overview) note('Nur Orte in der Sonne. Für alle Orte näher heranzoomen.');
  if (state.cloudy) note('Laut Vorhersage bedeckt.');
  if (state.source === 'tiles') note(state.fullDone ? 'Öffnungszeiten gerade nicht abrufbar.' : 'Lade Öffnungszeiten …');
  if (state.filters.open && unknownHours) note(`${unknownHours} ${unknownHours === 1 ? 'Ort' : 'Orte'} ohne Öffnungszeiten ausgeblendet.`);
  if (!rows.length) { note('Keine Treffer mit diesen Filtern.'); return; }
  for (const { p, inf } of rows) {
    if (inf.lite) continue;
    const s = sunText(inf.sun, i), o = openText(p, t, inf.open[i]);
    const li = document.createElement('li');
    const closed = inf.open[i] === 0;
    const cloudy = state.cloudy && (s.st === 'sun' || s.st === 'part');
    if (cloudy) s.text = s.st === 'sun' ? 'Frei, aber bewölkt' : 'Halbschatten, bewölkt';
    li.innerHTML = `<button type="button" class="row">
      <span class="status-dot ${closed ? 'closed' : cloudy ? 'cloudsun' : s.st}" aria-hidden="true"></span>
      <span class="row-main">
        <span class="row-title">${esc(p.name)}</span>
        <span class="row-sub"><span class="${s.st === 'sun' && !closed && !cloudy ? 'is-sun' : ''}">${s.text}</span></span>
        ${o.text ? `<span class="row-sub"><span class="${o.cls}">${o.text}</span> · ${subLabel(p)}</span>` : `<span class="row-sub">${subLabel(p)}</span>`}
      </span>
    </button>`;
    li.firstChild.onclick = () => select(p.id);
    ul.append(li);
  }
}

/* ================= Vorab berechnete Sonnenplätze (weiter Zoom) ================= */

function profileMode() {
  const z = map.getZoom();
  if (z >= PLACES_ZOOM || z < PROFILE_ZOOM || !state.profiles) return false;
  const c = map.getCenter();
  return covers(state.profiles, c.lat, c.lng);
}

function goToProfilePlace(pl) {
  if (!pl) return;
  state.pendingSelect = { name: pl.name, lat: pl.lat, lon: pl.lon, at: Date.now() };
  map.easeTo({ center: [pl.lon, pl.lat], zoom: 17, duration: 700 });
}

function renderProfiles() {
  const pr = state.profiles;
  const i = state.idx, sun = state.suns[i];
  const f = state.filters;
  const b = map.getBounds(), c = map.getCenter();
  const sunny = [];
  for (const pl of pr.places) {
    if (!b.contains([pl.lon, pl.lat])) continue;
    if (f.cafe !== f.bar && !f[pl.kind]) continue;
    if (sunFraction(pl, sun, pr.bins) >= SUNNY) sunny.push(pl);
  }
  const center = { lat: c.lat, lon: c.lng };
  sunny.sort((a, b2) => metersBetween(center, a) - metersBetween(center, b2));
  map.getSource('places')?.setData({
    type: 'FeatureCollection',
    features: sunny.map((pl, k) => ({
      type: 'Feature',
      properties: { id: pl.id, name: pl.name, state: state.cloudy ? 'cloudsun' : 'sun', selected: false, rank: k },
      geometry: { type: 'Point', coordinates: [pl.lon, pl.lat] },
    })),
  });
  if (state.selected) return;
  $('listTitle').textContent = sunny.length ? `${sunny.length} ${sunny.length === 1 ? 'Sonnenplatz' : 'Sonnenplätze'}` : 'Keine Sonnenplätze';
  $('listMeta').textContent = state.cloudy ? 'bewölkt' : 'im Ausschnitt';
  const ul = $('list');
  ul.replaceChildren();
  const note = (text) => { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; ul.append(li); };
  note('Öffnungszeiten und Außenplätze erst beim Heranzoomen.');
  if (state.cloudy) note('Laut Vorhersage bedeckt.');
  if (sun.altDeg <= 0.5) { note('Keine Sonne zu dieser Zeit.'); return; }
  for (const pl of sunny.slice(0, MAX_LIST)) {
    const tl = timeline(pl, state.suns, pr.bins);
    let j = i; while (j < tl.length && tl[j] >= SUNNY) j++;
    const until = j >= tl.length ? 'Sonne bis Sonnenuntergang' : `Sonne bis ${hhmm(state.steps[j])}`;
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="row">
      <span class="status-dot ${state.cloudy ? 'cloudsun' : 'sun'}" aria-hidden="true"></span>
      <span class="row-main">
        <span class="row-title">${esc(pl.name)}</span>
        <span class="row-sub"><span class="${state.cloudy ? '' : 'is-sun'}">${state.cloudy ? 'Frei, aber bewölkt' : until}</span></span>
        <span class="row-sub">${subLabel(pl)}</span>
      </span>
    </button>`;
    li.firstChild.onclick = () => goToProfilePlace(pl);
    ul.append(li);
  }
}

/* ================= Detail ================= */

function select(id) {
  state.selected = id;
  const p = state.places.find((x) => x.id === id);
  if (p) loadPrecise(p);
  if (p) {
    const pad = window.innerWidth >= 760 ? 0 : Math.min(window.innerHeight * 0.55, sheetHeights().medium) / 2;
    map.easeTo({ center: [p.lon, p.lat], offset: [0, -pad], zoom: Math.max(map.getZoom(), 17), duration: 500 });
  }
  $('listView').hidden = true;
  $('detailView').hidden = false;
  $('content').scrollTop = 0;
  if (state.detent === 'small') setDetent('medium');
  renderPlaces();
}

/** 3D-Stadtmodell um den gewählten Ort laden (nur Hamburg). */
async function loadPrecise(p) {
  const ctx = state.precise?.ctx;
  if (ctx) {
    const [x, y] = layer.proj.toXY(p.lat, p.lon);
    if (ctx.lod.covers(x, y, 60)) return; // schon geladen
  }
  state.preciseAbort?.abort();
  const ac = new AbortController();
  state.preciseAbort = ac;
  state.preciseStatus = { id: p.id, status: 'loading' };
  renderPlaces();
  try {
    const next = await preciseContext(places, p, ac.signal);
    if (ac.signal.aborted) return;
    state.preciseStatus = { id: p.id, status: next ? 'ok' : 'none' };
    if (next) { state.precise = { ctx: next }; layer.setLod2(next.lod); }
  } catch {
    if (ac.signal.aborted) return;
    state.preciseStatus = { id: p.id, status: 'error' };
  }
  renderPlaces();
}

function deselect() {
  state.selected = null;
  state.rateFor = null;
  $('listView').hidden = false;
  $('detailView').hidden = true;
  renderPlaces();
}

function renderDetail() {
  const p = state.places.find((x) => x.id === state.selected);
  const v = $('detailView');
  if (!p) { deselect(); return; }
  const inf = info(p);
  if (!inf) return;
  const i = state.idx, t = state.steps[i];
  const s = sunText(inf.sun, i), o = openText(p, t, inf.open[i]);
  const tg = p.tags || {};
  const addr = [tg['addr:street'] && `${tg['addr:street']} ${tg['addr:housenumber'] || ''}`.trim(), tg['addr:postcode'] && `${tg['addr:postcode']} ${tg['addr:city'] || ''}`.trim()].filter(Boolean).join(', ');
  const web = tg.website || tg['contact:website'];
  const phone = tg.phone || tg['contact:phone'];
  const total = [...inf.sun].filter((x) => x >= SUNNY).length * STEP;

  // Tagesleiste aus Sonnen-Abschnitten
  const n = state.steps.length;
  let segs = '';
  for (let j = 0; j < n;) {
    const st = sunState(inf.sun[j]);
    let k = j; while (k < n && sunState(inf.sun[k]) === st) k++;
    const col = st === 'sun' ? 'var(--sun)' : st === 'part' ? 'var(--sun-soft)' : 'transparent';
    if (col !== 'transparent') segs += `<i style="left:${(j / n) * 100}%;width:${((k - j) / n) * 100}%;background:${col}"></i>`;
    j = k;
  }
  const week = weekHours(p, t);
  const dayName = state.dayOffset === 0 ? 'heute' : state.dayOffset === 1 ? 'morgen' : `am ${fmtWeekday.format(t)}`;

  // Bewertungsbereich beim Neuzeichnen behalten (Zustand und Knöpfe)
  const keepRate = state.rateFor === p.id ? $('rateBox') : null;
  keepRate?.remove();
  v.innerHTML = `
    <button type="button" class="back" id="back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Alle Orte</button>
    <h2>${esc(p.name)}</h2>
    <div class="subtitle">${subLabel(p)}${addr ? ' · ' + esc(addr) : ''}</div>
    <div class="actions">
      <a class="action primary" href="https://maps.apple.com/?daddr=${p.lat},${p.lon}&q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">Route</a>
      ${web ? `<a class="action" href="${esc(web)}" target="_blank" rel="noopener">Website</a>` : ''}
      ${phone ? `<a class="action" href="tel:${esc(phone.replace(/\s/g, ''))}">Anrufen</a>` : ''}
    </div>

    <section class="group">
      <h3>Sonne ${dayName}</h3>
      <div class="status-line ${s.st === 'sun' && !state.cloudy ? 'is-sun' : ''}">${s.text}</div>
      ${state.cloudy && (s.st === 'sun' || s.st === 'part') ? '<p class="note">Der Platz liegt frei, laut Vorhersage ist es aber bedeckt.</p>' : ''}
      <div class="dayline" aria-hidden="true">${segs}<i class="now" style="left:${(i / n) * 100}%"></i></div>
      <div class="dayline-scale"><span>${hhmm(state.sunrise)}</span><span>${hhmm(state.sunset)}</span></div>
      <p class="note source-note">${preciseNote(p, inf)}</p>
      <p class="note">${total ? `${total >= 60 ? Math.floor(total / 60) + ' h ' : ''}${total % 60 ? (total % 60) + ' min' : ''} Sonne an diesem Tag.` : 'An diesem Tag keine Sonne.'}
      ${inf.facadeDeg != null ? ` Tische vermutlich auf der ${SIDE[Math.round(inf.facadeDeg / 45) % 8]}seite.` : ''}</p>
    </section>

    <section class="group">
      <h3>Öffnungszeiten</h3>
      ${o.text ? `<div class="status-line ${o.cls}">${o.text}</div>` : ''}
      ${week ? `<ul class="kv">${week.map((r) => `<li class="${r.today ? 'today' : ''}"><span>${r.day}</span><span class="v">${r.text}</span></li>`).join('')}</ul>`
        : `<p class="note">${state.source === 'tiles' ? 'Gerade nicht abrufbar.' : 'In OpenStreetMap nicht eingetragen.'}</p>`}
    </section>

    <section class="group">
      <h3>Details</h3>
      <ul class="kv">
        <li><span>Außenplätze</span><span class="v">${p.seating === true ? 'Ja' : p.seating === false ? 'Nein' : 'Unbekannt'}</span></li>
        <li><span>Art</span><span class="v">${subLabel(p)}</span></li>
      </ul>
      ${p.osm ? `<p class="note"><a href="https://www.openstreetmap.org/edit?${p.osm.replace('/', '=')}" target="_blank" rel="noopener">Angaben in OpenStreetMap ergänzen</a></p>` : ''}
      <p class="note" id="fbSummary"></p>
    </section>

    <section class="group" ${ratingTimeOk(p) ? '' : 'hidden'}>
      <h3>Vor Ort</h3>
      <div id="rateBox"></div>
    </section>`;
  $('back').onclick = deselect;
  if (keepRate) $('rateBox').replaceWith(keepRate);
  else { state.rateFor = p.id; renderRating(p, inf); }
  feedbackFor(p.id).then((all) => {
    const el = $('fbSummary');
    const list = all.filter((f) => !f.replacedBy);
    if (!el || !list.length) return;
    const sun = list.filter((f) => f.answer === 'sun').length;
    el.textContent = `Deine Bewertungen: ${sun}× sonnig, ${list.length - sun}× Schatten.`;
  });
}

function preciseNote(p, inf) {
  if (inf.precise) return 'Berechnet mit 3D-Stadtmodell und Baumkataster.';
  const st = state.preciseStatus;
  if (st?.id === p.id && st.status === 'loading') return 'Lade 3D-Stadtmodell …';
  if (st?.id === p.id && st.status === 'error') return '3D-Stadtmodell nicht erreichbar. Gebäudehöhen aus OpenStreetMap.';
  return 'Gebäudehöhen aus OpenStreetMap.';
}

/* ================= Panel ================= */

function sheetHeights() {
  const H = window.innerHeight;
  const small = $('grabber').offsetHeight + $('timebar').offsetHeight + 1;
  const top = document.querySelector('.chips').getBoundingClientRect().bottom + 8;
  return { small, medium: Math.max(small + 120, Math.round(H * 0.45)), large: H - top };
}

function setDetent(d, animate = true) {
  if (window.innerWidth >= 760) return;
  state.detent = d;
  const s = $('sheet');
  s.classList.toggle('animate', animate);
  s.dataset.detent = d;
  document.body.classList.toggle('sheet-large', d === 'large');
  const h = sheetHeights()[d];
  document.documentElement.style.setProperty('--sheet-h', h + 'px');
}

function bindSheet() {
  const s = $('sheet');
  let y0 = 0, h0 = 0, drag = false, moved = false;
  const start = (e) => {
    if (e.target.closest('button, input, nav')) return;
    drag = true; moved = false; y0 = e.clientY; h0 = s.offsetHeight;
    s.classList.remove('animate');
  };
  const move = (e) => {
    if (!drag) return;
    const dy = y0 - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const hs = sheetHeights();
    document.documentElement.style.setProperty('--sheet-h', Math.max(hs.small, Math.min(hs.large, h0 + dy)) + 'px');
  };
  const end = (e) => {
    if (!drag) return;
    drag = false;
    const order = ['small', 'medium', 'large'];
    if (!moved) { setDetent(order[(order.indexOf(state.detent) + 1) % 3]); return; }
    const hs = sheetHeights(), h = s.offsetHeight, v = y0 - e.clientY;
    let d = order.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
    if (Math.abs(v) > 50 && d === state.detent) d = order[Math.max(0, Math.min(2, order.indexOf(d) + (v > 0 ? 1 : -1)))];
    setDetent(d);
  };
  $('grabber').addEventListener('pointerdown', start);
  $('timebar').addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  $('grabber').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = ['small', 'medium', 'large']; setDetent(o[(o.indexOf(state.detent) + 1) % 3]); }
  });
}

/* ================= Sonne in der Nähe ================= */

const NEAR_RADIUS = 2000; // Meter
const NEAR_MAX = 25;
let nearRun = 0;

function metersBetween(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function closeNearby() {
  nearRun++;
  $('nearby').hidden = true;
  refreshPlaces();
}

async function openNearby() {
  const run = ++nearRun;
  $('nearby').hidden = false;
  $('nearbyList').replaceChildren();
  $('nearbyFoot').textContent = '';
  const status = (t) => { if (run === nearRun) $('nearbyStatus').textContent = t; };
  status('Suche Standort …');
  let origin = state.me && Date.now() - state.me.at < 5 * 60000 ? state.me : await locate(false);
  let originLabel = '';
  if (!origin) {
    const c = map.getCenter();
    origin = { lat: c.lat, lon: c.lng };
    originLabel = ' um die Kartenmitte';
  }
  if (run !== nearRun) return;
  const now = new Date();
  $('nearbySub').textContent = `Sonne jetzt (${hhmm(now)}), im Umkreis von 2 km${originLabel}`;
  renderFeedbackFoot();

  // Sonne überhaupt da?
  const times = SunCalc.getTimes(now, origin.lat, origin.lon);
  if (now < times.sunrise || now > times.sunset) {
    status(now > times.sunset ? `Sonne untergegangen (${hhmm(times.sunset)}).` : `Sonnenaufgang um ${hhmm(times.sunrise)}.`);
    return;
  }
  const wx = weatherAt(now);
  if (wx?.cloudy) {
    status(`Bedeckt (${Math.round(wx.cloud)} % Bewölkung).`);
    return;
  }

  // Orte im Umkreis
  status('Lade Cafés und Bars …');
  const keys = layer.tilesAround(origin.lat, origin.lon, NEAR_RADIUS);
  const { fast, full } = places.inTiles(keys);
  let list = await Promise.race([full, new Promise((r) => setTimeout(() => r(null), 15000))]);
  if (!list) list = await fast.catch(() => []);
  if (run !== nearRun) return;
  const cand = list
    .map((p) => ({ p, d: metersBetween(origin, p) }))
    .filter(({ p, d }) => d <= NEAR_RADIUS && p.seating !== false)
    .sort((a, b) => a.d - b.d);

  status('Berechne …');
  try { await places.prepare(cand.map((x) => x.p)); } catch { status('Gebäudedaten nicht erreichbar.'); return; }
  if (run !== nearRun) return;

  // Heutige Zeitschritte am Standort
  const steps = [];
  const start = new Date(times.sunrise); start.setMinutes(Math.ceil(start.getMinutes() / STEP) * STEP, 0, 0);
  for (let t = start.getTime(); t <= times.sunset.getTime(); t += STEP * 60000) steps.push(new Date(t));
  const suns = steps.map((t) => ({ ...sunVector(SunCalc.getPosition(t, origin.lat, origin.lon)), date: t }));
  const dayKey = `near:${now.toDateString()}:${origin.lat.toFixed(2)},${origin.lon.toFixed(2)}`;
  const i = steps.reduce((b, t, k) => (Math.abs(t - now) < Math.abs(steps[b] - now) ? k : b), 0);

  const hits = [];
  for (const { p, d } of cand) {
    if (places.sunAt(p, dayKey, suns, i) < SUNNY) continue;
    p._open ??= new Map();
    if (!p._open.has(dayKey)) p._open.set(dayKey, openTimeline(p, steps));
    if (p._open.get(dayKey)[i] === 0) continue; // geschlossen
    hits.push({ p, d });
    if (hits.length >= NEAR_MAX) break;
  }
  if (run !== nearRun) return;
  if (!hits.length) {
    status('Gerade nichts in der Sonne.');
    return;
  }
  status('');
  const ul = $('nearbyList');
  for (const { p, d } of hits) {
    const sun = places.sunTimeline(p, dayKey, suns).sun;
    let j = i; while (j < sun.length && sun[j] >= SUNNY) j++;
    const until = j >= sun.length ? `Sonne bis Sonnenuntergang (${hhmm(times.sunset)})` : `Sonne bis ${hhmm(steps[j])}`;
    const o = openText(p, now, p._open.get(dayKey)[i]);
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" class="near-main">
        <span class="row-title">${esc(p.name)}</span>
        <span class="row-sub">${subLabel(p)} · ${d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km'} · ${Math.max(1, Math.round(d / 80))} min zu Fuß</span>
        <span class="row-sub"><span class="is-sun">${until}</span>${o.text ? ` · <span class="${o.cls}">${o.text}</span>` : ''}</span>
      </button>`;
    li.querySelector('.near-main').onclick = () => {
      if (!state.places.some((x) => x.id === p.id)) state.places.push(p);
      closeNearby();
      if (state.dayOffset !== 0) selectDay(0);
      select(p.id);
    };
    ul.append(li);
  }
}

const FB_MAX_DIST = 300;        // Meter: bewerten nur vor Ort
const FB_MAX_ACC = 100;         // Meter: GPS muss halbwegs genau sein
const FB_INTERVAL = 10 * 60000; // höchstens eine Bewertung pro Ort alle 10 Minuten

/** Frische Position (höchstens 2 Minuten alt); fragt GPS nur, wenn nötig. */
let locating = null;
async function freshPosition(force = false) {
  if (!force && state.me && Date.now() - state.me.at < 2 * 60000) return state.me;
  if (!locating) locating = locate(false).finally(() => { locating = null; });
  return locating;
}

/**
 * Bewertung in der Einzelansicht: „Ist es hier jetzt sonnig?“
 * Nur bis 300 m Entfernung vom aktuellen Standort (gegen Fern-Bewertungen); beim Absenden wird
 * die Position erneut geprüft. Gespeichert werden Antwort, Prognose und die Werte dafür.
 */
async function renderRating(p, inf) {
  const box = $('rateBox');
  if (!box) return;
  const recent = (await feedbackFor(p.id)).filter((f) => !f.replacedBy).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (recent && Date.now() - Date.parse(recent.ts) < FB_INTERVAL) {
    box.innerHTML = `<p class="fb-done">Deine Bewertung: <b>${recent.answer === 'sun' ? 'sonnig' : 'Schatten'}</b>, ${hhmm(new Date(recent.ts))}. <button type="button">Ändern</button></p>`;
    box.querySelector('button').onclick = () => showRatingButtons(box, p, recent);
    return;
  }
  const section = box.closest('section');
  if (!ratingTimeOk(p)) { section.hidden = true; return; }
  section.hidden = false;
  box.innerHTML = '<p class="note">Prüfe Standort …</p>';
  const me = await freshPosition();
  if ($('rateBox') !== box || state.selected !== p.id) return;
  const why = ratingBlocked(me, p);
  if (why) { box.innerHTML = `<p class="note">${why}</p>`; return; }
  showRatingButtons(box, p, null);
}

/** Bewerten nur bei Tageslicht und nicht eine Stunde vor bis eine Stunde nach Sonnenuntergang. */
function ratingTimeOk(p, now = new Date()) {
  const t = SunCalc.getTimes(now, p.lat, p.lon);
  if (now < t.sunrise || now > t.sunset.getTime() + 3600e3) return false;
  return Math.abs(now - t.sunset) > 3600e3;
}

function ratingBlocked(me, p) {
  if (!me) return 'Bewerten nur vor Ort (bis 300 m), mit Standortfreigabe.';
  if (me.accuracy > FB_MAX_ACC) return `Standort zu ungenau (±${Math.round(me.accuracy)} m).`;
  const d = metersBetween(me, p);
  if (d > FB_MAX_DIST) return `Bewerten nur vor Ort (bis 300 m). Du bist ${d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km'} entfernt.`;
  return null;
}

function showRatingButtons(box, p, replaces) {
  box.innerHTML = `<div class="fb"><span class="fb-q">Ist es hier jetzt sonnig?</span>
    <span class="fb-btns"><button type="button" data-a="sun">Sonnig</button><button type="button" data-a="shade">Schatten</button></span></div>`;
  box.querySelectorAll('button[data-a]').forEach((b) => {
    b.onclick = async () => {
      box.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      // Position beim Absenden erneut prüfen
      if (!ratingTimeOk(p)) { box.closest('section').hidden = true; return; }
      const me = await freshPosition(true);
      const why = ratingBlocked(me, p);
      if (why) { box.innerHTML = `<p class="note">${why}</p>`; return; }
      const answer = b.dataset.a;
      const now = new Date();
      const s = sunVector(SunCalc.getPosition(now, p.lat, p.lon));
      const diag = places.diagnose(p, { ...s, date: now });
      const wx = weatherAt(now);
      // Prognose für jetzt: aus der Tageskurve, wenn heute angezeigt wird (inkl. 3D-Modell), sonst aus den Sitzpunkten
      let fraction = diag.samples.filter((x) => x.lit).length / diag.samples.length;
      let source = 'osm';
      const inf = info(p);
      if (inf && state.dayOffset === 0) { fraction = inf.sun[nearestIdx(now)]; if (inf.precise) source = 'lod2'; }
      const record = {
        ts: now.toISOString(),
        answer,                                       // 'sun' | 'shade'
        replaces: replaces?.id ?? null,               // korrigierte frühere Bewertung
        place: { id: p.id, osm: p.osm || null, name: p.name, kind: p.sub || p.kind, lat: p.lat, lon: p.lon, seating: p.seating },
        user: { lat: me.lat, lon: me.lon, accuracy: Math.round(me.accuracy), distance_m: Math.round(metersBetween(me, p)) },
        prediction: {
          fraction,                                   // Anteil der Sitzpunkte in der Sonne
          state: fraction >= SUNNY ? 'sun' : fraction > 0 ? 'part' : 'shade',
          buildings: source,                          // 'lod2' = 3D-Stadtmodell, 'osm' = OpenStreetMap-Höhen
          trees: inHamburgBox(p) ? 'baumkataster-hamburg' : 'keine',
          facadeDeg: diag.facadeDeg,
          samples: diag.samples,                      // je Sitzpunkt: von Gebäude / Baum beschattet? (OSM-Rechnung)
        },
        sun: { altitude: +s.altDeg.toFixed(2), azimuth: +s.bearingDeg.toFixed(2) },
        weather: wx ? { cloud: wx.cloud, sunMin: wx.sunMin } : null,
        app: 'sunseat-v12',
      };
      const id = await addFeedback(record);
      if (replaces) await markReplaced(replaces, id);
      const agrees = (answer === 'sun') === (fraction >= SUNNY);
      box.innerHTML = `<p class="fb-done">Gespeichert: <b>${answer === 'sun' ? 'sonnig' : 'Schatten'}</b>, ${hhmm(now)}.${agrees ? '' : ' Weicht von der Prognose ab.'}</p>`;
    };
  });
}

const inHamburgBox = (p) => p.lon > 8.42 && p.lon < 10.34 && p.lat > 53.39 && p.lat < 53.97;

async function renderFeedbackFoot() {
  const all = await allFeedback();
  const el = $('nearbyFoot');
  const n = all.filter((f) => !f.replacedBy).length;
  el.innerHTML = `Bewerten kannst du in der Einzelansicht eines Ortes, vor Ort bis 300 m.${n ? ` Gespeichert auf diesem Gerät: ${n}. <button type="button" id="fbExport">Exportieren</button>` : ''}`;
  $('fbExport')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sunseat-rueckmeldungen-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

/* ================= Standort ================= */

function locate(fly = true) {
  return new Promise((resolve) => {
  if (!navigator.geolocation) return resolve(null);
  navigator.geolocation.getCurrentPosition((pos) => {
    const ll = [pos.coords.longitude, pos.coords.latitude];
    state.me = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
    resolve(state.me);
    if (!me) {
      const el = document.createElement('div');
      el.className = 'me';
      me = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map);
    } else me.setLngLat(ll);
    $('locate').classList.add('active');
    if (fly) map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 16.4), duration: 600 });
  }, () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}

/* ================= Bedienung ================= */

function syncChips() {
  document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', !!state.filters[b.dataset.filter]));
}

document.querySelectorAll('[data-filter]').forEach((b) => {
  b.onclick = () => {
    state.filters[b.dataset.filter] = !state.filters[b.dataset.filter];
    store.set('filters3', state.filters);
    syncChips();
    renderPlaces();
  };
});
$('slider').addEventListener('input', (e) => { state.idx = +e.target.value; updateSun(); renderPlaces(); });
$('now').onclick = () => selectDay(0);
// Nach längerer Pause wieder auf jetzt und den eigenen Standort springen
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { state.hiddenAt = Date.now(); return; }
  if (state.hiddenAt && Date.now() - state.hiddenAt > 10 * 60000 && layer) { selectDay(0); locate(false); }
});
$('locate').onclick = () => locate(true);
$('nearbyBtn').onclick = openNearby;
$('nearbyBack').onclick = closeNearby;
window.addEventListener('resize', () => setDetent(state.detent, false));

syncChips();
bindSheet();
setDetent('medium', false);
locate(true);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
