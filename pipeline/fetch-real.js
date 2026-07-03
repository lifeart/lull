// Download human-verified CC0/Public-Domain field recordings and turn them into seamless, loudness-
// matched loops that OVERLAY the synthesized fallbacks (same soundscape id). Real recordings sound
// like the real thing where zero-dep synthesis has a ceiling (ocean/fire/wind); rain has no vetted
// CC0 source so it keeps the synthesized track.
//
// Provenance (all no-attribution): licenses verified on the source pages by a human review pass.
//   rain  — opengameart.org "AMB Rain Loop 2" (Kresiek The Furry)      — CC0-1.0
//   ocean — archive.org "ocean-sea-sounds" / "Gentle Ocean"            — CC0-1.0
//   fire  — opengameart.org "Fireplace Sound Loop" (PagDev)            — CC0-1.0
//   wind  — Wikimedia Commons "Vento_fisterra.ogg" (Escoitar.org)      — Public Domain
//
// The downloaded audio is NOT committed (redistribution) — it lands under web/player/assets/real/
// (gitignored) and is copied over the baked <id>.wav. `pipeline/bake.js` also re-applies this overlay
// at the end of a bake, so `npm run bake` keeps the real loops whenever real/ is present.
//
// Requires: curl + ffmpeg on PATH.  Run: npm run fetch:real

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'web', 'player', 'assets');
const REAL = path.join(ASSETS, 'real');
const TMP = path.join(ROOT, '.tmp-ambient');
const SR = 44100;

const SOURCES = [
  { id: 'rain', license: 'CC0-1.0', url: 'https://opengameart.org/sites/default/files/amb_rain2.ogg', start: 90, loopSec: 45, cfSec: 2.5 },
  { id: 'ocean', license: 'CC0-1.0', url: 'https://archive.org/download/ocean-sea-sounds/Gentle%20Ocean.mp3', start: 150, loopSec: 40, cfSec: 2.5 },
  { id: 'fire', license: 'CC0-1.0', url: 'https://opengameart.org/sites/default/files/fire.wav', start: 0, loopSec: 24, cfSec: 1.5 },
  { id: 'wind', license: 'PD', url: 'https://upload.wikimedia.org/wikipedia/commons/3/38/Vento_fisterra.ogg', start: 60, loopSec: 40, cfSec: 2.5 },
];

function readWavPcm16(file) {
  const b = readFileSync(file);
  let off = 12; // walk RIFF chunks to the 'data' chunk (ffmpeg may emit LIST/fact chunks first)
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.min(Math.floor(sz / 2), Math.floor((b.length - off - 8) / 2));
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return x;
    }
    off += 8 + sz + (sz & 1);
  }
  throw new Error('no data chunk in ' + file);
}
function encodeWavPCM16(x) {
  const n = x.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, x[i])); buf.writeInt16LE((s * 32767) | 0, 44 + i * 2); }
  return buf;
}
function crossfadeLoop(x, loopN, cfN) {
  if (x.length < loopN + cfN) throw new Error(`segment too short: ${x.length} < ${loopN + cfN}`);
  const out = new Float32Array(loopN);
  for (let i = 0; i < loopN; i++) out[i] = x[i];
  for (let i = 0; i < cfN; i++) { const t = i / cfN; out[i] = x[i] * Math.sqrt(t) + x[loopN + i] * Math.sqrt(1 - t); } // equal-power
  return out;
}

function have(cmd) { try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; } }

async function main() {
  if (!have('curl') || !have('ffmpeg')) { console.warn('[real] need curl + ffmpeg on PATH — skipping (synthesized loops stay in place).'); return; }
  mkdirSync(REAL, { recursive: true }); mkdirSync(TMP, { recursive: true });
  for (const s of SOURCES) {
    const src = path.join(TMP, `${s.id}.src`), seg = path.join(TMP, `${s.id}.seg.wav`);
    try {
      execSync(`curl -sL --fail --max-time 180 -o "${src}" "${s.url}"`, { stdio: ['ignore', 'ignore', 'inherit'] });
      const grab = s.loopSec + s.cfSec + 1; // a little extra so the crossfade always has tail samples
      execSync(`ffmpeg -y -ss ${s.start} -t ${grab} -i "${src}" -ac 1 -ar ${SR} -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a pcm_s16le "${seg}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
      const loop = crossfadeLoop(readWavPcm16(seg), Math.round(s.loopSec * SR), Math.round(s.cfSec * SR));
      const wav = encodeWavPCM16(loop);
      writeFileSync(path.join(REAL, `${s.id}.wav`), wav);
      copyFileSync(path.join(REAL, `${s.id}.wav`), path.join(ASSETS, `${s.id}.wav`)); // overlay now
      let peak = 0; for (let i = 0; i < loop.length; i++) peak = Math.max(peak, Math.abs(loop[i]));
      console.log(`[real] ${s.id.padEnd(6)} ${s.license.padEnd(8)} ${s.loopSec}s loop  peak ${peak.toFixed(2)}  sha ${createHash('sha256').update(wav).digest('hex').slice(0, 12)}  (${(wav.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      console.warn(`[real] ${s.id}: FAILED (${e.message.split('\n')[0]}) — keeping the synthesized loop.`);
    }
  }
  console.log('[real] done — real rain/ocean/fire/wind overlaid. (downloaded audio is gitignored)');
}

main().catch((e) => { console.error('[real] fatal:', e); process.exit(1); });
