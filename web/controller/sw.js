// Controller service worker — shell cache only (network-first), no media handling.
const SHELL = 'mp-controller-shell-v3';
const SHELL_PREFIX = 'mp-controller-shell-'; // only touch THIS app's caches on cleanup
const SHELL_FILES = [
  './', './index.html', './controller.js', './alarm.js', './manifest.webmanifest',
  '/app.css', '/shared/protocol.js', '/shared/tiers.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  // Per-origin CacheStorage is shared with /player — scope cleanup to this app's prefix. (finding #9)
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(SHELL_PREFIX) && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/ws' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
  );
});
