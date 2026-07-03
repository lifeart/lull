// mesh-playback hub — HTTP static host + WebSocket relay in one small process.
//
// Runs plain HTTP (default :8080). In production, Caddy terminates TLS in front of it so the
// PWAs get a secure context (required for service workers / audioSession / wake lock). For
// local testing, http://localhost:8080 is itself a secure context, so everything works on the
// dev machine without certs — you only need Caddy to reach a real iPhone. (docs/DESIGN.md §1.6)

import http from 'node:http';
import path from 'node:path';
import { readFileSync, createWriteStream } from 'node:fs';
import { rm, access, mkdir } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Store } from './store.js';
import { Hub } from './ws.js';
import { serveStatic, serveFileWithin } from './static.js';
import { buildAllowedOrigins, makeVerifyClient, tokenMatches, originAllowed, sameHost } from './auth.js';
import { Uploads, MAX_UPLOAD_BYTES } from './uploads.js';

const MAX_CONCURRENT_UPLOADS = 4; // bound in-flight uploads so a flood can't OOM a 1 GB Pi
let uploadsInFlight = 0;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STATE_FILE = process.env.STATE_FILE || path.join(REPO_ROOT, 'data', 'state.json');
// Resolve to an ABSOLUTE path: serveFileWithin's containment check compares against baseDir, and
// a relative UPLOADS_DIR (e.g. "./data/uploads") would normalize away the "./" and 403 every file.
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(REPO_ROOT, 'data', 'uploads'));

// Handshake auth (see hub/auth.js): Origin allowlist blocks browser CSWSH; an optional MP_TOKEN
// shared secret is the only defense against non-browser clients on the LAN/tailnet.
const MP_TOKEN = process.env.MP_TOKEN || '';
const ALLOWED_ORIGINS = buildAllowedOrigins({ port: PORT, domain: process.env.MP_DOMAIN, extra: process.env.MP_ORIGIN });
const verifyClient = makeVerifyClient({ allowed: ALLOWED_ORIGINS, token: MP_TOKEN });
// Ghost-device eviction: a deviceId not seen in this many days is pruned so the registry can't
// fill with stale ids from iOS storage eviction / reinstalls. 0 disables. (finding #3)
const DEVICE_TTL_DAYS = Number(process.env.MP_DEVICE_TTL_DAYS ?? 45);
const DEVICE_TTL_MS = Number.isFinite(DEVICE_TTL_DAYS) && DEVICE_TTL_DAYS > 0 ? DEVICE_TTL_DAYS * 86400000 : 0;

// Refuse a present-but-disallowed browser Origin on state-mutating /api routes — mirrors the WS
// Origin allowlist so a malicious page in the parent's browser can't drive the hub cross-origin.
// Native clients (curl/tests) send no Origin and still pass, gated only by MP_TOKEN. (finding #13)
function originOk(req) { return originAllowed(req.headers.origin, ALLOWED_ORIGINS) || sameHost(req.headers.origin, req.headers.host); }
function denyOrigin(res) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden origin'); }

// Defense in depth: a stray rejection/exception should be logged, never crash the always-on hub.
// A single malformed WS frame or a bug in a handler must not take down every nursery's control
// channel. (finding #1)
process.on('unhandledRejection', (err) => console.error('[hub] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[hub] uncaughtException:', err));

const store = new Store(STATE_FILE);
const hub = new Hub(store);
const uploads = new Uploads(UPLOADS_DIR);

// Fail closed on a real network interface with no shared secret: an OPEN control channel there
// lets anyone on the LAN/tailnet start/stop/max-volume the speakers. Opt back in with
// MP_ALLOW_OPEN=1 (kept for the localhost dev box, which is trusted). (finding #14)
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
if (!MP_TOKEN && !IS_LOOPBACK && process.env.MP_ALLOW_OPEN !== '1') {
  console.error('[hub] REFUSING TO START: no MP_TOKEN set while bound to a non-loopback host ' +
    `(${HOST}). Set MP_TOKEN (e.g. \`openssl rand -hex 24\`) or, to intentionally run OPEN on a ` +
    'trusted LAN, set MP_ALLOW_OPEN=1.');
  process.exit(1);
}

// Boot-time writability probe: an unwritable /data volume (read-only mount, wrong owner) otherwise
// boots clean and silently loses every state change until the next restart reverts it. (finding #15)
async function assertWritable(dir, label) {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, FS.W_OK);
  } catch (err) {
    console.error(`[hub] FATAL: ${label} directory not writable: ${dir} (${err.message}). ` +
      'Fix the mount ownership/permissions and restart.');
    process.exit(1);
  }
}

// The sound library = baked noise loops (from the player manifest) + user uploads. One source
// of truth both player and controller read; the player resolves a soundscape id → url from it.
function libraryJson() {
  const out = [];
  try {
    const m = JSON.parse(readFileSync(path.join(WEB_DIR, 'player', 'assets', 'manifest.json'), 'utf8'));
    for (const s of m.soundscapes) out.push({ id: s.id, label: s.label, url: `/player/assets/${s.files[0]}`, kind: s.kind || 'noise' });
  } catch (err) { console.warn('[hub] manifest read failed:', err.message); }
  // Downloaded ambient loops (optional; produced by `npm run fetch:ambient`). Kept in a SEPARATE
  // manifest so `npm run bake` — which overwrites manifest.json — never clobbers them. Absent = not
  // installed (the common case, silent); a corrupt file warns.
  try {
    const a = JSON.parse(readFileSync(path.join(WEB_DIR, 'player', 'assets', 'ambient', 'ambient.json'), 'utf8'));
    for (const s of a.soundscapes) out.push({ id: s.id, label: s.label, url: `/player/assets/ambient/${s.files[0]}`, kind: 'ambient' });
  } catch (err) { if (err.code !== 'ENOENT') console.warn('[hub] ambient manifest read failed:', err.message); }
  out.push(...uploads.list());
  // Mark favorites, then sort: favorites pinned first, then the saved display order (stable).
  const favSet = new Set(uploads.getFavs());
  for (const s of out) s.fav = favSet.has(s.id);
  const rank = new Map(uploads.getOrder().map((id, i) => [id, i]));
  out.sort((a, b) => {
    if (a.fav !== b.fav) return a.fav ? -1 : 1;
    return (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity);
  });
  return { soundscapes: out };
}

// Gate every state-mutating /api route: browser Origin allowlist (CSRF) THEN optional token.
function authApi(req, res) {
  if (!originOk(req)) { denyOrigin(res); return false; }
  if (MP_TOKEN && !tokenMatches(req.url, MP_TOKEN)) { res.writeHead(401).end('unauthorized'); return false; }
  return true;
}

async function handleOrder(req, res) {
  if (!authApi(req, res)) return;
  const ids = (new URL(req.url, 'http://x').searchParams.get('ids') || '').split(',').filter(Boolean);
  await uploads.setOrder(ids);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  hub.broadcastLibrary();
}

// Toggle a soundscape's favorite flag (hub-synced; ?id=<soundscapeId>&on=0|1). Mirrors handleOrder:
// same auth gate, same MSG.LIBRARY broadcast → every client refetches /api/library. (research: favorites)
async function handleFav(req, res) {
  if (!authApi(req, res)) return;
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id');
  if (!id) { res.writeHead(400).end('missing id'); return; }
  await uploads.setFav(id, q.get('on') !== '0');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  hub.broadcastLibrary();
}

// Stream the body straight to a temp file (never buffer a 30 MB blob in RAM) with a hard size
// cap and a global in-flight limit, and reject early when the library is already full. (finding #12)
async function handleUpload(req, res) {
  if (!authApi(req, res)) return;
  if (uploads.isFull()) { res.writeHead(409).end('upload library full'); return; }
  if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) { res.writeHead(503, { 'Retry-After': '2' }).end('too many uploads in progress'); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  const label = (q.get('name') || 'Track').slice(0, 60);
  const ext = (q.get('ext') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  if (!uploads.extAllowed(ext)) { res.writeHead(415).end('unsupported audio type'); return; }

  uploadsInFlight++;
  let tmpPath = null, size = 0, finished = false;
  const finish = (code, body) => {
    if (finished) return;
    finished = true;
    uploadsInFlight--;
    if (!res.headersSent) res.writeHead(code, code === 200 ? { 'Content-Type': 'application/json' } : undefined);
    res.end(body);
  };
  const cleanupTmp = () => { if (tmpPath) rm(tmpPath, { force: true }).catch(() => {}); };
  try {
    tmpPath = await uploads.reserveTempPath(Date.now());
    const out = createWriteStream(tmpPath);
    out.on('error', (err) => { cleanupTmp(); finish(500, 'write failed: ' + err.message); req.destroy(); });
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) { out.destroy(); cleanupTmp(); finish(413, 'file too large'); req.destroy(); }
    });
    req.on('error', () => { out.destroy(); cleanupTmp(); finish(400, 'bad request'); });
    req.on('aborted', () => { out.destroy(); cleanupTmp(); finish(400, 'aborted'); });
    out.on('finish', async () => {
      if (finished) { cleanupTmp(); return; }
      if (size === 0) { cleanupTmp(); finish(400, 'empty upload'); return; }
      try {
        const item = await uploads.commitTemp({ label, ext, tmpPath, nowMs: Date.now() });
        tmpPath = null; // commitTemp renamed it away
        finish(200, JSON.stringify({ ok: true, item }));
        hub.broadcastLibrary();
      } catch (err) { cleanupTmp(); finish(500, err.message); }
    });
    req.pipe(out);
  } catch (err) { cleanupTmp(); finish(500, err.message); }
}

async function handleRename(req, res) {
  if (!authApi(req, res)) return;
  const q = new URL(req.url, 'http://x').searchParams;
  const item = await uploads.rename(q.get('id') || '', (q.get('name') || '').slice(0, 60));
  if (!item) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, item }));
  hub.broadcastLibrary();
}

async function handleDelete(req, res) {
  if (!authApi(req, res)) return;
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  const ok = await uploads.remove(id);
  if (!ok) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  hub.broadcastLibrary();
}

// Parent-facing "forget device": drops a ghost registration so the bedtime pre-flight can go
// green again and the MAX_DEVICES cap can't be filled by dead ids. (finding #3)
async function handleForget(req, res) {
  if (!authApi(req, res)) return;
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  const ok = hub.forgetDevice(id);
  if (!ok) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

const server = http.createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    if (p === '/healthz' || p === '/api/health') {
      const h = hub.healthCounts(); // { total, online, offline }
      const ok = store.persistHealthy;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ ok, serverEpochMs: Date.now(), persistHealthy: store.persistHealthy, ...h }));
      return;
    }
    if (p === '/api/library') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(libraryJson()));
      return;
    }
    if (p === '/api/library/order' && req.method === 'POST') { await handleOrder(req, res); return; }
    if (p === '/api/library/fav' && req.method === 'POST') { await handleFav(req, res); return; }
    if (p === '/api/upload/rename' && req.method === 'POST') { await handleRename(req, res); return; }
    if (p === '/api/upload/delete' && req.method === 'POST') { await handleDelete(req, res); return; }
    if (p === '/api/device/forget' && req.method === 'POST') { await handleForget(req, res); return; }
    if (p === '/api/upload' && req.method === 'POST') { await handleUpload(req, res); return; }
    if (p.startsWith('/uploads/')) {
      const ok = await serveFileWithin(req, res, UPLOADS_DIR, p.slice('/uploads'.length));
      if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
      return;
    }
    const served = await serveStatic(req, res);
    if (!served) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  } catch (err) {
    console.error('[http] handler error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end('server error');
  }
});

// maxPayload caps a single frame (well above any real message) so a malicious client can't make
// the hub buffer/JSON.parse a huge blob and stall the event loop.
const wss = new WebSocketServer({ server, path: '/ws', verifyClient, maxPayload: 64 * 1024 });
wss.on('connection', (ws) => hub.handleConnection(ws));

async function boot() {
  await assertWritable(path.dirname(STATE_FILE), 'state file');
  await assertWritable(UPLOADS_DIR, 'uploads');
  const evicted = store.pruneStale(DEVICE_TTL_MS, Date.now());
  if (evicted.length) console.log(`[hub] evicted ${evicted.length} device(s) unseen >${DEVICE_TTL_DAYS}d: ${evicted.join(', ')}`);
  hub.startHeartbeat();
  server.listen(PORT, HOST, () => {
    console.log(`[hub] listening on http://${HOST}:${PORT}`);
    console.log(`[hub]   player     : http://localhost:${PORT}/player/`);
    console.log(`[hub]   controller : http://localhost:${PORT}/controller/`);
    console.log(`[hub]   state file : ${STATE_FILE}`);
    console.log(`[hub]   auth       : ${MP_TOKEN ? 'token required (MP_TOKEN set)' : 'OPEN (MP_ALLOW_OPEN / loopback)'}`);
    if (!MP_TOKEN && !IS_LOOPBACK) {
      console.warn('[hub] ⚠ Running OPEN — anyone who can reach this hub can control the speakers. Set MP_TOKEN in production.');
    }
  });
}
boot();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[hub] shutting down…');
  hub.stop();
  wss.close();
  server.close();
  // Guarantee the last desired-state change (a just-issued stop / new sleep-timer) reached disk
  // before exit; the fire-and-forget persist would otherwise be lost on a fast SIGTERM. (finding #11)
  const hardExit = setTimeout(() => process.exit(0), 3000);
  hardExit.unref();
  try { await Promise.all([store.flush(), uploads.flush()]); } catch (err) { console.error('[hub] flush on shutdown failed:', err.message); }
  clearTimeout(hardExit);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, hub, store, uploads };
