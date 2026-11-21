// Sunseat Service Worker: App-Dateien offline vorhalten, alles andere aus dem Netz.
const VERSION = 'sunseat-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'shadow.js', 'sunlayer.js', 'manifest.webmanifest',
  'vendor/suncalc.js', 'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/vector-tile.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
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
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
