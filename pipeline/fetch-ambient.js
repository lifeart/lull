// Auto-download-once curated ambient loops into the sound library. See docs/RESEARCH-AMBIENT-SOUNDS.md.
//
// SCAFFOLD + HUMAN LICENSE GATE. Every entry in pipeline/ambient-sources.json ships "cleared": false;
// this script SKIPS uncleared entries. A human must verify each source's license (CC0/PD, or an
// accepted CC-BY with attribution) and fill in the real direct `url` + `sha256` before flipping an
// entry to true. NC / ND / BY-SA are refused by the ingest filter below.
//
// Pipeline per cleared item (requires ffmpeg on PATH; if absent, ambient is skipped and the
// synthesized noise library is unaffected):
//   download → verify sha256 → decode + EBU-R128 loudnorm (-23 LUFS) + trim
//   → equal-power crossfade seamless loop (mirrors bake.js) → transcode to AAC .m4a + MP3 fallback
//   → upsert web/player/assets/ambient/ambient.json → record credits + state. Idempotent, never fatal.
//
// Usage: node pipeline/fetch-ambient.js   (run AFTER `npm run bake`; writes a SEPARATE manifest so
// bake never clobbers ambient). Output is loaded by hub/server.js libraryJson().

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'pipeline', 'ambient-sources.json');
const OUT_DIR = path.join(ROOT, 'web', 'player', 'assets', 'ambient');
const MANIFEST = path.join(OUT_DIR, 'ambient.json');
const CREDITS = path.join(ROOT, 'web', 'player', 'assets', 'CREDITS.json');
const STATE = path.join(OUT_DIR, '.fetch-state.json');
const SR = 44100;

const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const forbidden = (lic) => /(-nc|noncommercial|-nd|noderiv|-sa|sharealike)/i.test(String(lic || ''));

function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// Decode compressed audio → mono float32 @44.1k, loudness-normalized (single-pass loudnorm; two-pass
// is more accurate — a future refinement), trimmed to `seconds`. Reads from stdin, writes raw f32 stdout.
function decodeNormalized(inputBuf, seconds) {
  const out = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-t', String(seconds), '-ac', '1', '-ar', String(SR),
    '-af', 'loudnorm=I=-23:TP=-1.5:LRA=11',
    '-f', 'f32le', 'pipe:1',
  ], { input: inputBuf, maxBuffer: 512 * 1024 * 1024 });
  return new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4));
}
// Equal-power crossfade of the tail into the head → seamless <audio loop> (mirrors bake.js seamlessLoop).
function crossfadeLoop(samples, loopN, cfN) {
  if (samples.length < loopN + cfN) throw new Error(`source too short (${samples.length} < ${loopN + cfN})`);
  const out = new Float32Array(loopN);
  for (let i = 0; i < loopN; i++) out[i] = samples[i];
  for (let i = 0; i < cfN; i++) {
    const t = i / cfN;
    out[i] = samples[i] * Math.sqrt(t) + samples[loopN + i] * Math.sqrt(1 - t);
  }
  return out;
}
function encodeWav(f32) {
  const n = f32.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE((Math.max(-1, Math.min(1, f32[i])) * 32767) | 0, 44 + i * 2);
  return buf;
}
function transcode(wavBuf, outPath, args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', ...args, outPath],
    { input: wavBuf, maxBuffer: 512 * 1024 * 1024 });
}

async function main() {
  const sources = readJson(SOURCES, { items: [] }).items || [];
  const cleared = sources.filter((s) => s.cleared === true);
  const pending = sources.filter((s) => s.cleared !== true);

  if (!cleared.length) {
    console.log(`[ambient] 0 cleared, ${pending.length} pending human license review — nothing to fetch.`);
    console.log('[ambient] Verify a source\'s license + fill in url/sha256, set "cleared": true in');
    console.log('[ambient] pipeline/ambient-sources.json, then re-run. See docs/RESEARCH-AMBIENT-SOUNDS.md §8.');
    return;
  }
  if (!haveFfmpeg()) {
    console.warn('[ambient] ffmpeg not found on PATH — skipping ambient bake. The synthesized noise');
    console.warn('[ambient] library is unaffected. Install ffmpeg to enable downloaded ambient loops.');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const state = readJson(STATE, {});
  const manifest = readJson(MANIFEST, { soundscapes: [] });
  const credits = readJson(CREDITS, { items: [] });
  const byId = (arr, id) => arr.findIndex((x) => x.id === id);
  let built = 0;

  for (const item of cleared) {
    try {
      if (forbidden(item.license)) { console.warn(`[ambient] refusing ${item.id}: license '${item.license}' (NC/ND/SA)`); continue; }
      const outM4a = path.join(OUT_DIR, `${item.id}.m4a`);
      if (existsSync(outM4a) && state[item.id] === item.sha256) { continue; } // idempotent: already built

      console.log(`[ambient] fetching ${item.id} …`);
      const raw = await download(item.url);
      if (item.sha256 && !/^TODO/i.test(item.sha256) && sha256(raw) !== item.sha256) {
        console.warn(`[ambient] SKIP ${item.id}: sha256 mismatch (got ${sha256(raw).slice(0, 12)}…) — refusing unverified bytes`);
        continue;
      }
      const loopN = Math.round((item.loopSec || 60) * SR);
      const cfN = Math.round((item.crossfadeSec || 2) * SR);
      const decoded = decodeNormalized(raw, (item.loopSec || 60) + (item.crossfadeSec || 2));
      const loop = crossfadeLoop(decoded, loopN, cfN);
      const wav = encodeWav(loop);
      transcode(wav, outM4a, ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']);
      transcode(wav, path.join(OUT_DIR, `${item.id}.mp3`), ['-c:a', 'libmp3lame', '-b:a', '128k']);

      // Upsert manifest (m4a first — Apple-preferred — with mp3 fallback).
      const entry = { id: item.id, label: item.label, files: [`${item.id}.m4a`, `${item.id}.mp3`], durationSec: item.loopSec || 60, kind: 'ambient' };
      const mi = byId(manifest.soundscapes, item.id);
      if (mi >= 0) manifest.soundscapes[mi] = entry; else manifest.soundscapes.push(entry);

      // Record attribution for CC-BY items (CC0/PD may be listed as courtesy).
      if (item.attribution) {
        const cr = { id: item.id, label: item.label, license: item.license, attribution: item.attribution, source: item.sourceUrl };
        const ci = byId(credits.items, item.id);
        if (ci >= 0) credits.items[ci] = cr; else credits.items.push(cr);
      }
      state[item.id] = item.sha256;
      built++;
      console.log(`[ambient] ✓ ${item.id} (${item.license})`);
    } catch (err) {
      console.warn(`[ambient] ${item.id} failed (non-fatal): ${err.message}`);
    }
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  if (credits.items.length) writeFileSync(CREDITS, JSON.stringify(credits, null, 2));
  console.log(`[ambient] done — ${built} built, ${manifest.soundscapes.length} in the ambient library.`);
}

// Never fatal: a failed fetch must never block a build or the hub.
main().catch((err) => { console.warn('[ambient] fetch-ambient failed (non-fatal):', err.message); });
