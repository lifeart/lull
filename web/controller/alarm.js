// Foreground alarm on the PARENT's phone — the reliability backstop. When a nursery device
// stops ACKing (dead tab / dropped Wi-Fi), we cannot revive it remotely; we make noise on the
// awake parent's device instead. (docs/DESIGN.md §2)
//
// Two sound paths, for coverage across devices:
//  1. A looping <audio> element driven by navigator.audioSession.type='playback' — this is the
//     ONLY path that plays OVER the iOS ring/silent switch (16.4+), so the alarm is audible even
//     if the parent's phone is on silent. It's primed (unlocked) during the first user gesture.
//  2. A Web Audio square-wave oscillator + navigator.vibrate — richer on desktop/Android, but the
//     oscillator is muted by the iOS silent switch and vibrate is a no-op on iOS Safari, so it's a
//     supplement, not the iOS story. (finding #8)

let ctx = null;
let osc = null;
let gain = null;
let vibrateTimer = null;
let active = false;
let alarmEl = null;

// A short looping alarm tone as a data URI (no asset fetch needed). Alternating 880/660 Hz square
// wave — a deliberately alarm-like two-tone. Generated once.
function alarmToneDataUri() {
  const sr = 8000, dur = 0.6, n = Math.floor(sr * dur);
  const buf = new Uint8Array(44 + n * 2);
  const view = new DataView(buf.buffer);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  wr(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const freq = (Math.floor(t / 0.15) % 2) ? 660 : 880;
    const s = Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.5;
    view.setInt16(44 + i * 2, s * 32767, true);
  }
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

// Must be primed from a user gesture once (browsers block audio otherwise). The controller
// primes it on first interaction. Sets up BOTH sound paths and unlocks the <audio> element.
export function primeAlarm() {
  if (ctx || alarmEl) return; // already primed
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) { ctx = new AC(); ctx.resume().catch(() => {}); }
  try {
    alarmEl = new Audio(alarmToneDataUri());
    alarmEl.loop = true;
    alarmEl.setAttribute('playsinline', '');
    // Over-mute: play the alarm through the media session so the ring/silent switch can't gag it.
    if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch (e) { console.warn('alarm audioSession failed', e); } }
    // Unlock the element inside this gesture so a later, gesture-less alarm can start it. Guard the
    // callback so if an alarm has ALREADY started (startAlarm raced the still-pending prime) we
    // neither pause it nor leave it muted — the first alarm must always be audible. (review finding #3)
    alarmEl.muted = true;
    alarmEl.play().then(() => { if (!active) { alarmEl.pause(); alarmEl.currentTime = 0; } alarmEl.muted = false; })
      .catch(() => { alarmEl.muted = false; });
  } catch (e) { console.warn('alarm element prime failed', e); }
}

export function startAlarm() {
  if (active) return;
  active = true;
  // Over-mute path (primary on iOS). Force unmute in case a prime is still in flight. (review finding #3)
  if (alarmEl) {
    try { alarmEl.muted = false; alarmEl.currentTime = 0; alarmEl.play().catch(() => {}); } catch (e) { console.warn('alarm play failed', e); }
  }
  if (ctx) {
    // The context may have been suspended while the phone was idle/backgrounded — exactly when
    // the alarm matters. Resume it (async is fine; nodes started on a suspended ctx sound once
    // it resumes).
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    osc = ctx.createOscillator();
    gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    // pulse the gain
    let on = false;
    gain._pulse = setInterval(() => {
      on = !on;
      gain.gain.setTargetAtTime(on ? 0.2 : 0.0001, ctx.currentTime, 0.01);
      osc.frequency.setValueAtTime(on ? 880 : 660, ctx.currentTime);
    }, 500);
  }
  if ('vibrate' in navigator) {
    const buzz = () => navigator.vibrate([400, 200, 400]);
    buzz();
    vibrateTimer = setInterval(buzz, 1500);
  }
}

export function stopAlarm() {
  active = false;
  if (alarmEl) { try { alarmEl.pause(); alarmEl.currentTime = 0; } catch { /* not started */ } }
  if (osc) { try { clearInterval(gain._pulse); osc.stop(); } catch { /* already stopped */ } osc = null; gain = null; }
  if (vibrateTimer) { clearInterval(vibrateTimer); vibrateTimer = null; if ('vibrate' in navigator) navigator.vibrate(0); }
}

export function isAlarming() { return active; }
