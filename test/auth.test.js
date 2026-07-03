// Auth handshake (finding: verifyClient/CSWSH + token had no test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllowedOrigins, originAllowed, tokenMatches, makeVerifyClient, sameHost } from '../hub/auth.js';

test('buildAllowedOrigins includes localhost, domain, and trimmed extras', () => {
  const a = buildAllowedOrigins({ port: 8080, domain: 'hub.example.com', extra: 'https://a.example, https://b.example' });
  assert.ok(a.has('http://localhost:8080'));
  assert.ok(a.has('http://127.0.0.1:8080'));
  assert.ok(a.has('https://hub.example.com'));
  assert.ok(a.has('https://a.example'));
  assert.ok(a.has('https://b.example')); // whitespace trimmed
});

test('originAllowed: missing origin ok (native), unknown rejected, known accepted', () => {
  const a = buildAllowedOrigins({ port: 8080 });
  assert.equal(originAllowed(undefined, a), true);
  assert.equal(originAllowed('http://evil.example', a), false);
  assert.equal(originAllowed('http://localhost:8080', a), true);
});

test('tokenMatches: unset allows, set requires exact (length-guarded, constant-time)', () => {
  assert.equal(tokenMatches('/ws', ''), true); // dev: no token configured
  assert.equal(tokenMatches('/ws?token=secret', 'secret'), true);
  assert.equal(tokenMatches('/ws?token=nope', 'secret'), false);
  assert.equal(tokenMatches('/ws', 'secret'), false); // missing token
  assert.equal(tokenMatches('/ws?token=sec', 'secret'), false); // length mismatch
});

test('makeVerifyClient covers all done() branches', () => {
  const allowed = buildAllowedOrigins({ port: 8080 });
  const vc = makeVerifyClient({ allowed, token: 'secret' });
  const call = (info) => { let out; vc(info, (...a) => { out = a; }); return out; };
  assert.deepEqual(call({ origin: 'http://evil', req: { url: '/ws?token=secret' } }), [false, 403, 'forbidden origin']);
  assert.deepEqual(call({ origin: 'http://localhost:8080', req: { url: '/ws' } }), [false, 401, 'unauthorized']);
  assert.deepEqual(call({ origin: 'http://localhost:8080', req: { url: '/ws?token=secret' } }), [true]);
  assert.deepEqual(call({ origin: undefined, req: { url: '/ws?token=secret' } }), [true]); // native + token
});

test('sameHost: first-party Origin (host==Host) matches; cross-site does not', () => {
  assert.equal(sameHost('http://192.168.1.50:8080', '192.168.1.50:8080'), true); // LAN IP self-host
  assert.equal(sameHost('http://synology:8080', 'synology:8080'), true);         // NAS hostname
  assert.equal(sameHost('https://hub.example', 'hub.example'), true);            // proxy preserving Host
  assert.equal(sameHost('http://evil.example', '192.168.1.50:8080'), false);     // cross-site attacker
  assert.equal(sameHost(undefined, '192.168.1.50:8080'), false);
  assert.equal(sameHost('http://x:8080', undefined), false);
});

test('verifyClient allows same-origin LAN/NAS access with no MP_ORIGIN, still blocks cross-site', () => {
  const allowed = buildAllowedOrigins({ port: 8080 }); // only localhost/127.0.0.1 — NOT the LAN IP
  const vc = makeVerifyClient({ allowed, token: '' });
  const call = (info) => { let out; vc(info, (...a) => { out = a; }); return out; };
  // Served at http://192.168.1.50:8080 → browser Origin == Host → allowed without config.
  assert.deepEqual(call({ origin: 'http://192.168.1.50:8080', req: { url: '/ws', headers: { host: '192.168.1.50:8080' } } }), [true]);
  // A malicious cross-site page (Origin != Host) is still rejected.
  assert.deepEqual(call({ origin: 'http://evil.example', req: { url: '/ws', headers: { host: '192.168.1.50:8080' } } }), [false, 403, 'forbidden origin']);
});

test('with no token configured, any allowed-origin client passes', () => {
  const allowed = buildAllowedOrigins({ port: 8080 });
  const vc = makeVerifyClient({ allowed, token: '' });
  let out; vc({ origin: 'http://localhost:8080', req: { url: '/ws' } }, (...a) => { out = a; });
  assert.deepEqual(out, [true]);
});
