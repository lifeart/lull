// WebSocket handshake auth — pure + side-effect-free so it's unit-testable without booting a server.
//
// Two layers: (1) Origin allowlist stops browser cross-site WebSocket hijacking; (2) an optional
// shared-secret token (?token=…) is the ONLY thing that stops non-browser clients on the LAN/tailnet.

import crypto from 'node:crypto';

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

export function tokenMatches(url, token) {
  if (!token) return true; // dev: no token configured
  let t = '';
  try { t = new URL(url, 'http://x').searchParams.get('token') || ''; } catch { return false; }
  const a = Buffer.from(t);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b); // constant-time, length-guarded
}

export function makeVerifyClient({ allowed, token }) {
  return function verifyClient(info, done) {
    const host = info.req && info.req.headers ? info.req.headers.host : undefined;
    if (info.origin && !allowed.has(info.origin) && !sameHost(info.origin, host)) {
      return done(false, 403, 'forbidden origin');
    }
    if (!tokenMatches(info.req.url, token)) return done(false, 401, 'unauthorized');
    return done(true);
  };
}
