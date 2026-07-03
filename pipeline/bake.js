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

// --- procedural ambient textures (zero-dep, license-free — our own synthesis) -------------------
// All are filtered/modulated noise. Absolute levels don't matter: seamlessLoop peak-normalizes.
// Periodic modulation uses (i % loopN) so whole cycles fit the loop → seamless across the wrap.

function rain(n) { // bright, high-passed hiss
  const out = new Float32Array(n);
  let x1 = 0, y1 = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    const hp = 0.72 * (y1 + w - x1); x1 = w; y1 = hp; // one-pole high-pass
    lp = lp * 0.4 + hp * 0.6;                          // shave the harshest top
    let s = lp;
    if (Math.random() < 0.0009) s += (Math.random() * 2 - 1) * 0.5; // sparse droplets
    out[i] = s * 0.7;
  }
  return out;
}
function ocean(n, loopN) { // low swell (brown, low-passed, amplitude-modulated)
  const out = new Float32Array(n);
  let last = 0, lp = 0;
  const cycles = 3;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    lp = lp * 0.86 + last * 0.14;
    const phase = ((i % loopN) / loopN) * cycles * 2 * Math.PI;
    const swell = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(phase));
    out[i] = lp * 3.5 * swell;
  }
  return out;
}
function wind(n, loopN) { // band-passed noise with a slow cutoff sweep
  const out = new Float32Array(n);
  let lp = 0, lp2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    const phase = ((i % loopN) / loopN) * 2 * Math.PI * 2;
    const cut = 0.02 + 0.03 * (0.5 - 0.5 * Math.cos(phase));
    lp = lp * (1 - cut) + w * cut;
    lp2 = lp2 * (1 - cut) + lp * cut;
    out[i] = lp2 * 6.5;
  }
  return out;
}
function fire(n) { // warm brown base + sparse crackle
  const out = new Float32Array(n);
  let last = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    lp = lp * 0.7 + last * 0.3;
    let s = lp * 2.5;
    if (Math.random() < 0.0007) s += (Math.random() * 2 - 1) * 0.9; // crackle pop
    out[i] = s;
  }
  return out;
}
function fan(n) { // steady low-passed drone
  const out = new Float32Array(n);
  let last = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    lp = lp * 0.93 + last * 0.07;
    out[i] = lp * 3.5;
  }
  return out;
}
function heartbeat(n, loopN) { // lub-dub at 60 BPM (1 beat/sec → aligns to whole seconds)
  const out = new Float32Array(n);
  const beat = SR; // 60 BPM = SR samples/beat; divides a whole-second loop → seamless
  const env = (pos, k, wdt) => Math.exp(-((pos - k) * (pos - k)) / (2 * wdt * wdt));
  for (let i = 0; i < n; i++) {
    const pos = i % beat;
    const lub = env(pos, 0.06 * SR, 0.02 * SR);
    const dub = env(pos, 0.34 * SR, 0.025 * SR);
    out[i] = Math.sin(2 * Math.PI * 58 * i / SR) * (lub * 0.95 + dub * 0.6);
  }
  return out;
}
function womb(n, loopN) { // muffled pink whoosh + subdued heartbeat (in-utero)
  const out = new Float32Array(n);
  const pk = pink(n), hb = heartbeat(n, loopN);
  let l = 0;
  for (let i = 0; i < n; i++) {
    l = l * 0.9 + pk[i] * 0.1; // heavy low-pass = muffled
    out[i] = l * 2.6 + hb[i] * 0.45;
  }
  return out;
}

// Make an equal-power seamless loop of `loopN` samples from a generator (gen receives loopN so
// any periodic modulation can align to the loop for a seamless wrap).
function seamlessLoop(gen, loopN, cfN) {
  const raw = gen(loopN + cfN, loopN);
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
    // Procedural ambient textures (our own synthesis — no license, works fully offline).
    { id: 'rain', label: 'Rain', gen: rain, kind: 'ambient' },
    { id: 'ocean', label: 'Ocean waves', gen: ocean, kind: 'ambient' },
    { id: 'wind', label: 'Wind', gen: wind, kind: 'ambient' },
    { id: 'fire', label: 'Fireplace', gen: fire, kind: 'ambient' },
    { id: 'fan', label: 'Fan', gen: fan, kind: 'ambient' },
    { id: 'womb', label: 'Womb', gen: womb, kind: 'ambient' },
    { id: 'heartbeat', label: 'Heartbeat', gen: heartbeat, kind: 'ambient' },
  ];

  const soundscapes = [];
  for (const k of kinds) {
    const samples = seamlessLoop(k.gen, loopN, cfN);
    const wav = encodeWavPCM16(samples);
    const file = `${k.id}.wav`;
    await writeFile(path.join(OUT_DIR, file), wav);
    const entry = { id: k.id, label: k.label, files: [file], durationSec: LOOP_SEC };
    if (k.kind) entry.kind = k.kind;
    soundscapes.push(entry);
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
