// Bake seamless, loop-safe ambient loops on the hub — zero external tools (no ffmpeg needed).
//
// The background-survivable audio path on iOS is a plain <audio> element (raw Web Audio dies on
// screen lock), and <audio loop> has an audible seam at the loop point. We hide it with an
// equal-power crossfade of the tail into the head so power is continuous across the wrap
// (docs/DESIGN.md §1.3). Levels are matched across textures by ITU-R BS.1770 integrated loudness
// (not peak), so switching sounds doesn't jump in perceived volume — and every option stays inside
// a predictable level envelope (see docs/RESEARCH-SOUND-SCIENCE.md §5).
//
// The textures are decomposed BED + TRANSIENTS + HISS, each an independently slow-modulated layer
// (Farnell, Designing Sound) — the biggest realism lever. All synthesis is plain-JS biquads /
// state-variable filters / modal resonators in one per-sample loop; no native DSP libs.
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
const LOOP_SEC = Number(args.seconds || 30);
const CF_SEC = Number(args.crossfade || 1.0);
// Loudness matching. LUFS_TARGET is an internal reference — its absolute value is arbitrary for a
// nursery (real SPL depends on the device + distance + volume); the point is ONE target so all
// textures match perceptually. PEAK_CEIL keeps the max sample near the old peak level so the app's
// GAIN_DEFAULT still maps to the same quiet-nursery loudness, and leaves transcode headroom.
const LUFS_TARGET = -16;
const PEAK_CEIL = 0.8;

const rnd = () => Math.random() * 2 - 1; // white sample in [-1,1]

// --- reusable DSP primitives -------------------------------------------------------------------

// RBJ biquad (audio-EQ-cookbook). Returns a stateful process(x). Types: bp (constant 0 dB peak),
// lp, hp, highshelf (gainDb). Fixed coefficients — use makeSVF for swept cutoffs.
function biquad(type, f0, Q, gainDb = 0) {
  const w0 = (2 * Math.PI * f0) / SR, c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * Q);
  const A = Math.pow(10, gainDb / 40), sq = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;
  if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; }
  else if (type === 'highshelf') {
    b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
    a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq;
  } else throw new Error('biquad type ' + type);
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b2 / a0, na1 = a1 / a0, na2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

// Chamberlin state-variable filter — cheap per-sample cutoff/damping modulation (for wind/ocean
// sweeps). Returns process(x, fc, damp) → band-pass output; damp = 1/Q. Stable for fc < ~SR/6.
function makeSVF() {
  let low = 0, band = 0;
  return (x, fc, damp) => {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR * 0.24)) / SR);
    low += f * band;
    const high = x - low - damp * band;
    band += f * high;
    return band;
  };
}

// Poisson event start-samples over [0,n): exponential inter-arrival gaps at ratePerSec.
function poissonEvents(n, ratePerSec) {
  const evs = [], mean = SR / ratePerSec;
  let t = 0;
  while (t < n) { t += -Math.log(1 - Math.random()) * mean; if (t < n) evs.push(Math.floor(t)); }
  return evs;
}

// Add one transient "splat": a short noise burst shaped by a LOW-Q band-pass and an exponential
// decay. Broadband (not a ringing tone) — the right primitive for a raindrop impact or a fire pop.
// (A high-Q resonator here would ring like an electronic "plink", which is NOT how rain sounds.)
function addSplat(out, start, centerHz, decaySec, amp) {
  const bp = biquad('bp', centerHz, 0.9); // low Q → broadband splat, not a pitched blip
  const life = Math.min(out.length - start, Math.ceil(decaySec * SR * 4)), tau = decaySec * SR;
  for (let k = 0; k < life; k++) {
    const idx = start + k; if (idx >= out.length) break;
    out[idx] += bp(rnd()) * Math.exp(-k / tau) * amp;
  }
}

// --- noise generators (mono float, level arbitrary — loudness is matched later) -----------------
function white(n) { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = rnd(); return out; }
function pink(n) {
  // Paul Kellet's economical pink filter (−3 dB/oct, accurate to ±0.05 dB).
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}
function brown(n) { // leaky integrator (−6 dB/oct)
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last = (last + 0.02 * rnd()) / 1.02; out[i] = last * 3.5; }
  return out;
}

// --- procedural ambient textures (our own synthesis — no license, works fully offline) ----------
// Periodic modulation uses (i % loopN) so whole cycles fit the loop → seamless across the wrap.

function rain(n, loopN) { // dense filtered-noise WASH (the roar) + broadband splats (the patter)
  const out = new Float32Array(n);
  // Two shaped-noise beds: a mid "roar" (the mass of rain) and a high "hiss" (fine spray), each
  // slowly swelling so intensity waves like real rain. Whole-cycle LFOs → seamless loop.
  const roarHP = biquad('hp', 300, 0.7), roarLP = biquad('lp', 2600, 0.7);
  const hissHP = biquad('hp', 3200, 0.7), hissLP = biquad('lp', 9000, 0.7);
  for (let i = 0; i < n; i++) {
    const p = (i % loopN) / loopN;
    const roarMod = 0.7 + 0.3 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 3 * p));         // 3 whole cycles
    const hissMod = 0.7 + 0.3 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 5 * p + 1.7));   // 5 cycles, decorrelated
    out[i] = roarLP(roarHP(rnd())) * roarMod * 1.3 + hissLP(hissHP(rnd())) * hissMod * 0.5;
  }
  // Dense fine drops (a patter, blending into the wash) + sparse closer, heavier drops.
  for (const ev of poissonEvents(n, 260)) addSplat(out, ev, 1500 + Math.random() * 4000, 0.003 + Math.random() * 0.005, 0.05 + Math.random() * 0.10);
  for (const ev of poissonEvents(n, 7)) addSplat(out, ev, 500 + Math.random() * 1200, 0.012 + Math.random() * 0.02, 0.16 + Math.random() * 0.18);
  return out;
}
function ocean(n, loopN) { // three whole-cycle swells (seamless) + asymmetric crest wash (§4)
  const out = new Float32Array(n);
  const crestLP = biquad('lp', 4000, 0.7), cyc = [2, 3, 5];
  const atk = 1 - Math.exp(-1 / (0.3 * SR)), rel = 1 - Math.exp(-1 / (3 * SR));
  let brownState = 0, lp = 0, crest = 0;
  for (let i = 0; i < n; i++) {
    const p = (i % loopN) / loopN;
    let swell = 0; for (const cc of cyc) swell += 0.5 - 0.5 * Math.cos(2 * Math.PI * cc * p);
    swell /= cyc.length; // 0..~1, troughs at both loop ends → seamless
    brownState = (brownState + 0.02 * rnd()) / 1.02;
    const cut = 0.02 + 0.10 * swell;
    lp = lp * (1 - cut) + brownState * 3.5 * cut; // brown bed, cutoff opens on the swell
    const target = swell > 0.7 ? (swell - 0.7) * 3.3 : 0; // wave breaking on the crest
    crest += (target - crest) * (target > crest ? atk : rel); // fast attack, slow release
    out[i] = lp * (0.3 + 0.7 * swell) + crestLP(rnd()) * crest * 0.45;
  }
  return out;
}
function wind(n, loopN) { // parallel resonant band-passes + windspeed LFO + stochastic gusts (§4)
  const out = new Float32Array(n);
  const r1 = makeSVF(), r2 = makeSVF(), r3 = makeSVF();
  let gustLp = 0;
  for (let i = 0; i < n; i++) {
    const p = (i % loopN) / loopN;
    const speed = 0.4 + 0.6 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * p)); // 2 whole cycles → seamless
    gustLp = gustLp * 0.9997 + rnd() * 0.0003; // slow random gusts
    const gust = Math.max(0, Math.min(1, 0.5 + gustLp * 9));
    const cmod = 1 + 0.4 * (gust - 0.5); // gusts nudge resonance centers ±
    const src = rnd(), amp = speed * (0.35 + 0.65 * gust);
    const b1 = r1(src, 200 * cmod, 0.05), b2 = r2(src, 400 * cmod, 0.05), b3 = r3(src, 800 * cmod, 0.9);
    out[i] = (b1 * 1.0 + b2 * 0.8 + b3 * 0.35) * amp;
  }
  return out;
}
function fire(n) { // lapping bed (soft-clipped) + Poisson crackle + breathing hiss (§4)
  const out = new Float32Array(n);
  const bedBP = biquad('bp', 30, 5), bedHP = biquad('hp', 25, 0.7), hissHP = biquad('hp', 1000, 0.7);
  let hissEnv = 0.3;
  for (let i = 0; i < n; i++) {
    let bed = bedHP(bedBP(rnd()) * 12);
    bed = Math.tanh(bed * 1.5) * 0.55;                                  // harmonic warmth on small speakers
    const breath = 0.3 + 0.7 * Math.abs(Math.sin((2 * Math.PI * i) / SR)); // ~1 Hz breathing
    hissEnv += (breath - hissEnv) * 0.0002;
    out[i] = bed + hissHP(rnd()) * hissEnv * 0.14;
  }
  for (const ev of poissonEvents(n, 32)) // crackle: short broadband pops, amplitude jittered
    addSplat(out, ev, 1200 + Math.random() * 1400, 0.005 + Math.random() * 0.012, 0.08 + Math.random() * 0.32);
  return out;
}
function fan(n, loopN) { // low-passed motor rumble + faint blade-pass tone + comb slap (§4)
  const out = new Float32Array(n);
  const bladeHz = 80, combDelay = Math.round(SR / bladeHz), hist = new Float32Array(combDelay); // 80 Hz → 2400 whole cycles
  let brownState = 0, lp = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    brownState = (brownState + 0.02 * rnd()) / 1.02;
    lp = lp * 0.93 + brownState * 3.5 * 0.07;
    const ph = (2 * Math.PI * bladeHz * (i % loopN)) / SR;
    const s = lp + Math.sin(ph) * 0.06 + Math.sin(2 * ph) * 0.02;
    const delayed = hist[hi]; hist[hi] = s; hi = (hi + 1) % combDelay;
    out[i] = s * 0.85 + delayed * 0.15;
  }
  return out;
}
function heartbeat(n) { // maternal resting ~60 BPM lub-dub (the audible in-utero pulse, not fetal)
  const out = new Float32Array(n);
  const beat = SR; // 60 BPM = SR samples/beat; divides a whole-second loop → seamless
  const env = (pos, k, wdt) => Math.exp(-((pos - k) * (pos - k)) / (2 * wdt * wdt));
  for (let i = 0; i < n; i++) {
    const pos = i % beat, lub = env(pos, 0.06 * SR, 0.02 * SR), dub = env(pos, 0.34 * SR, 0.025 * SR);
    const tone = Math.sin((2 * Math.PI * 58 * i) / SR) * 0.7 + Math.sin((2 * Math.PI * 40 * i) / SR) * 0.3;
    out[i] = tone * (lub * 0.95 + dub * 0.6);
  }
  return out;
}
function womb(n, loopN) { // brown, steeply low-passed to the measured uterine spectrum + whoosh (§3,§4)
  const out = new Float32Array(n);
  const hb = heartbeat(n);
  const lp1 = biquad('lp', 500, 0.7), lp2 = biquad('lp', 500, 0.7); // ~24 dB/oct above ~500 Hz
  let brownState = 0;
  for (let i = 0; i < n; i++) {
    brownState = (brownState + 0.02 * rnd()) / 1.02;
    let base = lp2(lp1(brownState * 3.5));
    const whoosh = 0.5 - 0.5 * Math.cos((2 * Math.PI * 33 * (i % loopN)) / loopN); // ~66 BPM blood-flow, 33 whole cycles
    base *= 0.55 + 0.45 * whoosh;
    out[i] = base * 1.4 + hb[i] * 0.15; // heartbeat subtle, ~−16 dB under the bed
  }
  return out;
}

// --- loudness measurement (ITU-R BS.1770 / EBU R128, mono, gated) -------------------------------
function integratedLUFS(x) {
  const s1 = biquad('highshelf', 1500, 0.7071, 4), s2 = biquad('hp', 38, 0.5); // K-weighting
  const z = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { const y = s2(s1(x[i])); z[i] = y * y; }
  const block = Math.round(0.4 * SR), step = Math.round(0.1 * SR), blocks = [];
  for (let start = 0; start + block <= z.length; start += step) {
    let s = 0; for (let i = 0; i < block; i++) s += z[start + i];
    blocks.push(s / block);
  }
  if (!blocks.length) { let s = 0; for (let i = 0; i < z.length; i++) s += z[i]; blocks.push(s / z.length); }
  const L = (ms) => -0.691 + 10 * Math.log10(ms + 1e-12);
  let kept = blocks.filter((ms) => L(ms) >= -70); if (!kept.length) kept = blocks;         // absolute gate
  const rel = L(kept.reduce((a, b) => a + b, 0) / kept.length) - 10;                        // relative gate −10 LU
  let kept2 = kept.filter((ms) => L(ms) >= rel); if (!kept2.length) kept2 = kept;
  return L(kept2.reduce((a, b) => a + b, 0) / kept2.length);
}

// Make an equal-power seamless loop, high-passed below hearing, level-matched to LUFS_TARGET with a
// peak ceiling. gen receives loopN so periodic modulation aligns to the loop for a seamless wrap.
function seamlessLoop(gen, loopN, cfN) {
  const raw = gen(loopN + cfN, loopN);
  const hp = biquad('hp', 22, 0.7); // drop inaudible sub-bass that would only eat headroom
  for (let i = 0; i < raw.length; i++) raw[i] = hp(raw[i]);
  const out = new Float32Array(loopN);
  for (let i = 0; i < loopN; i++) out[i] = raw[i];
  for (let i = 0; i < cfN; i++) { // equal-power (√) crossfade: correct for uncorrelated noise (−3 dB midpoint each side)
    const t = i / cfN;
    out[i] = raw[i] * Math.sqrt(t) + raw[loopN + i] * Math.sqrt(1 - t);
  }
  let scale = Math.pow(10, (LUFS_TARGET - integratedLUFS(out)) / 20);
  let peak = 0; for (let i = 0; i < loopN; i++) peak = Math.max(peak, Math.abs(out[i] * scale));
  if (peak > PEAK_CEIL) scale *= PEAK_CEIL / peak; // transient textures land under target rather than clip
  for (let i = 0; i < loopN; i++) out[i] *= scale;
  let fp = 0; for (let i = 0; i < loopN; i++) fp = Math.max(fp, Math.abs(out[i]));
  return { out, lufs: integratedLUFS(out), peak: fp };
}

function encodeWavPCM16(float32) {
  const n = float32.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const loopN = Math.round(LOOP_SEC * SR), cfN = Math.round(CF_SEC * SR);

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
    const { out, lufs, peak } = seamlessLoop(k.gen, loopN, cfN);
    const wav = encodeWavPCM16(out), file = `${k.id}.wav`;
    await writeFile(path.join(OUT_DIR, file), wav);
    const entry = { id: k.id, label: k.label, files: [file], durationSec: LOOP_SEC };
    if (k.kind) entry.kind = k.kind;
    soundscapes.push(entry);
    console.log(`[bake] ${file.padEnd(14)} ${lufs.toFixed(1)} LUFS  peak ${peak.toFixed(2)}  (${LOOP_SEC}s, ${(wav.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedSec: LOOP_SEC, sampleRate: SR, loudnessTargetLUFS: LUFS_TARGET, soundscapes }, null, 2)
  );
  console.log(`[bake] wrote manifest.json with ${soundscapes.length} soundscapes to ${OUT_DIR}`);
  await generateIcons();
}

main().catch((err) => {
  console.error('[bake] failed:', err);
  process.exit(1);
});
