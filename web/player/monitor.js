// Baby-monitor "cry meter" (M8a) — the lightweight, telemetry-only path (docs/RESEARCH-BABY-MONITOR.md).
//
// Instead of streaming audio, we run a Web Audio AnalyserNode on the microphone, compute a
// band-limited loudness level (~0..1) a few times a second, and report just that NUMBER over the
// existing WebSocket. The parent's controller renders a meter and alarms on a sustained spike.
//
// Honest limits (baked into the UI copy, not hidden): capture requires a SECURE CONTEXT and mutes
// when the screen locks (iOS) — so monitor mode is a screen-on, opt-in profile. Starting capture
// flips the iOS audio session (playAndRecord), which can lower/re-colour the noise loop; that's the
// known trade-off. Everything here degrades gracefully: if the mic is unavailable or denied, the
// monitor simply reports no level and nothing breaks.

export class Monitor {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.timer = null;
    this.level = 0;
    this.active = false;
  }

  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext));
  }

  // MUST be called from within a user gesture (the arm tap) so iOS grants capture.
  async start() {
    if (this.active) return true;
    if (!this.supported()) return false;
    try {
      // echo/noise processing ON: iOS routes web capture through the voice pipeline whose echo
      // canceller subtracts the device's OWN output — i.e. it attenuates our white noise, so a cry
      // (loud, non-stationary) stands out. autoGainControl OFF so the meter reflects real loudness.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.buf = new Float32Array(this.analyser.fftSize);
      src.connect(this.analyser);
      this.active = true;
      this._tick();
      return true;
    } catch (e) {
      console.warn('[monitor] getUserMedia failed', e);
      this.stop();
      return false;
    }
  }

  _tick() {
    if (!this.active || !this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    // Map RMS → 0..1 with a gentle compression; smooth so the meter isn't jittery.
    const raw = Math.min(1, rms * 6);
    this.level = this.level * 0.6 + raw * 0.4;
    // setTimeout (not rAF) so the cadence survives a backgrounded-but-alive tab.
    this.timer = setTimeout(() => this._tick(), 400);
  }

  // Current 0..1 level, or null when not actively capturing.
  getLevel() { return this.active ? Math.round(this.level * 1000) / 1000 : null; }

  stop() {
    this.active = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.stream) { try { this.stream.getTracks().forEach((t) => t.stop()); } catch (e) { console.warn('[monitor] track stop', e); } }
    if (this.ctx) { this.ctx.close().catch(() => {}); }
    this.stream = this.ctx = this.analyser = this.buf = null;
    this.level = 0;
  }
}
