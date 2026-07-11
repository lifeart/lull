// LTAS (long-term-average-spectrum) shape check for the synthesized loops. The July-2026 research
// prescribes a specific "distant airflow" shape for the new masker: steep attenuation below ~100 Hz,
// a gentle pink-ish downward tilt through the mids, and a steep roll-off above ~6 kHz. We assert that
// shape directly on the generator output so a future tweak that (say) drops the high-cut is caught.
//
// The generators are deterministic (bake.js seeds a fixed PRNG), so these ratios are stable run-to-run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airflow, SR } from '../pipeline/bake.js';

// Single-bin Goertzel power estimate (relative units) at frequency f for a real signal.
function power(x, f) {
  const w = (2 * Math.PI * f) / SR, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}
// Average power across a few probes so one noisy bin can't skew a band's estimate.
const band = (x, freqs) => freqs.reduce((a, f) => a + Math.max(0, power(x, f)), 0) / freqs.length;

test('airflow LTAS: steep <100 Hz + >6 kHz roll-off, gentle downward mid tilt (research §4 shape)', () => {
  const N = 2 * SR; // 2 s → ample spectral resolution; deterministic (seeded PRNG)
  const x = airflow(N, N);
  let sumSq = 0; for (let i = 0; i < N; i++) sumSq += x[i] * x[i];
  assert.ok(Math.sqrt(sumSq / N) > 0, 'produces a real, non-silent signal');

  const sub = band(x, [40, 50, 60]);          // below the ~100 Hz corner → steeply cut
  const lowMid = band(x, [400, 500, 600]);    // the masking body → strongest
  const upper = band(x, [1800, 2000, 2200]);  // present but tilted down
  const high = band(x, [9000, 10000, 11000]); // above the ~6 kHz corner → steeply cut

  assert.ok(sub < lowMid * 0.3, `sub-100 Hz steeply attenuated (sub/lowMid=${(sub / lowMid).toFixed(3)})`);
  assert.ok(high < upper * 0.3, `>6 kHz steeply attenuated (high/upper=${(high / upper).toFixed(3)})`);
  assert.ok(upper < lowMid * 0.6, `downward tilt through the mids (upper/lowMid=${(upper / lowMid).toFixed(3)})`);
});
