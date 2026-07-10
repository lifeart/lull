// Production-hardening unit tests: the WS crash-guard, ghost-device eviction/forget, the
// shutdown flush + persist-health signal, and the streamed-upload primitives. (audit findings #1,3,11,12)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, rmSync } from 'node:fs';
import { Hub } from '../hub/ws.js';
import { Store } from '../hub/store.js';
import { Uploads } from '../hub/uploads.js';
import { DEFAULT_GROUP } from '../shared/protocol.js';

const fakeStore = { list: () => [], get: () => null };
function mkWs() {
  const h = {};
  return {
    readyState: 1, sent: [], terminated: false,
    on(ev, fn) { h[ev] = fn; },
    emit(ev, ...a) { if (h[ev]) h[ev](...a); },
    send(s) { this.sent.push(JSON.parse(s)); },
    terminate() { this.terminated = true; },
    ping() {},
  };
}
const tmp = (p) => path.join(os.tmpdir(), `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

test('a non-object WS frame (null / array / number) cannot crash the hub — it errors and survives', () => {
  const hub = new Hub(fakeStore);
  const ws = mkWs();
  hub.handleConnection(ws);
  for (const frame of ['null', '[1,2,3]', '42', '"hi"']) {
    assert.doesNotThrow(() => ws.emit('message', Buffer.from(frame)), `frame ${frame} must not throw`);
  }
  // Every one produced a protocol error, and the socket was never advanced past hello.
  assert.ok(ws.sent.filter((m) => m.t === 'error').length >= 4);
  assert.equal(ws.terminated, false);
  hub.stop();
});

test('the message rate limit survives a full bedtime pre-flight burst (MAX_DEVICES probes) (review #1)', () => {
  const hub = new Hub(fakeStore);
  const ws = mkWs();
  hub.handleConnection(ws);
  // Identify as a controller, then fire 64 probe-ish messages in one synchronous tick (~0 refill) —
  // exactly what runPreflight does for a full 64-device registry.
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', role: 'controller', deviceId: 'c', caps: {} })));
  for (let i = 0; i < 64; i++) ws.emit('message', Buffer.from(JSON.stringify({ t: 'pong' })));
  assert.equal(ws.terminated, false, 'controller must NOT be reaped mid-pre-flight');
  hub.stop();
});

test('the message rate limit still reaps a genuine flood', () => {
  const hub = new Hub(fakeStore);
  const ws = mkWs();
  hub.handleConnection(ws);
  ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', role: 'controller', deviceId: 'c', caps: {} })));
  for (let i = 0; i < 500 && !ws.terminated; i++) ws.emit('message', Buffer.from(JSON.stringify({ t: 'pong' })));
  assert.equal(ws.terminated, true, 'a sustained flood is still terminated');
  hub.stop();
});

test('a truly malformed (non-JSON) frame is reported as bad json, not a crash', () => {
  const hub = new Hub(fakeStore);
  const ws = mkWs();
  hub.handleConnection(ws);
  assert.doesNotThrow(() => ws.emit('message', Buffer.from('{not json')));
  assert.ok(ws.sent.some((m) => m.t === 'error' && /json/i.test(m.error)));
  hub.stop();
});

test('forgetDevice drops a registration and reports unknown ids', () => {
  const store = new Store(tmp('mp-forget'));
  store.upsertDevice({ deviceId: 'nursery', friendlyName: 'Nursery', caps: {}, tier: 'MID' }, Date.now());
  const hub = new Hub(store);
  assert.ok(store.get(DEFAULT_GROUP, 'nursery'));
  assert.equal(hub.forgetDevice(DEFAULT_GROUP, 'nursery'), true);
  assert.equal(store.get(DEFAULT_GROUP, 'nursery'), null);
  assert.equal(hub.forgetDevice(DEFAULT_GROUP, 'nursery'), false, 'second forget is a no-op');
  assert.equal(hub.forgetDevice(DEFAULT_GROUP, 'never-existed'), false);
  hub.stop();
});

test('pruneStale evicts devices unseen past the TTL and keeps fresh ones', () => {
  const store = new Store(tmp('mp-prune'));
  const now = 1_700_000_000_000;
  const day = 86_400_000;
  store.upsertDevice({ deviceId: 'ghost', friendlyName: 'g', caps: {}, tier: 'MID' }, now - 100 * day);
  store.upsertDevice({ deviceId: 'live', friendlyName: 'l', caps: {}, tier: 'MID' }, now - 2 * day);
  const removed = store.pruneStale(45 * day, now);
  assert.deepEqual(removed, [{ groupId: DEFAULT_GROUP, deviceId: 'ghost' }]);
  assert.equal(store.get(DEFAULT_GROUP, 'ghost'), null);
  assert.ok(store.get(DEFAULT_GROUP, 'live'));
  assert.deepEqual(store.pruneStale(0, now), [], 'TTL 0 disables eviction');
});

test('store.flush resolves and persistHealthy is true after a successful write', async () => {
  const store = new Store(tmp('mp-flush'));
  store.upsertDevice({ deviceId: 'a', friendlyName: 'A', caps: {}, tier: 'MID' }, Date.now());
  await store.flush();
  assert.equal(store.persistHealthy, true);
});

test('uploads: isFull gate + streamed temp-file commit round-trips', async () => {
  const dir = tmp('mp-up');
  const up = new Uploads(dir);
  assert.equal(up.isFull(), false);
  const tmpPath = await up.reserveTempPath(Date.now());
  await fs.writeFile(tmpPath, Buffer.from('ID3 fake audio bytes'));
  const item = await up.commitTemp({ label: 'Lullaby', ext: 'mp3', tmpPath, nowMs: Date.now() });
  assert.match(item.url, /^\/uploads\/up-.*\.mp3$/);
  assert.equal(item.label, 'Lullaby');
  assert.equal(up.list().length, 1);
  // the temp file was renamed away, not left behind
  await assert.rejects(fs.access(tmpPath));
  rmSync(dir, { recursive: true, force: true });
});

test('uploads: favorites are a hub-synced flag on any id, persisted, and dropped on delete', async () => {
  const dir = tmp('mp-fav');
  const up = new Uploads(dir);
  assert.deepEqual(up.getFavs(), []);
  await up.setFav('white', true);   // a baked-noise id we don't otherwise track
  await up.setFav('pink', true);
  await up.setFav('white', true);   // idempotent add
  assert.deepEqual(up.getFavs().sort(), ['pink', 'white']);
  await up.setFav('white', false);
  assert.deepEqual(up.getFavs(), ['pink']);
  // Persisted across a reload.
  await up.flush();
  const up2 = new Uploads(dir);
  assert.deepEqual(up2.getFavs(), ['pink']);
  // Deleting an uploaded track removes it from favs too.
  const t = await up2.reserveTempPath(Date.now());
  await fs.writeFile(t, Buffer.from('x'));
  const item = await up2.commitTemp({ label: 'Track', ext: 'mp3', tmpPath: t, nowMs: Date.now() });
  await up2.setFav(item.id, true);
  assert.ok(up2.getFavs().includes(item.id));
  await up2.remove(item.id);
  assert.ok(!up2.getFavs().includes(item.id), 'favs must not linger for a deleted upload');
  rmSync(dir, { recursive: true, force: true });
});

test('uploads: commitTemp rejects a disallowed extension and cleans up the temp file', async () => {
  const dir = tmp('mp-up2');
  const up = new Uploads(dir);
  const tmpPath = await up.reserveTempPath(Date.now());
  await fs.writeFile(tmpPath, Buffer.from('x'));
  await assert.rejects(up.commitTemp({ label: 'x', ext: 'exe', tmpPath, nowMs: Date.now() }), /unsupported/);
  await assert.rejects(fs.access(tmpPath), 'temp file removed on rejection');
  assert.equal(up.list().length, 0);
  rmSync(dir, { recursive: true, force: true });
});
