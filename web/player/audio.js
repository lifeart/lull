// Player audio engine. Encapsulates every iOS audio gotcha behind applyDesired().
//
// The noise is a plain looping <audio> element. On LEGACY/MID it is UNROUTED — the guaranteed
// background/lock-survivable substrate at a fixed hardware volume. On MODERN we route it through
// a GainNode for remote volume/fades; that routed graph's background survival relies on
// audioSession.type='playback' (16.4+, best-effort), NOT on being unrouted — and recover()
// downgrades to REQUIRES_GESTURE (which alarms the parent) if the context can't stay running.
// So remote volume on MODERN is a best-effort enhancement, never a background guarantee.
// (docs/DESIGN.md §1.2–1.4)

// Relative specifier resolves to /shared/protocol.js in the browser (../.. clamps at origin
// root) AND to repo/shared/protocol.js in Node, so this module is unit-testable.
import { STATES, TIERS, VERBS, usesGain, foregroundVolume, clampGain } from '../../shared/protocol.js';

export class AudioEngine {
  constructor({ tier, caps, onState }) {
    this.tier = tier;
    // MID foreground volume via element.volume — only where the device actually HONORS it
    // (detected by a probe in detectCaps); old iOS ignores element.volume, so it's excluded.
    this.fgVolume = foregroundVolume(tier) && !!(caps && caps.elementVolume);
    this.onState = onState || (() => {});
    this.el = null;
    this.ctx = null;
    this.gain = null;
    this.armed = false;
    this.state = STATES.ARMING;
    this.currentGain = 0;
    this.currentSoundscape = null;
    this.wakeLock = null;
  }

  // MUST be called synchronously inside a user gesture (tap). Unlocks audio for the page.
  async arm({ soundscapeId, url, gainLinear }) {
    const el = new Audio();
    el.src = url;
    el.loop = true;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    this.el = el;
    this.currentSoundscape = soundscapeId;
    if (this.fgVolume) el.volume = clampGain(gainLinear); // don't blast at 1.0 before the first snapshot

    // Only auto-replay when the element SHOULD be sounding: a gain-tier keep-alive (always
    // resident) or a device that is actually PLAYING. Never resurrect a deliberately STOPPED
    // non-gain element (the "never resurrect noise" invariant).
    const shouldSound = () => this.armed && this.state !== STATES.ERROR && (usesGain(this.tier) || this.state === STATES.PLAYING);
    el.addEventListener('error', () => this._fail('audio element error'));
    // 'stalled' is a transient network hiccup (very common on iOS during lock) — recover, do NOT
    // treat as a permanent error that the automatic recovery path can never clear.
    el.addEventListener('stalled', () => { if (shouldSound()) el.play().catch(() => {}); });
    el.addEventListener('ended', () => { if (shouldSound()) el.play().catch((e) => this._fail(e.message)); });
    // iOS can PAUSE the element / suspend the context for an audio-session interruption (Siri, a
    // system chime, another app grabbing the session) with NO visibility/focus event fired — which
    // is exactly what happens on a MODERN device whose Wake Lock keeps the screen on. Nothing else
    // would notice, so the device would keep reporting PLAYING while the room is silent. Detect it
    // here: retry playback, and if audio still isn't flowing, downgrade so the parent is alarmed.
    // A deliberate STOP leaves state STOPPED, so shouldSound() is false and we never resurrect. (finding #2)
    el.addEventListener('pause', () => {
      if (!shouldSound()) return;
      const recheck = () => { const before = this.state; this.reconcileLiveness(); if (this.state !== before) this._emit(); };
      try { Promise.resolve(el.play()).then(recheck, recheck); } catch { recheck(); }
    });

    // Promote the audio session so it plays in the background and OVER the mute switch (16.4+).
    if ('audioSession' in navigator) {
      try { navigator.audioSession.type = 'playback'; } catch (e) { console.warn('audioSession set failed', e); }
    }

    // The element's first play() MUST fire synchronously in the gesture — awaiting anything
    // (e.g. ctx.resume()) first can consume the transient user-activation and make play() reject.
    let playPromise;
    if (usesGain(this.tier)) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      // If the context is interrupted/suspended out from under us (no visibility event, per above),
      // re-check liveness so a stalled session can never be broadcast as PLAYING. (finding #2)
      this.ctx.addEventListener('statechange', () => {
        const before = this.state;
        this.reconcileLiveness();
        if (this.state !== before) this._emit();
      });
      const srcNode = this.ctx.createMediaElementSource(el);
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0; // start silent; start() ramps up
      srcNode.connect(this.gain).connect(this.ctx.destination);
      playPromise = el.play(); // start synchronously in the gesture, before any await
      await this.ctx.resume(); // synchronous-in-gesture unlock
    } else {
      playPromise = el.play(); // start synchronously in the gesture
    }
    // Keep it playing forever as the keep-alive substrate; on non-gain tiers "stop" pauses it.
    await playPromise;
    this.armed = true;
    this._setupMediaSession();
    await this._acquireWakeLock();
    return true;
  }

  // Realize a full desired state. Hub/player both derive desired via the shared reducer, so
  // this is the ONLY place audio is actuated — no divergent interpretations.
  async applyDesired(desired) {
    if (!this.armed) return;
    if (desired.soundscape && desired.soundscape !== this.currentSoundscape) {
      // Only start audio during the swap if it should be sounding (gain-tier keep-alive, or START);
      // a swap on a STOPPED unrouted device must not resurrect noise.
      await this._swapSoundscape(desired.soundscape, desired.url, usesGain(this.tier) || desired.verb === VERBS.START);
    }
    const g = clampGain(desired.gainLinear);
    if (usesGain(this.tier)) {
      // Element keeps playing regardless; gain expresses start/stop/volume.
      if (this.el.paused) { try { await this.el.play(); } catch (e) { this._fail(e.message); return; } }
      const on = desired.verb === VERBS.START;
      this._rampGain(on ? g : 0);
      this.currentGain = on ? g : 0;
      if (on) {
        // Don't report PLAYING unless the context is actually running (a suspended ctx = silence).
        if (this.ctx && this.ctx.state !== 'running') {
          try { await this.ctx.resume(); } catch (e) { console.warn('ctx.resume failed', e); }
        }
        const running = !this.el.paused && (!this.ctx || this.ctx.state === 'running');
        this.state = running ? STATES.PLAYING : STATES.REQUIRES_GESTURE;
      } else {
        this.state = STATES.STOPPED;
      }
    } else {
      // Unrouted element (LEGACY/MID). MID gets best-effort foreground volume via element.volume
      // (honored off-iOS; old iOS ignores it). Stays unrouted, so lock/background playback survives.
      const on = desired.verb === VERBS.START;
      if (this.fgVolume) this.el.volume = on ? g : this.el.volume; // 0..0.6, safe range
      if (on) {
        try { await this.el.play(); this.state = STATES.PLAYING; }
        catch (e) { this.state = STATES.REQUIRES_GESTURE; console.warn('play blocked', e); }
      } else {
        this.el.pause();
        this.state = STATES.STOPPED;
      }
      // MID reports its (element) volume; LEGACY is truly fixed → report 1/0.
      this.currentGain = this.fgVolume ? (on ? g : 0) : (on ? 1 : 0);
    }
    this._updateMediaSessionState();
    this._emit();
  }

  _rampGain(target) {
    if (!this.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const p = this.gain.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(Math.max(0.0001, p.value), now);
    // click-free ~1.2s fade
    p.setTargetAtTime(Math.max(0.0001, target), now, 0.35);
    p.setValueAtTime(target, now + 1.5);
  }

  async _swapSoundscape(soundscapeId, url, shouldPlay = true) {
    // src swaps are UNSAFE while backgrounded on iOS 15+ (kills lock playback). Defer if hidden.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      this._pendingSoundscape = { soundscapeId, url, shouldPlay };
      return;
    }
    this.currentSoundscape = soundscapeId;
    this._pendingSoundscape = null; // a foreground swap invalidates any stale deferral
    this.el.src = url;
    if (shouldPlay) { try { await this.el.play(); } catch (e) { this._fail(e.message); } } // don't resurrect a stopped device
  }

  // Recovery: iOS suspends/interrupts audio on background & has version-specific regressions.
  // Call on visibilitychange/pageshow/focus. Returns true if audio reached a running state.
  async recover() {
    if (!this.armed || !this.el) return false;
    if (this._pendingSoundscape && document.visibilityState === 'visible') {
      const p = this._pendingSoundscape; this._pendingSoundscape = null;
      await this._swapSoundscape(p.soundscapeId, p.url, p.shouldPlay !== false);
    }
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (e) { console.warn('ctx.resume failed', e); }
    }
    if (this.el.paused && this.state === STATES.PLAYING) {
      try { await this.el.play(); } catch (e) { console.warn('recover play blocked', e); }
    }
    await this._acquireWakeLock();
    const running = !this.el.paused && (!this.ctx || this.ctx.state === 'running');
    if (running && (this.state === STATES.ERROR || this.state === STATES.REQUIRES_GESTURE)) {
      // Audio is actually flowing again — clear a transient error OR a REQUIRES_GESTURE that a
      // background window set while ctx.resume() was still pending. Without the REQUIRES_GESTURE
      // case the device would stay stuck "needs a tap" and falsely alarm while playing fine. (finding #5)
      this.state = this.currentGain > 0 ? STATES.PLAYING : STATES.STOPPED;
      this._emit();
    } else if (!running && this.state === STATES.PLAYING) {
      this.state = STATES.REQUIRES_GESTURE; // needs a physical tap; report so controller alarms
      this._emit();
    }
    return running;
  }

  // Re-verify that a PLAYING claim is real: if the element is paused or the context isn't running,
  // audio is NOT flowing, so downgrade to REQUIRES_GESTURE (which alarms the parent). Called before
  // every report and from the pause/statechange listeners. Pure w.r.t. anything but state — does
  // NOT emit (callers decide) so it can't recurse through report(). (finding #2)
  reconcileLiveness() {
    if (this.armed && this.state === STATES.PLAYING) {
      const running = !!this.el && !this.el.paused && (!this.ctx || this.ctx.state === 'running');
      if (!running) { this.state = STATES.REQUIRES_GESTURE; this._updateMediaSessionState(); }
    }
    return this.state;
  }

  _fail(reason) {
    console.error('[audio] failure:', reason);
    this.state = STATES.ERROR; // must never masquerade as playing
    this._emit();
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: 'White noise', artist: 'mesh-playback', album: 'Nursery',
      });
      navigator.mediaSession.setActionHandler('play', () => this.onIntent && this.onIntent(VERBS.START));
      navigator.mediaSession.setActionHandler('pause', () => this.onIntent && this.onIntent(VERBS.STOP));
    } catch (e) { console.warn('mediaSession setup failed', e); }
  }

  _updateMediaSessionState() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = this.state === STATES.PLAYING ? 'playing' : 'paused';
    } catch { /* older iOS lacks playbackState — non-fatal, handler is what matters */ }
  }

  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (this.wakeLock) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch (e) { console.warn('wakeLock failed', e); }
  }

  getState() { return this.state; }
  getGain() { return this.currentGain; }
  getSoundscape() { return this.currentSoundscape; } // ACTUAL soundscape (not desired) for honest reports
  _emit() { this.onState(this.state, this.currentGain, this.currentSoundscape); }
}

export { TIERS };
