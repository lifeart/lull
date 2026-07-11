// Controller service worker — caches the app shell AND the sound files so the local "This device"
// player and the sound library work fully offline (travel, planes). A page this SW controls fetches
// audio from /player/assets and /uploads (same origin), so audio caching lives here too.
//
// Same tier-safe audio strategy as the player SW: cache + serve `fetch()` loop loads (buffer mode)
// cache-first; leave the <audio> element on the native network path while online (old-iOS-safe) and
// only synthesize its response from cache when offline. See web/player/sw.js for the full rationale.

// Version is AUTO-INJECTED by the hub (hub/server.js replaces __SHELL_VER__ with a content hash of
// web/ + shared/), so any change to app JS/CSS/HTML mints a new SW → clients re-cache automatically,
// no manual bump. If served raw (e.g. a static host with no injection), the literal is a stable name.
const SHELL = 'mp-controller-shell-__SHELL_VER__';
const SHELL_PREFIX = 'mp-controller-shell-'; // only touch THIS app's shell caches on cleanup
const AUDIO = 'mp-audio-v1'; // shared with /player (per-origin); bump to refresh sounds after a re-bake
const AUDIO_PREFIX = 'mp-audio-';
// EVERY module the controller loads, or offline rehydrate fails on a cache miss (the SW would serve
// index.html for a missing .js → a module MIME error). errbar.js (classic, loads first) + the shared
// AudioEngine at /player/audio.js (imported by controller.js for the local player) were missing.
const SHELL_FILES = [
  './', './index.html', './controller.js', './alarm.js', './manifest.webmanifest',
  '/errbar.js', '/player/audio.js', '/app.css', '/icons.js', '/shared/protocol.js', '/shared/tiers.js',
];
const CORE_SOUNDS = ['/player/assets/pink.wav', '/player/assets/white.wav', '/player/assets/brown.wav'];

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
  // Per-origin CacheStorage is shared with /player — scope shell cleanup to this app's prefix, and
  // drop only stale AUDIO caches (the audio cache is shared, both apps keep the current one). (finding #9)
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
    if (self.navigator && self.navigator.onLine === false) { e.respondWith(offlineMedia(req)); return; }
    return; // online media element → native network handling, SW not involved
  }

  // Shell: network-first, fall back to cache when offline.
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

async function offlineMedia(req) {
  const cache = await caches.open(AUDIO);
  const full = await cache.match(req.url);
  if (!full) return new Response('offline: sound not cached', { status: 504 });
  const range = req.headers.get('range');
  if (!range) return full;
  return sliceRange(full, range);
}

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
