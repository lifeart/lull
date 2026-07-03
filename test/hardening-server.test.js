// Server-level hardening: CSRF Origin gating on the mutating /api routes, the enriched health
// endpoint, and the forget route. Own process (node --test isolation) so server.js reads env fresh.
// (audit findings #13, #19, #3)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

test('mutating /api routes reject a disallowed Origin (CSRF); health reports connectivity counts', async () => {
  process.env.PORT = '8187';
  process.env.HOST = '127.0.0.1'; // loopback → OPEN mode allowed without a token
  process.env.MP_DOMAIN = 'hub.test.example';
  delete process.env.MP_TOKEN;
  const state = path.join(os.tmpdir(), `mp-hard-state-${Date.now()}.json`);
  const upDir = path.join(os.tmpdir(), `mp-hard-up-${Date.now()}`);
  process.env.STATE_FILE = state;
  process.env.UPLOADS_DIR = upDir;
  const mod = await import('../hub/server.js');
  try {
    await new Promise((r) => setTimeout(r, 300));
    const base = 'http://127.0.0.1:8187';

    // A cross-origin page in the parent's browser must not be able to drive the hub.
    const evil = await fetch(`${base}/api/library/order?ids=white`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403, 'disallowed Origin → 403');

    // An allowed Origin passes.
    const good = await fetch(`${base}/api/library/order?ids=white`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:8187' } });
    assert.equal(good.status, 200, 'allowed Origin → 200');

    // A native client (no Origin header, e.g. the tests / curl) still passes.
    const native = await fetch(`${base}/api/library/order?ids=white`, { method: 'POST' });
    assert.equal(native.status, 200, 'no Origin → 200');

    // Forget is Origin-gated too, and 404s an unknown device.
    const forgetEvil = await fetch(`${base}/api/device/forget?id=nope`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(forgetEvil.status, 403);
    const forget404 = await fetch(`${base}/api/device/forget?id=nope`, { method: 'POST' });
    assert.equal(forget404.status, 404, 'unknown device → 404');

    // Health now exposes connectivity, not just a raw registration count.
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.persistHealthy, true);
    for (const k of ['total', 'online', 'offline']) assert.equal(typeof health[k], 'number', `health.${k} present`);
    assert.equal(health.online, 0);

    // Favorites: Origin-gated, reflected in /api/library, and pinned to the top.
    const favEvil = await fetch(`${base}/api/library/fav?id=pink&on=1`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(favEvil.status, 403, 'fav toggle is Origin-gated');
    const favOk = await fetch(`${base}/api/library/fav?id=pink&on=1`, { method: 'POST' });
    assert.equal(favOk.status, 200);
    const lib = await (await fetch(`${base}/api/library`)).json();
    const pink = lib.soundscapes.find((s) => s.id === 'pink');
    assert.ok(pink && pink.fav === true, 'favorited id carries fav:true');
    assert.equal(lib.soundscapes[0].id, 'pink', 'favorite is pinned first');
    // Un-favoriting clears the flag.
    await fetch(`${base}/api/library/fav?id=pink&on=0`, { method: 'POST' });
    const lib2 = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib2.soundscapes.find((s) => s.id === 'pink').fav, false);
    // Missing id → 400.
    assert.equal((await fetch(`${base}/api/library/fav?on=1`, { method: 'POST' })).status, 400);
  } finally {
    mod.server.close();
    mod.hub.stop();
    rmSync(state, { force: true });
    rmSync(upDir, { recursive: true, force: true });
  }
});
