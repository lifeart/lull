// Generate PNG app icons (iOS ignores SVG for apple-touch-icon / PWA icons). Zero deps: a tiny
// PNG encoder (RGBA, zlib) draws a speaker + sound-waves glyph on the app's dark background.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// Apple-style: a systemBlue tile (subtle top-to-bottom gradient) with a white glyph.
const BG_TOP = [10, 132, 255];
const BG_BOT = [0, 96, 214];
const GLYPH = [255, 255, 255];

const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function draw(S) {
  const buf = Buffer.alloc(S * S * 4);
  const put = (x, y, [r, g, b]) => { const i = (y * S + x) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // vertical gradient background
      let c = [
        Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * v),
        Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * v),
        Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * v),
      ];
      // speaker body
      if (u >= 0.26 && u <= 0.40 && Math.abs(v - 0.5) <= 0.07) c = GLYPH;
      // cone (widening trapezoid)
      if (u > 0.40 && u <= 0.58) { const hh = 0.06 + ((u - 0.40) / 0.18) * (0.20 - 0.06); if (Math.abs(v - 0.5) <= hh) c = GLYPH; }
      // sound waves (two arcs to the right)
      const dx = u - 0.42, dy = v - 0.5;
      const dist = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      if (u > 0.5 && Math.abs(ang) < 0.72) { for (const rr of [0.30, 0.40]) if (Math.abs(dist - rr) < 0.026) c = GLYPH; }
      put(x, y, c);
    }
  }
  return encodePng(S, S, buf);
}

export async function generateIcons(outDir = WEB_DIR) {
  await mkdir(outDir, { recursive: true });
  for (const size of [180, 512]) {
    await writeFile(path.join(outDir, `icon-${size}.png`), draw(size));
    console.log(`[icon] icon-${size}.png`);
  }
}

// Run standalone: node pipeline/icon.js
if (import.meta.url === `file://${process.argv[1]}`) {
  generateIcons().catch((err) => { console.error('[icon] failed:', err); process.exit(1); });
}
