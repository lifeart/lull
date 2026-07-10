// WebSocket relay + connection registry + app-level heartbeat.
//
// Why a heartbeat: a backgrounded iOS socket freezes with NO close event and send() silently
// fails, so "the socket object exists" != "connected". The hub pings every socket and reaps
// ones that stop ponging. Controllers learn a device died via a devices broadcast, then alarm
// the (awake) parent — you cannot revive a suspended nursery tab from here. (docs/DESIGN.md §1.4)
//
// Multi-tenancy: every connection carries a groupId (resolved from its token in hub/auth.js and
// stashed on the request by verifyClient). Players are keyed by groupKey(groupId, deviceId) and
// controllers are bucketed per group, so a controller only ever sees/commands devices in ITS
// group and every broadcast fans out to same-group controllers only. The group is derived from
// the authenticated token, never from client-supplied data, so a client can't cross the boundary.

import { WebSocket } from 'ws';
import { StateManager } from './state.js';
import {
  MSG,
  VERBS,
  HEARTBEAT_MS,
  HEARTBEAT_GRACE_MS,
  DEFAULT_GROUP,
  groupKey,
  makeWelcome,
  makeSnapshot,
  makeAck,
  makeDevices,
  validateCommand,
} from '../shared/protocol.js';

const HELLO_TIMEOUT_MS = 10000; // reap a socket that connects but never identifies
const MAX_DEVICES = 64; // per-GROUP registry cap so one family can't grow state unbounded
const MAX_GROUPS = 128; // TOFU cap: distinct token-groups that may register devices (stray tokens can't grow state without bound)
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
    this.players = new Map(); // groupKey(groupId, deviceId) -> ws
    this.controllers = new Map(); // groupId -> Set<ws>
    this.state = new StateManager(store, {
      onDesiredChanged: (groupId, deviceId) => {
        // Hub-owned timer flipped desired (e.g. sleep timer elapsed): tell player + controllers.
        this._pushSnapshot(groupId, deviceId);
        this._broadcastDevices(groupId);
      },
    });
    this._hb = null;
  }

  handleConnection(ws, req) {
    // The group was resolved from the token by verifyClient and stashed on the request. Tests (and
    // the loopback dev box) may connect with no req → the single DEFAULT_GROUP.
    const groupId = (req && req._groupId) || DEFAULT_GROUP;
    ws._meta = { role: null, groupId, deviceId: null, alive: true, graceTimer: null, tokens: MSG_BUCKET_CAP, lastMsgMs: Date.now() };
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
        // Player ACKing a command/probe -> forward to the controllers in ITS group only.
        this._broadcastToControllers(ws._meta.groupId, msg);
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
    const groupId = ws._meta.groupId;
    if (msg.role === 'player') {
      const id = msg.deviceId;
      if (typeof id !== 'string' || !DEVICE_ID_RE.test(id)) {
        this._send(ws, { t: MSG.ERROR, error: 'invalid deviceId' });
        try { ws.terminate(); } catch (err) { console.error('[ws] terminate bad-id failed:', err.message); }
        return;
      }
      // Per-group caps: a family can register up to MAX_DEVICES, and a brand-new group (its first
      // device) is refused once MAX_GROUPS distinct groups already hold devices — so an attacker
      // spraying distinct tokens can't grow state.json without bound.
      const known = !!this.store.get(groupId, id);
      if (!known) {
        if (this.store.countInGroup(groupId) >= MAX_DEVICES) {
          this._send(ws, { t: MSG.ERROR, error: 'device registry full' });
          try { ws.terminate(); } catch (err) { console.error('[ws] terminate over-cap failed:', err.message); }
          return;
        }
        if (this.store.countInGroup(groupId) === 0 && this.store.groupCount() >= MAX_GROUPS) {
          this._send(ws, { t: MSG.ERROR, error: 'group registry full' });
          try { ws.terminate(); } catch (err) { console.error('[ws] terminate over-group-cap failed:', err.message); }
          return;
        }
      }
      ws._meta.role = msg.role;
      ws._meta.deviceId = id;
      const k = groupKey(groupId, id);
      // A frozen iOS socket fires no close event; on reconnect (same group+deviceId) proactively
      // reap the stale one so the heartbeat/FD isn't leaked and routing points at the live socket.
      const old = this.players.get(k);
      if (old && old !== ws) {
        try { old.terminate(); } catch (err) { console.error('[ws] terminate stale player failed:', err.message); }
      }
      this.players.set(k, ws);
      this.state.register({
        groupId,
        deviceId: id,
        friendlyName: msg.friendlyName,
        caps: msg.caps,
        tier: (msg.caps && msg.caps.tier) || undefined,
      });
      this._send(ws, makeWelcome({ serverEpochMs: Date.now(), devices: [], groupId }));
      // Authoritative desired state on every (re)connect — REPLACE-ALL, timer reconciled.
      this._pushSnapshot(groupId, id);
      this._broadcastDevices(groupId);
    } else if (msg.role === 'controller') {
      ws._meta.role = msg.role;
      let set = this.controllers.get(groupId);
      if (!set) { set = new Set(); this.controllers.set(groupId, set); }
      set.add(ws);
      this._send(ws, makeWelcome({ serverEpochMs: Date.now(), devices: this._deviceList(groupId), groupId }));
    } else {
      this._send(ws, { t: MSG.ERROR, error: `unknown role: ${msg.role}` });
    }
  }

  _onReport(ws, msg) {
    if (ws._meta.role !== 'player') return;
    const groupId = ws._meta.groupId;
    this.state.setReported(groupId, ws._meta.deviceId, {
      state: msg.state,
      gainLinear: msg.gainLinear,
      remainingSec: msg.remainingSec,
      soundscape: msg.soundscape,
      tier: msg.tier,
      micLevel: msg.micLevel, // baby-monitor room loudness (0..1 or undefined) — M8a
    });
    this._broadcastDevices(groupId);
  }

  _onCommand(ws, msg) {
    const groupId = ws._meta.groupId;
    // Controllers may command any device IN THEIR GROUP; a player may only command ITSELF
    // (lock-screen intent). A target in another group resolves to nothing here.
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
    // Save intent regardless of whether the player is reachable (it conforms on reconnect). A
    // target that doesn't exist IN THIS GROUP returns the same "unknown device" as a truly-missing
    // one, so a wrong-group target can't be used as a cross-group existence oracle.
    const device = this.state.applyCommand(groupId, msg.target, msg);
    if (!device) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'unknown device' }));
      return;
    }
    this._broadcastDevices(groupId);

    // Player-originated intent: make it authoritative and echo a snapshot; no relay/ACK loop.
    if (selfPlayer) {
      this._pushSnapshot(groupId, msg.target);
      return;
    }

    const player = this.players.get(groupKey(groupId, msg.target));
    if (!player) {
      // Offline: the controller must know so it can alarm the parent. Desired is still saved.
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'device offline' }));
      return;
    }
    // If the timer's deadline was already in the past, applyCommand synchronously fired it and
    // desired is now STOP (a STOP snapshot was already pushed). Relaying the original START would
    // restart audio for ~1s until the player's safety net catches up, so ACK success and skip it.
    const reconciled = this.state.getDesired(groupId, msg.target);
    if ((msg.verb === VERBS.SET_TIMER || msg.verb === VERBS.START) && reconciled && reconciled.verb === VERBS.STOP) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: true }));
      return;
    }
    this._send(player, msg); // relay verbatim; player ACKs when applied
  }

  _onProbe(ws, msg) {
    if (ws._meta.role !== 'controller') return;
    const player = this.players.get(groupKey(ws._meta.groupId, msg.target));
    if (!player) {
      this._send(ws, makeAck({ deviceId: msg.target, cmdId: msg.cmdId, ok: false, error: 'device offline' }));
      return;
    }
    this._send(player, msg); // player replies with an ACK echoing cmdId
  }

  _onClose(ws) {
    if (ws._meta.helloTimer) { clearTimeout(ws._meta.helloTimer); ws._meta.helloTimer = null; }
    if (ws._meta.graceTimer) { clearTimeout(ws._meta.graceTimer); ws._meta.graceTimer = null; }
    const groupId = ws._meta.groupId;
    if (ws._meta.role === 'player' && ws._meta.deviceId) {
      const k = groupKey(groupId, ws._meta.deviceId);
      if (this.players.get(k) === ws) this.players.delete(k);
      this._broadcastDevices(groupId);
    } else if (ws._meta.role === 'controller') {
      const set = this.controllers.get(groupId);
      if (set) { set.delete(ws); if (!set.size) this.controllers.delete(groupId); }
    }
  }

  // ---- broadcasts / snapshots ----

  _pushSnapshot(groupId, deviceId) {
    const player = this.players.get(groupKey(groupId, deviceId));
    if (!player) return;
    const desired = this.state.getDesired(groupId, deviceId);
    this._send(player, makeSnapshot({ deviceId, desired, serverEpochMs: Date.now() }));
  }

  _deviceList(groupId) {
    return this.store.list(groupId).map((d) =>
      this.state.view(groupId, d.deviceId, { online: this.players.has(groupKey(groupId, d.deviceId)) })
    );
  }

  _broadcastDevices(groupId) {
    const set = this.controllers.get(groupId);
    if (!set || !set.size) return;
    const payload = makeDevices({ devices: this._deviceList(groupId) });
    for (const c of set) this._send(c, payload);
  }

  _broadcastToControllers(groupId, msg) {
    const set = this.controllers.get(groupId);
    if (!set) return;
    for (const c of set) this._send(c, msg);
  }

  // Tell every client in a group (players + controllers) the sound library changed → refetch
  // /api/library. Scoped: another family's library change never wakes this group.
  broadcastLibrary(groupId) {
    const m = { t: MSG.LIBRARY };
    const set = this.controllers.get(groupId);
    if (set) for (const c of set) this._send(c, m);
    for (const p of this.players.values()) if (p._meta.groupId === groupId) this._send(p, m);
  }

  _heartbeatTick() {
    const all = [...this.players.values()];
    for (const set of this.controllers.values()) for (const c of set) all.push(c);
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

  // Health snapshot for /api/health: total registered vs currently-connected players, plus the
  // number of distinct groups holding devices. (finding #19)
  healthCounts() {
    const total = this.store.listAll().length;
    const online = this.players.size;
    return { total, online, offline: Math.max(0, total - online), groups: this.store.groupCount() };
  }

  // Drop a device registration entirely (parent tapped "Forget", or an admin prune). Clears its
  // sleep-timer, closes any live socket, and tells controllers. Group-scoped so a family can only
  // forget its own devices. (finding #3)
  forgetDevice(groupId, deviceId) {
    if (!this.store.get(groupId, deviceId)) return false;
    this.state.forget(groupId, deviceId);
    this.store.removeDevice(groupId, deviceId);
    const k = groupKey(groupId, deviceId);
    const sock = this.players.get(k);
    if (sock) {
      this.players.delete(k);
      try { sock.terminate(); } catch (err) { console.error('[ws] forget terminate failed:', err.message); }
    }
    this._broadcastDevices(groupId);
    return true;
  }
}
