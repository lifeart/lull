// Bake seamless, loop-safe noise files on the hub — zero external tools (no ffmpeg needed).
//
// The background-survivable audio path on iOS is a plain <audio> element (raw Web Audio dies
// on screen lock), and <audio loop> has an audible seam at the loop point. For stationary
// noise a seam is nearly inaudible, and we further hide it with an equal-power crossfade of
// the tail into the head so amplitude is continuous across the wrap. (docs/DESIGN.md §1.3)
//
// Usage: node pipeline/bake.js  [--seconds=30] [--crossfade=1.0]

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from './icon.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'web', 'player', 'assets');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const SR = 44100;
const AMP = 0.6; // headroom below full scale; playback gain scales further
const LOOP_SEC = Number(args.seconds || 30);
const CF_SEC = Number(args.crossfade || 1.0);

// --- noise generators (mono float in [-1,1]) ---
function white(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1;
  return out;
}
function pink(n) {
  // Paul Kellet's economical pink filter.
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}
function brown(n) {
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last * 3.5;
  }
  return out;
}

// Make an equal-power seamless loop of `loopN` samples from a generator.
function seamlessLoop(gen, loopN, cfN) {
  const raw = gen(loopN + cfN);
  const out = new Float32Array(loopN);
  for (let i = 0; i < loopN; i++) out[i] = raw[i];
  for (let i = 0; i < cfN; i++) {
    const t = i / cfN;
    const fadeIn = Math.sqrt(t);
    const fadeOut = Math.sqrt(1 - t);
    out[i] = raw[i] * fadeIn + raw[loopN + i] * fadeOut;
  }
  // normalize peak to AMP
  let peak = 0;
  for (let i = 0; i < loopN; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = peak > 0 ? AMP / peak : 1;
  for (let i = 0; i < loopN; i++) out[i] *= scale;
  return out;
}

function encodeWavPCM16(float32) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const loopN = Math.round(LOOP_SEC * SR);
  const cfN = Math.round(CF_SEC * SR);

  const kinds = [
    { id: 'white', label: 'White noise', gen: white },
    { id: 'pink', label: 'Pink noise', gen: pink },
    { id: 'brown', label: 'Brown noise', gen: brown },
  ];

  const soundscapes = [];
  for (const k of kinds) {
    const samples = seamlessLoop(k.gen, loopN, cfN);
    const wav = encodeWavPCM16(samples);
    const file = `${k.id}.wav`;
    await writeFile(path.join(OUT_DIR, file), wav);
    soundscapes.push({ id: k.id, label: k.label, files: [file], durationSec: LOOP_SEC });
    console.log(`[bake] ${file}  (${(wav.length / 1024 / 1024).toFixed(1)} MB, ${LOOP_SEC}s loop)`);
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedSec: LOOP_SEC, sampleRate: SR, soundscapes }, null, 2)
  );
  console.log(`[bake] wrote manifest.json with ${soundscapes.length} soundscapes to ${OUT_DIR}`);
  await generateIcons();
}

main().catch((err) => {
  console.error('[bake] failed:', err);
  process.exit(1);
});
