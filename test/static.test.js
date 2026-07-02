// Static server: Range/206, suffix ranges, 416 boundaries, traversal + malformed rejection,
// and /shared routing (finding: static.js had no coverage).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, serveFileWithin } from '../hub/static.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = '/shared/protocol.js'; // a real served file with a stable size
const SIZE = statSync(path.join(ROOT, 'shared/protocol.js')).size;

let server, port;
before(async () => {
  server = http.createServer(async (req, res) => {
    const served = await serveStatic(req, res);
    if (!served) res.writeHead(404).end('nf');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

function req(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, len: Buffer.concat(chunks).length }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('no Range -> 200 full body', async () => {
  const r = await req(TARGET);
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers['content-length']), SIZE);
});

test('bytes=0-99 -> 206 first 100 bytes', async () => {
  const r = await req(TARGET, { Range: 'bytes=0-99' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 0-99/${SIZE}`);
  assert.equal(r.len, 100);
});

test('suffix bytes=-10 -> 206 last 10 bytes', async () => {
  const r = await req(TARGET, { Range: 'bytes=-10' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`);
  assert.equal(r.len, 10);
});

test('open-ended bytes=100- -> 206 to EOF', async () => {
  const r = await req(TARGET, { Range: 'bytes=100-' });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], `bytes 100-${SIZE - 1}/${SIZE}`);
  assert.equal(r.len, SIZE - 100);
});

test('bytes=- (unsatisfiable) -> 416', async () => {
  const r = await req(TARGET, { Range: 'bytes=-' });
  assert.equal(r.status, 416);
});

test('range past EOF -> 416', async () => {
  const r = await req(TARGET, { Range: `bytes=0-${SIZE + 50}` });
  assert.equal(r.status, 416);
});

test('path traversal -> 403', async () => {
  const r = await req('/../hub/server.js');
  assert.equal(r.status, 403);
});

test('malformed percent-encoding -> 403 (not 500)', async () => {
  const r = await req('/%');
  assert.equal(r.status, 403);
});

test('NUL byte -> 403', async () => {
  const r = await req('/%00');
  assert.equal(r.status, 403);
});

test('/shared/* routes to the shared dir', async () => {
  const r = await req('/shared/protocol.js');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /javascript/);
});

test('unknown path -> 404', async () => {
  const r = await req('/nope.xyz');
  assert.equal(r.status, 404);
});

test('serveFileWithin works with a RELATIVE baseDir (no false 403)', async () => {
  // Regression: a relative UPLOADS_DIR like "./data/uploads" used to 403 every file because
  // path.join normalized away the "./" and broke the containment check.
  const srv = http.createServer(async (rq, rs) => {
    const ok = await serveFileWithin(rq, rs, './shared', rq.url);
    if (!ok) rs.writeHead(404).end('nf');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = srv.address().port;
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: p, path: '/protocol.js' }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  srv.close();
  assert.equal(status, 200);
});
