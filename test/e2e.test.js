// Real end-to-end run through the actual hub (per global rule: exercise the full stack, not
// just units). Spins up the hub, connects a player + a controller over real WebSockets, and
// drives: hello → snapshot → command → ack, then the hub-owned sleep timer → stop snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from '../hub/store.js';
import { Hub } from '../hub/ws.js';
import {
  MSG, ROLES, VERBS, STATES,
  makeHello, makeCommand, makeAck, makeReport,
  reduceCommand, defaultDesired,
} from '../shared/protocol.js';

function startHub() {
  const file = path.join(os.tmpdir(), `mp-e2e-${process.pid}-${Date.now()}.json`);
  const store = new Store(file);
  const hub = new Hub(store);
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => hub.handleConnection(ws));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, hub, store,
        close: () => { try { wss.close(); server.close(); hub.stop(); rmSync(file, { force: true }); } catch { /* ignore */ } },
      });
    });
  });
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === MSG.PING) { ws.send(JSON.stringify({ t: MSG.PONG })); return; }
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const waitFor = (pred, ms = 2000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error('timeout waiting for message')), ms).unref?.();
    });
  const open = new Promise((r) => ws.on('open', r));
  return { ws, send, waitFor, open, close: () => ws.close() };
}

test('end-to-end: hello → snapshot → command → ack, then hub timer → stop', async () => {
  const hub = await startHub();
  const deviceId = 'nursery-test';
  try {
    // --- player connects and identifies ---
    const player = client(hub.port);
    await player.open;
    player.send(makeHello({
      role: ROLES.PLAYER, deviceId, friendlyName: 'Nursery',
      caps: { tier: 'MODERN', audioSession: true, mediaSession: true },
    }));
    const snap0 = await player.waitFor((m) => m.t === MSG.SNAPSHOT);
    assert.equal(snap0.desired.verb, VERBS.STOP, 'fresh device starts stopped');

    // player handles commands through the REAL shared reducer (same code path as player.js),
    // so a regression in reduceCommand/applyCommandToDesired fails this test.
    let pdesired = defaultDesired();
    player.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === MSG.COMMAND) {
        const r = reduceCommand(pdesired, m, deviceId);
        pdesired = r.desired;
        player.send(r.ack);
        player.send(makeReport({
          deviceId,
          state: r.desired.verb === VERBS.START ? STATES.PLAYING : STATES.STOPPED,
          gainLinear: r.desired.gainLinear, remainingSec: null, soundscape: r.desired.soundscape, tier: 'MODERN',
        }));
      }
    });

    // --- controller connects and sees the device ---
    const ctrl = client(hub.port);
    await ctrl.open;
    ctrl.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'controller', friendlyName: 'Ctrl', caps: {} }));
    const welcome = await ctrl.waitFor((m) => m.t === MSG.WELCOME);
    assert.ok(welcome.devices.some((d) => d.deviceId === deviceId), 'controller sees the player');

    // --- controller starts playback; player must receive the command and ACK ---
    const startCmd = makeCommand({ target: deviceId, verb: VERBS.START });
    ctrl.send(startCmd);
    const gotCmd = await player.waitFor((m) => m.t === MSG.COMMAND && m.cmdId === startCmd.cmdId);
    assert.equal(gotCmd.verb, VERBS.START);
    const ack = await ctrl.waitFor((m) => m.t === MSG.ACK && m.cmdId === startCmd.cmdId);
    assert.equal(ack.ok, true, 'controller receives a positive ACK end-to-end');

    // controller should observe the device reported as playing
    await ctrl.waitFor((m) => m.t === MSG.DEVICES && m.devices.some((d) => d.reported && d.reported.state === STATES.PLAYING));

    // --- hub-owned sleep timer: set a 300ms deadline, expect a STOP snapshot to the player ---
    ctrl.send(makeCommand({ target: deviceId, verb: VERBS.SET_TIMER, endsAtEpochMs: Date.now() + 300 }));
    const stopSnap = await player.waitFor(
      (m) => m.t === MSG.SNAPSHOT && m.desired.verb === VERBS.STOP && m !== snap0, 2000
    );
    assert.equal(stopSnap.desired.verb, VERBS.STOP, 'hub flips desired to stop at the deadline');
    assert.equal(stopSnap.desired.endsAtEpochMs, null, 'and clears the timer so a resync cannot resurrect noise');

    player.close();
    ctrl.close();
  } finally {
    hub.close();
  }
});

test('offline device: command is saved and controller is told (so it can alarm)', async () => {
  const hub = await startHub();
  try {
    // register a device, then disconnect it
    const p = client(hub.port);
    await p.open;
    p.send(makeHello({ role: ROLES.PLAYER, deviceId: 'gone', friendlyName: 'Gone', caps: { tier: 'LEGACY' } }));
    await p.waitFor((m) => m.t === MSG.SNAPSHOT);
    p.close();
    await new Promise((r) => setTimeout(r, 50));

    const ctrl = client(hub.port);
    await ctrl.open;
    ctrl.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'c', caps: {} }));
    await ctrl.waitFor((m) => m.t === MSG.WELCOME);
    const cmd = makeCommand({ target: 'gone', verb: VERBS.START });
    ctrl.send(cmd);
    const ack = await ctrl.waitFor((m) => m.t === MSG.ACK && m.cmdId === cmd.cmdId);
    assert.equal(ack.ok, false);
    assert.match(ack.error, /offline/);
    ctrl.close();
  } finally {
    hub.close();
  }
});

test('self-command: a player may command itself; hub echoes a snapshot, no ack/relay loop', async () => {
  const hub = await startHub();
  const deviceId = 'nursery-self';
  try {
    const player = client(hub.port);
    await player.open;
    player.send(makeHello({ role: ROLES.PLAYER, deviceId, friendlyName: 'N', caps: { tier: 'MID' } }));
    const snap0 = await player.waitFor((m) => m.t === MSG.SNAPSHOT);
    assert.equal(snap0.desired.verb, VERBS.STOP);
    const cmd = makeCommand({ target: deviceId, verb: VERBS.START }); // lock-screen self-intent
    player.send(cmd);
    const snap1 = await player.waitFor((m) => m.t === MSG.SNAPSHOT && m !== snap0 && m.desired.verb === VERBS.START, 2000);
    assert.equal(snap1.desired.verb, VERBS.START);
    // no ACK and no COMMAND echo for the player's own intent (no loop)
    await assert.rejects(player.waitFor((m) => (m.t === MSG.ACK || m.t === MSG.COMMAND) && m.cmdId === cmd.cmdId, 200));
    player.close();
  } finally { hub.close(); }
});

test('cross-device: a player cannot command a different device', async () => {
  const hub = await startHub();
  try {
    const a = client(hub.port); await a.open;
    a.send(makeHello({ role: ROLES.PLAYER, deviceId: 'devA', friendlyName: 'A', caps: { tier: 'MID' } }));
    await a.waitFor((m) => m.t === MSG.SNAPSHOT);
    const b = client(hub.port); await b.open;
    b.send(makeHello({ role: ROLES.PLAYER, deviceId: 'devB', friendlyName: 'B', caps: { tier: 'MID' } }));
    const bSnap0 = await b.waitFor((m) => m.t === MSG.SNAPSHOT);
    a.send(makeCommand({ target: 'devB', verb: VERBS.START }));
    await assert.rejects(b.waitFor((m) => m.t === MSG.COMMAND || (m.t === MSG.SNAPSHOT && m !== bSnap0), 250));
    a.close(); b.close();
  } finally { hub.close(); }
});

test('durationMs is rebased to an absolute hub-clock deadline and durationMs is stripped', async () => {
  const hub = await startHub();
  const deviceId = 'nursery-dur';
  try {
    const player = client(hub.port); await player.open;
    player.send(makeHello({ role: ROLES.PLAYER, deviceId, friendlyName: 'N', caps: { tier: 'MID' } }));
    const snap0 = await player.waitFor((m) => m.t === MSG.SNAPSHOT);
    const ctrl = client(hub.port); await ctrl.open;
    ctrl.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'c', caps: {} }));
    await ctrl.waitFor((m) => m.t === MSG.WELCOME);
    const t0 = Date.now();
    ctrl.send(makeCommand({ target: deviceId, verb: VERBS.SET_TIMER, durationMs: 400 }));
    const cmd = await player.waitFor((m) => m.t === MSG.COMMAND && m.verb === VERBS.SET_TIMER);
    assert.equal(typeof cmd.endsAtEpochMs, 'number');
    assert.equal(cmd.durationMs, undefined, 'durationMs stripped after rebase');
    assert.ok(cmd.endsAtEpochMs >= t0 + 400 - 100 && cmd.endsAtEpochMs <= Date.now() + 400 + 100, 'rebased to hub clock');
    const stop = await player.waitFor((m) => m.t === MSG.SNAPSHOT && m !== snap0 && m.desired.verb === VERBS.STOP, 2000);
    assert.equal(stop.desired.endsAtEpochMs, null);
    player.close(); ctrl.close();
  } finally { hub.close(); }
});

test('past-deadline START: hub ACKs ok, snapshots STOP, and does NOT relay the START', async () => {
  const hub = await startHub();
  const deviceId = 'nursery-past';
  try {
    const player = client(hub.port); await player.open;
    player.send(makeHello({ role: ROLES.PLAYER, deviceId, friendlyName: 'N', caps: { tier: 'MID' } }));
    const snap0 = await player.waitFor((m) => m.t === MSG.SNAPSHOT);
    const ctrl = client(hub.port); await ctrl.open;
    ctrl.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'c', caps: {} }));
    await ctrl.waitFor((m) => m.t === MSG.WELCOME);
    const cmd = makeCommand({ target: deviceId, verb: VERBS.START, endsAtEpochMs: Date.now() - 1 });
    ctrl.send(cmd);
    const ack = await ctrl.waitFor((m) => m.t === MSG.ACK && m.cmdId === cmd.cmdId);
    assert.equal(ack.ok, true);
    const stop = await player.waitFor((m) => m.t === MSG.SNAPSHOT && m !== snap0 && m.desired.verb === VERBS.STOP);
    assert.equal(stop.desired.verb, VERBS.STOP);
    await assert.rejects(player.waitFor((m) => m.t === MSG.COMMAND && m.cmdId === cmd.cmdId, 200));
    player.close(); ctrl.close();
  } finally { hub.close(); }
});
