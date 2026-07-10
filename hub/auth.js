// WebSocket handshake auth — pure + side-effect-free so it's unit-testable without booting a server.
//
// Two layers: (1) Origin allowlist stops browser cross-site WebSocket hijacking; (2) an optional
// shared-secret token (?token=…) is the ONLY thing that stops non-browser clients on the LAN/tailnet.

import crypto from 'node:crypto';
import { DEFAULT_GROUP } from '../shared/protocol.js';

export function buildAllowedOrigins({ port, domain, extra } = {}) {
  return new Set(
    [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      ...(domain ? [`https://${domain}`] : []),
      ...(extra ? extra.split(',').map((s) => s.trim()) : []),
    ].filter(Boolean)
  );
}

export function originAllowed(origin, allowed) {
  if (!origin) return true; // native client / test: no browser Origin header to forge
  return allowed.has(origin);
}

// Same-origin: the request's Origin host:port equals the Host it's connecting to. This is always a
// legitimate first-party request (a cross-site attacker's page carries ITS OWN Origin, which won't
// match the hub's Host), so it's safe to allow — and it lets a self-hosted hub reached by LAN IP or
// NAS hostname (e.g. http://synology:8080) work with no MP_ORIGIN config. A reverse proxy that
// preserves the Host header (Caddy/DSM default) is covered too; MP_DOMAIN/MP_ORIGIN remain for
// proxies that rewrite Host.
export function sameHost(origin, hostHeader) {
  if (!origin || !hostHeader) return false;
  try { return new URL(origin).host === hostHeader; } catch { return false; }
}

export function tokenFromUrl(url) {
  try { return new URL(url, 'http://x').searchParams.get('token') || ''; } catch { return ''; }
}

export function tokenMatches(url, token) {
  if (!token) return true; // dev: no token configured
  const t = tokenFromUrl(url);
  const a = Buffer.from(t);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b); // constant-time, length-guarded
}

// Multi-tenancy (TOFU): derive a stable, filesystem-safe, non-guessable group id from a token.
// Same token → same group; a different token → a fully isolated group, with no server-side
// registry. This is a partition key, NOT the secret: possessing the id doesn't grant access, you
// still need the token itself. Truncated SHA-256 (80 bits) is collision-safe for a home hub and
// keeps the id short enough to name an on-disk uploads dir.
export function hashGroup(token) {
  return 'g' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 20);
}

// Resolve which group a connection belongs to, from its token. This is the ONE place group
// membership is decided, and it depends only on the (authenticated) token — never on client-
// supplied data — so a client can only ever act inside the group its token grants.
//   multiGroup  : TOFU mode — any non-empty token is its own group.
//   token       : the configured MP_TOKEN. In single-group mode it's the access gate; in multi-group
//                 mode it's ALSO honored — a client presenting exactly this token stays on the shared
//                 DEFAULT_GROUP, so an existing single-token deployment keeps its devices + uploads
//                 when the flag is flipped on. Every other token is its own isolated group.
//   allowTokenless: may a tokenless client join the shared DEFAULT_GROUP? (loopback / MP_ALLOW_OPEN)
// Returns { ok:true, groupId } or { ok:false, code, reason }.
export function resolveGroup(url, { multiGroup = false, token = '', allowTokenless = false } = {}) {
  if (multiGroup) {
    const t = tokenFromUrl(url);
    // Migration continuity: the configured MP_TOKEN keeps mapping to DEFAULT_GROUP (constant-time
    // compare) so its devices + uploads carry over. A brand-new/different token → its own group.
    if (token && tokenMatches(url, token)) return { ok: true, groupId: DEFAULT_GROUP };
    if (t) return { ok: true, groupId: hashGroup(t) };
    if (allowTokenless) return { ok: true, groupId: DEFAULT_GROUP };
    return { ok: false, code: 401, reason: 'token required' };
  }
  if (!tokenMatches(url, token)) return { ok: false, code: 401, reason: 'unauthorized' };
  return { ok: true, groupId: DEFAULT_GROUP };
}

export function makeVerifyClient({ allowed, token, multiGroup = false, allowTokenless = false }) {
  return function verifyClient(info, done) {
    const host = info.req && info.req.headers ? info.req.headers.host : undefined;
    if (info.origin && !allowed.has(info.origin) && !sameHost(info.origin, host)) {
      return done(false, 403, 'forbidden origin');
    }
    const g = resolveGroup(info.req.url, { multiGroup, token, allowTokenless });
    if (!g.ok) return done(false, g.code, g.reason);
    info.req._groupId = g.groupId; // stash the resolved group; the ws layer reads it in handleConnection
    return done(true);
  };
}
