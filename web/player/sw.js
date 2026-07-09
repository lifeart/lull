// Player service worker. Caches the app shell so a memory-pressure reload can rehydrate,
// but NEVER intercepts audio/Range requests — a mishandled Range breaks background playback.
// (docs/DESIGN.md §4)

const SHELL = 'mp-player-shell-v5'; // bump → drops the stale-cached shell (old JS) on activate
const SHELL_PREFIX = 'mp-player-shell-'; // only touch THIS app's caches on cleanup
const SHELL_FILES = [
  './', './index.html', './player.js', './audio.js', './manifest.webmanifest',
  '/app.css', '/icons.js', '/shared/protocol.js', '/shared/tiers.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // CacheStorage is per-ORIGIN (shared by /player and /controller), so scope cleanup to this app's
  // own cache prefix — otherwise activating one app's SW would wipe the other's offline shell and
  // a memory-pressure reload of the armed player could fail to rehydrate. (finding #9)
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(SHELL_PREFIX) && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Bypass: audio assets, Range requests, websocket, and cross-origin — straight to network.
  if (req.headers.has('range') || url.pathname.includes('/assets/') || url.pathname === '/ws' || url.origin !== location.origin) {
    return; // default network handling, Range/206 preserved
  }
  // Shell: network-first (fresh in dev), fall back to cache when offline.
  e.respondWith(
    fetch(req).then((res) => {
      // Only cache good responses — a transient 404/500/redirect must not clobber the shell.
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
  );
});
