// WebSocket relay + connection registry + app-level heartbeat.
//
// Why a heartbeat: a backgrounded iOS socket freezes with NO close event and send() silently
// fails, so "the socket object exists" != "connected". The hub pings every socket and reaps
// ones that stop ponging. Controllers learn a device died via a devices broadcast, then alarm
// the (awake) parent — you cannot revive a suspended nursery tab from here. (docs/DESIGN.md §1.4)

import { WebSocket } from 'ws';
import { StateManager } from './state.js';
import {
  MSG,
  VERBS,
  HEARTBEAT_MS,
  HEARTBEAT_GRACE_MS,
  makeWelcome,
  makeSnapshot,
  makeAck,
  makeDevices,
  validateCommand,
} from '../shared/protocol.js';

const HELLO_TIMEOUT_MS = 10000; // reap a socket that connects but never identifies
const MAX_DEVICES = 64; // registry cap so a flood of new deviceIds can't grow state.json unbounded
const DEVICE_ID_RE = /^[\w-]{1,64}$/; // letters/digits/_/- only
// Per-socket token bucket: caps message rate so a buggy/compromised client stuck in a report loop
// can't spin the event loop or amplify O(devices×controllers) broadcasts. (finding #16)
// The burst allowance MUST exceed the largest legitimate burst: the bedtime pre-flight fires one
// PROBE per registered device in a single tick, up to MAX_DEVICES — sizing the cap below that would
// reap the controller mid-pre-flight and silently defeat the safety check. (review finding #1)
const MSG_BUCKET_CAP = 2 * MAX_DEVICES; // 128 — pre-flight fan-out (≤64) + generous headroom
const MSG_REFILL_PER_SEC = 25; // steady-state; well above real traffic (~1 msg/5s per device)

export class Hub {
  constructor(store) {
    this.store = store;
    this.players = new Map(); // deviceId -> ws
    this.controllers = new Set(); // ws
    this.state = new StateManager(store, {
      onDesiredChanged: (deviceId) => {
        // Hub-owned timer flipped desired (e.g. sleep timer elapsed): tell player + controllers.
        this._pushSnapshot(deviceId);
        this._broadcastDevices();
      },
    });
    this._hb = null;
  }

  handleConnection(ws) {
    ws._meta = { role: null, deviceId: null, alive: true, graceTimer: null, tokens: MSG_BUCKET_CAP, lastMsgMs: Date.now() };
    // A socket that connects but never sends `hello` (crash before hello, frozen tab, malicious
    // flood) is in no map and the heartbeat can't reap it — so give it a hard deadline.
    ws._meta.helloTimer = setTimeout(() => {
      if (!ws._meta.role) {
        try { ws.terminate(); } catch (err) { console.error('[ws] hello-timeout terminate failed:', err.message); }
      }
    }, HELLO_TIMEOUT_MS);
    if (typeof ws._meta.helloTimer.unref === 'function') ws._meta.helloTimer.unref();
    ws.on('message', (raw) => {
      if (!this._rateOk(ws)) return;
      // A malformed frame or a bug in a handler must be contained to this socket, never crash the
      // always-on hub (the top-level uncaughtException handler is the last resort). (finding #1)
      try { this._onMessage(ws, raw); }
      catch (err) { console.error('[ws] message handler error:', err.message); }
    });
    ws.on('close', () => this._onClose(ws));
    ws.on('error', (err) => console.error('[ws] socket error:', err.message));
    ws.on('pong', () => { ws._meta.alive = true; }); // native ws pong
  }

  // Token-bucket rate limit. Returns false (and terminates) when a socket exceeds the budget.
  _rateOk(ws) {
    const m = ws._meta;
    const now = Date.now();
    m.tokens = Math.min(MSG_BUCKET_CAP, m.tokens + ((now - m.lastMsgMs) / 1000) * MSG_REFILL_PER_SEC);
    m.lastMsgMs = now;
    if (m.tokens < 1) {
      console.warn('[ws] message rate exceeded — terminating', m.deviceId || m.role || 'socket');
      try { ws.terminate(); } catch (err) { console.error('[ws] rate-limit terminate failed:', err.message); }
      return false;
    }
    m.tokens -= 1;
    return true;
  }

  startHeartbeat() {
    this._hb = setInterval(() => this._heartbeatTick(), HEARTBEAT_MS);
    if (typeof this._hb.unref === 'function') this._hb.unref();
  }

  stop() {
    if (this._hb) clearInterval(this._hb);
    this._hb = null;
  }

  // ---- messaging ----

  _send(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      console.error('[ws] send failed:', err.message);
    }
  }

  _onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      this._send(ws, { t: MSG.ERROR, error: 'bad json' });
      return;
    }
    // Reject non-object JSON (null / number / string / array): downstream reads msg.t and a bare
    // `null` frame would throw a TypeError that crashes the process. (finding #1)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this._send(ws, { t: MSG.ERROR, error: 'message must be a JSON object' });
      return;
    }

    // First message must be a hello.
    if (!ws._meta.role) {
      if (msg.t !== MSG.HELLO) {
        this._send(ws, { t: MSG.ERROR, error: 'expected hello first' });
        return;
      }
      this._onHello(ws, msg);
      return;
    }

    switch (msg.t) {
      case MSG.PONG:
        ws._meta.alive = true;
        break;
      case MSG.REPORT:
        this._onReport(ws, msg);
        break;
      case MSG.ACK:
        // Player ACKing a command/probe -> forward to all controllers.
        this._broadcastToControllers(msg);
        break;
      case MSG.COMMAND:
        this._onCommand(ws, msg);
        break;
      case MSG.PROBE:
        this._onProbe(ws, msg);
        break;
      default:
        this._send(ws, { t: MSG.ERROR, error: `unexpected type: ${msg.t}` });
    }
  }

  _onHello(ws, msg) {
    if (ws._meta.helloTimer) { clearTimeout(ws._meta.helloTimer); ws._meta.helloTimer = null; }
    if (msg.role === 'player') {
      const id = msg.deviceId;
      if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) {
        this._send(ws, { t: MSG.ERROR, error: 'invalid deviceId' });
        try { ws.terminate(); } catch (err) { console.error('[ws] terminate bad-id failed:', err.message); }
        return;
      }
      if (!this.store.get(id) && this.store.list().length >= MAX_DEVICES) {
        this._send(ws, { t: MSG.ERROR, error: 'device registry full' });
        try { ws.terminate(); } catch (err) { console.error('[ws] terminate over-cap failed:', err.message); }
        return;
      }
      ws._meta.role = msg.role;
      ws._meta.deviceId = id;
      // A frozen iOS socket fires no close event; on reconnect (same deviceId) proactively reap
      // the stale one so the heartbeat/FD isn't leaked and routing points at the live socket.
      const old = this.players.get(id);
      if (old && old !== ws) {
        try { old.terminate(); } catch (err) { console.error('[ws] terminate stale player failed:', err.message); }
      }
      this.players.set(id, ws);
      this.state.register({
        deviceId: msg.deviceId,
        friendlyName: msg.friendlyName,
        caps: msg.caps,
        tier: (msg.caps && msg.caps.tier) || undefined,
      });
      this._send(ws, makeWelcome({ serverEpochMs: Date.now(), devices: [] }));
      // Authoritative desired state on every (re)connect — REPLACE-ALL, timer reconciled.
      this._pushSnapshot(msg.deviceId);
      this._broadcastDevices();
    } else if (msg.role === 'controller') {
      ws._meta.role = msg.role;
      this.controllers.add(ws);
      this._send(ws, makeWelcome({ serverEpochMs: Date.now(), devices: this._deviceList() }));
    } else {
      this._send(ws, { t: MSG.ERROR, error: `unknown role: ${msg.role}` });
    }
  }

  _onReport(ws, msg) {
    if (ws._meta.role !== 'player') return;
    this.state.setReported(ws._meta.deviceId, {
      state: msg.state,
      gainLinear: msg.gainLinear,
      remainingSec: msg.remainingSec,
      soundscape: msg.soundscape,
      tier: msg.tier,
      micLevel: msg.micLevel, // baby-monitor room loudness (0..1 or undefined) — M8a
    });
    this._broadcastDevices();
  }

  _onCommand(ws, msg) {
    // Controllers may command any device; a player may only command ITSELF (lock-screen intent).
    const selfPlayer = ws._meta.role === 'player' && msg.target === ws._meta.deviceId;
    if (ws._meta.role !== 'controller' && !selfPlayer) return;
    const check = validateCommand(msg);
    if (!check.ok) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: check.error }));
      return;
    }
    // Clock authority: convert a relative durationMs into an absolute deadline on the HUB's
    // clock, so player/controller clock skew can't make the timer fire early/late. (§ clock fix)
    if ((msg.verb === VERBS.SET_TIMER || msg.verb === VERBS.START) &&
        msg.durationMs !== undefined && Number.isFinite(Number(msg.durationMs))) {
      msg = { ...msg, endsAtEpochMs: Date.now() + Number(msg.durationMs) };
      delete msg.durationMs;
    }
    // Save intent regardless of whether the player is reachable (it conforms on reconnect).
    const device = this.state.applyCommand(msg.target, msg);
    if (!device) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'unknown device' }));
      return;
    }
    this._broadcastDevices();

    // Player-originated intent: make it authoritative and echo a snapshot; no relay/ACK loop.
    if (selfPlayer) {
      this._pushSnapshot(msg.target);
      return;
    }

    const player = this.players.get(msg.target);
    if (!player) {
      // Offline: the controller must know so it can alarm the parent. Desired is still saved.
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'device offline' }));
      return;
    }
    // If the timer's deadline was already in the past, applyCommand synchronously fired it and
    // desired is now STOP (a STOP snapshot was already pushed). Relaying the original START would
    // restart audio for ~1s until the player's safety net catches up, so ACK success and skip it.
    const reconciled = this.state.getDesired(msg.target);
    if ((msg.verb === VERBS.SET_TIMER || msg.verb === VERBS.START) && reconciled && reconciled.verb === VERBS.STOP) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: true }));
      return;
    }
    this._send(player, msg); // relay verbatim; player ACKs when applied
  }

  _onProbe(ws, msg) {
    if (ws._meta.role !== 'controller') return;
    const player = this.players.get(msg.target);
    if (!player) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'device offline' }));
      return;
    }
    this._send(player, msg); // player replies with an ACK echoing cmdId
  }

  _onClose(ws) {
    if (ws._meta.helloTimer) { clearTimeout(ws._meta.helloTimer); ws._meta.helloTimer = null; }
    if (ws._meta.graceTimer) { clearTimeout(ws._meta.graceTimer); ws._meta.graceTimer = null; }
    if (ws._meta.role === 'player' && ws._meta.deviceId) {
      if (this.players.get(ws._meta.deviceId) === ws) this.players.delete(ws._meta.deviceId);
      this._broadcastDevices();
    } else if (ws._meta.role === 'controller') {
      this.controllers.delete(ws);
    }
  }

  // ---- broadcasts / snapshots ----

  _pushSnapshot(deviceId) {
    const player = this.players.get(deviceId);
    if (!player) return;
    const desired = this.state.getDesired(deviceId);
    this._send(player, makeSnapshot({ deviceId, desired, serverEpochMs: Date.now() }));
  }

  _deviceList() {
    return this.store.list().map((d) =>
      this.state.view(d.deviceId, { online: this.players.has(d.deviceId) })
    );
  }

  _broadcastDevices() {
    const payload = makeDevices({ devices: this._deviceList() });
    for (const c of this.controllers) this._send(c, payload);
  }

  _broadcastToControllers(msg) {
    for (const c of this.controllers) this._send(c, msg);
  }

  // Tell every client (players + controllers) the sound library changed → refetch /api/library.
  broadcastLibrary() {
    const m = { t: MSG.LIBRARY };
    for (const c of this.controllers) this._send(c, m);
    for (const p of this.players.values()) this._send(p, m);
  }

  _heartbeatTick() {
    const all = [...this.players.values(), ...this.controllers];
    for (const ws of all) {
      if (ws._meta.alive === false) {
        // Backstop: still no pong a full interval after the last ping -> reap (fires close ->
        // devices broadcast). Normally the grace timer below has already reaped it sooner.
        try { ws.terminate(); } catch (err) { console.error('[ws] terminate failed:', err.message); }
        continue;
      }
      ws._meta.alive = false;
      try {
        ws.ping(); // native ping; also send an app-level ping for clients that prefer it
        this._send(ws, { t: MSG.PING });
      } catch (err) {
        console.error('[ws] ping failed:', err.message);
      }
      // Reap within HEARTBEAT_GRACE_MS of the ping if no pong arrives — so a frozen iOS socket is
      // detected in ~HEARTBEAT_MS+HEARTBEAT_GRACE_MS (the documented budget), not up to 2×HEARTBEAT_MS.
      // (finding #18)
      if (ws._meta.graceTimer) clearTimeout(ws._meta.graceTimer);
      ws._meta.graceTimer = setTimeout(() => {
        if (ws._meta.alive === false) {
          try { ws.terminate(); } catch (err) { console.error('[ws] grace terminate failed:', err.message); }
        }
      }, HEARTBEAT_GRACE_MS);
      if (typeof ws._meta.graceTimer.unref === 'function') ws._meta.graceTimer.unref();
    }
  }

  // Health snapshot for /api/health: total registered vs currently-connected players. (finding #19)
  healthCounts() {
    const total = this.store.list().length;
    const online = this.players.size;
    return { total, online, offline: Math.max(0, total - online) };
  }

  // Drop a device registration entirely (parent tapped "Forget", or an admin prune). Clears its
  // sleep-timer, closes any live socket, and tells controllers. (finding #3)
  forgetDevice(deviceId) {
    if (!this.store.get(deviceId)) return false;
    this.state.forget(deviceId);
    this.store.removeDevice(deviceId);
    const sock = this.players.get(deviceId);
    if (sock) {
      this.players.delete(deviceId);
      try { sock.terminate(); } catch (err) { console.error('[ws] forget terminate failed:', err.message); }
    }
    this._broadcastDevices();
    return true;
  }
}
