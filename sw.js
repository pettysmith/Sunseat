// Sunseat Service Worker: App-Dateien offline vorhalten, Daten immer frisch laden.
const VERSION = 'sunseat-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'shadow.js', 'map.js', 'data.js', 'manifest.webmanifest',
  'vendor/suncalc.js', 'vendor/opening_hours.js', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Netz zuerst, damit Updates sofort ankommen; offline aus dem Cache
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
