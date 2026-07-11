// Player service worker. Caches the app shell AND the sound files so the app works fully offline
// (travel, planes). (docs/DESIGN.md §4)
//
// Audio strategy — safe across every tier:
//   • A buffer-mode loop load is a `fetch()` (request.destination is '' , not 'audio'). We cache it
//     and serve it cache-first, so modern-browser playback (the audible source is the decoded buffer)
//     works with no network.
//   • The `<audio>` element (request.destination === 'audio') stays on the NATIVE network path while
//     online — old-iOS lock/background playback depends on native Range/206 and must never be
//     SW-served. Only when we're OFFLINE do we synthesize the element's response (a correct 206, or
//     the full file) from the cached copy, so a modern browser on a plane can still start playback.
// Old iOS never issues the `fetch()` load and is always online at home, so its behaviour is unchanged.

// Version is AUTO-INJECTED by the hub (hub/server.js replaces __SHELL_VER__ with a content hash of
// web/ + shared/), so any change to app JS/CSS/HTML mints a new SW → clients re-cache automatically,
// no manual bump. If served raw (e.g. a static host with no injection), the literal is a stable name.
const SHELL = 'mp-player-shell-__SHELL_VER__';
const SHELL_PREFIX = 'mp-player-shell-'; // only touch THIS app's shell caches on cleanup
const AUDIO = 'mp-audio-v1'; // shared with /controller (per-origin); bump to refresh sounds after a re-bake
const AUDIO_PREFIX = 'mp-audio-';
// EVERY module the player loads, or offline rehydrate fails on a cache miss (the SW would serve
// index.html for a missing .js → a module MIME error). errbar.js (classic, loads first) + monitor.js
// (imported by player.js) were missing — offline needs the complete graph.
const SHELL_FILES = [
  './', './index.html', './player.js', './audio.js', './monitor.js', './manifest.webmanifest',
  '/errbar.js', '/app.css', '/icons.js', '/shared/protocol.js', '/shared/tiers.js',
];
// Pre-cache the core noise loops so they play offline from the very first visit (best-effort — a
// missing asset in dev, or being offline during install, must not fail the shell install).
const CORE_SOUNDS = ['/player/assets/pink.wav', '/player/assets/white.wav', '/player/assets/brown.wav', '/player/assets/airflow.wav'];

const isAudio = (url) => url.pathname.includes('/assets/') || url.pathname.startsWith('/uploads/');

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)),
      caches.open(AUDIO).then((c) => c.addAll(CORE_SOUNDS)).catch((err) => console.warn('[sw] core-sound precache skipped:', err && err.message)),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // CacheStorage is per-ORIGIN (shared by /player and /controller): drop only THIS app's stale shell,
  // plus any stale AUDIO cache (the audio cache is shared, so both apps keep the current one). (finding #9)
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => (k.startsWith(SHELL_PREFIX) && k !== SHELL) || (k.startsWith(AUDIO_PREFIX) && k !== AUDIO))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname === '/ws') return;

  if (req.method === 'GET' && isAudio(url)) {
    if (req.destination !== 'audio') { e.respondWith(cacheFirstAudio(req)); return; } // fetch() loop load
    // <audio> element: native while online (old-iOS-safe); only synthesize from cache when offline.
    if (self.navigator && self.navigator.onLine === false) { e.respondWith(offlineMedia(req)); return; }
    return; // online media element → native network handling, SW not involved
  }

  // Shell: network-first (fresh in dev), fall back to cache when offline.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((m) => m || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});

// A plain (fetch()) sound load: serve the cached copy if present, else fetch it and cache the full
// 200 for next time / offline. Only full 200s are cached (these requests carry no Range).
async function cacheFirstAudio(req) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    return new Response('offline: sound not cached', { status: 504 });
  }
}

// Offline <audio>-element request: reconstruct the response from the cached FULL file (cached by the
// fetch() load or the install precache). Honors a Range header with a proper 206 so the element loads.
async function offlineMedia(req) {
  const cache = await caches.open(AUDIO);
  const full = await cache.match(req.url); // keyed by URL — matches the cached full 200
  if (!full) return new Response('offline: sound not cached', { status: 504 });
  const range = req.headers.get('range');
  if (!range) return full;
  return sliceRange(full, range);
}

// Slice a cached full response into a 206 Partial Content (mirrors the hub's static.js Range logic).
async function sliceRange(fullRes, rangeHeader) {
  const buf = await fullRes.arrayBuffer();
  const total = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  let start = 0, end = total - 1;
  if (m) {
    if (m[1] === '') {
      if (m[2] === '') return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
      start = Math.max(0, total - parseInt(m[2], 10));
    } else {
      start = parseInt(m[1], 10);
      if (m[2] !== '') end = parseInt(m[2], 10);
    }
  }
  if (isNaN(start) || isNaN(end) || start > end || end >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': fullRes.headers.get('Content-Type') || 'audio/wav',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
