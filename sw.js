// Sunseat Service Worker
// - App-Dateien: aus dem Netz, offline aus dem Cache
// - Kartenkacheln, Schriften, Kartenstil (OpenFreeMap): Cache zuerst, 7 Tage
// - Hamburger Daten (Baumkataster, 3D-Stadtmodell): Cache zuerst, 30 Tage
// - Wetter (Open-Meteo): Netz zuerst, bei Fehler bis 3 Stunden alt aus dem Cache
const VERSION = 'sunseat-v13';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'shadow.js', 'sunlayer.js', 'places.js', 'trees.js', 'lod2.js', 'db.js', 'profiles.js', 'data/horizons.json',
  'manifest.webmanifest', 'vendor/suncalc.js', 'vendor/opening_hours.js', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
  'vendor/vector-tile.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];
const DAY = 864e5;
const RULES = [
  { test: (u) => u.hostname === 'tiles.openfreemap.org', cache: 'sunseat-tiles', maxAge: 7 * DAY, max: 1500, strategy: 'cache' },
  { test: (u) => u.hostname === 'api.hamburg.de', cache: 'sunseat-hamburg', maxAge: 30 * DAY, max: 400, strategy: 'cache' },
  { test: (u) => u.hostname === 'api.open-meteo.com', cache: 'sunseat-weather', maxAge: 3 * 3600e3, max: 20, strategy: 'network' },
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = new Set([VERSION, ...RULES.map((r) => r.cache)]);
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** Antwort mit Zeitstempel ablegen (für das Ablaufdatum). */
async function store(cacheName, req, res, max) {
  const headers = new Headers(res.headers);
  headers.set('x-sunseat-cached', String(Date.now()));
  const body = await res.clone().arrayBuffer();
  const cache = await caches.open(cacheName);
  await cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers }));
  // Älteste Einträge entfernen, wenn zu viele
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function fresh(res, maxAge) {
  const t = +res?.headers.get('x-sunseat-cached');
  return res && t && Date.now() - t < maxAge;
}

async function handle(rule, req) {
  const cache = await caches.open(rule.cache);
  const hit = await cache.match(req);
  if (rule.strategy === 'cache' && fresh(hit, rule.maxAge)) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) store(rule.cache, req, res.clone(), rule.max).catch(() => {});
    return res;
  } catch (err) {
    if (hit && (rule.strategy === 'cache' || fresh(hit, rule.maxAge))) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const rule = RULES.find((r) => r.test(url));
  if (rule) { e.respondWith(handle(rule, e.request)); return; }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
