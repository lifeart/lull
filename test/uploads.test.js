// Upload library: the Uploads store + the hub's /api/library, /api/upload, /uploads round-trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { Uploads, MAX_UPLOAD_BYTES } from '../hub/uploads.js';

test('Uploads: extAllowed, add, list, and persistence', async () => {
  const dir = path.join(os.tmpdir(), `mp-up-${process.pid}-${Date.now()}`);
  try {
    const u = new Uploads(dir);
    assert.equal(u.extAllowed('mp3'), true);
    assert.equal(u.extAllowed('m4a'), true);
    assert.equal(u.extAllowed('exe'), false);

    const item = await u.add({ label: 'Lullaby', ext: 'mp3', bytes: Buffer.from('ID3-fake'), nowMs: 1 });
    assert.match(item.url, /^\/uploads\/up-[a-z0-9]+\.mp3$/);
    assert.equal(item.kind, 'upload');
    assert.equal(u.list().length, 1);
    assert.equal(u.list()[0].label, 'Lullaby');

    await assert.rejects(u.add({ label: 'x', ext: 'exe', bytes: Buffer.from('x'), nowMs: 2 }), /unsupported/);

    const u2 = new Uploads(dir); // reload from disk index
    assert.equal(u2.list().length, 1);
    assert.equal(u2.list()[0].label, 'Lullaby');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Uploads: rename and remove', async () => {
  const dir = path.join(os.tmpdir(), `mp-up2-${process.pid}-${Date.now()}`);
  try {
    const u = new Uploads(dir);
    const it = await u.add({ label: 'A', ext: 'wav', bytes: Buffer.from('RIFFdata'), nowMs: 1 });
    const r = await u.rename(it.id, 'B');
    assert.equal(r.label, 'B');
    assert.equal(u.list()[0].label, 'B');
    assert.equal(await u.rename('nope', 'x'), null);
    assert.equal(await u.remove(it.id), true);
    assert.equal(u.list().length, 0);
    assert.equal(await u.remove('nope'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Uploads: order get/set/persist', async () => {
  const dir = path.join(os.tmpdir(), `mp-up3-${process.pid}-${Date.now()}`);
  try {
    const u = new Uploads(dir);
    await u.setOrder(['pink', 'white', 'up-x']);
    assert.deepEqual(u.getOrder(), ['pink', 'white', 'up-x']);
    const u2 = new Uploads(dir); // reload
    assert.deepEqual(u2.getOrder(), ['pink', 'white', 'up-x']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hub: /api/library merges baked + uploaded; upload + /uploads round-trips', async () => {
  const state = path.join(os.tmpdir(), `mp-srv-state-${Date.now()}.json`);
  const upDir = path.join(os.tmpdir(), `mp-srv-up-${Date.now()}`);
  process.env.PORT = '8183';
  process.env.HOST = '127.0.0.1';
  process.env.STATE_FILE = state;
  process.env.UPLOADS_DIR = upDir;
  const mod = await import('../hub/server.js');
  try {
    await new Promise((r) => setTimeout(r, 300));
    const base = 'http://127.0.0.1:8183';

    const before = (await (await fetch(base + '/api/library')).json()).soundscapes.length;

    const up = await fetch(base + '/api/upload?name=Test%20Track&ext=mp3', { method: 'POST', body: Buffer.from('audio-bytes-xyz') });
    const upj = await up.json();
    assert.equal(upj.ok, true);
    assert.equal(upj.item.label, 'Test Track');

    const lib = (await (await fetch(base + '/api/library')).json()).soundscapes;
    assert.equal(lib.length, before + 1);
    const added = lib.find((s) => s.kind === 'upload');
    assert.ok(added, 'uploaded track appears in the library');

    const got = await fetch(base + added.url);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'audio-bytes-xyz'); // served back byte-for-byte

    // reorder: put the uploaded track first
    await fetch(`${base}/api/library/order?ids=${added.id},white,pink,brown`, { method: 'POST' });
    const ordered = (await (await fetch(base + '/api/library')).json()).soundscapes;
    assert.equal(ordered[0].id, added.id, 'library order applied');

    // partial + stale order: known ids ranked first, bogus ignored, omitted kept in manifest order
    await fetch(`${base}/api/library/order?ids=bogus-xyz,${added.id},brown`, { method: 'POST' });
    const seq = (await (await fetch(base + '/api/library')).json()).soundscapes.map((s) => s.id);
    assert.deepEqual(seq, [added.id, 'brown', 'white', 'pink']);

    // rename
    const rn = await fetch(`${base}/api/upload/rename?id=${added.id}&name=Renamed`, { method: 'POST' });
    assert.equal((await rn.json()).item.label, 'Renamed');
    const lib2 = (await (await fetch(base + '/api/library')).json()).soundscapes;
    assert.ok(lib2.find((s) => s.id === added.id && s.label === 'Renamed'), 'library reflects rename');

    // delete
    const dl = await fetch(`${base}/api/upload/delete?id=${added.id}`, { method: 'POST' });
    assert.equal((await dl.json()).ok, true);
    const lib3 = (await (await fetch(base + '/api/library')).json()).soundscapes;
    assert.ok(!lib3.find((s) => s.id === added.id), 'deleted track gone from library');
    assert.equal((await fetch(`${base}/api/upload/delete?id=nope`, { method: 'POST' })).status, 404);

    const bad = await fetch(base + '/api/upload?name=x&ext=exe', { method: 'POST', body: Buffer.from('x') });
    assert.equal(bad.status, 415); // non-audio rejected

    // size limit: an oversized body is rejected (413 or socket reset) and nothing is persisted
    const beforeBig = (await (await fetch(base + '/api/library')).json()).soundscapes.length;
    let big = null;
    try { big = await fetch(`${base}/api/upload?name=Big&ext=mp3`, { method: 'POST', body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) }); }
    catch { big = null; } // server may reset the socket mid-stream
    if (big) assert.equal(big.status, 413);
    const afterBig = (await (await fetch(base + '/api/library')).json()).soundscapes.length;
    assert.equal(afterBig, beforeBig, 'oversized upload not persisted');
  } finally {
    mod.server.close();
    mod.hub.stop();
    rmSync(state, { force: true });
    rmSync(upDir, { recursive: true, force: true });
  }
});
