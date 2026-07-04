// Unit tests for the baby-monitor mic availability logic — the "web-app mic support" surface.
// The Monitor's methods read browser globals (window/navigator/location) only when CALLED, so we can
// import it in Node and drive each scenario by stubbing those globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../web/player/monitor.js';

// Run fn with window/navigator/location temporarily replaced, then restore. Async-aware: if fn
// returns a promise, restoration waits for it to settle (so an async body sees the stubbed globals).
function withGlobals({ win, nav, loc }, fn) {
  const g = globalThis;
  const savedWin = Object.getOwnPropertyDescriptor(g, 'window');
  const savedNav = Object.getOwnPropertyDescriptor(g, 'navigator');
  const savedLoc = Object.getOwnPropertyDescriptor(g, 'location');
  const restore = () => {
    savedWin ? Object.defineProperty(g, 'window', savedWin) : delete g.window;
    savedNav ? Object.defineProperty(g, 'navigator', savedNav) : delete g.navigator;
    savedLoc ? Object.defineProperty(g, 'location', savedLoc) : delete g.location;
  };
  Object.defineProperty(g, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
  Object.defineProperty(g, 'location', { value: loc, configurable: true, writable: true });
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
    restore(); return r;
  } catch (e) { restore(); throw e; }
}

const AudioCtx = function () {};
const modernNav = { mediaDevices: { getUserMedia() {} } };
const httpsLoc = { protocol: 'https:', hostname: 'nursery.example.com' };

function avail(cfg) { return withGlobals(cfg, () => new Monitor().availability()); }

test('modern secure context with mediaDevices → available', () => {
  const a = avail({ win: { AudioContext: AudioCtx, isSecureContext: true }, nav: modernNav, loc: httpsLoc });
  assert.equal(a.ok, true);
  assert.equal(a.reason, null);
});

test('plain HTTP on a real host → insecure (not available)', () => {
  const a = avail({ win: { AudioContext: AudioCtx, isSecureContext: false }, nav: modernNav, loc: { protocol: 'http:', hostname: '192.168.1.9' } });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'insecure');
});

test('http://localhost is treated as secure (isSecureContext absent → origin rule)', () => {
  const a = avail({ win: { AudioContext: AudioCtx }, nav: modernNav, loc: { protocol: 'http:', hostname: 'localhost' } });
  assert.equal(a.ok, true);
});

test('installed web-app on iOS < 14.3 (standalone, no capture API over HTTPS) → standalone reason', () => {
  const a = avail({
    win: { AudioContext: AudioCtx, isSecureContext: true, matchMedia: (q) => ({ matches: q.indexOf('standalone') !== -1 }) },
    nav: { standalone: true }, // no mediaDevices, no legacy getUserMedia
    loc: httpsLoc,
  });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'standalone');
  assert.match(a.note, /Safari/);
});

test('secure but no capture API and NOT standalone (iOS 11-only-in-tab / iOS 10-ish) → no-mic-api', () => {
  const a = avail({ win: { AudioContext: AudioCtx, isSecureContext: true }, nav: {}, loc: httpsLoc });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'no-mic-api');
});

test('no Web Audio at all → no-audio', () => {
  const a = avail({ win: { isSecureContext: true }, nav: modernNav, loc: httpsLoc });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'no-audio');
});

test('legacy webkitGetUserMedia is recognized (old-WebKit fallback) → available', () => {
  const a = avail({ win: { AudioContext: AudioCtx, isSecureContext: true }, nav: { webkitGetUserMedia() {} }, loc: httpsLoc });
  assert.equal(a.ok, true);
});

test('start() switches audioSession to play-and-record (or iOS ends the mic track), stop() restores it', async () => {
  // The root cause of the iOS 17 "Start baby monitor does nothing": the player pins type='playback'
  // at arm; per the Audio Session spec a mic track is ended unless the type is play-and-record/auto.
  const fakeCtx = {
    createMediaStreamSource: () => ({ connect() {} }),
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData() {} }),
    close: () => Promise.resolve(),
  };
  const nav = {
    audioSession: { type: 'playback' }, // player pinned playback at arm
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  };
  const win = { AudioContext: function () { return fakeCtx; }, isSecureContext: true };
  await withGlobals({ win, nav, loc: httpsLoc }, async () => {
    const m = new Monitor();
    const ok = await m.start();
    assert.equal(ok, true, 'monitor starts');
    assert.equal(nav.audioSession.type, 'play-and-record', 'capture intent declared before getUserMedia');
    m.stop();
    assert.equal(nav.audioSession.type, 'playback', 'playback session restored on stop');
  });
});

test('supported() mirrors availability().ok', () => {
  withGlobals({ win: { AudioContext: AudioCtx, isSecureContext: true }, nav: modernNav, loc: httpsLoc }, () => {
    assert.equal(new Monitor().supported(), true);
  });
  withGlobals({ win: { isSecureContext: true }, nav: {}, loc: httpsLoc }, () => {
    assert.equal(new Monitor().supported(), false);
  });
});
