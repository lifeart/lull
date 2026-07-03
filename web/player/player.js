// Player PWA controller: arm gesture, WS client, snapshot/command handling, recovery.
// The audio itself lives in audio.js; this file is wiring + reliability.

import {
  MSG, ROLES, STATES, VERBS,
  makeHello, makeReport, makeAck, makeCommand,
  applyCommandToDesired, reduceCommand, defaultDesired, remainingSec, probeAudibleReady,
  startIntentFailed,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS,
} from '/shared/protocol.js';
import { detectCaps, tierFromCaps, lockSummary } from '/shared/tiers.js';
import { AudioEngine } from './audio.js';

const $ = (id) => document.getElementById(id);

// --- identity (persist so a reload keeps the same device) ---
function getDeviceId() {
  let id = localStorage.getItem('mp.deviceId');
  if (!id) { id = 'dev-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('mp.deviceId', id); }
  return id;
}
const deviceId = getDeviceId();
// A setup link can prefill the room name (?name=Nursery) so nothing is typed on the old device. (P4)
function urlName() {
  try { const q = new URL(location.href).searchParams.get('name'); if (q) { const n = q.slice(0, 60); localStorage.setItem('mp.name', n); return n; } } catch (e) { console.warn('name param parse failed', e); }
  return '';
}
let friendlyName = urlName() || localStorage.getItem('mp.name') || '';

const caps = detectCaps();
const tier = tierFromCaps(caps);
caps.tier = tier;

let engine = null;
let ws = null;
let desired = defaultDesired();
let soundscapeUrls = { white: '/player/assets/white.wav' };
let soundscapeLabels = { white: 'White noise' };
let reconnectDelay = RECONNECT_BASE_MS;
let armed = false;
let lastReportAt = 0;
// Timers use absolute hub-clock epochs; align our clock to the hub's via serverEpochMs so a
// skewed old-device clock can't fire the sleep timer early/late.
let clockOffset = 0;
const hubNow = () => Date.now() + clockOffset;

// --- sound library (baked loops + uploads) maps id -> url ---
async function loadLibrary() {
  try {
    const res = await fetch('/api/library', { cache: 'no-cache' });
    if (res.ok) {
      const m = await res.json();
      const map = {}, labels = {};
      for (const s of m.soundscapes) { map[s.id] = s.url; labels[s.id] = s.label || s.id; }
      if (Object.keys(map).length) { soundscapeUrls = map; soundscapeLabels = labels; }
    }
  } catch (e) { console.warn('library load failed, using default', e); }
}
const urlFor = (id) => soundscapeUrls[id] || soundscapeUrls.white || '/player/assets/white.wav';
const labelFor = (id) => soundscapeLabels[id] || id;

// --- realize desired on the audio engine ---
async function realize() {
  if (!engine) return;
  if (desired.soundscape && !soundscapeUrls[desired.soundscape]) await loadLibrary(); // uploaded track not seen yet
  await engine.applyDesired({ ...desired, url: urlFor(desired.soundscape) });
  render();
}

// --- WebSocket ---
function authToken() {
  const q = new URL(location.href).searchParams.get('token');
  const h = (location.hash.match(/t=([^&]+)/) || [])[1];
  const t = q || (h && decodeURIComponent(h));
  if (t) localStorage.setItem('mp.token', t);
  return t || localStorage.getItem('mp.token') || '';
}
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const t = authToken();
  return `${proto}://${location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    send(makeHello({ role: ROLES.PLAYER, deviceId, friendlyName, caps }));
    report();
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
}

function scheduleReconnect() {
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 1.7);
  setTimeout(() => { if (!ws) connect(); }, reconnectDelay);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function onMessage(msg) {
  switch (msg.t) {
    case MSG.PING: send({ t: MSG.PONG }); break;
    case MSG.SNAPSHOT: // authoritative REPLACE-ALL — timer already reconciled by the hub
      if (typeof msg.serverEpochMs === 'number') clockOffset = msg.serverEpochMs - Date.now();
      desired = msg.desired;
      await realize();
      break;
    case MSG.COMMAND: {
      const r = reduceCommand(desired, msg, deviceId); // same shared reducer the hub uses
      desired = r.desired;
      let ack = r.ack;
      if (r.ok) {
        if (armed && engine) {
          await realize();
          // A start-intent command must only ACK success if audio actually reached PLAYING —
          // otherwise the parent sees a clean ACK for a silent (backgrounded / gesture-locked)
          // room and no alarm fires. Fold the realized state into the ACK. (finding #4)
          // Gate on the COMMAND's intent, not the reduced desired.verb: a routine SET_GAIN /
          // SET_SOUNDSCAPE on an already-silent (desired=START) device applied fine and must ACK ok,
          // else every volume nudge would NACK and re-blare the alarm. (review finding #2)
          const st = engine.getState();
          if (startIntentFailed(msg.verb, r.desired.verb, st)) {
            ack = makeAck({ deviceId, cmdId: msg.cmdId, ok: false, error: st });
          }
        } else {
          ack = makeAck({ deviceId, cmdId: msg.cmdId, ok: false, error: 'not armed' });
        }
      }
      send(ack);
      report();
      break;
    }
    case MSG.PROBE: { // bedtime pre-flight liveness — ACK only if actually audible-capable
      const st = engine ? engine.getState() : null;
      send(makeAck({ deviceId, cmdId: msg.cmdId, ok: probeAudibleReady(armed, st) }));
      break;
    }
    case MSG.WELCOME:
      if (typeof msg.serverEpochMs === 'number') clockOffset = msg.serverEpochMs - Date.now();
      break;
    case MSG.LIBRARY: await loadLibrary(); break; // a track was uploaded — refresh id→url map
    case MSG.ERROR: console.warn('[hub error]', msg.error); break;
  }
}

function report() {
  if (!engine) return;
  lastReportAt = Date.now();
  // Re-verify liveness first so a PLAYING claim can never outlive the audio actually flowing
  // (OS interruption with no visibility event). (finding #2)
  const state = engine.reconcileLiveness ? engine.reconcileLiveness() : engine.getState();
  send(makeReport({
    deviceId,
    state,
    gainLinear: engine.getGain(),
    remainingSec: remainingSec(desired, hubNow()),
    soundscape: engine.getSoundscape() || desired.soundscape, // report what's ACTUALLY playing
    tier,
  }));
}

// --- arm / gesture ---
async function armFromGesture() {
  friendlyName = ($('name').value || friendlyName || 'Speaker').trim();
  localStorage.setItem('mp.name', friendlyName);
  engine = new AudioEngine({
    tier,
    caps,
    onState: () => { render(); report(); },
  });
  engine.onIntent = async (verb) => { // lock-screen play/pause -> make authoritative via the hub
    send(makeCommand({ target: deviceId, verb })); // hub reduces + echoes a snapshot
    desired = applyCommandToDesired(desired, { verb }); // optimistic; snapshot will confirm
    await realize(); report();
  };
  try {
    await engine.arm({ soundscapeId: 'white', url: urlFor('white'), gainLinear: desired.gainLinear });
    armed = true;
    hideOverlay();
    connect();
    render();
  } catch (e) {
    // Release the failed engine's AudioContext so repeated retry taps can't exhaust iOS's
    // ~4-AudioContext limit and permanently block arming.
    try { await engine?.ctx?.close(); } catch (err) { console.warn('ctx close failed', err); }
    engine = null;
    armed = false;
    console.error('arm failed', e);
    $('armError').textContent = 'Could not start audio: ' + e.message + ' — tap again.';
  }
}

// Cold reload re-locks audio; a dark full-screen tap re-arms/recovers with a fresh gesture.
async function resumeFromGesture() {
  if (!engine) return armFromGesture();
  try {
    if (engine.el && engine.el.paused) await engine.el.play();
    if (engine.ctx && engine.ctx.state !== 'running') await engine.ctx.resume();
    await realize();
    hideOverlay();
  } catch (e) { console.warn('resume failed', e); }
}

function showOverlay(text) { $('overlay').classList.add('show'); $('overlayText').textContent = text; }
function hideOverlay() { $('overlay').classList.remove('show'); }

// --- recovery hooks ---
function wireRecovery() {
  const recover = async () => {
    if (!armed) return;
    if (!ws) connect();
    const ok = await engine.recover();
    if (!ok && engine.getState() === STATES.REQUIRES_GESTURE) showOverlay('Tap anywhere to resume the sound');
    report();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recover(); });
  window.addEventListener('pageshow', recover);
  window.addEventListener('focus', recover);
  window.addEventListener('online', () => { if (armed && !ws) connect(); }); // never join hub pre-arm
}

// --- render ---
function render() {
  // Returning device (already named): skip the setup form and offer a big dark "tap to arm" — the
  // same one-tap recovery target, operable in the dark at 3am without focusing a text field. (P8)
  const reArm = !armed && !!friendlyName;
  $('setup').hidden = armed || reArm;
  $('status').hidden = !armed;
  if (reArm) { showOverlay(`Tap to arm “${friendlyName}”`); return; }
  if (!armed) return;
  const st = engine.getState();
  const playing = st === STATES.PLAYING;
  $('devName').textContent = friendlyName;
  $('tierBadge').textContent = tier;
  $('eq').hidden = !playing;
  $('stateLine').textContent =
    playing ? '▶ Playing' :
    st === STATES.STOPPED ? '■ Silent (armed & connected)' :
    st === STATES.REQUIRES_GESTURE ? '⚠ Needs a tap to resume' :
    st === STATES.ERROR ? '⚠ Audio error' : st;
  $('soundLine').textContent = playing ? `Sound: ${labelFor(engine.getSoundscape() || desired.soundscape)}` : '';
  const rem = remainingSec(desired, hubNow());
  $('timerLine').textContent = rem != null ? `Sleep timer: ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}` : '';
  $('capsLine').textContent = '🔒 ' + lockSummary(tier);
  if (st === STATES.REQUIRES_GESTURE) showOverlay('Tap anywhere to resume the sound');
}

// --- local timer safety net: stop promptly at the deadline even before the hub snapshot ---
setInterval(async () => {
  if (armed && desired.verb === VERBS.START && desired.endsAtEpochMs && hubNow() >= desired.endsAtEpochMs) {
    desired = { ...desired, verb: VERBS.STOP, endsAtEpochMs: null };
    await realize(); report();
  }
  render();
  // Elapsed-time cadence (robust to interval drift / background throttling; never double-fires).
  if (armed && Date.now() - lastReportAt >= 5000) report();
}, 1000);

// --- pre-arm hardening checklist (advisory; persisted per device) (P9) ---
const HARDEN = [
  ['power', '🔌 Plugged into power'],
  ['autolock', '🔒 Auto-Lock = Never (or Guided Access on)'],
  ['updates', '🔄 Automatic Updates off'],
  ['ring', '🔔 Ring switch on, volume up'],
  ['lowpower', '🪫 Low Power Mode off'],
  ['tabs', '🗂 Safari → Close Tabs = Manually'],
];
function updateHardenCount() {
  const done = HARDEN.filter(([k]) => localStorage.getItem('mp.harden.' + k) === '1').length;
  const el = $('hardenCount'); if (el) el.textContent = `${done}/${HARDEN.length}`;
}
function buildHardening() {
  const wrap = $('hardenList'); if (!wrap) return;
  wrap.innerHTML = '';
  for (const [key, label] of HARDEN) {
    const row = document.createElement('label'); row.className = 'checkrow';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'harden'; cb.dataset.key = key;
    cb.checked = localStorage.getItem('mp.harden.' + key) === '1';
    cb.addEventListener('change', () => { localStorage.setItem('mp.harden.' + key, cb.checked ? '1' : '0'); updateHardenCount(); });
    const span = document.createElement('span'); span.textContent = label;
    row.append(cb, span); wrap.append(row);
  }
  updateHardenCount();
}

// --- boot ---
(async function boot() {
  await loadLibrary();
  $('name').value = friendlyName;
  buildHardening();
  $('armBtn').addEventListener('click', armFromGesture);
  $('overlay').addEventListener('click', resumeFromGesture);
  $('overlay').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') resumeFromGesture(); });
  wireRecovery();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw reg failed', e));
  }
  render();
})();
