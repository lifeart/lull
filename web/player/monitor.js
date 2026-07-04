// Baby-monitor "cry meter" (M8a) — the lightweight, telemetry-only path (docs/RESEARCH-BABY-MONITOR.md).
//
// Instead of streaming audio, we run a Web Audio AnalyserNode on the microphone, compute a
// band-limited loudness level (~0..1) a few times a second, and report just that NUMBER over the
// existing WebSocket. The parent's controller renders a meter and alarms on a sustained spike.
//
// Honest limits (surfaced in the UI via availability(), not hidden): capture needs a SECURE CONTEXT,
// mutes when the screen locks (iOS), and — the web-app gotcha — is UNAVAILABLE in a Home-Screen
// (standalone) web app on iOS before 14.3, even though Safari on the same device has it. iOS 10 has no
// working capture at all. Everything degrades gracefully: if the mic is unavailable or denied, the
// monitor reports no level, the button explains why, and nothing breaks.

// getUserMedia across old + new WebKit. Modern path: navigator.mediaDevices.getUserMedia (iOS 11+).
// Older WebKit / Android exposed the callback form directly on navigator; wrap it in a Promise so the
// caller can always `await`. Rejects when no capture API exists at all. (finding: web-app mic support)
function getUserMediaCompat(constraints) {
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) return md.getUserMedia(constraints);
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (legacy) return new Promise(function (resolve, reject) { legacy.call(navigator, constraints, resolve, reject); });
  return Promise.reject(new Error('getUserMedia unavailable'));
}

function hasCaptureApi() {
  const md = navigator.mediaDevices;
  return !!((md && md.getUserMedia) || navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
}

// Installed to the Home Screen (standalone display-mode). iOS hid getUserMedia here until 14.3.
function isStandalone() {
  if (navigator.standalone === true) return true; // iOS Safari's own flag
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (e) { /* old WebKit lacks the display-mode media query — fall through */ }
  return false;
}

// getUserMedia requires a secure context. isSecureContext is the truth where it exists (iOS 11.3+);
// older engines fall back to the origin rules (https, or loopback).
function secureEnough() {
  if (typeof window.isSecureContext === 'boolean') return window.isSecureContext;
  const h = location.hostname;
  return location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

export class Monitor {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.buf = null;
    this.timer = null;
    this.level = 0;
    this.active = false;
    this.lastError = null; // set when a start() attempt fails at runtime (permission, etc.)
  }

  // Why the mic can / can't run on THIS device+context, so the UI can be honest instead of hiding the
  // button. reason ∈ null | 'no-audio' | 'insecure' | 'standalone' | 'no-mic-api'; note is UI copy.
  availability() {
    if (!(window.AudioContext || window.webkitAudioContext)) {
      return { ok: false, reason: 'no-audio', note: 'This browser has no Web Audio — the baby monitor can’t run here.' };
    }
    if (!secureEnough()) {
      return { ok: false, reason: 'insecure', note: 'The baby monitor needs a secure page. Open Lull over https:// (e.g. via the Cloudflare tunnel or DSM’s reverse proxy) to use the mic.' };
    }
    if (!hasCaptureApi()) {
      if (isStandalone()) {
        return { ok: false, reason: 'standalone', note: 'On this iOS version the mic works only in Safari, not the installed app. Open this room in Safari to use the baby monitor.' };
      }
      return { ok: false, reason: 'no-mic-api', note: 'This device can’t capture audio — the baby monitor needs iOS 11 or newer.' };
    }
    return { ok: true, reason: null, note: '' };
  }

  supported() { return this.availability().ok; }

  // MUST be called from within a user gesture (the arm tap) so iOS grants capture.
  async start() {
    if (this.active) return true;
    this.lastError = null;
    if (!this.supported()) { this.lastError = this.availability().reason; return false; }
    try {
      // echo/noise processing ON: iOS routes web capture through the voice pipeline whose echo
      // canceller subtracts the device's OWN output — i.e. it attenuates our white noise, so a cry
      // (loud, non-stationary) stands out. autoGainControl OFF so the meter reflects real loudness.
      this.stream = await getUserMediaCompat({
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
      // Denied/failed capture is distinct from "unsupported" — record the name so the UI can say
      // "blocked, allow it and tap again" vs. a device limitation.
      this.lastError = (e && e.name) || 'error';
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
