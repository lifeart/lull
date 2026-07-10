// Unit tests for the audio ACTUATION layer (AudioEngine.applyDesired), which the seam/e2e
// tests don't cover. Uses injected fakes for the <audio> element and Web Audio graph so it runs
// in Node. (finding: tests-gaps — audio.js applyDesired had zero coverage)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../web/player/audio.js';
import { VERBS, STATES, TIERS, GAIN_SOFT_CAP } from '../shared/protocol.js';

function fakeEl() {
  return {
    paused: true,
    src: '',
    volume: 1,
    plays: 0,
    _listeners: {},
    addEventListener(k, fn) { (this._listeners[k] ||= []).push(fn); },
    async play() { this.paused = false; this.plays++; },
    pause() { this.paused = true; },
  };
}
function fakeGainParam() {
  return {
    value: 0, calls: [],
    cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; this.calls.push(['set', v]); },
    setTargetAtTime(v) { this.calls.push(['target', v]); },
    linearRampToValueAtTime(v) { this.value = v; this.calls.push(['linear', v]); },
    exponentialRampToValueAtTime(v) { this.value = v; this.calls.push(['exp', v]); },
    setValueCurveAtTime(curve, _start, dur) { const v = curve[curve.length - 1]; this.value = v; this.calls.push(['curve', v, dur]); },
  };
}
// Every gain-automation kind that ends on a value (a fade-in curve, a ramp, a target approach).
const rampValues = (gain) => gain.gain.calls.filter((c) => ['target', 'linear', 'exp', 'curve'].includes(c[0])).map((c) => c[1]);

// MODERN tier engine wired to fakes (bypasses arm()'s real Web Audio construction).
function modernEngine() {
  const eng = new AudioEngine({ tier: TIERS.MODERN, onState: () => {} });
  eng.el = fakeEl();
  eng.gain = { gain: fakeGainParam() };
  eng.ctx = { state: 'running', currentTime: 0, async resume() { this.state = 'running'; } };
  eng.armed = true;
  return eng;
}

function fakeBufferSrc() {
  return {
    buffer: null, loop: false, started: 0, stopped: 0, onended: null,
    connect() {}, start() { this.started++; }, stop() { this.stopped++; },
  };
}
// GRAPH+buffer engine: the gapless AudioBufferSourceNode path (MODERN, or any non-iOS platform).
// Bypasses arm()'s real Web Audio + decode; _buf is a stand-in for a decoded AudioBuffer.
function bufferEngine(tier = TIERS.MODERN, caps = { audioSession: true }) {
  const eng = new AudioEngine({ tier, caps, onState: () => {} });
  eng.el = fakeEl();
  eng.gain = { gain: fakeGainParam() };
  eng.ctx = {
    state: 'running', currentTime: 0, async resume() { this.state = 'running'; },
    createBufferSource() { return fakeBufferSrc(); },
  };
  eng.useBuffer = true;
  eng._buf = { duration: 30 }; // truthy stand-in for a decoded buffer
  eng.currentSoundscape = 'white'; // so a same-sound START doesn't trigger a (real) decode swap
  eng.armed = true;
  return eng;
}

test('MODERN: START plays the element, ramps gain up, reports PLAYING', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.el.paused, false);
  assert.equal(eng.getState(), STATES.PLAYING);
  assert.equal(eng.getGain(), 0.3);
  const ramps = rampValues(eng.gain);
  assert.ok(ramps.length > 0, 'gain ramps up (fade-in)');
  assert.ok(Math.abs(Math.max(...ramps) - 0.3) < 1e-6, 'ramps to the requested gain, not a fixed value');
});

test('start-from-silence fades in over ~3s; a volume nudge while playing does NOT', async () => {
  const eng = modernEngine();
  // From silence → a fade-in CURVE (the shock-free swell) over 3s, landing on the target.
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  const fadeIn = eng.gain.gain.calls.find((c) => c[0] === 'curve');
  assert.ok(fadeIn, 'start from silence uses a fade-in curve');
  assert.ok(Math.abs(fadeIn[1] - 0.3) < 1e-6, 'fade-in lands on the requested gain');
  assert.equal(fadeIn[2], 3, 'over ~3 seconds');

  // A volume change WHILE playing must stay responsive: a quick ramp, NOT another 3s fade-in.
  eng.gain.gain.calls.length = 0;
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.5, soundscape: 'white' });
  assert.ok(!eng.gain.gain.calls.some((c) => c[0] === 'curve'), 'no 3s fade-in on a mid-playback volume nudge');
  assert.ok(eng.gain.gain.calls.some((c) => c[0] === 'target'), 'uses the quick click-free ramp instead');
  assert.equal(eng.getGain(), 0.5);
});

test('MODERN: STOP ramps gain to ~0 but keeps the element playing (keep-alive)', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  await eng.applyDesired({ verb: VERBS.STOP, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.STOPPED);
  assert.equal(eng.getGain(), 0);
  assert.equal(eng.el.paused, false, 'element keeps playing so the tab stays resident');
  const targets = eng.gain.gain.calls.filter((c) => c[0] === 'target').map((c) => c[1]);
  assert.ok(Math.min(...targets) <= 0.0002, 'ramps toward silence');
});

test('MODERN: timer fade-out ramps to silence, then stops', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'pink' });
  eng.gain.gain.calls.length = 0;
  eng.fadeOutAndStop(0.05); // 50 ms fade
  const targets = eng.gain.gain.calls.filter((c) => c[0] === 'target').map((c) => c[1]);
  assert.ok(targets.some((t) => t <= 0.0002), 'schedules a fade toward silence');
  assert.equal(eng.getState(), STATES.PLAYING, 'still playing during the fade');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(eng.getState(), STATES.STOPPED, 'stops once the fade completes');
  assert.equal(eng.getGain(), 0);
});

test('a new actuation cancels an in-progress timer fade-out', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'pink' });
  eng.fadeOutAndStop(0.05);
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'pink' }); // cancels the pending stop
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(eng.getState(), STATES.PLAYING, 'fade cancelled — still playing, not stopped');
});

test('MODERN: gain above the soft cap is clamped', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 5, soundscape: 'white' });
  assert.equal(eng.getGain(), GAIN_SOFT_CAP);
});

test('MODERN: START with a suspended context does NOT masquerade as PLAYING', async () => {
  const eng = modernEngine();
  eng.ctx.state = 'suspended';
  eng.ctx.resume = async function () { /* stays suspended (resume blocked) */ };
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.REQUIRES_GESTURE);
});

test('LEGACY: START plays, STOP pauses (fixed-volume, unrouted element)', async () => {
  const eng = new AudioEngine({ tier: TIERS.LEGACY, onState: () => {} });
  eng.el = fakeEl();
  eng.armed = true;
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.el.paused, false);
  assert.equal(eng.getState(), STATES.PLAYING);
  await eng.applyDesired({ verb: VERBS.STOP, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.el.paused, true, 'unrouted element pauses on stop');
  assert.equal(eng.getState(), STATES.STOPPED);
});

test('MID (element.volume honored): foreground volume; remembered across stop', async () => {
  const eng = new AudioEngine({ tier: TIERS.MID, caps: { elementVolume: true }, onState: () => {} });
  eng.el = fakeEl();
  eng.armed = true;
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.4, soundscape: 'white' });
  assert.equal(eng.el.volume, 0.4, 'element.volume set for MID');
  assert.equal(eng.getGain(), 0.4);
  assert.equal(eng.getState(), STATES.PLAYING);
  // ELEMENT-mode actuation (no gain node) never creates an AudioContext — this is the unrouted
  // fallback path (old iOS, or a MID device with no Web Audio at all). On a normal desktop/Android
  // MID device element.volume IS honored, so arm() takes the gapless GRAPH path instead — covered
  // by the "GAPLESS: MID desktop …" test above.
  assert.equal(eng.ctx, null, 'element-mode actuation stays unrouted (no AudioContext)');
  await eng.applyDesired({ verb: VERBS.STOP, gainLinear: 0.4, soundscape: 'white' });
  assert.equal(eng.el.paused, true);
  assert.equal(eng.getState(), STATES.STOPPED);
  assert.equal(eng.getGain(), 0);
  assert.equal(eng.el.volume, 0.4, 'volume not zeroed on stop (remembered)');
});

test('MID (element.volume NOT honored, e.g. old iOS): behaves fixed, no el.volume change', async () => {
  const eng = new AudioEngine({ tier: TIERS.MID, caps: { elementVolume: false }, onState: () => {} });
  eng.el = fakeEl();
  eng.armed = true;
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.4, soundscape: 'white' });
  assert.equal(eng.el.volume, 1, 'no element.volume change when unhonored');
  assert.equal(eng.getGain(), 1);
});

test('LEGACY: no element.volume changes (truly fixed)', async () => {
  const eng = new AudioEngine({ tier: TIERS.LEGACY, onState: () => {} });
  eng.el = fakeEl();
  eng.armed = true;
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.4, soundscape: 'white' });
  assert.equal(eng.el.volume, 1, 'LEGACY leaves element.volume untouched');
  assert.equal(eng.getGain(), 1);
});

test('SET_SOUNDSCAPE on a STOPPED device does not resurrect audio (shouldPlay guard)', async () => {
  const eng = new AudioEngine({ tier: TIERS.LEGACY, onState: () => {} });
  eng.el = fakeEl();
  eng.armed = true;
  await eng.applyDesired({ verb: VERBS.STOP, gainLinear: 0.3, soundscape: 'white' }); // stopped, sound=white
  eng.el.plays = 0;
  await eng.applyDesired({ verb: VERBS.STOP, gainLinear: 0.3, soundscape: 'pink' }); // change sound while stopped
  assert.equal(eng.el.plays, 0, 'swap on a stopped device must not call play()');
  assert.equal(eng.el.paused, true);
  assert.equal(eng.getState(), STATES.STOPPED);
});

test('GAPLESS: START starts a LOOPING buffer source, ramps gain, keeps the keep-alive element playing', async () => {
  const eng = bufferEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.ok(eng._bufSrc, 'a buffer source drives the sound');
  assert.equal(eng._bufSrc.loop, true, 'it loops sample-accurately (gapless)');
  assert.equal(eng._bufSrc.started, 1, 'and is actually started');
  assert.equal(eng.getState(), STATES.PLAYING);
  assert.equal(eng.getGain(), 0.3);
  assert.equal(eng.el.paused, false, 'the muted keep-alive element keeps playing');
  const ramps = rampValues(eng.gain);
  assert.ok(Math.abs(Math.max(...ramps) - 0.3) < 1e-6, 'ramps the gain bus to the requested volume');
});

test('GAPLESS: a paused (muted) keep-alive element does NOT downgrade PLAYING — the buffer is the source', async () => {
  const eng = bufferEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.PLAYING);
  eng.el.paused = true; // iOS paused the SILENT keep-alive element; the audible buffer still loops
  assert.equal(eng.reconcileLiveness(), STATES.PLAYING, 'still audibly playing, so still PLAYING');
});

test('GAPLESS: a suspended/interrupted context DOES downgrade PLAYING (real silence)', async () => {
  const eng = bufferEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  eng.ctx.state = 'interrupted';
  assert.equal(eng.reconcileLiveness(), STATES.REQUIRES_GESTURE);
});

test('GAPLESS: losing the buffer source downgrades PLAYING', async () => {
  const eng = bufferEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  eng._bufSrc.onended(); // the loop was torn down (interruption); onended nulls _bufSrc
  assert.equal(eng._bufSrc, null);
  assert.equal(eng.reconcileLiveness(), STATES.REQUIRES_GESTURE);
});

test('GAPLESS: STOP ramps to silence but keeps the loop + keep-alive resident (never a wrap gap on restart)', async () => {
  const eng = bufferEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  const srcBefore = eng._bufSrc;
  await eng.applyDesired({ verb: VERBS.STOP, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.STOPPED);
  assert.equal(eng.getGain(), 0);
  assert.equal(eng.el.paused, false, 'keep-alive element stays resident');
  assert.equal(eng._bufSrc, srcBefore, 'the loop keeps running silently (gated by gain), not torn down');
});

test('GAPLESS: soundscape swap decodes + replaces the loop WITHOUT reloading the element src (background-safe)', async () => {
  const eng = bufferEngine();
  eng._loadBuffer = async () => ({ duration: 30 }); // stub fetch+decode
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  const firstSrc = eng._bufSrc;
  eng.el.src = 'KEEPALIVE_URL';
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'pink', url: 'PINK_URL' });
  assert.equal(eng.getSoundscape(), 'pink', 'currentSoundscape follows the swap');
  assert.notEqual(eng._bufSrc, firstSrc, 'a fresh looping source replaced the old one');
  assert.equal(eng._bufSrc.loop, true);
  assert.equal(eng.el.src, 'KEEPALIVE_URL', 'the keep-alive element src is NOT reloaded (would kill iOS lock playback)');
});

test('GAPLESS: MID desktop (element.volume honored) uses foreground volume on the gain bus', async () => {
  const eng = bufferEngine(TIERS.MID, { elementVolume: true });
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.4, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.PLAYING);
  assert.equal(eng.getGain(), 0.4, 'foreground volume actuated via the gain node');
  const ramps = rampValues(eng.gain);
  assert.ok(Math.abs(Math.max(...ramps) - 0.4) < 1e-6);
});

test('_canUseBuffer: gapless where bg Web Audio survives; element fallback on old iOS', () => {
  const orig = globalThis.window;
  globalThis.window = { AudioContext: function () {} };
  try {
    const modern = new AudioEngine({ tier: TIERS.MODERN, caps: { audioSession: true }, onState() {} });
    assert.equal(modern._canUseBuffer(), true, 'MODERN (audioSession=playback survives lock) → gapless');
    const desktop = new AudioEngine({ tier: TIERS.MID, caps: { elementVolume: true }, onState() {} });
    assert.equal(desktop._canUseBuffer(), true, 'desktop/Android (element.volume honored ⇒ not iOS) → gapless');
    const oldIosMid = new AudioEngine({ tier: TIERS.MID, caps: { elementVolume: false }, onState() {} });
    assert.equal(oldIosMid._canUseBuffer(), false, 'old iOS MID → keep the lock-surviving <audio> loop');
    const legacy = new AudioEngine({ tier: TIERS.LEGACY, caps: {}, onState() {} });
    assert.equal(legacy._canUseBuffer(), false, 'old iOS LEGACY → keep the lock-surviving <audio> loop');
    globalThis.window = {}; // no AudioContext at all
    assert.equal(modern._canUseBuffer(), false, 'no Web Audio → element loop regardless of tier');
  } finally { globalThis.window = orig; }
});

test('applyDesired is a no-op when not armed', async () => {
  const eng = new AudioEngine({ tier: TIERS.MODERN, onState: () => {} });
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.ARMING);
});

test('reconcileLiveness downgrades a PLAYING claim when the element was paused out from under us (finding #2)', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.getState(), STATES.PLAYING);
  eng.el.paused = true; // iOS paused the element for an interruption; no event wired on this fake
  assert.equal(eng.reconcileLiveness(), STATES.REQUIRES_GESTURE);
  assert.equal(eng.getState(), STATES.REQUIRES_GESTURE, 'a silent room can never keep reporting PLAYING');
});

test('reconcileLiveness downgrades PLAYING when the AudioContext is no longer running (finding #2)', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  eng.ctx.state = 'interrupted'; // Siri / system chime suspended the context
  assert.equal(eng.reconcileLiveness(), STATES.REQUIRES_GESTURE);
});

test('reconcileLiveness leaves a genuinely-playing device alone', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.reconcileLiveness(), STATES.PLAYING);
});

test('recover() clears a stuck REQUIRES_GESTURE once audio is actually flowing again (finding #5)', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  eng.state = STATES.REQUIRES_GESTURE; // stuck: entered during a background window
  eng.el.paused = false; eng.ctx.state = 'running'; // audio is truly flowing now
  const ok = await eng.recover();
  assert.equal(ok, true);
  assert.equal(eng.getState(), STATES.PLAYING, 'no false "needs a tap" alarm while playing correctly');
});
