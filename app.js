import { compass } from './shadow.js';
import {
  STEP_MIN, SUNNY, fetchOsm, fetchWeather, searchPlaces, buildArea, computeDay, dayDate,
  weatherAt, isCloudy, daySunshineHours, sampleLit, sunClass, sunMinutes,
} from './data.js';
import { SunMap } from './map.js';

const DEFAULT_PLACE = { lat: 53.5636, lon: 9.9662, label: 'Schanze', source: 'default' };
const RATING_TAGS = ['☕ Guter Kaffee', '🥐 Leckeres Essen', '🧣 Decken', '🔥 Heizstrahler', '🐶 Hunde ok', '💻 Laptop ok', '👶 Kinderfreundlich', '🌿 Ruhig'];

const $ = (id) => document.getElementById(id);
const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDayShort = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const fmtWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const fmtDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' });
const hhmm = (d) => fmtTime.format(d);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('sunseat.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sunseat.' + k, JSON.stringify(v)); } catch { /* egal */ } },
};

const state = {
  place: null,
  area: null,
  weather: null,
  days: new Map(),
  dayOffset: 0,
  step: 0,
  selected: null,
  filters: { sun: false, open: false, seat: false, ice: false, ...store.get('filters2', {}) },
  radius: store.get('radius', 500),
  ratings: store.get('ratings', {}),
  loadId: 0,
  drawnKey: null,
  map: null,
  pendingCafe: new URLSearchParams(location.search).get('cafe'),
};

/* ================= Ort ================= */

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
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, label: 'Hier bei dir', source: 'gps' }),
      reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

async function useGps() {
  toast('📍 Suche deinen Standort …');
  try { setPlace(await getGps()); } catch {
    toast('Kein Standortzugriff – ich zeige dir die Schanze.', 3500);
    setPlace({ ...DEFAULT_PLACE });
  }
}

function setPlace(place) {
  state.place = place;
  $('placeLabel').textContent = place.label;
  $('placeSub').textContent = place.source === 'gps' ? `Umkreis ${state.radius} m um dich` : `Umkreis ${state.radius} m`;
  updateUrl();
  closeSearch();
  load();
}

function updateUrl() {
  const u = new URL(location.href);
  u.search = '';
  const p = state.place;
  if (p && p.source !== 'gps' && p.source !== 'default') {
    u.searchParams.set('lat', p.lat.toFixed(5));
    u.searchParams.set('lon', p.lon.toFixed(5));
    u.searchParams.set('name', p.label);
  }
  if (state.selected) u.searchParams.set('cafe', state.selected);
  history.replaceState(null, '', u);
}

/* ================= Laden ================= */

async function load() {
  const id = ++state.loadId;
  const { lat, lon } = state.place;
  state.days.clear();
  state.area = null;
  state.selected = null;
  showList();
  $('listTitle').innerHTML = '<span class="spin">☀️</span> Die Sonne sucht Plätze …';
  $('listSub').textContent = 'Cafés und Häuser kommen aus OpenStreetMap. Das dauert meist 5 bis 20 Sekunden.';
  $('list').replaceChildren();
  const mapP = ensureMap();
  const weatherP = fetchWeather(lat, lon).catch(() => null);
  let osm;
  try {
    osm = await fetchOsm(lat, lon, state.radius);
  } catch {
    if (id !== state.loadId) return;
    $('listTitle').textContent = '🙈 OpenStreetMap antwortet gerade nicht';
    $('listSub').innerHTML = '<button class="btn" id="retry">Nochmal versuchen</button>';
    $('retry').onclick = load;
    return;
  }
  if (id !== state.loadId) return;
  await new Promise((r) => setTimeout(r, 0));
  const area = buildArea(osm, state.place, state.radius);
  state.weather = await weatherP;
  if (id !== state.loadId) return;
  state.area = area;
  state.drawnKey = null;

  await mapP.catch(() => {});
  if (state.map?.map) state.map.setArea({ place: state.place, ...area });

  const now = new Date();
  state.dayOffset = now > day(0).sunset ? 1 : 0;
  if (state.dayOffset === 1) toast('🌙 Heute ist die Sonne schon weg. Hier ist morgen.', 4000);
  selectDay(state.dayOffset);
  if (state.pendingCafe && area.cafes.some((c) => c.id === state.pendingCafe)) select(state.pendingCafe);
  state.pendingCafe = null;
}

function day(offset) {
  if (!state.days.has(offset)) state.days.set(offset, computeDay(state.area, state.place, offset));
  return state.days.get(offset);
}

/* ================= Auswertung ================= */

function passes(c, d, i) {
  const f = state.filters;
  const pc = d.perCafe[c._i];
  if (f.seat && c.seating !== 'yes') return false;
  if (!f.seat && c.seating === 'no') return false;
  if (f.ice && c.kind !== 'Eisdiele') return false;
  if (f.open && pc.open[i] === 0) return false;
  if (f.sun && !(pc.sun[i] >= SUNNY)) return false;
  return true;
}

function sunnyCount(d, i) {
  let n = 0;
  for (const c of state.area.cafes) {
    const pc = d.perCafe[c._i];
    if (c.seating === 'no' || pc.open[i] === 0) continue;
    if (state.filters.ice && c.kind !== 'Eisdiele') continue;
    if (pc.sun[i] >= SUNNY) n++;
  }
  return n;
}

function bestStep(d) {
  let best = 0, bestN = -1, bestD = Infinity;
  d.steps.forEach((t, i) => {
    const n = sunnyCount(d, i), dist = Math.abs(t - d.solarNoon);
    if (n > bestN || (n === bestN && dist < bestD)) { bestN = n; best = i; bestD = dist; }
  });
  return best;
}

function nearestStep(d, t) {
  let best = 0, bd = Infinity;
  d.steps.forEach((s, i) => { const x = Math.abs(s - t); if (x < bd) { bd = x; best = i; } });
  return best;
}

function fmtDur(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Sonnenzustand eines Cafés zur Zeit i, mit Text für Liste und Detail. */
function sunInfo(c, d, i) {
  const sun = d.perCafe[c._i].sun, steps = d.steps;
  const v = sun[i], cls = sunClass(v);
  const t = steps[i];
  if (cls === 'night') {
    const j = sun.findIndex((x) => x >= SUNNY);
    if (t < d.sunrise) return { cls, short: j >= 0 ? `Sonne ab ${hhmm(steps[j])}` : 'Heute ohne Sonne', big: 'Noch dunkel', sub: j >= 0 ? `Sonne ab ${hhmm(steps[j])}` : 'An diesem Tag keine Sonne' };
    return { cls, short: 'Sonne ist weg', big: 'Sonne ist weg 🌙', sub: `Untergang war um ${hhmm(d.sunset)}` };
  }
  if (cls === 'sun') {
    let j = i; while (j < sun.length && sun[j] >= SUNNY) j++;
    const toSunset = j >= sun.length - 1 || sun[j] < 0;
    const end = toSunset ? d.sunset : steps[j];
    const left = Math.max(0, Math.round((end - t) / 60000));
    return { cls, short: toSunset ? 'Sonne bis Untergang' : `Sonne bis ${hhmm(end)}`, big: toSunset ? `Sonne bis ${hhmm(end)} 🌇` : `Sonne bis ${hhmm(end)}`, sub: `noch ${fmtDur(left)}` };
  }
  let j = i; while (j < sun.length && !(sun[j] >= SUNNY)) j++;
  const has = j < sun.length && sun[j] >= 0;
  const wait = has ? Math.round((steps[j] - t) / 60000) : 0;
  if (cls === 'part') return { cls, short: 'Halb in der Sonne', big: 'Halb Sonne, halb Schatten', sub: has ? `ganz sonnig ab ${hhmm(steps[j])}` : 'Mehr Sonne kommt heute nicht' };
  return { cls, short: has ? `Sonne ab ${hhmm(steps[j])}` : 'Heute keine Sonne mehr', big: has ? `Sonne ab ${hhmm(steps[j])}` : 'Heute keine Sonne mehr', sub: has ? `in ${fmtDur(wait)}` : 'Morgen vielleicht?' };
}

function openInfo(c, t, code) {
  if (!c.oh) return { cls: 'unk', short: 'Öffnungszeiten unbekannt' };
  if (c.oh === 'invalid' || code === 2) return { cls: 'unk', short: 'Öffnungszeiten unklar' };
  let next = null;
  try { next = c.oh.getNextChange(t); } catch { /* egal */ }
  const when = (n) => {
    if (!n) return '';
    if (n.toDateString() === t.toDateString()) return hhmm(n);
    if (n - t < 6 * 864e5) return `${fmtWeekday.format(n)} ${hhmm(n)}`;
    return `am ${fmtDate.format(n)}`;
  };
  if (code === 1) return { cls: 'open', short: next ? `Geöffnet bis ${when(next)}` : 'Geöffnet' };
  return { cls: 'closed', short: next ? `Geschlossen · öffnet ${when(next)}` : 'Geschlossen' };
}

/* ================= Bewertungen ================= */

function rating(id) { return state.ratings[id] || null; }
function saveRating(id, patch) {
  const r = { stars: 0, tags: [], note: '', ...(state.ratings[id] || {}), ...patch, ts: Date.now() };
  if (!r.stars && !r.tags.length && !r.note) delete state.ratings[id];
  else state.ratings[id] = r;
  store.set('ratings', state.ratings);
}

function starsHtml(n, cls = '') {
  let s = `<span class="stars ${cls}" aria-label="${n} von 5 Sternen">`;
  for (let k = 1; k <= 5; k++) s += `<svg class="${k <= n ? 'on' : ''}"><use href="#i-star"/></svg>`;
  return s + '</span>';
}

/** Sonnen-Note: Sonnenminuten des Tages als 0–5 Sonnen. */
function sunScore(c, d) {
  const total = sunMinutes(d.perCafe[c._i].sun);
  const daylight = (d.sunset - d.sunrise) / 60000;
  return { total, score: Math.round(Math.min(1, total / Math.max(60, daylight * 0.6)) * 5) };
}

/* ================= Darstellung ================= */

function selectDay(offset) {
  state.dayOffset = offset;
  const d = day(offset);
  const now = new Date();
  state.step = offset === 0 && now >= d.steps[0] && now <= d.sunset ? nearestStep(d, now) : bestStep(d);
  const slider = $('time');
  slider.max = d.steps.length - 1;
  slider.value = state.step;
  $('riseLabel').textContent = `🌅 ${hhmm(d.sunrise)}`;
  $('setLabel').textContent = `${hhmm(d.sunset)} 🌇`;
  renderDays();
  drawHisto();
  render();
}

function renderDays() {
  const wrap = $('days');
  wrap.replaceChildren();
  for (let o = 0; o < 7; o++) {
    const dd = dayDate(o);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.className = 'day' + (o === state.dayOffset ? ' active' : '');
    b.setAttribute('aria-selected', o === state.dayOffset);
    const h = daySunshineHours(state.weather, dd);
    const icon = h == null ? '' : h >= 4 ? '☀️' : h >= 1.5 ? '🌤️' : h > 0.3 ? '⛅' : '☁️';
    const name = o === 0 ? 'Heute' : o === 1 ? 'Morgen' : fmtDayShort.format(dd);
    b.innerHTML = `<span class="day-ico">${icon}</span><span>${name}</span>${h == null ? '' : `<small>${h.toLocaleString('de-DE', { maximumFractionDigits: 1 })} h</small>`}`;
    b.onclick = () => selectDay(o);
    wrap.append(b);
  }
}

function drawHisto() {
  if (!state.area) return;
  const d = day(state.dayOffset);
  const cv = $('histo');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const counts = d.steps.map((_, i) => sunnyCount(d, i));
  const max = Math.max(1, ...counts);
  const thumb = 15;
  const bw = (w - thumb * 2) / counts.length;
  counts.forEach((n, i) => {
    const bh = n ? Math.max(3, (n / max) * (h - 2)) : 2;
    const cloudy = isCloudy(weatherAt(state.weather, d.steps[i]));
    g.fillStyle = !n ? 'rgba(128,128,128,.25)' : cloudy ? '#b8c0cc' : '#fbbf24';
    const x = thumb + i * bw;
    g.beginPath();
    g.roundRect(x + 0.6, h - bh, Math.max(1.5, bw - 1.2), bh, [2, 2, 0, 0]);
    g.fill();
  });
}

function render() {
  if (!state.area) return;
  const d = day(state.dayOffset);
  const i = state.step;
  const t = d.steps[i];
  const sun = d.suns[i];
  const now = new Date();
  const isNow = state.dayOffset === 0 && Math.abs(t - now) < STEP_MIN * 60000;
  const dayName = state.dayOffset === 0 ? 'Heute' : state.dayOffset === 1 ? 'Morgen' : fmtWeekday.format(t);
  $('timeLabel').textContent = `${dayName}, ${hhmm(t)}`;
  $('sunLabel').textContent = sun.altDeg > 0
    ? `☀️ ${Math.round(sun.altDeg)}° hoch aus ${compass(sun.bearingDeg)}${t < now - STEP_MIN * 60000 ? ' · vorbei' : ''}`
    : '🌙 Sonne unter dem Horizont';
  $('nowBtn').hidden = isNow;
  const wx = weatherAt(state.weather, t);
  const cloudy = isCloudy(wx);
  const wp = $('weatherPill');
  wp.hidden = !wx;
  if (wx) {
    const ico = cloudy ? (wx.cloud > 85 ? '☁️' : '⛅') : wx.cloud > 40 ? '🌤️' : '☀️';
    wp.textContent = `${ico} ${wx.temp != null ? Math.round(wx.temp) + '°' : Math.round(wx.cloud) + ' %'}`;
    wp.title = `Bewölkung ${Math.round(wx.cloud)} %${wx.sunMin != null ? `, ca. ${Math.round(wx.sunMin)} min Sonnenschein in dieser Stunde` : ''}`;
    wp.classList.toggle('cloudy', cloudy);
  }
  state.cloudy = cloudy;

  const rows = state.area.cafes.filter((c) => passes(c, d, i) || c.id === state.selected);
  const rank = (c) => {
    const pc = d.perCafe[c._i];
    const v = pc.sun[i];
    if (pc.open[i] === 0) return 5;
    if (v >= SUNNY) return 0;
    if (v > 0) return 1;
    for (let j = i + 1; j < pc.sun.length; j++) if (pc.sun[j] >= SUNNY) return 2 + j / 1000;
    return 4;
  };
  rows.sort((a, b) => rank(a) - rank(b) || a.dist - b.dist);
  state.rows = rows;

  renderMap(d, i);
  if (state.selected) renderDetail(d, i);
  else renderList(d, i, rows);
}

function renderMap(d, i) {
  const m = state.map;
  if (!m?.map || !state.area) return;
  const key = `${state.loadId}:${state.dayOffset}:${i}`;
  if (key !== state.drawnKey) { m.drawSun(d.suns[i]); state.drawnKey = key; }
  const visible = new Set(state.rows.map((c) => c.id));
  m.setCafes(state.area.cafes.map((c) => {
    const pc = d.perCafe[c._i];
    return {
      id: c.id, lat: c.lat, lon: c.lon, name: c.name, emoji: c.emoji,
      cls: sunClass(pc.sun[i]), closed: pc.open[i] === 0, hidden: !visible.has(c.id),
      samples: c.id === state.selected ? c.samples.map((p) => ({ lat: p.lat, lon: p.lon, lit: sampleLit(state.area, p, d.suns[i]) })) : [],
    };
  }), state.selected);
}

function headline(d, i, rows) {
  const n = rows.filter((c) => d.perCafe[c._i].sun[i] >= SUNNY && d.perCafe[c._i].open[i] !== 0).length;
  const sun = d.suns[i];
  if (sun.altDeg <= 0.5) return { title: '🌙 Nachtschicht', sub: 'Die Sonne schläft. Schieb den Regler oder wähl einen anderen Tag.' };
  if (!state.area.cafes.length) return { title: '🤷 Hier gibt es keine Cafés', sub: 'Probier einen größeren Umkreis oder einen anderen Ort.' };
  const best = bestStep(d), bn = sunnyCount(d, best);
  const tip = bn && best !== i ? ` Die meisten (${bn}) gibt es um ${hhmm(d.steps[best])}.` : '';
  if (state.cloudy && n) return { title: `⛅ ${n} ${n === 1 ? 'Platz wäre' : 'Plätze wären'} sonnig`, sub: 'Laut Vorhersage ist es aber bewölkt.' + tip };
  if (n) return { title: `☀️ ${n} ${n === 1 ? 'Sonnenplatz' : 'Sonnenplätze'} offen`, sub: (n > 3 ? 'Nichts wie raus!' : 'Schnell sein lohnt sich.') + tip };
  return { title: '😎 Gerade alles im Schatten', sub: bn ? `Um ${hhmm(d.steps[best])} liegen ${bn} Terrassen in der Sonne.` : 'An diesem Tag kommt laut Rechnung keine Terrasse in die Sonne.' };
}

function renderList(d, i, rows) {
  const h = headline(d, i, rows);
  $('listTitle').textContent = h.title;
  $('listSub').textContent = h.sub;
  const frag = document.createDocumentFragment();
  for (const c of rows) frag.append(listItem(c, d, i));
  if (!rows.length && state.area.cafes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<svg class="mascot big"><use href="#mascot"/></svg><p>Mit diesen Filtern bleibt nichts übrig.</p>';
    frag.append(li);
  }
  $('list').replaceChildren(frag);
}

function dayBar(c, d, i) {
  const pc = d.perCafe[c._i];
  const n = d.steps.length;
  const pct = (j) => (j / (n - 1)) * 100;
  const stops = [], ostops = [];
  for (let j = 0; j < n; j++) {
    const v = pc.sun[j];
    const col = v < 0 ? 'var(--night)' : v >= SUNNY ? 'var(--sun)' : v > 0 ? 'var(--part)' : 'var(--shade)';
    const oc = pc.open[j] === 1 ? 'var(--open)' : pc.open[j] === 0 ? 'transparent' : 'transparent';
    const a0 = pct(Math.max(0, j - 0.5)), a1 = pct(Math.min(n - 1, j + 0.5));
    stops.push(`${col} ${a0}%`, `${col} ${a1}%`);
    ostops.push(`${oc} ${a0}%`, `${oc} ${a1}%`);
  }
  return `<div class="daybar"><div class="daybar-sun" style="background:linear-gradient(90deg,${stops.join(',')})"></div><div class="daybar-open" style="background:linear-gradient(90deg,${ostops.join(',')})"></div><i style="left:${pct(i)}%"></i></div>`;
}

function listItem(c, d, i) {
  const pc = d.perCafe[c._i];
  const si = sunInfo(c, d, i);
  const oi = openInfo(c, d.steps[i], pc.open[i]);
  const r = rating(c.id);
  const { score } = sunScore(c, d);
  const li = document.createElement('li');
  li.className = `item is-${si.cls}${pc.open[i] === 0 ? ' is-closed' : ''}`;
  li.innerHTML = `
    <button type="button" class="item-btn">
      <span class="avatar av-${si.cls}">${c.emoji}${si.cls === 'sun' ? '<span class="av-badge">☀️</span>' : ''}</span>
      <span class="item-main">
        <span class="item-name">${esc(c.name)}</span>
        <span class="item-line">${r?.stars ? `<b class="rate">${r.stars},0</b>${starsHtml(r.stars, 'small')} · ` : ''}<span class="suns" title="Sonnen-Note für den Tag">${'☀'.repeat(score)}<span class="off">${'☀'.repeat(5 - score)}</span></span> · ${c.dist < 1000 ? Math.round(c.dist / 10) * 10 + ' m' : (c.dist / 1000).toFixed(1) + ' km'}</span>
        <span class="item-status"><span class="st st-${si.cls}${state.cloudy && si.cls === 'sun' ? ' cloudy' : ''}">${si.short}</span> · <span class="op op-${oi.cls}">${oi.short}</span></span>
        ${dayBar(c, d, i)}
      </span>
    </button>`;
  li.querySelector('.item-btn').onclick = () => select(c.id);
  return li;
}

function sunChart(c, d, i) {
  const pc = d.perCafe[c._i];
  const n = d.steps.length;
  const W = 340, H = 96, base = 78;
  const maxAlt = Math.max(5, ...d.suns.map((s) => s.altDeg));
  const x = (j) => (j / (n - 1)) * W;
  const y = (alt) => base - Math.max(0, alt) / maxAlt * 62;
  let bars = '';
  for (let j = 0; j < n; j++) {
    const v = pc.sun[j];
    const col = v < 0 ? 'var(--night)' : v >= SUNNY ? 'var(--sun)' : v > 0 ? 'var(--part)' : 'var(--shade)';
    const yy = y(d.suns[j].altDeg);
    bars += `<rect x="${x(j) - W / n / 2}" y="${yy}" width="${W / n + 0.4}" height="${base - yy}" fill="${col}"/>`;
    if (pc.open[j] === 1) bars += `<rect x="${x(j) - W / n / 2}" y="${base + 4}" width="${W / n + 0.4}" height="4" fill="var(--open)"/>`;
  }
  const curve = d.suns.map((s, j) => `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(s.altDeg).toFixed(1)}`).join('');
  const labels = [0, Math.floor((n - 1) / 2), n - 1].map((j, k) =>
    `<text x="${x(j)}" y="${H - 2}" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${hhmm(d.steps[j])}</text>`).join('');
  const sx = x(i), sy = y(d.suns[i].altDeg);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Sonne und Schatten über den Tag">
    ${bars}<path d="${curve}" fill="none" stroke="var(--ink)" stroke-opacity=".35" stroke-width="1.2"/>
    <line x1="${sx}" x2="${sx}" y1="4" y2="${base + 8}" stroke="var(--ink)" stroke-width="1.5"/>
    <circle cx="${sx}" cy="${sy}" r="5.5" fill="#fbbf24" stroke="#fff" stroke-width="2"/>
    ${labels}</svg>`;
}

function renderDetail(d, i) {
  const c = state.area.cafes.find((x) => x.id === state.selected);
  if (!c) { state.selected = null; return render(); }
  const pc = d.perCafe[c._i];
  const t = d.steps[i];
  const si = sunInfo(c, d, i);
  const oi = openInfo(c, t, pc.open[i]);
  const r = rating(c.id) || { stars: 0, tags: [], note: '' };
  const { total, score } = sunScore(c, d);
  const tg = c.tags;
  const addr = [tg['addr:street'] && `${tg['addr:street']} ${tg['addr:housenumber'] || ''}`.trim(), tg['addr:postcode'] && `${tg['addr:postcode']} ${tg['addr:city'] || ''}`.trim()].filter(Boolean).join(', ');
  const web = tg.website || tg['contact:website'];
  const phone = tg.phone || tg['contact:phone'];
  const heroEmoji = si.cls === 'sun' ? '<svg class="mascot hero-m"><use href="#mascot"/></svg>' : si.cls === 'night' ? '<span class="hero-e">🌙</span>' : si.cls === 'part' ? '<span class="hero-e">⛅</span>' : '<span class="hero-e">🌥️</span>';
  const v = $('detailView');
  v.innerHTML = `
    <div class="d-head">
      <button type="button" class="icon-btn" id="dBack" aria-label="Zurück zur Liste"><svg><use href="#i-back"/></svg></button>
      <div class="d-title">
        <h2>${esc(c.name)}</h2>
        <div class="d-line">${r.stars ? `<b class="rate">${r.stars},0</b> ${starsHtml(r.stars, 'small')} <span class="muted">(deine)</span> · ` : ''}${c.kind} · ${c.dist < 1000 ? Math.round(c.dist / 10) * 10 + ' m' : (c.dist / 1000).toFixed(1) + ' km'}</div>
        <div class="d-line"><span class="op op-${oi.cls}">${oi.short}</span></div>
      </div>
    </div>

    <div class="hero hero-${si.cls}${state.cloudy && si.cls === 'sun' ? ' hero-cloudy' : ''}">
      ${heroEmoji}
      <div>
        <div class="hero-big">${si.big}</div>
        <div class="hero-sub">${si.sub}${state.cloudy && si.cls === 'sun' ? ' · aber wohl bewölkt ☁️' : ''}</div>
      </div>
    </div>

    <div class="actions">
      <a class="act" href="https://maps.apple.com/?daddr=${c.lat},${c.lon}&q=${encodeURIComponent(c.name)}" target="_blank" rel="noopener"><span class="act-ico primary"><svg><use href="#i-route"/></svg></span>Route</a>
      <button type="button" class="act" id="aRate"><span class="act-ico"><svg><use href="#i-star"/></svg></span>Bewerten</button>
      <button type="button" class="act" id="aShare"><span class="act-ico"><svg><use href="#i-share"/></svg></span>Teilen</button>
      <a class="act" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name + ' ' + (tg['addr:street'] || '') + ' Hamburg')}" target="_blank" rel="noopener"><span class="act-ico"><svg><use href="#i-g"/></svg></span>Google</a>
    </div>

    <section class="d-sec">
      <div class="d-sec-head"><h3>Sonne ${state.dayOffset === 0 ? 'heute' : state.dayOffset === 1 ? 'morgen' : 'am ' + fmtWeekday.format(t)}</h3>
        <span class="suns big">${'☀'.repeat(score)}<span class="off">${'☀'.repeat(5 - score)}</span></span></div>
      ${sunChart(c, d, i)}
      <p class="muted small">${total ? `${fmtDur(total)} Sonne auf der Terrasse.` : 'Die Terrasse bekommt an diesem Tag keine Sonne.'} Der grüne Streifen zeigt, wann geöffnet ist.</p>
    </section>

    <ul class="info">
      <li><span>🕐</span><div>${oi.short}${tg.opening_hours ? `<small>${esc(tg.opening_hours)}</small>` : ''}</div></li>
      <li><span>🪑</span><div>${c.seating === 'yes' ? 'Hat Außenplätze' : c.seating === 'no' ? 'Keine Außenplätze laut OSM' : 'Außenplätze: unbekannt'}</div></li>
      <li><span>🧭</span><div>${c.facadeDeg != null ? `Tische vermutlich auf der ${compass(c.facadeDeg)}-Seite` : 'Steht frei, Tische rundherum möglich'}<small>Die Punkte auf der Karte zeigen die vermutete Lage.</small></div></li>
      ${addr ? `<li><span>📍</span><div>${esc(addr)}</div></li>` : ''}
      ${web ? `<li><span>🌐</span><div><a href="${esc(web)}" target="_blank" rel="noopener">${esc(web.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></div></li>` : ''}
      ${phone ? `<li><span>📞</span><div><a href="tel:${esc(phone.replace(/\s/g, ''))}">${esc(phone)}</a></div></li>` : ''}
    </ul>

    <section class="d-sec rate-sec" id="rateSec">
      <h3>Deine Bewertung</h3>
      <div class="rate-stars" role="radiogroup" aria-label="Sterne">
        ${[1, 2, 3, 4, 5].map((k) => `<button type="button" data-star="${k}" class="${k <= r.stars ? 'on' : ''}" aria-label="${k} Sterne"><svg><use href="#i-star"/></svg></button>`).join('')}
      </div>
      <div class="rate-tags">${RATING_TAGS.map((tag) => `<button type="button" class="tag${r.tags.includes(tag) ? ' on' : ''}" data-tag="${esc(tag)}">${tag}</button>`).join('')}</div>
      <textarea id="rateNote" rows="2" placeholder="Notiz für dich, z. B. „Ecktisch links hat am längsten Sonne“">${esc(r.note)}</textarea>
      <p class="muted small">Bleibt nur auf deinem Gerät.</p>
    </section>

    <p class="muted small d-foot">Daten: OpenStreetMap · <a href="https://www.openstreetmap.org/edit?${c.osmType}=${c.osmId}" target="_blank" rel="noopener">Fehler? In OSM verbessern</a></p>`;

  $('dBack').onclick = () => deselect();
  $('aRate').onclick = () => { setSnap('full'); $('rateSec').scrollIntoView({ behavior: 'smooth' }); };
  $('aShare').onclick = async () => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('lat', state.place.lat.toFixed(5));
    url.searchParams.set('lon', state.place.lon.toFixed(5));
    url.searchParams.set('name', state.place.label);
    url.searchParams.set('cafe', c.id);
    const text = `${c.name}: ${si.big} ☀️`;
    try {
      if (navigator.share) await navigator.share({ title: c.name, text, url: url.toString() });
      else { await navigator.clipboard.writeText(`${text} ${url}`); toast('Link kopiert 📋'); }
    } catch { /* abgebrochen */ }
  };
  v.querySelectorAll('[data-star]').forEach((b) => {
    b.onclick = () => {
      const k = +b.dataset.star;
      const cur = rating(c.id)?.stars || 0;
      saveRating(c.id, { stars: k === cur ? 0 : k });
      if (k !== cur) toast(['', '😬 Notiert.', '🙂 Notiert.', '😊 Schön!', '😍 Super!', '🤩 Sonnenplatz-Legende!'][k]);
      render();
    };
  });
  v.querySelectorAll('[data-tag]').forEach((b) => {
    b.onclick = () => {
      const tags = new Set(rating(c.id)?.tags || []);
      tags.has(b.dataset.tag) ? tags.delete(b.dataset.tag) : tags.add(b.dataset.tag);
      saveRating(c.id, { tags: [...tags] });
      b.classList.toggle('on');
    };
  });
  $('rateNote').onchange = (e) => saveRating(c.id, { note: e.target.value.trim() });
}

function select(id) {
  state.selected = id;
  $('listView').hidden = true;
  $('detailView').hidden = false;
  $('sheetBody').scrollTop = 0;
  updateUrl();
  if (state.snap !== 'full') setSnap('half');
  render();
  const c = state.area?.cafes.find((x) => x.id === id);
  if (c) state.map?.flyTo(c.lat, c.lon);
}

function deselect() {
  state.selected = null;
  updateUrl();
  showList();
  render();
}

function showList() {
  $('listView').hidden = false;
  $('detailView').hidden = true;
}

/* ================= Karte ================= */

async function ensureMap() {
  if (!state.map) state.map = new SunMap($('map'), { onSelect: select, onBackgroundClick: () => { if (state.selected) deselect(); } });
  await state.map.init(state.place);
  updateMapPadding();
}

/* ================= Bottom-Sheet ================= */

function snapHeights() {
  const H = window.innerHeight;
  const tb = $('timebox');
  const peek = Math.min(H * 0.5, $('grab').offsetHeight + tb.offsetHeight + 104);
  return { peek, half: Math.max(peek, Math.round(H * 0.56)), full: H - 72 - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0) };
}

function setSnap(snap, animate = true) {
  state.snap = snap;
  const h = snapHeights()[snap];
  const s = $('sheet');
  s.classList.toggle('anim', animate);
  s.dataset.snap = snap;
  s.style.height = h + 'px';
  updateMapPadding(h);
}

function updateMapPadding(h) {
  const sheetH = h ?? $('sheet').offsetHeight;
  document.documentElement.style.setProperty('--sheet-h', sheetH + 'px');
  state.map?.setPadding(Math.min(sheetH, window.innerHeight * 0.6), 110);
}

function bindSheet() {
  const s = $('sheet');
  let startY = 0, startH = 0, dragging = false, moved = false;
  const down = (e) => {
    if (e.target.closest('input, .days, button:not(.grab-able)') && !e.target.closest('#grab')) return;
    dragging = true; moved = false;
    startY = e.clientY; startH = s.offsetHeight;
    s.classList.remove('anim');
    s.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const { peek, full } = snapHeights();
    const h = Math.max(peek * 0.8, Math.min(full, startH + dy));
    s.style.height = h + 'px';
    document.documentElement.style.setProperty('--sheet-h', h + 'px');
  };
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    const hs = snapHeights();
    const h = s.offsetHeight;
    if (!moved) { // Tippen auf den Griff: eine Stufe weiter
      setSnap(state.snap === 'peek' ? 'half' : state.snap === 'half' ? 'full' : 'peek');
      return;
    }
    const v = startY - e.clientY;
    let snap = Object.entries(hs).reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0];
    if (Math.abs(v) > 60) { // Wischen bevorzugt die Richtung
      const order = ['peek', 'half', 'full'];
      const cur = order.indexOf(state.snap);
      snap = order[Math.max(0, Math.min(2, cur + (v > 0 ? 1 : -1)))];
      if (Math.abs(v) > 260) snap = v > 0 ? 'full' : 'peek';
    }
    setSnap(snap);
  };
  for (const el of [$('grab'), $('timebox').querySelector('.time-head')]) el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  // Liste ganz oben + weiter nach unten ziehen = Sheet verkleinern
  const body = $('sheetBody');
  let ty = null;
  body.addEventListener('touchstart', (e) => { ty = body.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (ty == null) return;
    const dy = e.touches[0].clientY - ty;
    if (dy > 70 && state.snap !== 'peek') { ty = null; setSnap(state.snap === 'full' ? 'half' : 'peek'); }
  }, { passive: true });
  body.addEventListener('scroll', () => { if (body.scrollTop > 20 && state.snap === 'peek') setSnap('half'); }, { passive: true });
}

/* ================= Suche ================= */

function openSearch() {
  $('search').hidden = false;
  requestAnimationFrame(() => $('search').classList.add('open'));
  setTimeout(() => $('searchInput').focus(), 50);
}
function closeSearch() {
  $('search').classList.remove('open');
  setTimeout(() => { $('search').hidden = true; }, 180);
}

async function runSearch(q) {
  const ul = $('searchResults');
  ul.innerHTML = '<li class="muted">Suche …</li>';
  try {
    const res = await searchPlaces(q);
    ul.replaceChildren();
    if (!res.length) { ul.innerHTML = '<li class="muted">Nichts gefunden 🤔</li>'; return; }
    for (const p of res) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" class="search-row"><span class="sr-ico">📍</span><span><b>${esc(p.label)}</b><small>${esc(p.detail)}</small></span></button>`;
      li.firstChild.onclick = () => setPlace({ ...p, source: 'search' });
      ul.append(li);
    }
  } catch {
    ul.innerHTML = '<li class="muted">Suche gerade nicht erreichbar.</li>';
  }
}

/* ================= Kleinkram ================= */

let toastTimer;
function toast(text, ms = 2200) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 250); }, ms);
}

function syncChips() {
  document.querySelectorAll('[data-filter]').forEach((b) => {
    const on = !!state.filters[b.dataset.filter];
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  });
  $('radiusChip').textContent = `📏 ${state.radius} m`;
}

function bind() {
  $('searchBtn').onclick = openSearch;
  $('searchClose').onclick = closeSearch;
  $('searchForm').onsubmit = (e) => { e.preventDefault(); const q = $('searchInput').value.trim(); if (q) runSearch(q); };
  document.querySelector('[data-gps]').onclick = useGps;
  document.querySelectorAll('[data-place]').forEach((b) => {
    b.onclick = () => { const [lat, lon, label] = b.dataset.place.split(','); setPlace({ lat: +lat, lon: +lon, label, source: 'preset' }); };
  });
  document.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      state.filters[b.dataset.filter] = !state.filters[b.dataset.filter];
      store.set('filters2', state.filters);
      syncChips();
      if (state.area) { drawHisto(); render(); }
    };
  });
  $('radiusChip').onclick = () => {
    const opts = [300, 500, 800];
    state.radius = opts[(opts.indexOf(state.radius) + 1) % opts.length];
    store.set('radius', state.radius);
    syncChips();
    toast(`Umkreis ${state.radius} m`);
    if (state.place) setPlace(state.place);
  };
  $('time').addEventListener('input', (e) => { state.step = +e.target.value; render(); });
  $('nowBtn').onclick = () => selectDay(new Date() > day(0).sunset ? 1 : 0);
  $('btn3d').onclick = () => { const on = state.map?.toggle3d(); $('btn3d').setAttribute('aria-pressed', !!on); };
  $('locateBtn').onclick = () => {
    if (state.place?.source === 'gps') state.map?.recenter(state.place.lat, state.place.lon);
    else useGps();
  };
  window.addEventListener('resize', () => { setSnap(state.snap || 'peek', false); drawHisto(); state.map?.resize(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') state.hiddenAt = Date.now();
    else if (state.area && state.hiddenAt && Date.now() - state.hiddenAt > 15 * 60000) selectDay(0);
  });
  bindSheet();
}

bind();
syncChips();
setSnap('peek', false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
const fromUrl = placeFromUrl();
if (fromUrl) setPlace(fromUrl); else useGps();
