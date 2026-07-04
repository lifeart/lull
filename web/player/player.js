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
import { Monitor } from './monitor.js';

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

// Runs at module load. If capability detection ever throws on an old engine it must NOT kill the
// whole module (that would silently un-wire the Arm button); fall back to LEGACY and surface it.
let caps, tier;
try {
  caps = detectCaps();
  tier = tierFromCaps(caps);
  caps.tier = tier;
} catch (e) {
  if (window.__lullError) window.__lullError('detectCaps failed: ' + (e && e.stack ? e.stack : e));
  caps = {}; tier = tierFromCaps(caps); caps.tier = tier; // {} → LEGACY
}

let engine = null;
const monitor = new Monitor(); // baby-monitor "cry meter" (M8a) — opt-in, screen-on only
let ws = null;
let desired = defaultDesired();
let soundscapeUrls = { pink: '/player/assets/pink.wav', white: '/player/assets/white.wav' };
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
  await engine.applyDesired(Object.assign({}, desired, { url: urlFor(desired.soundscape) }));
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
  ws.onerror = () => { try { ws.close(); } catch (_e) { /* already closing */ } };
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
    micLevel: monitor.getLevel(), // baby-monitor room loudness (null when off → omitted)
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
    await engine.arm({ soundscapeId: desired.soundscape, url: urlFor(desired.soundscape), gainLinear: desired.gainLinear });
    armed = true;
    hideOverlay();
    // Re-open the baby monitor within this same arm gesture if it was on before. (M8a)
    if (localStorage.getItem('mp.monitor') === '1') { await monitor.start(); }
    connect();
    render();
    renderMonitor();
  } catch (e) {
    // Release the failed engine's AudioContext so repeated retry taps can't exhaust iOS's
    // ~4-AudioContext limit and permanently block arming.
    try { if (engine && engine.ctx) await engine.ctx.close(); } catch (err) { console.warn('ctx close failed', err); }
    engine = null;
    armed = false;
    console.error('arm failed', e);
    $('armError').textContent = 'Could not start audio: ' + e.message + ' — tap again.';
    if (window.__lullError) window.__lullError('Arm failed: ' + (e && e.stack ? e.stack : e)); // visible on old iOS
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
  renderMonitor();
  if (st === STATES.REQUIRES_GESTURE) showOverlay('Tap anywhere to resume the sound');
}

// --- local timer safety net: stop promptly at the deadline even before the hub snapshot ---
setInterval(async () => {
  if (armed && desired.verb === VERBS.START && desired.endsAtEpochMs && hubNow() >= desired.endsAtEpochMs) {
    desired = Object.assign({}, desired, { verb: VERBS.STOP, endsAtEpochMs: null });
    await realize(); report();
  }
  render();
  // Elapsed-time cadence — faster while monitoring so the loudness meter is responsive.
  if (armed && Date.now() - lastReportAt >= (monitor.active ? 2000 : 5000)) report();
}, 1000);

// --- baby monitor (M8a): opt-in mic loudness telemetry, started from a gesture (screen-on only) ---
async function toggleMonitor() {
  if (monitor.active) { monitor.stop(); localStorage.setItem('mp.monitor', '0'); }
  else {
    const ok = await monitor.start(); // needs the tap's user-activation for iOS mic permission
    localStorage.setItem('mp.monitor', ok ? '1' : '0'); // renderMonitor() surfaces monitor.lastError on failure
    if (!ok) {
      // Make the failure UNMISSABLE (the "Start baby monitor does nothing" report): why it didn't run.
      const a = monitor.availability();
      const why = monitor.lastError || a.reason || 'unknown';
      console.warn('[monitor] not started:', why, a);
      if (window.__lullError) window.__lullError('Baby monitor did not start — ' + why + (a.note ? (' · ' + a.note) : ''));
    }
  }
  renderMonitor();
  report();
}
const MONITOR_ON_NOTE = "Sends this room's sound level to your phone. Needs the screen on — capture stops when the device locks.";
function renderMonitor() {
  const btn = $('monitorToggle'), note = $('monitorNote');
  if (!btn) return;
  const avail = monitor.availability();
  if (!avail.ok) {
    // Don't silently vanish the feature. For anything the parent can ACT on (open in Safari / use
    // HTTPS) say so where the button would be; stay quiet for hard device limits (iOS 10, no Web Audio).
    btn.hidden = true;
    if (note) {
      const actionable = avail.reason === 'standalone' || avail.reason === 'insecure';
      note.hidden = !actionable;
      if (actionable) note.textContent = avail.note;
    }
    return;
  }
  btn.hidden = false;
  btn.textContent = monitor.active ? '🎙 Baby monitor: on — tap to stop' : '🎙 Start baby monitor';
  btn.classList.toggle('btn-primary', monitor.active);
  btn.classList.toggle('btn-ghost', !monitor.active);
  if (note) {
    if (monitor.active) { note.hidden = false; note.textContent = MONITOR_ON_NOTE; }
    else if (monitor.lastError) {
      note.hidden = false;
      note.textContent = monitor.lastError === 'NotAllowedError'
        ? 'Microphone blocked — allow it (Settings › Safari › Microphone), then tap again.'
        : 'Microphone unavailable or blocked — baby monitor off.';
    } else { note.hidden = true; }
  }
}

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
 try {
  // Wire EVERY primary control synchronously FIRST — before any await or optional setup — so a slow
  // library fetch or a later failure can't leave a button dead ("Arm/Start does nothing"). (finding: silent errors)
  $('armBtn').addEventListener('click', armFromGesture);
  $('monitorToggle').addEventListener('click', toggleMonitor);
  $('overlay').addEventListener('click', resumeFromGesture);
  $('overlay').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') resumeFromGesture(); });
  wireRecovery();
  $('name').value = friendlyName;
  buildHardening();
  renderMonitor();
  const tokenInput = $('tokenInput'); // in-UI access token (alternative to the #t= link); read by authToken() on connect
  if (tokenInput) {
    try { tokenInput.value = localStorage.getItem('mp.token') || ''; } catch (_e) { /* storage blocked */ }
    tokenInput.addEventListener('input', () => {
      const v = tokenInput.value.trim();
      try { v ? localStorage.setItem('mp.token', v) : localStorage.removeItem('mp.token'); } catch (e) { console.warn('token save blocked', e); }
    });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw reg failed', e));
  }
  await loadLibrary(); // last: needs the network; the controls above already work without it
  render();
 } catch (e) {
  console.error('boot failed', e);
  if (window.__lullError) window.__lullError('Boot failed: ' + (e && e.stack ? e.stack : e));
 }
})();
