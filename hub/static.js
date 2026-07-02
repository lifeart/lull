// Minimal static file server with Range/206 support.
//
// Range matters: iOS media playback issues Range requests for <audio>. If the hub (or a
// service worker) answers a Range request with a plain 200, background audio can silently
// break. We always honor Range for media. (docs/DESIGN.md §4)

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const SHARED_DIR = path.join(REPO_ROOT, 'shared');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.caf': 'audio/x-caf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Resolve a URL path within a base dir, refusing traversal / malformed / NUL. Returns null on refuse.
function safeResolve(baseDir, relPath) {
  const base = path.resolve(baseDir); // absolute so containment is robust to a relative base
  let rel;
  try {
    rel = decodeURIComponent(relPath.split('?')[0]);
  } catch {
    return null; // malformed percent-encoding (e.g. "/%") -> 403, not a 500
  }
  if (rel.indexOf("\u0000") !== -1) return null; // reject NUL bytes explicitly
  const abs = path.normalize(path.join(base, rel));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null; // traversal
  return abs;
}

// Serve a file located UNDER baseDir (traversal-safe). Reused for web/, shared/, and uploads/.
export async function serveFileWithin(req, res, baseDir, relPath) {
  const abs = safeResolve(baseDir, relPath);
  if (!abs) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  let st;
  try {
    st = await stat(abs);
    if (st.isDirectory()) return serveFile(req, res, path.join(abs, 'index.html'));
  } catch {
    return false; // not found -> let caller 404
  }
  return serveFile(req, res, abs, st);
}

export async function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/shared/')) return serveFileWithin(req, res, SHARED_DIR, urlPath.slice('/shared'.length));
  return serveFileWithin(req, res, WEB_DIR, urlPath);
}

async function serveFile(req, res, abs, st) {
  if (!st) {
    try {
      st = await stat(abs);
    } catch {
      res.writeHead(404).end('not found');
      return true;
    }
  }
  const type = TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  const total = st.size;

  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache', // dev-friendly; production assets are content-hashed
  };

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start, end;
      if (m[1] === '') {
        // Suffix range "bytes=-N" -> the LAST N bytes (RFC 7233). iOS media does issue these.
        if (m[2] === '') {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
          return true;
        }
        start = Math.max(0, total - parseInt(m[2], 10));
        end = total - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return true;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      createReadStream(abs, { start, end }).pipe(res);
      return true;
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': total });
  createReadStream(abs).pipe(res);
  return true;
}
