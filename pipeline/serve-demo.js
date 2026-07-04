// Serve the built demo (_site) over plain HTTP for local viewing — `npm run serve:demo`.
// Builds _site first if it's missing. Correct MIME for ES modules + WAV; reads the file BEFORE
// sending headers (so a missing file 404s cleanly instead of crashing); never dies on a bad request.
//
// Run: npm run serve:demo   [PORT=8080]   then open http://localhost:<PORT>/  (intro, /live/, /rtc/)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, '_site');
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.css': 'text/css',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

if (!existsSync(path.join(SITE, 'index.html'))) {
  console.log('[serve] _site not found — building it (npm run build:demo)…');
  execSync('node pipeline/build-demo.js', { cwd: ROOT, stdio: 'inherit' });
}

http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    let file = path.join(SITE, p);
    if (!file.startsWith(SITE)) { res.writeHead(403).end('forbidden'); return; } // path-traversal guard
    try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { /* handled below */ }
    const body = await readFile(file); // read BEFORE headers → a missing file 404s cleanly, no crash
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => console.log(`[serve] demo live → http://localhost:${PORT}/  (intro · /live/ · /rtc/)`));

process.on('uncaughtException', (e) => console.error('[serve] non-fatal:', e.message)); // keep serving
