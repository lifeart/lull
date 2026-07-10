// Multi-tenancy (per-family groups via TOFU token → group). Two halves:
//   1. resolveGroup / hashGroup / verifyClient units — the ONE place group membership is decided.
//   2. A REAL WebSocket cross-group isolation test (the seam, per the Multi-Agent Integration Rule):
//      a controller must never see or command another family's device, two families may reuse the
//      same deviceId without collision, and a wrong-group target is indistinguishable from a
//      missing one (no cross-group existence oracle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from '../hub/store.js';
import { Hub } from '../hub/ws.js';
import { UploadsManager } from '../hub/uploads.js';
import { buildAllowedOrigins, makeVerifyClient, resolveGroup, hashGroup } from '../hub/auth.js';
import { MSG, ROLES, VERBS, makeHello, makeCommand } from '../shared/protocol.js';

// ---------- resolver units ----------

test('hashGroup: deterministic, distinct per token, filesystem-safe id', () => {
  assert.equal(hashGroup('smith'), hashGroup('smith'), 'same token → same group');
  assert.notEqual(hashGroup('smith'), hashGroup('jones'), 'different token → different group');
  assert.match(hashGroup('smith'), /^g[0-9a-f]{20}$/, 'short hex id, safe as a path segment');
});

test('resolveGroup: TOFU maps any token→its own group; tokenless gated by allowTokenless', () => {
  const mg = { multiGroup: true, token: '', allowTokenless: false };
  assert.deepEqual(resolveGroup('/ws?token=smith', mg), { ok: true, groupId: hashGroup('smith') });
  assert.notEqual(resolveGroup('/ws?token=smith', mg).groupId, resolveGroup('/ws?token=jones', mg).groupId);
  assert.equal(resolveGroup('/ws', mg).ok, false, 'tokenless on the network is rejected');
  assert.equal(resolveGroup('/ws', { ...mg, allowTokenless: true }).groupId, 'default', 'tokenless → shared default group when allowed');
});

test('resolveGroup: legacy mode gates on the single MP_TOKEN, one default group', () => {
  const lg = { multiGroup: false, token: 'secret', allowTokenless: false };
  assert.deepEqual(resolveGroup('/ws?token=secret', lg), { ok: true, groupId: 'default' });
  assert.equal(resolveGroup('/ws?token=nope', lg).ok, false, 'wrong token rejected');
  // unset token (dev) → open, default group
  assert.deepEqual(resolveGroup('/ws', { multiGroup: false, token: '', allowTokenless: false }), { ok: true, groupId: 'default' });
});

test('makeVerifyClient (multi-group): rejects tokenless on the network and stashes the resolved group on the req', () => {
  const allowed = buildAllowedOrigins({ port: 8080 });
  const vc = makeVerifyClient({ allowed, token: '', multiGroup: true, allowTokenless: false });
  const call = (info) => { let out; vc(info, (...a) => { out = a; }); return out; };
  const reqA = { url: '/ws?token=smith', headers: {} };
  assert.deepEqual(call({ origin: undefined, req: reqA }), [true]);
  assert.equal(reqA._groupId, hashGroup('smith'), 'group derived from token, stashed for the ws layer');
  assert.deepEqual(call({ origin: undefined, req: { url: '/ws', headers: {} } }), [false, 401, 'token required']);
});

// ---------- per-group uploads isolation ----------

test('UploadsManager: each group gets an isolated library; default keeps the flat legacy layout', async () => {
  const root = path.join(os.tmpdir(), `mp-mgup-${process.pid}-${Date.now()}`);
  try {
    const mgr = new UploadsManager(root);
    const a = mgr.for('gaaa'), b = mgr.for('gbbb');
    const ia = await a.add({ label: 'A-lullaby', ext: 'mp3', bytes: Buffer.from('aaa'), nowMs: 1 });
    assert.equal(a.list().length, 1);
    assert.equal(b.list().length, 0, 'group B cannot see group A uploads');
    assert.match(ia.url, /^\/uploads\/gaaa\/up-/, 'group uploads are served under /uploads/<groupId>/');
    const d = mgr.for('default');
    const idf = await d.add({ label: 'D', ext: 'mp3', bytes: Buffer.from('d'), nowMs: 2 });
    assert.match(idf.url, /^\/uploads\/up-/, 'default group keeps the flat /uploads/ layout (no migration)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- real WebSocket cross-group isolation (the seam) ----------

function startHub() {
  const file = path.join(os.tmpdir(), `mp-mg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const store = new Store(file);
  const hub = new Hub(store);
  const server = http.createServer();
  const allowed = buildAllowedOrigins({ port: 0 });
  const verifyClient = makeVerifyClient({ allowed, token: '', multiGroup: true, allowTokenless: true });
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient });
  wss.on('connection', (ws, req) => hub.handleConnection(ws, req));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, hub, store,
      close: () => { try { wss.close(); server.close(); hub.stop(); rmSync(file, { force: true }); } catch { /* ignore */ } },
    }));
  });
}

function client(port, token) {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${q}`);
  const inbox = [], waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === MSG.PING) { ws.send(JSON.stringify({ t: MSG.PONG })); return; }
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
  });
  return {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    open: new Promise((r) => ws.on('open', r)),
    waitFor: (pred, ms = 1500) => new Promise((resolve, reject) => {
      const hit = inbox.find(pred); if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), ms).unref?.();
    }),
    close: () => ws.close(),
  };
}

test('cross-group: a controller sees only devices in its own group', async () => {
  const h = await startHub();
  try {
    const pA = client(h.port, 'familyA'); await pA.open;
    pA.send(makeHello({ role: ROLES.PLAYER, deviceId: 'phone', friendlyName: 'A-phone', caps: { tier: 'MID' } }));
    await pA.waitFor((m) => m.t === MSG.SNAPSHOT);

    const cB = client(h.port, 'familyB'); await cB.open;
    cB.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'B-ctrl', caps: {} }));
    const wB = await cB.waitFor((m) => m.t === MSG.WELCOME);
    assert.equal(wB.devices.length, 0, 'family B sees none of family A devices');
    assert.equal(wB.groupId, hashGroup('familyB'), 'welcome echoes the resolved group');

    const cA = client(h.port, 'familyA'); await cA.open;
    cA.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'A-ctrl', caps: {} }));
    const wA = await cA.waitFor((m) => m.t === MSG.WELCOME);
    assert.ok(wA.devices.some((d) => d.deviceId === 'phone'), 'family A controller sees its own device');
    pA.close(); cA.close(); cB.close();
  } finally { h.close(); }
});

test('cross-group: a controller cannot command another group’s device (unknown, no oracle)', async () => {
  const h = await startHub();
  try {
    const pA = client(h.port, 'familyA'); await pA.open;
    pA.send(makeHello({ role: ROLES.PLAYER, deviceId: 'phone', friendlyName: 'A', caps: { tier: 'MID' } }));
    await pA.waitFor((m) => m.t === MSG.SNAPSHOT);

    const cB = client(h.port, 'familyB'); await cB.open;
    cB.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'B', caps: {} }));
    await cB.waitFor((m) => m.t === MSG.WELCOME);

    const cmd = makeCommand({ target: 'phone', verb: VERBS.START }); // B guesses A's deviceId
    cB.send(cmd);
    const ack = await cB.waitFor((m) => m.t === MSG.ACK && m.cmdId === cmd.cmdId);
    assert.equal(ack.ok, false);
    assert.match(ack.error, /unknown device/, 'same error as a truly-missing device — no existence oracle');
    // ...and family A's player must NOT receive the command.
    await assert.rejects(pA.waitFor((m) => m.t === MSG.COMMAND, 250), 'A never receives B’s command');
    pA.close(); cB.close();
  } finally { h.close(); }
});

test('cross-group: the same deviceId in two groups stays independent', async () => {
  const h = await startHub();
  try {
    const pA = client(h.port, 'familyA'); await pA.open;
    pA.send(makeHello({ role: ROLES.PLAYER, deviceId: 'shared-id', friendlyName: 'A', caps: { tier: 'MODERN', audioSession: true } }));
    await pA.waitFor((m) => m.t === MSG.SNAPSHOT);
    const pB = client(h.port, 'familyB'); await pB.open;
    pB.send(makeHello({ role: ROLES.PLAYER, deviceId: 'shared-id', friendlyName: 'B', caps: { tier: 'MODERN', audioSession: true } }));
    await pB.waitFor((m) => m.t === MSG.SNAPSHOT);

    // Neither reap-on-reconnect nor command routing collapsed the two identical deviceIds.
    assert.equal(h.hub.players.size, 2, 'two distinct (group, deviceId) player sockets coexist');

    const cA = client(h.port, 'familyA'); await cA.open;
    cA.send(makeHello({ role: ROLES.CONTROLLER, deviceId: 'c', friendlyName: 'A', caps: {} }));
    await cA.waitFor((m) => m.t === MSG.WELCOME);
    const cmd = makeCommand({ target: 'shared-id', verb: VERBS.START });
    cA.send(cmd);
    await pA.waitFor((m) => m.t === MSG.COMMAND && m.cmdId === cmd.cmdId); // A's player receives it
    await assert.rejects(pB.waitFor((m) => m.t === MSG.COMMAND, 250), 'B’s same-named player never does');
    pA.close(); pB.close(); cA.close();
  } finally { h.close(); }
});
