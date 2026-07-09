// Player audio engine. Encapsulates every iOS audio gotcha behind applyDesired().
//
// SEAMLESS LOOPING. `<audio loop>` re-buffers at the wrap point, so its loop has an audible seam
// (a periodic silence gap) — the very thing a white-noise app must not have. Where Web Audio can
// stay alive in the background we therefore play the loop as an AudioBufferSourceNode with
// loop=true: the wrap happens sample-accurately in the native audio-render thread, so it stays
// gapless even while the JS main thread is frozen on a locked screen. Where Web Audio would be
// suspended on lock (old iOS) we FALL BACK to the plain unrouted `<audio loop>`, because a
// (near-seamless) WAV loop that survives the lock beats a gapless one that goes silent. The
// decision is `_canUseBuffer()` — feature-detected, never version-sniffed.
//
// Two playback shapes, chosen at arm():
//   • GRAPH mode (a GainNode exists): audible = the looping buffer (or, as a decode-failure
//     fallback, the element) → gain → destination. Used on MODERN (remote volume + fades, kept
//     alive by audioSession='playback', 16.4+) and on any non-iOS platform (desktop/Android —
//     proven by element.volume being honored). The `<audio>` element is kept PLAYING but routed
//     through a muted gain purely as a liveness signal + iOS interruption detector + keep-alive.
//   • ELEMENT mode (no GainNode): the UNROUTED `<audio loop>` at fixed/foreground volume — the
//     guaranteed background/lock-survivable substrate on old iOS (LEGACY, and MID without
//     element.volume). This is the compat fallback and is byte-for-byte the pre-existing path.
// (docs/DESIGN.md §1.2–1.4)

// Relative specifier resolves to /shared/protocol.js in the browser (../.. clamps at origin
// root) AND to repo/shared/protocol.js in Node, so this module is unit-testable.
import { STATES, TIERS, VERBS, usesGain, foregroundVolume, clampGain } from '../../shared/protocol.js';

export class AudioEngine {
  constructor({ tier, caps, onState }) {
    this.tier = tier;
    this.caps = caps || {};
    // MID foreground volume via element.volume — only where the device actually HONORS it
    // (detected by a probe in detectCaps); old iOS ignores element.volume, so it's excluded.
    this.fgVolume = foregroundVolume(tier) && !!this.caps.elementVolume;
    this.onState = onState || (() => {});
    this.el = null;
    this.ctx = null;
    this.gain = null;      // audible bus (GRAPH mode only); its presence IS the mode flag
    this.useBuffer = false; // audible source is a gapless AudioBufferSourceNode (vs the element)
    this._elSrc = null;    // MediaElementSource (GRAPH mode) — kept referenced so it isn't GC'd
    this._elMute = null;   // gain=0 sink for the keep-alive element when the buffer is audible
    this._buf = null;      // decoded AudioBuffer of the current soundscape
    this._bufSrc = null;   // the live looping AudioBufferSourceNode (null ⇒ not looping)
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
    el.addEventListener('error', () => {
      // In GRAPH+buffer mode the element is only a MUTED keep-alive; the audible sound is the buffer,
      // so a keep-alive hiccup must not report ERROR (a false alarm) while audio is actually flowing.
      // Just re-verify liveness. In ELEMENT mode the element IS the audio, so an error is a real fail.
      if (this.useBuffer) {
        console.warn('keep-alive element error (audible buffer is unaffected)');
        const before = this.state; this.reconcileLiveness(); if (this.state !== before) this._emit();
      } else {
        this._fail('audio element error');
      }
    });
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
      try { Promise.resolve(el.play()).then(recheck, recheck); } catch (_e) { recheck(); }
    });

    // Promote the audio session so it plays in the background and OVER the mute switch (16.4+).
    if (typeof navigator !== 'undefined' && 'audioSession' in navigator) {
      try { navigator.audioSession.type = 'playback'; } catch (e) { console.warn('audioSession set failed', e); }
    }

    // The element's first play() MUST fire synchronously in the gesture — awaiting anything
    // (e.g. ctx.resume()) first can consume the transient user-activation and make play() reject.
    this.useBuffer = this._canUseBuffer();
    const graph = this.useBuffer || usesGain(this.tier); // GRAPH mode builds an AudioContext + GainNode
    let playPromise;
    if (graph) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      // If the context is interrupted/suspended out from under us (no visibility event, per above),
      // re-check liveness so a stalled session can never be broadcast as PLAYING. (finding #2)
      this.ctx.addEventListener('statechange', () => {
        const before = this.state;
        this.reconcileLiveness();
        if (this.state !== before) this._emit();
      });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0; // start silent; applyDesired ramps up
      this.gain.connect(this.ctx.destination);
      this._elSrc = this.ctx.createMediaElementSource(el);
      if (this.useBuffer) {
        // Element is a MUTED keep-alive (liveness + iOS interruption signal); the audible sound is
        // the gapless looping buffer routed through the gain bus (started just below).
        this._elMute = this.ctx.createGain();
        this._elMute.gain.value = 0;
        this._elSrc.connect(this._elMute).connect(this.ctx.destination);
      } else {
        this._elSrc.connect(this.gain); // no buffer: the element IS the audible source, via the gain
      }
      playPromise = el.play(); // start synchronously in the gesture, before any await
      await this.ctx.resume(); // synchronous-in-gesture unlock
      if (this.useBuffer) {
        // Decode + start the sample-accurate loop. Safe AFTER the gesture (a buffer source needs a
        // RUNNING context, not user-activation). On any failure, fall back to element-as-audible so
        // the room is never silent just because one decode failed.
        try {
          this._buf = await this._loadBuffer(url);
          this._startBuffer();
        } catch (e) {
          console.warn('gapless buffer unavailable — falling back to <audio> loop', e);
          this.useBuffer = false;
          this._buf = null; this._bufSrc = null;
          try { this._elSrc.disconnect(); } catch (_e) { /* was only connected to the mute sink */ }
          this._elSrc.connect(this.gain); // element becomes the audible source through the gain bus
        }
      }
    } else {
      playPromise = el.play(); // ELEMENT mode: start the unrouted loop synchronously in the gesture
    }
    // Keep it playing forever as the keep-alive substrate; on ELEMENT-mode non-gain tiers "stop" pauses it.
    await playPromise;
    this.armed = true;
    this._setupMediaSession();
    await this._acquireWakeLock();
    return true;
  }

  // Realize a full desired state. Hub/player both derive desired via the shared reducer, so
  // this is the ONLY place audio is actuated — no divergent interpretations.
  async applyDesired(desired) {
    clearTimeout(this._fadeTimer); // a new actuation cancels any in-progress timer fade-out
    if (!this.armed) return;
    if (desired.soundscape && desired.soundscape !== this.currentSoundscape) {
      // Only start audio during the swap if it should be sounding (GRAPH-mode keep-alive, or START);
      // a swap on a STOPPED unrouted device must not resurrect noise.
      await this._swapSoundscape(desired.soundscape, desired.url, !!this.gain || desired.verb === VERBS.START);
    }
    const g = clampGain(desired.gainLinear);
    const on = desired.verb === VERBS.START;
    if (this.gain) {
      // GRAPH mode: the element keeps playing (as the audible source, or as a muted keep-alive when
      // the looping buffer is audible); the GAIN expresses start/stop/volume. The volume TARGET is
      // tier-aware — remote (MODERN) or foreground (MID desktop/Android) volume where the device
      // honors it, else a fixed unity gain (LEGACY-class / fixed-volume devices).
      if (this.el.paused) { try { await this.el.play(); } catch (e) { this._fail(e.message); return; } }
      if (on && this.useBuffer && !this._bufSrc) this._startBuffer(); // (re)start a dropped gapless loop
      const softVolume = usesGain(this.tier) || this.fgVolume;
      this._rampGain(on ? (softVolume ? g : 1) : 0);
      this.currentGain = softVolume ? (on ? g : 0) : (on ? 1 : 0);
      if (on) {
        // Don't report PLAYING unless audio is actually flowing (a suspended ctx = silence).
        if (this.ctx && this.ctx.state !== 'running') {
          try { await this.ctx.resume(); } catch (e) { console.warn('ctx.resume failed', e); }
        }
        this.state = this._isRunning() ? STATES.PLAYING : STATES.REQUIRES_GESTURE;
      } else {
        this.state = STATES.STOPPED;
      }
    } else {
      // ELEMENT mode: unrouted <audio> (LEGACY/MID on old iOS). MID gets best-effort foreground
      // volume via element.volume (honored off-iOS; old iOS ignores it). Stays unrouted, so
      // lock/background playback survives — this is the compat fallback, unchanged.
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

  // Gentle sleep-timer wind-down: ramp to silence over `seconds`, then stop. Only foreground/gain
  // paths can actually fade (a locked device's Web Audio is suspended, and LEGACY volume is fixed),
  // so elsewhere this is a clean stop — we don't pretend to fade what iOS won't let us. Used by the
  // local "This device" player, which is always on-screen.
  fadeOutAndStop(seconds = 8) {
    if (!this.armed) return;
    const stop = () => this.applyDesired({ verb: VERBS.STOP, gainLinear: 0, soundscape: this.currentSoundscape });
    if (this.gain && this.ctx && this.ctx.state === 'running') {
      const now = this.ctx.currentTime, p = this.gain.gain;
      p.cancelScheduledValues(now);
      p.setValueAtTime(Math.max(0.0001, p.value), now);
      p.setTargetAtTime(0.0001, now, seconds / 4); // exponential fade, ~silent by `seconds`
      this._fadeTimer = setTimeout(stop, seconds * 1000);
    } else if (this.fgVolume && this.el && !this.el.paused) {
      const start = this.el.volume, steps = Math.max(1, Math.round(seconds * 20)), dt = (seconds * 1000) / steps;
      let k = 0;
      const tick = () => {
        k += 1; this.el.volume = Math.max(0, start * (1 - k / steps));
        this._fadeTimer = k < steps ? setTimeout(tick, dt) : (stop(), null);
      };
      this._fadeTimer = setTimeout(tick, dt);
    } else {
      stop(); // LEGACY / suspended — a fade is impossible here; stop cleanly
    }
  }

  async _swapSoundscape(soundscapeId, url, shouldPlay = true) {
    if (this.useBuffer) {
      // Gapless swap: decode the new loop and replace the looping source on the gain bus. The
      // (muted) keep-alive element's src is deliberately NOT reloaded — reloading a media element's
      // src while backgrounded is exactly what kills iOS lock playback; a buffer swap has no such
      // issue (decoding + starting a source in a running context needs neither a gesture nor
      // visibility). Audibility is gated by the gain, so this stays silent while STOPPED.
      this.currentSoundscape = soundscapeId;
      this._pendingSoundscape = null;
      try {
        this._buf = await this._loadBuffer(url);
        this._startBuffer();
      } catch (e) { this._fail(e.message); }
      return;
    }
    // ELEMENT mode: src swaps are UNSAFE while backgrounded on iOS 15+ (kills lock playback). Defer if hidden.
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
    // Keep the element playing: the audible source in ELEMENT mode, and a keep-alive / iOS
    // interruption signal in GRAPH+buffer mode (where its pause doesn't itself silence the room).
    if (this.el.paused && (this.state === STATES.PLAYING || this.useBuffer)) {
      try { await this.el.play(); } catch (e) { console.warn('recover play blocked', e); }
    }
    // An interruption can tear down the gapless loop; re-arm it once the context is running again.
    if (this.useBuffer && this.state === STATES.PLAYING && this.ctx && this.ctx.state === 'running' && !this._bufSrc) {
      this._startBuffer();
    }
    await this._acquireWakeLock();
    const running = this._isRunning();
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

  // Is audible audio actually flowing right now? In GRAPH+buffer mode the audible source is the
  // looping buffer, so a paused (muted) keep-alive element does NOT mean silence — liveness tracks
  // the context + a live buffer source. Otherwise the element itself is the audible source.
  _isRunning() {
    if (!this.armed || !this.el) return false;
    if (this.useBuffer) return !!this.ctx && this.ctx.state === 'running' && !!this._bufSrc;
    return !this.el.paused && (!this.ctx || this.ctx.state === 'running');
  }

  // Re-verify that a PLAYING claim is real: if audio is NOT flowing (element paused / context not
  // running / buffer torn down), downgrade to REQUIRES_GESTURE (which alarms the parent). Called
  // before every report and from the pause/statechange listeners. Pure w.r.t. anything but state —
  // does NOT emit (callers decide) so it can't recurse through report(). (finding #2)
  reconcileLiveness() {
    if (this.armed && this.state === STATES.PLAYING && !this._isRunning()) {
      this.state = STATES.REQUIRES_GESTURE; this._updateMediaSessionState();
    }
    return this.state;
  }

  // Decide the loop engine. TRUE ⇒ play the loop as a gapless AudioBufferSourceNode; FALSE ⇒ keep
  // the unrouted <audio loop> (the old-iOS fallback that survives a locked screen). We go gapless
  // only where a Web Audio context can KEEP RUNNING in the background: MODERN pins audioSession=
  // 'playback' (16.4+); any non-iOS platform is proven by element.volume being honored (old iOS
  // ignores it, so it never qualifies — exactly the devices that must keep the lock-surviving
  // element). Feature-detected, never version-sniffed, and a wrong guess fails safe (→ element).
  _canUseBuffer() {
    const win = typeof window !== 'undefined' ? window : {};
    if (!(win.AudioContext || win.webkitAudioContext)) return false;
    return usesGain(this.tier) || !!this.caps.audioSession || !!this.caps.elementVolume;
  }

  // Fetch + decode a soundscape URL into an AudioBuffer. Handles BOTH decodeAudioData shapes (modern
  // promise + old callback) so it works across the WebKit range that reaches GRAPH mode.
  async _loadBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('fetch ' + res.status);
    const bytes = await res.arrayBuffer();
    return await new Promise((resolve, reject) => {
      let settled = false;
      const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
      const no = (e) => { if (!settled) { settled = true; reject(e || new Error('decodeAudioData failed')); } };
      try {
        const p = this.ctx.decodeAudioData(bytes, ok, no); // callback form: universal
        if (p && typeof p.then === 'function') p.then(ok, no); // promise form: modern
      } catch (e) { no(e); }
    });
  }

  // (Re)start the sample-accurate looping source feeding the gain bus. A stopped BufferSourceNode is
  // single-use, so recovery creates a fresh node from the same decoded buffer.
  _startBuffer() {
    if (!this.ctx || !this._buf || !this.gain) return;
    try { if (this._bufSrc) { this._bufSrc.onended = null; this._bufSrc.stop(); } } catch (_e) { /* already stopped */ }
    const src = this.ctx.createBufferSource();
    src.buffer = this._buf;
    src.loop = true; // the wrap is sample-accurate in the audio thread → gapless, even while locked
    src.connect(this.gain);
    src.onended = () => { if (this._bufSrc === src) this._bufSrc = null; };
    try { src.start(); } catch (e) { console.warn('buffer start failed', e); }
    this._bufSrc = src;
  }

  _fail(reason) {
    console.error('[audio] failure:', reason);
    this.state = STATES.ERROR; // must never masquerade as playing
    this._emit();
  }

  _setupMediaSession() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: 'White noise', artist: 'Lull', album: 'Nursery',
      });
      navigator.mediaSession.setActionHandler('play', () => this.onIntent && this.onIntent(VERBS.START));
      navigator.mediaSession.setActionHandler('pause', () => this.onIntent && this.onIntent(VERBS.STOP));
    } catch (e) { console.warn('mediaSession setup failed', e); }
  }

  _updateMediaSessionState() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = this.state === STATES.PLAYING ? 'playing' : 'paused';
    } catch (_e) { /* older iOS lacks playbackState — non-fatal, handler is what matters */ }
  }

  async _acquireWakeLock() {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
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
