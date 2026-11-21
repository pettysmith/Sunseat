// Sunseat – Sonnen-Karte
import { SunLayer, MIN_ZOOM } from './sunlayer.js';
import { sunVector, compass } from './shadow.js';

/* global maplibregl, SunCalc */

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
const TILES = 'https://tiles.openfreemap.org/planet';
const START = { lng: 9.9662, lat: 53.5636, zoom: 16.4 }; // Sternschanze
const STEP = 5; // Minuten

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric' });
const hhmm = (d) => fmtTime.format(d);

const state = { dayOffset: 0, steps: [], idx: 0, clouds: null, cloudsAt: null };

/* ---------- Karte ---------- */

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  center: [START.lng, START.lat],
  zoom: START.zoom,
  minZoom: 10,
  maxZoom: 19,
  hash: true,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  attributionControl: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

let layer;
let me;

map.on('load', async () => {
  // Basiskarte etwas ruhiger: keine Haus-Nummern, keine POI-Symbole
  for (const l of map.getStyle().layers) {
    if (/housenum|poi/i.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
  }
  const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  let tileUrl;
  try {
    tileUrl = (await (await fetch(TILES)).json()).tiles[0];
  } catch {
    notice('Kartendaten nicht erreichbar');
    return;
  }
  layer = new SunLayer(map, tileUrl, { beforeId: firstLabel, onStatus });
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  selectDay(0, true);
  loadClouds();
});

map.on('moveend', () => {
  updateSun();
  const c = map.getCenter();
  if (!state.cloudsAt || distKm(c, state.cloudsAt) > 5) loadClouds();
});

function onStatus(s) {
  if (s === 'zoom') notice('Näher heranzoomen, um die Sonne zu sehen');
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

/* ---------- Zeit ---------- */

function dayStart(offset) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d;
}

function selectDay(offset, initial = false) {
  const c = map.getCenter();
  let times = SunCalc.getTimes(dayStart(offset), c.lat, c.lng);
  const now = new Date();
  if (initial && offset === 0 && now > times.sunset) {
    offset = 1;
    times = SunCalc.getTimes(dayStart(1), c.lat, c.lng);
  }
  state.dayOffset = offset;
  const start = new Date(times.sunrise);
  start.setMinutes(Math.ceil(start.getMinutes() / STEP) * STEP, 0, 0);
  state.steps = [];
  for (let t = start.getTime(); t <= times.sunset.getTime(); t += STEP * 60000) state.steps.push(new Date(t));
  state.sunrise = times.sunrise;
  state.sunset = times.sunset;

  const target = offset === 0 && now >= state.steps[0] && now <= times.sunset ? now : times.solarNoon;
  state.idx = state.steps.reduce((best, t, i) => (Math.abs(t - target) < Math.abs(state.steps[best] - target) ? i : best), 0);

  const s = $('slider');
  s.max = state.steps.length - 1;
  s.value = state.idx;
  $('rise').textContent = `Aufgang ${hhmm(times.sunrise)}`;
  $('set').textContent = `Untergang ${hhmm(times.sunset)}`;
  renderDays();
  updateSun();
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

function updateSun() {
  if (!layer || !state.steps.length) return;
  const t = state.steps[state.idx];
  const c = map.getCenter();
  const sun = sunVector(SunCalc.getPosition(t, c.lat, c.lng));
  layer.setSun(sun);
  $('time').textContent = hhmm(t);
  $('sun').textContent = sun.altDeg > 0 ? `Sonne ${Math.round(sun.altDeg)}° hoch, aus ${compassLong(sun.bearingDeg)}` : 'Sonne unter dem Horizont';
  const now = new Date();
  $('now').hidden = state.dayOffset === 0 && Math.abs(t - now) <= STEP * 60000;
  const pct = (state.idx / Math.max(1, state.steps.length - 1)) * 100;
  $('slider').style.setProperty('--track', `linear-gradient(90deg, var(--sun) ${pct}%, var(--line) ${pct}%)`);
  renderCloud(t);
}

const LONG = { N: 'Norden', NNO: 'Nordnordost', NO: 'Nordost', ONO: 'Ostnordost', O: 'Osten', OSO: 'Ostsüdost', SO: 'Südost', SSO: 'Südsüdost', S: 'Süden', SSW: 'Südsüdwest', SW: 'Südwest', WSW: 'Westsüdwest', W: 'Westen', WNW: 'Westnordwest', NW: 'Nordwest', NNW: 'Nordnordwest' };
const compassLong = (deg) => LONG[compass(deg)];

/* ---------- Bewölkung ---------- */

async function loadClouds() {
  const c = map.getCenter();
  state.cloudsAt = { lat: c.lat, lng: c.lng };
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat.toFixed(3)}&longitude=${c.lng.toFixed(3)}&hourly=cloud_cover&timezone=auto&forecast_days=7`;
    const j = await (await fetch(u)).json();
    state.clouds = new Map(j.hourly.time.map((t, i) => [t.slice(0, 13), j.hourly.cloud_cover[i]]));
  } catch {
    state.clouds = null;
  }
  if (state.steps.length) renderCloud(state.steps[state.idx]);
}

function renderCloud(t) {
  const el = $('cloud');
  if (!state.clouds) { el.textContent = ''; return; }
  const p = (n) => String(n).padStart(2, '0');
  const v = state.clouds.get(`${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}`);
  el.textContent = v == null ? '' : `Bewölkung ${Math.round(v)} %`;
}

function distKm(a, b) {
  const dx = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180), dy = (a.lat - b.lat) * 111;
  return Math.hypot(dx, dy);
}

/* ---------- Standort ---------- */

function locate(fly = true) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const ll = [pos.coords.longitude, pos.coords.latitude];
    if (!me) {
      const el = document.createElement('div');
      el.className = 'me';
      me = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map);
    } else me.setLngLat(ll);
    $('locate').classList.add('active');
    if (fly) map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 16.4), duration: 600 });
  }, () => notice(''), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
}

/* ---------- Bedienung ---------- */

$('slider').addEventListener('input', (e) => { state.idx = +e.target.value; updateSun(); });
$('now').onclick = () => selectDay(0);
$('locate').onclick = () => locate(true);

const setPanelH = () => {
  const h = document.querySelector('.panel').offsetHeight;
  document.documentElement.style.setProperty('--panel-h', h + 8 + 'px');
};
new ResizeObserver(setPanelH).observe(document.querySelector('.panel'));

// Ohne gespeicherte Kartenposition im Link: zum eigenen Standort
if (!location.hash) locate(true);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
