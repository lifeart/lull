// Controller PWA — the parent's remote. Renders live device state with PERSISTENT cards
// (updated in place so a volume drag / countdown is never torn down), alarms the parent on
// command failures AND spontaneous device failures, and runs the bedtime pre-flight.

import {
  MSG, ROLES, VERBS, STATES,
  makeHello, makeCommand, makeProbe, remainingSec,
  ACK_TIMEOUT_MS, GAIN_SOFT_CAP, GAIN_DEFAULT, SOUNDSCAPE_DEFAULT,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS,
} from '/shared/protocol.js';
import { tierControls, lockSummary, detectCaps, tierFromCaps } from '/shared/tiers.js';
import { AudioEngine } from '../player/audio.js'; // reuse the player's iOS audio engine locally
import { primeAlarm, startAlarm, stopAlarm } from './alarm.js';

const $ = (id) => document.getElementById(id);

let ws = null;
let devices = [];
let reconnectDelay = RECONNECT_BASE_MS;
const pending = new Map(); // cmdId -> { deviceId, timer, kind }
let preflight = null; // { need:Set, ok:Set, fail:Set }
let soundscapes = [{ id: 'pink', label: 'Pink noise' }]; // bootstrap = the default; replaced once the library loads

const cards = new Map(); // deviceId -> { el, update }
const lastState = new Map(); // deviceId -> { online, state } for spontaneous-failure alarms
const dragging = new Set(); // deviceIds whose volume slider is being dragged
const micHigh = new Map(); // deviceId -> sustained-loud counter (baby-monitor cry detection, M8a)
// Cry thresholds (0..1 room loudness). ON high + sustained → alarm; hysteresis to OFF clears it.
const CRY_ON = 0.6, CRY_OFF = 0.35, CRY_SUSTAIN = 3;

// --- token (optional shared secret; distributed via URL, persisted, appended to WS) ---
function authToken() {
  const q = new URL(location.href).searchParams.get('token');
  const h = (location.hash.match(/t=([^&]+)/) || [])[1];
  const t = q || (h && decodeURIComponent(h));
  if (t) localStorage.setItem('mp.token', t);
  return t || localStorage.getItem('mp.token') || '';
}

// --- WebSocket ---
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const t = authToken();
  return `${proto}://${location.host}/ws${t ? `?token=${encodeURIComponent(t)}` : ''}`;
}
function connect() {
  setHub('connecting');
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    setHub('online');
    send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'controller', friendlyName: 'Controller', caps: {} }));
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { ws = null; setHub('offline'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
}
function scheduleReconnect() {
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 1.7);
  setTimeout(() => { if (!ws) connect(); }, reconnectDelay);
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// --- remembered per-room sleep timer (P1) ---------------------------------------------------------
// Volume + soundscape already persist in `desired`; the sleep timer is the one nightly setting the
// system forgets (STOP wipes endsAtEpochMs). Remember the last-chosen timer per device (controller-
// local) so a plain Start re-applies it, and offer a wall-clock "until 7:00" option. All timers ride
// the existing durationMs path (the hub rebases to its own clock and owns the absolute deadline).
const rememberedTimerKey = (deviceId) => { try { return localStorage.getItem('mp.timer.' + deviceId) || null; } catch { return null; } };
const setRememberedTimerKey = (deviceId, key) => { try { key ? localStorage.setItem('mp.timer.' + deviceId, key) : localStorage.removeItem('mp.timer.' + deviceId); } catch (e) { console.warn('timer prefs blocked', e); } };
function nextWakeEpochMs(hour) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // already past today → tomorrow
  return d.getTime();
}
const MIN_TIMER = { '15m': 15, '30m': 30, '45m': 45, '60m': 60 };
function timerFieldsForKey(key) {
  if (key && MIN_TIMER[key]) return { durationMs: MIN_TIMER[key] * 60000 };
  if (key === 'wake') return { durationMs: Math.max(0, nextWakeEpochMs(7) - Date.now()) };
  return null; // 'off' or unset → no sleep timer
}
function startDevice(deviceId) {
  const f = timerFieldsForKey(rememberedTimerKey(deviceId));
  sendCommand(deviceId, f ? { verb: VERBS.START, ...f } : { verb: VERBS.START });
}

function onMessage(msg) {
  switch (msg.t) {
    // WELCOME is the authoritative resync on every (re)connect. Seed the alarm baseline from it
    // WITHOUT firing — after a routine hub restart every device is momentarily offline (players
    // haven't re-registered yet), and treating that as an online→offline transition would storm the
    // parent with a false alarm for every room. A room that's genuinely down is caught by the
    // bedtime pre-flight, the authoritative "all rooms up?" check. (finding #7)
    case MSG.WELCOME: devices = msg.devices || []; seedAlarmBaseline(devices); render(); runHealthCheck(); break; // auto pre-flight (P3)
    case MSG.DEVICES: devices = msg.devices || []; reconcileAlarms(devices); render(); break;
    case MSG.ACK: onAck(msg); break;
    case MSG.LIBRARY: refreshLibrary(); break; // library changed (upload/rename/delete/reorder) — refresh
    case MSG.ERROR: console.warn('[hub error]', msg.error); break;
  }
}

// --- alarm on spontaneous device failures (not just command failures) ---
// Seed the per-device alarm baseline without raising anything (used on the WELCOME resync).
function seedAlarmBaseline(next) {
  for (const d of next) lastState.set(d.deviceId, { online: d.online, state: (d.reported || {}).state });
}

function reconcileAlarms(next) {
  for (const d of next) {
    const prev = lastState.get(d.deviceId);
    const st = (d.reported || {}).state;
    if (prev) {
      const wasPlaying = prev.state === STATES.PLAYING;
      // A device that was online and dropped: alarm the awake parent (we can't revive it remotely).
      if (prev.online && !d.online) raiseAlarm(d.deviceId, 'went offline — the tab may have been reclaimed');
      // ERROR is edge-triggered (only on entry) so the parent can dismiss it while walking to the
      // room instead of it re-firing on every ~5s telemetry broadcast. (finding #6)
      else if (d.online && st === STATES.ERROR && prev.state !== STATES.ERROR) raiseAlarm(d.deviceId, 'audio error — not playing');
      else if (d.online && st === STATES.REQUIRES_GESTURE && wasPlaying) raiseAlarm(d.deviceId, 'needs a screen tap to resume');
    }
    // P5: auto-de-escalate a FAILURE alarm — if the device that raised it recovered to a healthy
    // online state, silence the siren and demote the banner to a passive "recovered" note (still
    // dismissable). Never trusts the socket alone: requires a real PLAYING/STOPPED report. Does NOT
    // apply to a 'cry' alarm — a crying room is "healthy", so cries clear on the level dropping (below).
    if (alarmKind === 'failure' && alarmDeviceId === d.deviceId && d.online && (st === STATES.PLAYING || st === STATES.STOPPED)) {
      const name = d.friendlyName || d.deviceId;
      stopAlarm();
      $('alarmText').textContent = `✓ ${name} recovered`;
      alarmDeviceId = null; alarmKind = null;
    }
    // Baby monitor (M8a): sustained loud room → "possible crying"; clears when it goes quiet again.
    const lvl = (d.reported || {}).micLevel;
    if (typeof lvl === 'number') {
      const m = micHigh.get(d.deviceId) || { count: 0 };
      if (lvl >= CRY_ON) m.count++; else if (lvl < CRY_OFF) m.count = 0;
      const alreadyCrying = alarmKind === 'cry' && alarmDeviceId === d.deviceId;
      if (m.count >= CRY_SUSTAIN && !alreadyCrying) raiseAlarm(d.deviceId, 'possible crying — loud in the room', 'cry');
      if (alreadyCrying && lvl < CRY_OFF) {
        const name = d.friendlyName || d.deviceId;
        stopAlarm(); $('alarmText').textContent = `✓ ${name} quiet again`; alarmDeviceId = null; alarmKind = null; m.count = 0;
      }
      micHigh.set(d.deviceId, m);
    }
    lastState.set(d.deviceId, { online: d.online, state: st });
  }
}

// --- commands with ACK tracking ---
function sendCommand(deviceId, fields, kind = 'command') {
  primeAlarm();
  const cmd = makeCommand({ target: deviceId, ...fields });
  const timer = setTimeout(() => onAckTimeout(cmd.cmdId), ACK_TIMEOUT_MS);
  pending.set(cmd.cmdId, { deviceId, timer, kind });
  send(cmd);
}
function onAck(msg) {
  const p = pending.get(msg.cmdId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.cmdId);
  if (p.kind === 'probe' && preflight && preflight.need.has(p.deviceId)) {
    (msg.ok ? preflight.ok : preflight.fail).add(p.deviceId);
    updatePreflight();
  }
  if (p.kind === 'health') { (msg.ok ? health.ok : health.fail).add(p.deviceId); updateHealth(); return; } // silent (P3)
  if (!msg.ok) raiseAlarm(p.deviceId, msg.error || 'device did not accept the command');
}
function onAckTimeout(cmdId) {
  const p = pending.get(cmdId);
  if (!p) return;
  pending.delete(cmdId);
  if (p.kind === 'probe' && preflight && preflight.need.has(p.deviceId)) { preflight.fail.add(p.deviceId); updatePreflight(); }
  if (p.kind === 'health') { if (health) { health.fail.add(p.deviceId); updateHealth(); } return; } // silent (P3)
  raiseAlarm(p.deviceId, 'no response within 3s — device may be asleep or offline');
}

let alarmDeviceId = null; // the device that raised the ACTIVE alarm (for P5 auto-de-escalation)
let alarmKind = null;     // 'failure' | 'cry' — cries de-escalate on quiet, failures on recovery
function raiseAlarm(deviceId, why, kind = 'failure') {
  const d = devices.find((x) => x.deviceId === deviceId);
  const name = d ? d.friendlyName : deviceId;
  alarmDeviceId = deviceId; alarmKind = kind;
  $('alarmBanner').hidden = false;
  $('alarmText').textContent = `${kind === 'cry' ? '👶' : '⚠'} ${name}: ${why}`;
  startAlarm();
}
function clearAlarm() { stopAlarm(); alarmDeviceId = null; alarmKind = null; $('alarmBanner').hidden = true; }

// --- ambient health / auto pre-flight (P3) --------------------------------------------------------
// A SILENT, continuous liveness check (on connect, on foreground, every 60s) that drives a persistent
// "✓ N rooms verified Ns ago" / "✗ M not responding" line — so "Check all rooms" stops being a nightly
// ritual you must remember. It never fires the siren directly (that stays edge-triggered in
// reconcileAlarms / command ACKs); and it can't sound before the first user gesture anyway, so a
// pre-gesture failure degrades to the red visual line. (research P3)
let health = null;        // in-flight round: { need:Set, ok:Set, fail:Set }
let healthResult = null;  // last completed: { ok, fail, at }
function runHealthCheck() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const [cmdId, p] of pending) { if (p.kind === 'health') { clearTimeout(p.timer); pending.delete(cmdId); } }
  if (!devices.length) { health = null; healthResult = null; renderHealth(); return; }
  health = { need: new Set(devices.map((d) => d.deviceId)), ok: new Set(), fail: new Set() };
  for (const d of devices) {
    const probe = makeProbe({ target: d.deviceId });
    const timer = setTimeout(() => onAckTimeout(probe.cmdId), ACK_TIMEOUT_MS);
    pending.set(probe.cmdId, { deviceId: d.deviceId, timer, kind: 'health' });
    send(probe);
  }
  renderHealth();
}
function updateHealth() {
  if (!health) return;
  if (health.ok.size + health.fail.size < health.need.size) return; // wait for all
  healthResult = { ok: health.ok.size, fail: health.fail.size, at: Date.now() };
  health = null;
  renderHealth();
}
function agoText(sec) { return sec < 5 ? 'just now' : sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`; }
function renderHealth() {
  const el = $('healthLine'); if (!el) return;
  if (!devices.length) { el.textContent = ''; el.className = 'healthline'; return; }
  if (health) { el.textContent = 'Checking rooms…'; el.className = 'healthline faint'; return; }
  if (!healthResult) { el.textContent = ''; el.className = 'healthline'; return; }
  const ago = Math.max(0, Math.round((Date.now() - healthResult.at) / 1000));
  if (healthResult.fail === 0) { el.textContent = `✓ ${healthResult.ok} room${healthResult.ok === 1 ? '' : 's'} verified ${agoText(ago)}`; el.className = 'healthline ok'; }
  else { el.textContent = `✗ ${healthResult.fail} room${healthResult.fail === 1 ? '' : 's'} not responding — check before bed`; el.className = 'healthline bad'; }
}

// --- bedtime pre-flight ---
function runPreflight() {
  primeAlarm();
  // Cancel any in-flight probes from a prior (double-tapped) run so stale results can't leak in.
  for (const [cmdId, p] of pending) { if (p.kind === 'probe') { clearTimeout(p.timer); pending.delete(cmdId); } }
  if (!devices.length) { setPreflight('No devices registered yet.', 'var(--danger-text)'); return; }
  preflight = { need: new Set(devices.map((d) => d.deviceId)), ok: new Set(), fail: new Set() };
  for (const d of devices) {
    const probe = makeProbe({ target: d.deviceId });
    const timer = setTimeout(() => onAckTimeout(probe.cmdId), ACK_TIMEOUT_MS);
    pending.set(probe.cmdId, { deviceId: d.deviceId, timer, kind: 'probe' });
    send(probe);
  }
  setPreflight('Checking all rooms…', 'var(--accent)');
}
// --- one-tap Bedtime scene (P2) -------------------------------------------------------------------
// Start every online room that isn't already playing, each with its remembered sleep timer (P1), in
// one tap. No new verbs; per-room verification + alarm rides the existing start-intent ACK (a room
// that can't reach PLAYING NACKs → the parent is alarmed). Max one command per device (≤ MAX_DEVICES),
// well under the socket rate-limit burst, so no stagger is needed.
function runBedtime() {
  primeAlarm();
  if (!devices.length) { setPreflight('No rooms yet — arm a Speaker first.', 'var(--danger-text)'); return; }
  const online = devices.filter((d) => d.online);
  if (!online.length) { setPreflight('No rooms online — check the speakers before bed.', 'var(--danger-text)'); return; }
  let started = 0, already = 0;
  for (const d of online) {
    if ((d.reported || {}).state === STATES.PLAYING) { already++; continue; }
    startDevice(d.deviceId); // carries the remembered timer; ACK-failure alarms the parent
    started++;
  }
  const offline = devices.length - online.length;
  const parts = [`Started ${started}`];
  if (already) parts.push(`${already} already playing`);
  if (offline) parts.push(`${offline} offline`);
  setPreflight('🌙 ' + parts.join(' · '), offline ? 'var(--warn)' : 'var(--play-text)');
}

function updatePreflight() {
  if (!preflight) return;
  const done = preflight.ok.size + preflight.fail.size;
  if (done < preflight.need.size) { setPreflight(`Checking… ${done}/${preflight.need.size}`, 'var(--accent)'); return; }
  if (preflight.fail.size === 0) setPreflight(`✓ All ${preflight.ok.size} rooms responding`, 'var(--play-text)');
  else setPreflight(`✗ ${preflight.fail.size} room(s) not responding — fix before bed`, 'var(--danger-text)');
  preflight = null;
}
function setPreflight(text, color) { const el = $('preflightResult'); el.textContent = text; el.style.color = color; }

// --- persistent cards ---
function fmt(sec) { return sec == null ? '' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

function render() {
  const container = $('devices');
  $('empty').hidden = devices.length > 0;
  const seen = new Set();
  for (const d of devices) {
    seen.add(d.deviceId);
    let card = cards.get(d.deviceId);
    if (!card) { card = makeCard(d.deviceId, d.tier, d.caps); cards.set(d.deviceId, card); container.append(card.el); }
    card.update(d);
  }
  for (const [id, card] of cards) if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
}

function makeCard(deviceId, tier, caps) {
  const controls = tierControls(tier || 'LEGACY', caps);
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.deviceId = deviceId;
  el.innerHTML = `
    <div class="row">
      <span class="dot"></span>
      <strong class="dname"></strong>
      <span class="badge"></span>
      <span class="spacer"></span>
      <span class="eq" hidden aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>
      <span class="statechip"></span>
      <button class="link-btn danger forget" hidden>Forget</button>
    </div>
    <div class="btnrow" style="margin-top:14px">
      <button class="btn btn-play go">▶ Start</button>
      <button class="btn btn-danger">■ Stop</button>
    </div>
    <div class="sec">
      <div class="row"><span class="sec-label" style="margin-bottom:0">Sleep timer</span><span class="rem countdown spacer" style="text-align:right"></span></div>
      <div class="chips timers" style="margin-top:8px"></div>
    </div>
    <div class="sound"></div>
    <div class="vol"></div>
    <div class="mic sec" hidden><div class="sec-label" style="margin-bottom:6px">👶 Room sound</div><div class="meter"><span class="meter-fill"></span></div></div>
    <div class="lockline faint" style="margin-top:14px"></div>`;

  const refs = {
    dot: el.querySelector('.dot'), dname: el.querySelector('.dname'), badge: el.querySelector('.badge'),
    chip: el.querySelector('.statechip'), eq: el.querySelector('.eq'), rem: el.querySelector('.rem'),
    start: el.querySelector('.go'), stop: el.querySelector('.btn-danger'), lock: el.querySelector('.lockline'),
    forget: el.querySelector('.forget'), soundChips: new Map(), timerChips: new Map(), slider: null, setFill: null,
    mic: el.querySelector('.mic'), meterFill: el.querySelector('.meter-fill'),
  };

  refs.start.addEventListener('click', () => startDevice(deviceId)); // carries the remembered timer (P1)
  refs.stop.addEventListener('click', () => sendCommand(deviceId, { verb: VERBS.STOP }));

  // Forget an offline (ghost) device: two-tap confirm, no blocking dialog. Clears a stale
  // registration so the bedtime pre-flight can go green and the device cap can't fill. (finding #3)
  let forgetArmed = false, forgetTimer = null;
  refs.forget.addEventListener('click', async () => {
    if (!forgetArmed) { forgetArmed = true; refs.forget.textContent = 'Confirm forget?'; forgetTimer = setTimeout(() => { forgetArmed = false; refs.forget.textContent = 'Forget'; }, 3000); return; }
    clearTimeout(forgetTimer); forgetArmed = false; refs.forget.textContent = 'Forget';
    lastState.delete(deviceId); // don't let a stale entry re-alarm
    await apiPost(`/api/device/forget?id=${encodeURIComponent(deviceId)}`);
    // hub broadcasts devices → render() drops the card
  });

  const timers = el.querySelector('.timers');
  const addTimer = (key, label, fields) => {
    const b = chipBtn(label, () => {
      setRememberedTimerKey(deviceId, key === 'off' ? null : key); // remember the choice (P1)
      sendCommand(deviceId, { verb: VERBS.SET_TIMER, ...fields() });
      paintTimerChips();
    });
    refs.timerChips.set(key, b);
    timers.append(b);
  };
  for (const min of [15, 30, 45, 60]) addTimer(`${min}m`, `${min}m`, () => ({ durationMs: min * 60000 }));
  addTimer('wake', '☾ 7:00', () => ({ durationMs: Math.max(0, nextWakeEpochMs(7) - Date.now()) }));
  addTimer('off', 'off', () => ({ endsAtEpochMs: null }));
  function paintTimerChips() {
    const k = rememberedTimerKey(deviceId);
    for (const [key, b] of refs.timerChips) b.setAttribute('aria-pressed', String(key === k));
  }
  paintTimerChips();

  if (soundscapes.length > 1) {
    const sound = el.querySelector('.sound');
    sound.className = 'sound sec';
    sound.append(secLabel('Sound'));
    const row = document.createElement('div'); row.className = 'chips';
    for (const s of soundscapes) {
      const b = chipBtn(s.label, () => sendCommand(deviceId, { verb: VERBS.SET_SOUNDSCAPE, soundscape: s.id }));
      refs.soundChips.set(s.id, b);
      row.append(b);
    }
    // Inline add-sound — upload without scrolling up to the Sounds card.
    const addChip = chipBtn('＋', () => $('fileInput').click());
    addChip.className = 'chip chip-add';
    addChip.setAttribute('aria-label', 'Add a sound');
    row.append(addChip);
    sound.append(row);
  }

  const vol = el.querySelector('.vol');
  vol.className = 'vol sec';
  if (controls.remoteVolume || controls.foregroundVolume) {
    vol.append(secLabel('Volume'));
    const row = document.createElement('div'); row.className = 'slider-row';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = String(GAIN_SOFT_CAP); slider.step = '0.02'; slider.value = '0.3';
    slider.setAttribute('aria-label', 'Volume');
    const pct = document.createElement('span'); pct.className = 'muted mono'; pct.style.minWidth = '3.5ch'; pct.style.textAlign = 'right';
    const setFill = () => {
      slider.style.setProperty('--fill', `${(Number(slider.value) / GAIN_SOFT_CAP) * 100}%`);
      pct.textContent = `${Math.round(Number(slider.value) * 100)}%`;
    };
    slider.addEventListener('pointerdown', () => dragging.add(deviceId));
    slider.addEventListener('input', setFill);
    slider.addEventListener('change', () => {
      dragging.delete(deviceId);
      sendCommand(deviceId, { verb: VERBS.SET_GAIN, gainLinear: Number(slider.value) });
      flushLibraryRefresh(); // apply any library refresh deferred during the drag
    });
    row.append(slider, pct);
    vol.append(row);
    if (controls.foregroundVolume) vol.append(faint('Works while the screen is on — old iOS uses the device buttons.'));
    refs.slider = slider; refs.setFill = setFill; setFill();
  } else {
    vol.append(faint('Fixed volume (set with the hardware buttons at setup).'));
  }

  function update(d) {
    const rep = d.reported || {};
    refs.dot.className = 'dot ' + (d.online ? 'on' : 'off');
    el.className = 'card' + (d.online ? '' : ' offline') + (rep.state === STATES.REQUIRES_GESTURE || rep.state === STATES.ERROR ? ' attention' : '');
    refs.dname.textContent = d.friendlyName || d.deviceId;
    refs.badge.textContent = d.tier || '?';
    refs.chip.textContent = stateLabel(rep.state, d.online);
    refs.chip.className = 'statechip';
    for (const cls of stateClass(rep.state, d.online).split(' ').filter(Boolean)) refs.chip.classList.add(cls);
    refs.eq.hidden = !(d.online && rep.state === STATES.PLAYING);
    // Baby-monitor loudness meter — shown only while the device is reporting a level (monitor on).
    const lvl = rep.micLevel;
    if (typeof lvl === 'number' && d.online) {
      refs.mic.hidden = false;
      refs.meterFill.style.width = `${Math.round(Math.min(1, Math.max(0, lvl)) * 100)}%`;
      refs.meterFill.classList.toggle('hot', lvl >= CRY_ON);
    } else { refs.mic.hidden = true; }
    refs.forget.hidden = d.online; // only offer "Forget" for a currently-offline (ghost) device
    refs.lock.textContent = '🔒 ' + lockSummary(d.tier || 'LEGACY');
    refs.rem.textContent = d.remainingSec != null ? fmt(d.remainingSec) : '—';
    refs.start.disabled = rep.state === STATES.PLAYING;
    const active = rep.soundscape || (d.desired && d.desired.soundscape);
    for (const [id, b] of refs.soundChips) b.setAttribute('aria-pressed', String(active === id));
    paintTimerChips(); // reflect the remembered sleep-timer choice (P1)
    // Seed the slider from the DESIRED gain (what Start will use), but never fight the user.
    if (refs.slider && document.activeElement !== refs.slider && !dragging.has(deviceId)) {
      refs.slider.value = String((d.desired && d.desired.gainLinear) ?? rep.gainLinear ?? 0.3);
      refs.setFill();
    }
  }

  return { el, update };
}

function chipBtn(text, on) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = text; b.addEventListener('click', on); return b; }
function linkBtn(text, on) { const b = document.createElement('button'); b.className = 'link-btn'; b.textContent = text; b.addEventListener('click', on); return b; }
function faint(t) { const d = document.createElement('div'); d.className = 'faint'; d.textContent = t; return d; }
function secLabel(t) { const d = document.createElement('div'); d.className = 'sec-label'; d.textContent = t; return d; }

function stateLabel(s, online) {
  if (!online) return 'offline';
  if (s === STATES.PLAYING) return 'playing';
  if (s === STATES.STOPPED) return 'silent';
  if (s === STATES.REQUIRES_GESTURE) return 'needs tap';
  if (s === STATES.ERROR) return 'error';
  return s || '—';
}
function stateClass(s, online) {
  if (!online) return '';
  return s === STATES.PLAYING ? 'playing' : s === STATES.ERROR || s === STATES.REQUIRES_GESTURE ? 'bad' : '';
}

function setHub(state) {
  const el = $('hubStatus');
  el.textContent = state === 'online' ? '● hub connected' : state === 'connecting' ? '○ connecting…' : '● hub unreachable';
  el.className = 'hub ' + state;
}

// Local 1s countdown — updates only each card's timer text (never rebuilds cards / slider).
setInterval(() => {
  for (const d of devices) {
    const card = cards.get(d.deviceId);
    if (!card) continue;
    const r = remainingSec(d.desired, Date.now());
    card.el.querySelector('.rem').textContent = r != null ? fmt(r) : '—';
  }
  renderHealth(); // keep the "verified Ns ago" fresh (P3)
}, 1000);
// Ambient auto pre-flight: re-verify every 60s while foregrounded, and on return to foreground. (P3)
setInterval(() => { if (document.visibilityState === 'visible') runHealthCheck(); }, 60000);

async function loadSoundscapes() {
  try {
    const res = await fetch('/api/library', { cache: 'no-cache' });
    if (res.ok) {
      const m = await res.json();
      if (Array.isArray(m.soundscapes) && m.soundscapes.length) {
        soundscapes = m.soundscapes.map((s) => ({ id: s.id, label: s.label || s.id, kind: s.kind || 'noise', fav: !!s.fav, url: s.url }));
      }
    }
  } catch (e) { console.warn('library load failed', e); }
  renderUploadList();
  renderLocalPlayer();
}

// --- uploaded-sound management (rename / delete) ---
function renderUploadList() {
  const wrap = $('uploadList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!soundscapes.length) return;
  wrap.appendChild(secLabel('Library — drag ⠿ to reorder'));
  for (const s of soundscapes) wrap.appendChild(libraryRow(s));
  enableReorder(wrap);
}

function libraryRow(s) {
  const row = document.createElement('div'); row.className = 'uprow'; row.dataset.id = s.id;
  const handle = document.createElement('span'); handle.className = 'handle'; handle.textContent = '⠿'; handle.setAttribute('aria-label', 'Drag to reorder');
  // Favorite toggle — hub-synced; favorites are pinned to the top of the library server-side.
  const star = document.createElement('button');
  star.className = 'fav' + (s.fav ? ' on' : '');
  star.textContent = s.fav ? '★' : '☆';
  star.setAttribute('aria-pressed', String(!!s.fav));
  star.setAttribute('aria-label', s.fav ? `Unfavorite ${s.label}` : `Favorite ${s.label}`);
  star.addEventListener('click', () => toggleFav(s));
  const name = document.createElement('span'); name.className = 'upname'; name.textContent = s.label;
  const sp = document.createElement('span'); sp.className = 'spacer';
  row.append(handle, star, name, sp);
  // Keyboard/VoiceOver-accessible reorder alternative to the pointer drag (which touch-only users
  // and screen readers can't operate). (finding #20)
  const up = linkBtn('▲', () => moveRow(s.id, -1)); up.setAttribute('aria-label', `Move ${s.label} up`);
  const down = linkBtn('▼', () => moveRow(s.id, +1)); down.setAttribute('aria-label', `Move ${s.label} down`);
  row.append(up, down);
  if (s.kind === 'upload') row.append(linkBtn('Rename', () => beginRename(row, s)), deleteControl(s));
  else { const t = document.createElement('span'); t.className = 'faint'; t.textContent = 'built-in'; row.append(t); }
  return row;
}

// Pointer-based reorder (works on touch + mouse; HTML5 DnD doesn't fire on iOS touch).
// Move/up are bound on window so they fire regardless of what's under the pointer.
function enableReorder(wrap) {
  wrap.querySelectorAll('.handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      const row = handle.closest('.uprow');
      if (!row) return;
      e.preventDefault();
      setBusy(true); // block broadcast-driven rebuilds mid-drag
      row.classList.add('dragging');
      const onMove = (ev) => {
        const y = ev.clientY;
        let placed = false;
        for (const sib of wrap.querySelectorAll('.uprow:not(.dragging)')) {
          const r = sib.getBoundingClientRect();
          if (y < r.top + r.height / 2) { wrap.insertBefore(row, sib); placed = true; break; }
        }
        if (!placed) wrap.appendChild(row);
      };
      const finish = () => { // runs on ANY terminal event so window listeners never leak
        row.classList.remove('dragging');
        setBusy(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
      };
      const onUp = () => { finish(); commitOrder([...wrap.querySelectorAll('.uprow')].map((r) => r.dataset.id)); };
      const onCancel = () => { finish(); refreshLibrary(); }; // interrupted → resync from server
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  });
}

async function commitOrder(ids) {
  const unique = [...new Set(ids.filter(Boolean))]; // de-dupe (a mid-drag rebuild could dup an id)
  const ok = await apiPost(`/api/library/order?ids=${encodeURIComponent(unique.join(','))}`);
  if (!ok) refreshLibrary(); // failed → resync the DOM to the server's order
  // success → hub broadcasts MSG.LIBRARY → refreshLibrary()
}

// Toggle a favorite. Optimism is unnecessary: the hub broadcasts MSG.LIBRARY on success →
// refreshLibrary() rebuilds with the new star + favorites-first order; on failure we resync.
async function toggleFav(s) {
  const ok = await apiPost(`/api/library/fav?id=${encodeURIComponent(s.id)}&on=${s.fav ? '0' : '1'}`);
  if (!ok) refreshLibrary();
}

// Swap a library entry with its neighbour and persist — the keyboard/VoiceOver reorder path.
function moveRow(id, dir) {
  const ids = soundscapes.map((s) => s.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  commitOrder(ids);
}

function beginRename(row, s) {
  setBusy(true); // don't let a broadcast rebuild the list mid-edit
  row.innerHTML = '';
  const input = document.createElement('input'); input.className = 'input upedit'; input.value = s.label; input.maxLength = 60;
  input.setAttribute('aria-label', 'Rename sound');
  const finishEdit = async (doSave) => {
    if (doSave) await apiPost(`/api/upload/rename?id=${encodeURIComponent(s.id)}&name=${encodeURIComponent(input.value.trim() || s.label)}`);
    setBusy(false);
    refreshLibrary(); // reload from server (new name on success; reverts on cancel/failure)
  };
  row.append(input, linkBtn('Save', () => finishEdit(true)), linkBtn('Cancel', () => finishEdit(false)));
  input.focus();
}

function deleteControl(s) {
  let armedDel = false, timer = null;
  const disarm = () => { armedDel = false; setBusy(false); btn.textContent = 'Delete'; };
  const btn = linkBtn('Delete', async () => {
    if (!armedDel) { // two-tap confirm (no blocking dialog)
      armedDel = true; setBusy(true); btn.textContent = 'Confirm?';
      timer = setTimeout(() => { disarm(); refreshLibrary(); }, 3000);
      return;
    }
    clearTimeout(timer); disarm();
    await apiPost(`/api/upload/delete?id=${encodeURIComponent(s.id)}`);
    refreshLibrary(); // row gone on success, restored on failure
  });
  btn.classList.add('danger');
  return btn;
}

// POST helper: surfaces failures in #uploadStatus (no silent swallow) and returns success.
async function apiPost(url) {
  const t = authToken();
  const full = url + (t ? (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(t)}` : '');
  const status = $('uploadStatus');
  try {
    const res = await fetch(full, { method: 'POST' });
    if (!res.ok) { status.hidden = false; status.textContent = `Action failed (${res.status}).`; return false; }
    return true;
  } catch (e) { status.hidden = false; status.textContent = 'Action failed: ' + e.message; return false; }
}

// Upload a user audio file → hub → appears as a soundscape on every device.
async function uploadFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const label = file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Track';
  const t = authToken();
  const status = $('uploadStatus');
  status.hidden = false; status.textContent = `Uploading “${label}”…`;
  try {
    const url = `/api/upload?name=${encodeURIComponent(label)}&ext=${encodeURIComponent(ext)}${t ? `&token=${encodeURIComponent(t)}` : ''}`;
    const res = await fetch(url, { method: 'POST', body: file });
    if (!res.ok) { status.textContent = `Upload failed (${res.status}). Use an audio file under 30 MB.`; return; }
    status.textContent = `Added “${label}”`;
    // hub broadcasts MSG.LIBRARY → refreshLibrary() rebuilds the list + cards
  } catch (e) { status.textContent = 'Upload failed: ' + e.message; }
}

// Single refresh path for library changes, DEFERRED while a reorder drag, inline edit, or
// volume drag is active so it can't tear down an in-progress interaction mid-gesture.
let libraryBusy = false;
let pendingLibraryRefresh = false;
let refreshRetry = null;
let refreshRetries = 0;
const REFRESH_RETRY_CAP = 25; // ~10s of self-heal polling, then give up (release still flushes it)
// Re-arm the deferred-refresh poll, but only up to the cap — an ABANDONED rename/volume-drag must
// not wake the phone every 400ms forever. The definitive flush still happens on release (setBusy /
// the drag's change handler), so capping only bounds the background polling, never loses a refresh.
function armRefreshRetry() { clearTimeout(refreshRetry); if (refreshRetries++ < REFRESH_RETRY_CAP) refreshRetry = setTimeout(flushLibraryRefresh, 400); }
async function refreshLibrary() {
  if (libraryBusy || dragging.size) { pendingLibraryRefresh = true; armRefreshRetry(); return; }
  pendingLibraryRefresh = false; refreshRetries = 0;
  await loadSoundscapes();
  rebuildAllCards();
}
function flushLibraryRefresh() {
  if (!pendingLibraryRefresh) return;
  if (libraryBusy || dragging.size) { armRefreshRetry(); return; }
  refreshLibrary();
}
// Route every libraryBusy change through this so RELEASING an interaction always applies a refresh
// that was deferred during it. Otherwise an upload or arrow-reorder done while a delete is armed
// ("Confirm?") or a rename is open stays deferred and never shows — the reported "Added but nothing
// appears" / "arrow reorder does nothing" bug (only a volume drag flushed it before).
function setBusy(v) { libraryBusy = v; if (!v) flushLibraryRefresh(); }

// Soundscape chips are created once per card; when the library changes we must recreate cards.
function rebuildAllCards() {
  for (const [, card] of cards) card.el.remove();
  cards.clear();
  render();
}

// --- local playback: THIS device is its own speaker (no separate client needed) --------------------
// Reuses the player's AudioEngine so the main app can play any library sound (noise or an uploaded
// track) directly — arm once with a tap (iOS gesture), then play/stop/volume/sound/timer locally.
// State lives here (not in the DOM), so a library-driven rebuild never tears down playback.
const localState = {
  engine: null, armed: false, tier: null, controls: null, refs: {},
  desired: { verb: VERBS.STOP, gainLinear: GAIN_DEFAULT, soundscape: SOUNDSCAPE_DEFAULT, endsAtEpochMs: null },
};
const localUrlFor = (id) => { const s = soundscapes.find((x) => x.id === id); return (s && s.url) || '/player/assets/pink.wav'; };
const localPlaying = () => !!localState.engine && localState.engine.getState() === STATES.PLAYING;
async function localRealize() {
  if (!localState.engine) return;
  await localState.engine.applyDesired({ ...localState.desired, url: localUrlFor(localState.desired.soundscape) });
}
async function localArm() {
  if (localState.engine) return true;
  const caps = detectCaps(); const tier = tierFromCaps(caps); caps.tier = tier;
  localState.tier = tier; localState.controls = tierControls(tier, caps);
  localState.engine = new AudioEngine({ tier, caps, onState: renderLocal });
  localState.engine.onIntent = (verb) => { if (verb === VERBS.START) localPlay(); else localStop(); }; // lock-screen controls
  try {
    await localState.engine.arm({ soundscapeId: localState.desired.soundscape, url: localUrlFor(localState.desired.soundscape), gainLinear: localState.desired.gainLinear });
    localState.armed = true; return true;
  } catch (e) { localState.engine = null; localState.armed = false; console.warn('local arm failed', e); return false; }
}
async function localPlay() { primeAlarm(); localState.fading = false; if (!(await localArm())) { renderLocal(); return; } localState.desired = { ...localState.desired, verb: VERBS.START }; await localRealize(); renderLocal(); }
async function localStop() { localState.fading = false; localState.desired = { ...localState.desired, verb: VERBS.STOP, endsAtEpochMs: null }; await localRealize(); renderLocal(); }
async function localToggle() { if (localPlaying()) await localStop(); else await localPlay(); }
async function localSetSound(id) { localState.desired = { ...localState.desired, soundscape: id }; if (localState.armed) await localRealize(); renderLocal(); }
function localSetGain(g) { localState.desired = { ...localState.desired, gainLinear: g }; if (localState.armed) localRealize(); }
async function localSetTimer(durationMs) {
  if (durationMs == null) { localState.desired = { ...localState.desired, endsAtEpochMs: null }; if (localState.armed) await localRealize(); renderLocal(); return; }
  if (!(await localArm())) { renderLocal(); return; }
  localState.desired = { ...localState.desired, endsAtEpochMs: Date.now() + durationMs, verb: VERBS.START };
  await localRealize(); renderLocal();
}

// Build the "This device" card (rebuilt on library change; engine state is preserved in localState).
function renderLocalPlayer() {
  const host = $('localPlayer'); if (!host) return;
  host.innerHTML = `
    <div class="row">
      <strong>🔊 This device</strong>
      <span class="badge local-tier"></span>
      <span class="spacer"></span>
      <span class="eq local-eq" hidden aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></span>
      <span class="statechip local-state"></span>
    </div>
    <div class="btnrow" style="margin-top:14px">
      <button class="btn btn-play local-play block" style="grid-column:1 / -1"></button>
    </div>
    <div class="sec local-soundsec" hidden><div class="sec-label">Sound</div><div class="chips local-sounds"></div></div>
    <div class="local-vol sec" hidden></div>
    <div class="sec"><div class="row"><span class="sec-label" style="margin-bottom:0">Sleep timer</span><span class="local-rem mono spacer" style="text-align:right"></span></div><div class="chips local-timers" style="margin-top:8px"></div></div>
    <p class="note-safety">🔊 <strong>Keep the volume low</strong> and the device across the room from the crib. Louder isn’t safer, and no app can measure the real loudness. A 30–45&nbsp;min timer is gentler than all night.</p>
    <p class="faint" style="margin-top:12px">Plays on this phone/tablet — no separate speaker needed. Keep this tab open.</p>`;
  const r = localState.refs = {
    tier: host.querySelector('.local-tier'), eq: host.querySelector('.local-eq'), state: host.querySelector('.local-state'),
    play: host.querySelector('.local-play'), rem: host.querySelector('.local-rem'),
    soundsec: host.querySelector('.local-soundsec'), sounds: host.querySelector('.local-sounds'),
    vol: host.querySelector('.local-vol'), soundChips: new Map(), slider: null, setFill: null,
  };
  r.play.addEventListener('click', localToggle);

  // Sound chooser (only if there's more than one sound).
  if (soundscapes.length > 1) {
    r.soundsec.hidden = false;
    for (const s of soundscapes) {
      const b = chipBtn(s.label, () => localSetSound(s.id));
      r.soundChips.set(s.id, b); r.sounds.append(b);
    }
  }

  // Volume (only where the tier can honor it, once armed — otherwise hardware buttons).
  const controls = localState.controls || tierControls(tierFromCaps(detectCaps()), detectCaps());
  if (controls.remoteVolume || controls.foregroundVolume) {
    r.vol.hidden = false;
    r.vol.append(secLabel('Volume'));
    const rowv = document.createElement('div'); rowv.className = 'slider-row';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = String(GAIN_SOFT_CAP); slider.step = '0.02';
    slider.value = String(localState.desired.gainLinear); slider.setAttribute('aria-label', 'Volume (this device)');
    const pct = document.createElement('span'); pct.className = 'muted mono'; pct.style.minWidth = '3.5ch'; pct.style.textAlign = 'right';
    const setFill = () => { slider.style.setProperty('--fill', `${(Number(slider.value) / GAIN_SOFT_CAP) * 100}%`); pct.textContent = `${Math.round(Number(slider.value) * 100)}%`; };
    slider.addEventListener('input', setFill);
    slider.addEventListener('change', () => localSetGain(Number(slider.value)));
    rowv.append(slider, pct); r.vol.append(rowv); r.slider = slider; r.setFill = setFill; setFill();
  }

  // Timer chips (local deadline, enforced by the 1s interval below).
  const addT = (label, ms) => r.timers && r.timers.append(chipBtn(label, () => localSetTimer(ms)));
  const timers = host.querySelector('.local-timers'); r.timers = timers;
  for (const min of [15, 30, 45, 60]) addT(`${min}m`, min * 60000);
  addT('☾ 7:00', Math.max(0, nextWakeEpochMs(7) - Date.now()));
  addT('off', null);

  renderLocal();
}

function renderLocal() {
  const r = localState.refs; if (!r || !r.play) return;
  const st = localState.engine ? localState.engine.getState() : STATES.STOPPED;
  const playing = st === STATES.PLAYING;
  r.tier.textContent = localState.tier || '';
  r.tier.hidden = !localState.tier;
  if (st === STATES.STOPPED) localState.fading = false; // the timer fade finished
  r.eq.hidden = !playing;
  r.state.textContent = !localState.armed ? '' : localState.fading ? 'winding down…' : playing ? 'playing' : st === STATES.REQUIRES_GESTURE ? 'tap to resume' : st === STATES.ERROR ? 'error' : 'stopped';
  r.state.className = 'statechip local-state' + (playing ? ' playing' : (st === STATES.ERROR || st === STATES.REQUIRES_GESTURE) ? ' bad' : '');
  r.play.textContent = playing ? '⏸ Pause' : '▶ Play here';
  const sound = localState.desired.soundscape;
  for (const [id, b] of r.soundChips) b.setAttribute('aria-pressed', String(id === sound));
  if (r.slider && document.activeElement !== r.slider) { r.slider.value = String(localState.desired.gainLinear); r.setFill && r.setFill(); }
  updateLocalRem();
}
function updateLocalRem() {
  const r = localState.refs; if (!r || !r.rem) return;
  const d = localState.desired;
  const rem = (localState.armed && d.verb === VERBS.START && d.endsAtEpochMs) ? Math.max(0, Math.round((d.endsAtEpochMs - Date.now()) / 1000)) : null;
  r.rem.textContent = rem != null ? fmt(rem) : '—';
}
// Local sleep-timer + countdown tick.
setInterval(() => {
  const d = localState.desired;
  if (localState.armed && d.verb === VERBS.START && d.endsAtEpochMs && Date.now() >= d.endsAtEpochMs) {
    localState.desired = { ...d, verb: VERBS.STOP, endsAtEpochMs: null };
    localState.fading = true; // shown as "winding down…" until the engine reaches STOPPED
    localState.engine.fadeOutAndStop(8); // gentle wind-down (this player is always on-screen)
    renderLocal();
  }
  updateLocalRem();
}, 1000);
// iOS re-locks audio after a reclaim/background; recover local playback on return.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && localState.engine) localState.engine.recover().then(renderLocal); });

// --- add a room: a prefilled setup link (name + token) → zero typing on the old device (P4) ---
function setupAddRoom() {
  const btn = $('addRoomBtn'), panel = $('addRoomPanel'), nameEl = $('addRoomName'), linkEl = $('addRoomLink'), copyEl = $('addRoomCopy');
  if (!btn) return;
  const rebuild = () => {
    const name = (nameEl.value || '').trim().slice(0, 60);
    if (!name) { linkEl.removeAttribute('href'); linkEl.textContent = ''; return; } // no name yet → no link
    const t = authToken();
    const url = `${location.origin}/player/?name=${encodeURIComponent(name)}${t ? `#t=${encodeURIComponent(t)}` : ''}`;
    linkEl.href = url; linkEl.textContent = url;
  };
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) rebuild(); });
  nameEl.addEventListener('input', rebuild);
  copyEl.addEventListener('click', async () => {
    rebuild();
    try { await navigator.clipboard.writeText(linkEl.href); copyEl.textContent = 'Copied ✓'; setTimeout(() => { copyEl.textContent = 'Copy link'; }, 1500); }
    catch { copyEl.textContent = 'Select the link above to copy'; } // clipboard needs a secure context
  });
  rebuild();
}

// --- boot ---
setupAddRoom();
$('bedtimeBtn').addEventListener('click', runBedtime);
$('preflightBtn').addEventListener('click', runPreflight);
$('alarmDismiss').addEventListener('click', clearAlarm);
$('addSoundBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; });
// Drag-and-drop onto the Sounds card
const soundsCard = $('soundsCard');
['dragenter', 'dragover'].forEach((ev) => soundsCard.addEventListener(ev, (e) => { e.preventDefault(); soundsCard.classList.add('dropping'); }));
['dragleave', 'dragend', 'drop'].forEach((ev) => soundsCard.addEventListener(ev, (e) => { e.preventDefault(); soundsCard.classList.remove('dropping'); }));
soundsCard.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) uploadFile(f); });
document.addEventListener('click', primeAlarm, { once: true });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw reg failed', e));
window.addEventListener('online', () => { if (!ws) connect(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!ws) connect(); else runHealthCheck(); } });
await loadSoundscapes();
connect();
