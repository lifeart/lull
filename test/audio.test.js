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
  };
}

// MODERN tier engine wired to fakes (bypasses arm()'s real Web Audio construction).
function modernEngine() {
  const eng = new AudioEngine({ tier: TIERS.MODERN, onState: () => {} });
  eng.el = fakeEl();
  eng.gain = { gain: fakeGainParam() };
  eng.ctx = { state: 'running', currentTime: 0, async resume() { this.state = 'running'; } };
  eng.armed = true;
  return eng;
}

test('MODERN: START plays the element, ramps gain up, reports PLAYING', async () => {
  const eng = modernEngine();
  await eng.applyDesired({ verb: VERBS.START, gainLinear: 0.3, soundscape: 'white' });
  assert.equal(eng.el.paused, false);
  assert.equal(eng.getState(), STATES.PLAYING);
  assert.equal(eng.getGain(), 0.3);
  const targets = eng.gain.gain.calls.filter((c) => c[0] === 'target').map((c) => c[1]);
  assert.ok(targets.length > 0, 'gain ramps');
  assert.ok(Math.abs(Math.max(...targets) - 0.3) < 1e-6, 'ramps to the requested gain, not a fixed value');
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
  assert.equal(eng.ctx, null, 'MID never creates an AudioContext (stays unrouted)');
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
