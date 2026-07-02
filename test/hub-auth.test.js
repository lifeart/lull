// Token-gated mutating endpoints (finding: the MP_TOKEN 401 branch was untested).
// Runs in its own process (node --test uses process isolation) so server.js reads MP_TOKEN fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

test('mutating endpoints require the token when MP_TOKEN is set', async () => {
  process.env.PORT = '8184';
  process.env.HOST = '127.0.0.1';
  process.env.MP_TOKEN = 'sekret';
  const state = path.join(os.tmpdir(), `mp-auth-state-${Date.now()}.json`);
  const upDir = path.join(os.tmpdir(), `mp-auth-up-${Date.now()}`);
  process.env.STATE_FILE = state;
  process.env.UPLOADS_DIR = upDir;
  const mod = await import('../hub/server.js');
  try {
    await new Promise((r) => setTimeout(r, 300));
    const base = 'http://127.0.0.1:8184';
    const endpoints = [
      '/api/library/order?ids=white',
      '/api/upload?name=x&ext=mp3',
      '/api/upload/rename?id=up-x&name=y',
      '/api/upload/delete?id=up-x',
    ];
    for (const ep of endpoints) {
      const noTok = await fetch(base + ep, { method: 'POST', body: Buffer.from('x') });
      assert.equal(noTok.status, 401, `no token → 401 for ${ep}`);
      const wrong = await fetch(base + ep + '&token=nope', { method: 'POST', body: Buffer.from('x') });
      assert.equal(wrong.status, 401, `wrong token → 401 for ${ep}`);
    }
    // correct token is accepted
    const ok = await fetch(`${base}/api/library/order?ids=white&token=sekret`, { method: 'POST' });
    assert.equal(ok.status, 200);
  } finally {
    mod.server.close();
    mod.hub.stop();
    rmSync(state, { force: true });
    rmSync(upDir, { recursive: true, force: true });
  }
});
