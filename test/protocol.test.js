import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERBS, ALL_VERBS, GAIN_SOFT_CAP, STATES,
  clampGain, tierFromCaps, usesGain, foregroundVolume, TIERS,
  applyCommandToDesired, reconcileTimer, remainingSec,
  validateCommand, defaultDesired, makeCommand, reduceCommand, probeAudibleReady,
  startIntentFailed,
} from '../shared/protocol.js';
import { tierControls, lockSummary } from '../shared/tiers.js';

test('clampGain floors at 0 and caps at the soft cap', () => {
  assert.equal(clampGain(-1), 0);
  assert.equal(clampGain(0.3), 0.3);
  assert.equal(clampGain(5), GAIN_SOFT_CAP);
  assert.equal(clampGain('nope'), 0.3); // default
});

test('startIntentFailed only NACKs genuine start-intent that missed PLAYING (findings #4 + review #2)', () => {
  // A real START that didn't reach PLAYING → NACK (alarm the parent).
  assert.equal(startIntentFailed(VERBS.START, VERBS.START, STATES.REQUIRES_GESTURE), true);
  assert.equal(startIntentFailed(VERBS.START, VERBS.START, STATES.ERROR), true);
  // A START that reached PLAYING → ok.
  assert.equal(startIntentFailed(VERBS.START, VERBS.START, STATES.PLAYING), false);
  // setTimer that implies start (reduced verb START) but not audible → NACK.
  assert.equal(startIntentFailed(VERBS.SET_TIMER, VERBS.START, STATES.REQUIRES_GESTURE), true);
  // The regression: a routine SET_GAIN / SET_SOUNDSCAPE on an already-silent (desired=START) device
  // applied fine and must ACK ok even though the device isn't PLAYING — no false alarm.
  assert.equal(startIntentFailed(VERBS.SET_GAIN, VERBS.START, STATES.REQUIRES_GESTURE), false);
  assert.equal(startIntentFailed(VERBS.SET_SOUNDSCAPE, VERBS.START, STATES.REQUIRES_GESTURE), false);
  // STOP never NACKs on non-PLAYING state.
  assert.equal(startIntentFailed(VERBS.STOP, VERBS.STOP, STATES.STOPPED), false);
});

test('tierFromCaps maps feature presence to tiers (never version sniff)', () => {
  assert.equal(tierFromCaps({ audioSession: true, mediaSession: true }), TIERS.MODERN);
  assert.equal(tierFromCaps({ mediaSession: true }), TIERS.MID);
  assert.equal(tierFromCaps({}), TIERS.LEGACY);
  assert.equal(usesGain(TIERS.MODERN), true);
  assert.equal(usesGain(TIERS.LEGACY), false);
});

test('applyCommandToDesired handles EVERY verb without throwing', () => {
  const base = defaultDesired();
  for (const verb of ALL_VERBS) {
    const cmd = makeCommand({ target: 'd', verb, gainLinear: 0.2, endsAtEpochMs: Date.now() + 1000, soundscape: 'pink' });
    assert.doesNotThrow(() => applyCommandToDesired(base, cmd), `verb ${verb} must be handled`);
  }
});

test('applyCommandToDesired reducer semantics', () => {
  let d = defaultDesired();
  d = applyCommandToDesired(d, { verb: VERBS.START });
  assert.equal(d.verb, VERBS.START);
  d = applyCommandToDesired(d, { verb: VERBS.SET_GAIN, gainLinear: 9 });
  assert.equal(d.gainLinear, GAIN_SOFT_CAP); // clamped
  const end = Date.now() + 60000;
  d = applyCommandToDesired(d, { verb: VERBS.SET_TIMER, endsAtEpochMs: end });
  assert.equal(d.endsAtEpochMs, end);
  d = applyCommandToDesired(d, { verb: VERBS.STOP });
  assert.equal(d.verb, VERBS.STOP);
  assert.equal(d.endsAtEpochMs, null, 'stop clears the timer');
  // setTimer while stopped implies play
  d = applyCommandToDesired(d, { verb: VERBS.SET_TIMER, endsAtEpochMs: end });
  assert.equal(d.verb, VERBS.START);
});

test('applyCommandToDesired throws on unknown verb (no silent drift)', () => {
  assert.throws(() => applyCommandToDesired(defaultDesired(), { verb: 'play' }));
});

test('reconcileTimer stops an elapsed timer and NEVER resurrects noise', () => {
  const now = 1_000_000;
  const running = { verb: VERBS.START, gainLinear: 0.3, soundscape: 'white', endsAtEpochMs: now - 1 };
  const r = reconcileTimer(running, now);
  assert.equal(r.changed, true);
  assert.equal(r.desired.verb, VERBS.STOP);
  assert.equal(r.desired.endsAtEpochMs, null);
  // future timer untouched
  const future = { ...running, endsAtEpochMs: now + 10000 };
  assert.equal(reconcileTimer(future, now).changed, false);
});

test('remainingSec computes seconds and null when not timing', () => {
  const now = 1_000_000;
  assert.equal(remainingSec({ verb: VERBS.START, endsAtEpochMs: now + 45000 }, now), 45);
  assert.equal(remainingSec({ verb: VERBS.STOP, endsAtEpochMs: now + 45000 }, now), null);
  assert.equal(remainingSec({ verb: VERBS.START, endsAtEpochMs: null }, now), null);
});

test('validateCommand rejects malformed commands', () => {
  assert.equal(validateCommand({ verb: 'bogus', target: 'd' }).ok, false);
  assert.equal(validateCommand({ verb: VERBS.START }).ok, false); // no target
  assert.equal(validateCommand({ verb: VERBS.SET_GAIN, target: 'd' }).ok, false); // no gain
  assert.equal(validateCommand({ verb: VERBS.SET_GAIN, target: 'd', gainLinear: 0.2 }).ok, true);
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd', endsAtEpochMs: 'soon' }).ok, false);
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd', endsAtEpochMs: null }).ok, true);
});

test('units are baked into field names (no ambiguous volume/time)', () => {
  const cmd = makeCommand({ target: 'd', verb: VERBS.SET_GAIN, gainLinear: 0.2 });
  assert.ok('gainLinear' in cmd);
  assert.ok(!('volume' in cmd));
});

test('timer boundary: exactly at the deadline stops (>=) and remainingSec is 0 not null', () => {
  const now = 1_000_000;
  const atDeadline = { verb: VERBS.START, gainLinear: 0.3, soundscape: 'white', endsAtEpochMs: now };
  const r = reconcileTimer(atDeadline, now);
  assert.equal(r.changed, true, 'stops at exact equality (>=)');
  assert.equal(r.desired.verb, VERBS.STOP);
  assert.equal(remainingSec({ verb: VERBS.START, endsAtEpochMs: now }, now), 0, 'exactly 0 at the deadline, not null');
});

test('validateCommand rejects a non-numeric endsAtEpochMs on START (safety timer cannot be silently disabled)', () => {
  assert.equal(validateCommand({ verb: VERBS.START, target: 'd', endsAtEpochMs: 'abc' }).ok, false); // NaN -> rejected
  assert.equal(validateCommand({ verb: VERBS.START, target: 'd', endsAtEpochMs: '3600' }).ok, true); // numeric string -> coerced safely
  assert.equal(validateCommand({ verb: VERBS.START, target: 'd', endsAtEpochMs: null }).ok, true);
  assert.equal(validateCommand({ verb: VERBS.START, target: 'd' }).ok, true);
});

test('validateCommand accepts SET_TIMER via durationMs (relative) and rejects non-numeric', () => {
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd', durationMs: 900000 }).ok, true);
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd', durationMs: 'soon' }).ok, false);
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd' }).ok, false); // needs one of the two
});

test('applyCommandToDesired coerces a numeric-string endsAtEpochMs to a real number', () => {
  const d = applyCommandToDesired(defaultDesired(), { verb: VERBS.SET_TIMER, endsAtEpochMs: '1700000000000' });
  assert.equal(typeof d.endsAtEpochMs, 'number');
  assert.equal(d.verb, VERBS.START);
});

test('foregroundVolume is MID-only; tierControls gates it on caps.elementVolume; lockSummary per tier', () => {
  assert.equal(foregroundVolume(TIERS.MID), true);
  assert.equal(foregroundVolume(TIERS.MODERN), false);
  assert.equal(foregroundVolume(TIERS.LEGACY), false);
  assert.equal(tierControls(TIERS.MODERN).remoteVolume, true);
  assert.equal(tierControls(TIERS.MID, { elementVolume: true }).foregroundVolume, true);
  assert.equal(tierControls(TIERS.MID, { elementVolume: false }).foregroundVolume, false); // old iOS: no slider
  assert.equal(tierControls(TIERS.MID, { elementVolume: true }).fixedVolumeNote, false);
  assert.equal(tierControls(TIERS.MID, {}).fixedVolumeNote, true); // unhonored → hardware-only
  assert.equal(tierControls(TIERS.LEGACY).fixedVolumeNote, true);
  assert.match(lockSummary(TIERS.MODERN), /over the mute switch/);
  assert.match(lockSummary(TIERS.MID), /screen on/i);
  assert.match(lockSummary(TIERS.LEGACY), /started from silence/i);
});

test('probeAudibleReady passes only for armed + PLAYING/STOPPED', () => {
  assert.equal(probeAudibleReady(true, STATES.PLAYING), true);
  assert.equal(probeAudibleReady(true, STATES.STOPPED), true);
  assert.equal(probeAudibleReady(true, STATES.REQUIRES_GESTURE), false); // silent, needs a tap
  assert.equal(probeAudibleReady(true, STATES.ERROR), false);
  assert.equal(probeAudibleReady(true, STATES.ARMING), false);
  assert.equal(probeAudibleReady(false, STATES.PLAYING), false);
});

test('validateCommand accepts numeric-string durationMs (hub coerces) and numeric on START', () => {
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd', durationMs: '900000' }).ok, true);
  assert.equal(validateCommand({ verb: VERBS.START, target: 'd', durationMs: 60000 }).ok, true);
  assert.equal(validateCommand({ verb: VERBS.SET_TIMER, target: 'd', durationMs: 'nope' }).ok, false);
});

test('reduceCommand returns updated desired + matching ACK on success, and ok:false ACK on bad verb', () => {
  const ok = reduceCommand(defaultDesired(), { verb: VERBS.START, cmdId: 'c1' }, 'dev1');
  assert.equal(ok.ok, true);
  assert.equal(ok.desired.verb, VERBS.START);
  assert.equal(ok.ack.cmdId, 'c1');
  assert.equal(ok.ack.deviceId, 'dev1');
  assert.equal(ok.ack.ok, true);

  const bad = reduceCommand(defaultDesired(), { verb: 'play', cmdId: 'c2' }, 'dev1');
  assert.equal(bad.ok, false);
  assert.equal(bad.ack.cmdId, 'c2'); // same cmdId echoed so the controller can clear its pending timer
  assert.equal(bad.ack.ok, false);
  assert.match(bad.ack.error, /unknown verb/);
});
