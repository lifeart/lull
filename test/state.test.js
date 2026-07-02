// Hub sleep-timer internals: the re-verify guard in _fireTimer and TIMEOUT_MAX chunking
// (finding: these branches are skipped by the e2e happy path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { Store } from '../hub/store.js';
import { StateManager } from '../hub/state.js';
import { VERBS } from '../shared/protocol.js';

function fresh() {
  const file = path.join(os.tmpdir(), `mp-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const store = new Store(file);
  let fired = 0;
  const sm = new StateManager(store, { onDesiredChanged: () => { fired++; } });
  return { store, sm, cleanup: () => rmSync(file, { force: true }), fired: () => fired };
}

test('_fireTimer does NOT stop a still-future timer (re-verify guard); it reschedules', () => {
  const { sm, cleanup, fired } = fresh();
  try {
    sm.register({ deviceId: 'd', caps: {}, tier: 'LEGACY' });
    sm.applyCommand('d', { verb: VERBS.START, endsAtEpochMs: Date.now() + 60000 });
    sm._fireTimer('d'); // force an early/spurious fire
    assert.equal(sm.store.get('d').desired.verb, VERBS.START, 'still playing — deadline not reached');
    assert.equal(fired(), 0, 'onDesiredChanged not called on a spurious fire');
    assert.ok(sm.timers.has('d'), 'timer was rescheduled');
  } finally { sm._clearTimer('d'); cleanup(); }
});

test('_fireTimer DOES stop an elapsed timer', () => {
  const { sm, cleanup, fired } = fresh();
  try {
    sm.register({ deviceId: 'd', caps: {}, tier: 'LEGACY' });
    sm.applyCommand('d', { verb: VERBS.START, endsAtEpochMs: Date.now() - 1 }); // already past
    // applyCommand -> _rescheduleTimer sees delay<=0 -> _fireTimer synchronously
    assert.equal(sm.store.get('d').desired.verb, VERBS.STOP);
    assert.equal(sm.store.get('d').desired.endsAtEpochMs, null);
    assert.ok(fired() >= 1, 'onDesiredChanged fired on real elapse');
  } finally { sm._clearTimer('d'); cleanup(); }
});

test('per-device volume is independent, remembered across start, and persisted', async () => {
  const { sm, store, cleanup } = fresh();
  try {
    sm.register({ deviceId: 'a', caps: { tier: 'MODERN' }, tier: 'MODERN' });
    sm.register({ deviceId: 'b', caps: { tier: 'MODERN' }, tier: 'MODERN' });
    sm.applyCommand('a', { verb: VERBS.SET_GAIN, gainLinear: 0.5 });
    sm.applyCommand('b', { verb: VERBS.SET_GAIN, gainLinear: 0.15 });
    assert.equal(store.get('a').desired.gainLinear, 0.5);
    assert.equal(store.get('b').desired.gainLinear, 0.15, 'devices keep independent volumes');
    sm.applyCommand('a', { verb: VERBS.START }); // START carries no gain -> remembered value kept
    assert.equal(store.get('a').desired.gainLinear, 0.5, 'volume remembered across start');
    await store._persist();
    const store2 = new Store(store.filePath); // reload from disk
    assert.equal(store2.get('a').desired.gainLinear, 0.5, 'persisted per device');
    assert.equal(store2.get('b').desired.gainLinear, 0.15);
  } finally { sm._clearTimer('a'); sm._clearTimer('b'); cleanup(); }
});

test('a >24.8-day timer is chunked, not fired immediately (no setTimeout overflow)', () => {
  const { sm, cleanup } = fresh();
  try {
    sm.register({ deviceId: 'd', caps: {}, tier: 'LEGACY' });
    sm.applyCommand('d', { verb: VERBS.START, endsAtEpochMs: Date.now() + 3_000_000_000 }); // > 2^31 ms
    assert.equal(sm.store.get('d').desired.verb, VERBS.START, 'not stopped by an overflowed delay');
    assert.ok(sm.timers.has('d'), 'a chunked re-check timer is scheduled');
  } finally { sm._clearTimer('d'); cleanup(); }
});
