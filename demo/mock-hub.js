// In-browser mock hub for the GitHub Pages demo. GitHub Pages is static-only (no Node, no
// WebSocket relay), so this shim makes the UNCHANGED Player + Controller PWAs run with no server:
// it patches window.WebSocket and window.fetch, and runs a faithful hub entirely in the browser
// using the SAME shared/protocol.js reducers the real hub uses. A real Player tab and a real
// Controller tab (or the two iframes on the demo landing) talk to each other via BroadcastChannel;
// one context is elected (Web Locks) to run the single authoritative hub.
//
// The build (pipeline/build-demo.js) injects this as a module BEFORE the app module, so the patches
// are installed before the app opens its socket. This file is never loaded by the production app.

import {
  MSG, VERBS, TIERS,
  applyCommandToDesired, reconcileTimer, remainingSec, validateCommand, defaultDesired,
  makeWelcome, makeSnapshot, makeAck, makeDevices,
} from '../shared/protocol.js';

const SITE_ROOT = new URL('../', import.meta.url); // demo/ is one level under the site root
const assetUrl = (rel) => new URL(rel, SITE_ROOT).href;

// ---- a bus that reaches every same-origin context (BroadcastChannel) AND this one (local) ----
// BroadcastChannel never echoes to the sender, so local dispatch covers the leader talking to a
// client that lives in the same context (e.g. the leader iframe's own player).
function makeBroadcastBus() {
  const bc = 'BroadcastChannel' in self ? new BroadcastChannel('mp-demo-bus') : null;
  const localSinks = new Set();
  return {
    post(m) { if (bc) bc.postMessage(m); for (const fn of localSinks) queueMicrotask(() => fn(m)); },
    onAny(fn) { localSinks.add(fn); if (bc) bc.addEventListener('message', (e) => fn(e.data)); },
  };
}
// The transport is a pluggable {post, onAny} seam. demo/rtc-hub.js installs a WebRTC bus on
// self.__MP_BUS__ (loaded BEFORE this module, so no import race), and the SAME hub + unmodified apps
// then run peer-to-peer over an RTCDataChannel instead of BroadcastChannel — the /rtc/ demo. When it's
// the host it calls bus.setHost() (below) so the WebRTC bus knows to accept peers. (docs/DEPLOY.md)
const bus = self.__MP_BUS__ || makeBroadcastBus();

// ---- fake WebSocket: the app thinks it's talking to /ws; it's talking to the in-browser hub ----
const RealWebSocket = self.WebSocket;
const wsByConn = new Map(); // connId -> FakeWebSocket (in THIS context)
let connSeq = 0;

class FakeWebSocket {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    this.connId = `c${Date.now().toString(36)}-${connSeq++}-${Math.random().toString(36).slice(2, 6)}`;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this._lastHello = null;
    wsByConn.set(this.connId, this);
    // Open on the next microtask so the app can attach handlers first (mirrors real async open).
    queueMicrotask(() => { this.readyState = 1; if (this.onopen) this.onopen({ type: 'open' }); });
    // If a (new) hub announces itself later, re-identify so a leader hand-off doesn't lose us.
    this._onReady = () => { if (this._lastHello) bus.post({ to: 'hub', from: this.connId, frame: this._lastHello }); };
  }
  send(data) {
    let frame; try { frame = JSON.parse(data); } catch { return; }
    if (frame && frame.t === MSG.HELLO) this._lastHello = frame;
    bus.post({ to: 'hub', from: this.connId, frame });
  }
  deliver(frame) { if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    wsByConn.delete(this.connId);
    bus.post({ to: 'hub', from: this.connId, gone: true });
    if (this.onclose) this.onclose({ type: 'close', code: 1000, wasClean: true });
  }
}

function isWsUrl(url) {
  try { return /\/ws$/.test(new URL(String(url), location.href).pathname.replace(/\/$/, '')); }
  catch { return /\/ws(\?|$)/.test(String(url)); }
}
function WebSocketShim(url, protocols) {
  return isWsUrl(url) ? new FakeWebSocket(url) : new RealWebSocket(url, protocols);
}
for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WebSocketShim[k] = RealWebSocket[k];
self.WebSocket = WebSocketShim;

// A closing tab won't always call ws.close(); make sure the hub learns the client is gone.
addEventListener('pagehide', () => { for (const ws of wsByConn.values()) ws.close(); });

// ---- demo library store (baked sounds + user uploads persisted in localStorage) ----
const LS_UPLOADS = 'mp-demo-uploads';
const LS_ORDER = 'mp-demo-order';
const LS_FAVS = 'mp-demo-favs';
const LS_REGISTRY = 'mp-demo-registry';
const MAX_DEMO_UPLOAD = 3 * 1024 * 1024; // localStorage is small; keep demo uploads modest

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('demo persist failed', e); } };

let bakedCache = null;
async function bakedSoundscapes() {
  if (bakedCache) return bakedCache;
  try {
    const m = await fetchReal(assetUrl('player/assets/manifest.json'));
    const j = await m.json();
    bakedCache = j.soundscapes.map((s) => ({ id: s.id, label: s.label, url: assetUrl(`player/assets/${s.files[0]}`), kind: s.kind || 'noise' }));
  } catch { bakedCache = [{ id: 'white', label: 'White noise', url: assetUrl('player/assets/white.wav'), kind: 'noise' }]; }
  return bakedCache;
}
async function libraryPayload() {
  const favs = lsGet(LS_FAVS, []);
  const uploads = lsGet(LS_UPLOADS, []).map((u) => ({ id: u.id, label: u.label, url: u.dataUrl, kind: 'upload' }));
  const all = [...(await bakedSoundscapes()), ...uploads].map((s) => ({ ...s, fav: favs.includes(s.id) }));
  const order = lsGet(LS_ORDER, []);
  const rank = new Map(order.map((id, i) => [id, i]));
  all.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : Infinity) - (rank.has(b.id) ? rank.get(b.id) : Infinity));
  // Favorites pinned to the top (stable within each group), matching the real hub's libraryJson.
  return { soundscapes: [...all.filter((s) => s.fav), ...all.filter((s) => !s.fav)] };
}
function libraryChanged() { bus.post({ to: 'hub', libraryChanged: true }); }

// ---- fetch shim for the /api/* + /healthz routes the app calls ----
const fetchReal = self.fetch.bind(self);
const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const fileToDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(file);
});

self.fetch = async (input, init) => {
  let url; try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch { return fetchReal(input, init); }
  const p = url.pathname;
  const q = url.searchParams;
  if (p.endsWith('/api/library') && (!init || (init.method || 'GET') === 'GET')) return jsonResponse(await libraryPayload());
  if (p.endsWith('/healthz') || p.endsWith('/api/health')) return jsonResponse({ ok: true, serverEpochMs: Date.now(), persistHealthy: true, total: 0, online: 0, offline: 0 });
  if (p.endsWith('/api/library/order')) { lsSet(LS_ORDER, (q.get('ids') || '').split(',').filter(Boolean)); libraryChanged(); return jsonResponse({ ok: true }); }
  if (p.endsWith('/api/library/fav')) {
    const id = q.get('id'); if (!id) return jsonResponse({ error: 'no id' }, 400);
    const favs = lsGet(LS_FAVS, []);
    lsSet(LS_FAVS, q.get('on') === '1' ? [...new Set([...favs, id])] : favs.filter((f) => f !== id));
    libraryChanged(); return jsonResponse({ ok: true });
  }
  if (p.endsWith('/api/upload/rename')) {
    const ups = lsGet(LS_UPLOADS, []); const it = ups.find((u) => u.id === q.get('id'));
    if (!it) return jsonResponse({ error: 'not found' }, 404);
    it.label = (q.get('name') || it.label).slice(0, 60); lsSet(LS_UPLOADS, ups); libraryChanged();
    return jsonResponse({ ok: true, item: { id: it.id, label: it.label, url: it.dataUrl, kind: 'upload' } });
  }
  if (p.endsWith('/api/upload/delete')) {
    let ups = lsGet(LS_UPLOADS, []); if (!ups.some((u) => u.id === q.get('id'))) return jsonResponse({ error: 'not found' }, 404);
    ups = ups.filter((u) => u.id !== q.get('id')); lsSet(LS_UPLOADS, ups);
    lsSet(LS_FAVS, lsGet(LS_FAVS, []).filter((f) => f !== q.get('id'))); // drop a deleted upload from favorites too
    libraryChanged(); return jsonResponse({ ok: true });
  }
  if (p.endsWith('/api/device/forget')) {
    const reg = lsGet(LS_REGISTRY, {}); if (!reg[q.get('id')]) return jsonResponse({ error: 'not found' }, 404);
    bus.post({ to: 'hub', forget: q.get('id') }); return jsonResponse({ ok: true });
  }
  if (p.endsWith('/api/upload')) {
    const file = init && init.body;
    if (!(file instanceof Blob)) return jsonResponse({ error: 'no file' }, 400);
    if (file.size > MAX_DEMO_UPLOAD) return new Response('demo uploads are capped at 3 MB (localStorage) — the real hub allows 30 MB', { status: 413 });
    const ups = lsGet(LS_UPLOADS, []);
    const id = 'up-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = { id, label: (q.get('name') || 'Track').slice(0, 60), dataUrl: await fileToDataUrl(file) };
    ups.push(item); lsSet(LS_UPLOADS, ups); libraryChanged();
    return jsonResponse({ ok: true, item: { id, label: item.label, url: item.dataUrl, kind: 'upload' } });
  }
  return fetchReal(input, init);
};

// ---- the authoritative hub (runs only in the leader context) ----
class MiniHub {
  constructor() {
    this.registry = lsGet(LS_REGISTRY, {}); // deviceId -> { friendlyName, caps, tier, desired, reported, lastSeenEpochMs }
    this.players = new Map();     // deviceId -> connId
    this.controllers = new Set(); // connId
    this.conns = new Map();       // connId -> { role, deviceId }
    this.timers = new Map();      // deviceId -> timeout
    for (const id of Object.keys(this.registry)) this._rescheduleTimer(id);
    bus.onAny((m) => this._route(m));
    bus.post({ hubReady: true }); // tell existing clients to re-identify
  }
  _persist() { lsSet(LS_REGISTRY, this.registry); }
  _send(connId, obj) { bus.post({ to: connId, frame: obj }); }

  _route(m) {
    if (m.hubReady) return; // that's our own announcement / a rival's — ignore here
    if (m.libraryChanged) { const lib = { t: MSG.LIBRARY }; for (const c of this._all()) this._send(c, lib); return; }
    if (m.forget) { this._forget(m.forget); return; }
    if (m.to !== 'hub') return; // not addressed to the hub
    if (m.gone) { this._gone(m.from); return; }
    this._onMessage(m.from, m.frame);
  }
  _all() { return [...this.players.values(), ...this.controllers]; }

  _onMessage(connId, msg) {
    if (!msg || typeof msg !== 'object') return;
    const meta = this.conns.get(connId);
    if (!meta) { if (msg.t === MSG.HELLO) this._onHello(connId, msg); return; }
    switch (msg.t) {
      case MSG.REPORT: return this._onReport(connId, msg);
      case MSG.ACK: return this._broadcastToControllers(msg);
      case MSG.COMMAND: return this._onCommand(connId, msg);
      case MSG.PROBE: return this._onProbe(connId, msg);
      default: /* ping/pong/hello-again: ignore */
    }
  }

  _onHello(connId, msg) {
    if (msg.role === 'player') {
      const id = msg.deviceId;
      if (typeof id !== 'string' || !id) return;
      const now = Date.now();
      const existing = this.registry[id];
      this.registry[id] = {
        friendlyName: msg.friendlyName || (existing && existing.friendlyName) || id,
        caps: msg.caps || (existing && existing.caps) || {},
        tier: (msg.caps && msg.caps.tier) || (existing && existing.tier),
        desired: (existing && existing.desired) || defaultDesired(),
        reported: existing ? existing.reported : null,
        lastSeenEpochMs: now,
      };
      this.conns.set(connId, { role: 'player', deviceId: id });
      const old = this.players.get(id); if (old && old !== connId) this.conns.delete(old);
      this.players.set(id, connId);
      this._reconcile(id);
      this._persist();
      this._send(connId, makeWelcome({ serverEpochMs: now, devices: [] }));
      this._pushSnapshot(id);
      this._broadcastDevices();
    } else if (msg.role === 'controller') {
      this.conns.set(connId, { role: 'controller' });
      this.controllers.add(connId);
      this._send(connId, makeWelcome({ serverEpochMs: Date.now(), devices: this._deviceList() }));
    }
  }

  _onReport(connId, msg) {
    const meta = this.conns.get(connId); if (!meta || meta.role !== 'player') return;
    const d = this.registry[meta.deviceId]; if (!d) return;
    d.reported = { state: msg.state, gainLinear: msg.gainLinear, remainingSec: msg.remainingSec, soundscape: msg.soundscape, tier: msg.tier, micLevel: msg.micLevel };
    d.lastSeenEpochMs = Date.now();
    this._persist();
    this._broadcastDevices();
  }

  _onCommand(connId, msg) {
    const meta = this.conns.get(connId); if (!meta) return;
    const selfPlayer = meta.role === 'player' && msg.target === meta.deviceId;
    if (meta.role !== 'controller' && !selfPlayer) return;
    const check = validateCommand(msg);
    if (!check.ok) { this._send(connId, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: check.error })); return; }
    if ((msg.verb === VERBS.SET_TIMER || msg.verb === VERBS.START) && msg.durationMs !== undefined && Number.isFinite(Number(msg.durationMs))) {
      msg = { ...msg, endsAtEpochMs: Date.now() + Number(msg.durationMs) }; delete msg.durationMs;
    }
    const d = this.registry[msg.target];
    if (!d) { this._send(connId, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'unknown device' })); return; }
    d.desired = applyCommandToDesired(d.desired, msg);
    this._persist();
    this._rescheduleTimer(msg.target);
    this._broadcastDevices();
    if (selfPlayer) { this._pushSnapshot(msg.target); return; }
    const playerConn = this.players.get(msg.target);
    if (!playerConn) { this._send(connId, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'device offline' })); return; }
    this._reconcile(msg.target);
    if ((msg.verb === VERBS.SET_TIMER || msg.verb === VERBS.START) && this.registry[msg.target].desired.verb === VERBS.STOP) {
      this._send(connId, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: true })); return;
    }
    this._send(playerConn, msg); // relay; player ACKs when applied
  }

  _onProbe(connId, msg) {
    const meta = this.conns.get(connId); if (!meta || meta.role !== 'controller') return;
    const playerConn = this.players.get(msg.target);
    if (!playerConn) { this._send(connId, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'device offline' })); return; }
    this._send(playerConn, msg);
  }

  _gone(connId) {
    const meta = this.conns.get(connId); if (!meta) return;
    this.conns.delete(connId);
    if (meta.role === 'player' && meta.deviceId) { if (this.players.get(meta.deviceId) === connId) this.players.delete(meta.deviceId); this._broadcastDevices(); }
    else if (meta.role === 'controller') this.controllers.delete(connId);
  }

  _forget(id) {
    if (!this.registry[id]) return;
    this._clearTimer(id);
    delete this.registry[id];
    const conn = this.players.get(id); if (conn) this.players.delete(id);
    this._persist();
    this._broadcastDevices();
  }

  _broadcastToControllers(msg) { for (const c of this.controllers) this._send(c, msg); }
  _pushSnapshot(id) { const conn = this.players.get(id); if (!conn) return; this._send(conn, makeSnapshot({ deviceId: id, desired: this.registry[id].desired, serverEpochMs: Date.now() })); }
  _broadcastDevices() { const payload = makeDevices({ devices: this._deviceList() }); for (const c of this.controllers) this._send(c, payload); }
  _deviceList() {
    const now = Date.now();
    return Object.keys(this.registry).map((id) => {
      const d = this.registry[id];
      return { deviceId: id, friendlyName: d.friendlyName, caps: d.caps, tier: d.tier, desired: d.desired, reported: d.reported, online: this.players.has(id), lastSeenEpochMs: d.lastSeenEpochMs, remainingSec: remainingSec(d.desired, now) };
    });
  }

  // hub-owned absolute-deadline sleep timer (same semantics as hub/state.js)
  _reconcile(id) { const d = this.registry[id]; if (!d) return; const { desired, changed } = reconcileTimer(d.desired, Date.now()); if (changed) { d.desired = desired; this._clearTimer(id); this._persist(); } }
  _clearTimer(id) { const h = this.timers.get(id); if (h) { clearTimeout(h); this.timers.delete(id); } }
  _rescheduleTimer(id) {
    this._clearTimer(id); const d = this.registry[id]; if (!d) return;
    if (d.desired.verb !== VERBS.START || typeof d.desired.endsAtEpochMs !== 'number') return;
    const delay = d.desired.endsAtEpochMs - Date.now();
    if (delay <= 0) { this._fireTimer(id); return; }
    this.timers.set(id, setTimeout(() => this._fireTimer(id), Math.min(delay, 2147483647)));
  }
  _fireTimer(id) {
    this._clearTimer(id); const d = this.registry[id]; if (!d) return;
    const { changed } = reconcileTimer(d.desired, Date.now());
    if (!changed) { this._rescheduleTimer(id); return; }
    d.desired = { ...d.desired, verb: VERBS.STOP, endsAtEpochMs: null };
    this._persist(); this._pushSnapshot(id); this._broadcastDevices();
  }
}

// Non-leader contexts still need to (a) deliver hub replies to their local fake sockets and
// (b) re-identify when a hub announces itself.
bus.onAny((m) => {
  if (m.hubReady) { for (const ws of wsByConn.values()) ws._onReady(); return; }
  if (m.to && m.to !== 'hub' && wsByConn.has(m.to)) wsByConn.get(m.to).deliver(m.frame);
});

// Elect exactly one hub across all tabs/iframes via the Web Locks API. The lock is held for the
// lifetime of the context; if the leader tab closes, another acquires it and takes over (device
// registry survives in localStorage).
let miniHub = null;
const becomeHub = () => { miniHub = new MiniHub(); if (bus.setHost) bus.setHost(); }; // tell a WebRTC bus it's the peer host
if ('locks' in navigator && navigator.locks && navigator.locks.request) {
  navigator.locks.request('mp-demo-hub', { mode: 'exclusive' }, () => new Promise(() => becomeHub()));
} else {
  // No Web Locks (very old browser): fall back to a single in-context hub so a standalone tab still works.
  becomeHub();
}

// A small, dismissable banner so a standalone Player/Controller tab makes clear it's the demo.
if (self.top === self.window) {
  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.setAttribute('role', 'note');
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 12px;font:600 12px/1.4 -apple-system,system-ui,sans-serif;text-align:center;background:#1c1c1e;color:#fff;';
    b.innerHTML = '🔧 DEMO — the hub is simulated in your browser (no server). Open the <a style="color:#0a84ff" href="../">demo home</a> to see Player + Controller together.';
    document.body.appendChild(b);
  });
}
