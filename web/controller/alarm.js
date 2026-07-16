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

// Short looping WAVs as data URIs (no asset fetch needed). sampleAt(t) returns the PCM sample
// in [-1, 1] at time t seconds.
function wavDataUri(sampleAt) {
  const sr = 8000, dur = 0.6, n = Math.floor(sr * dur);
  const buf = new Uint8Array(44 + n * 2);
  const view = new DataView(buf.buffer);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  wr(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, sampleAt(i / sr) * 32767, true);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

// The alarm tone: alternating 880/660 Hz square wave — a deliberately alarm-like two-tone.
let toneUri = null;
function alarmToneDataUri() {
  if (!toneUri) toneUri = wavDataUri((t) => {
    const freq = (Math.floor(t / 0.15) % 2) ? 660 : 880;
    return Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.5;
  });
  return toneUri;
}

// Pure digital silence (all-zero PCM) — what the prime plays. Inaudible on EVERY engine no matter
// how `muted`/`volume` are treated, unlike a muted play of the siren tone (see primeAlarm).
function silenceDataUri() { return wavDataUri(() => 0); }

// Must be primed from a user gesture once (browsers block audio otherwise). The controller
// primes it on first interaction. Sets up BOTH sound paths and unlocks the <audio> element.
export function primeAlarm() {
  if (ctx || alarmEl) return; // already primed
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) { ctx = new AC(); ctx.resume().catch(() => {}); }
  try {
    // Unlock the element by playing PURE DIGITAL SILENCE, never the siren tone. iOS ignores
    // `volume` writes on media elements and has a history of not honoring `muted` on <audio>, so a
    // muted play() of the tone can still be audible — the siren blipped on the first tap even after
    // the muted-prime fix (user report: "I hear the alarm when I tap the This-device header after
    // opening the app"). Zero PCM cannot make sound regardless of how muted/volume are treated;
    // muted + volume 0 stay only as a belt for engines that do honor them. We also do NOT switch
    // the audio session to 'playback' here — that too is armed only when a real alarm fires.
    alarmEl = new Audio(silenceDataUri());
    alarmEl.loop = true;
    alarmEl.setAttribute('playsinline', '');
    alarmEl.muted = true;
    alarmEl.volume = 0;
    alarmEl.play().then(() => {
      // If a real alarm fired while the prime's play() was settling, startAlarm has already swapped
      // in the tone and is sounding it — don't pause it. (review finding #3) Deliberate asymmetry:
      // an alarm that went active BEFORE the first tap stays banner-only — the parent is at the
      // phone and looking at it, and the first tap of a night visit must NEVER itself blast the
      // siren (user report: siren mid-night right after opening the app). It sounds normally the
      // next time it's raised after the prime.
      if (active) return;
      alarmEl.pause();
      // Swap in the real tone while the tap's transient user activation is still live, so the load
      // happens under the gesture and the unlock carries over to the alarm sound. The element stays
      // paused + muted — startAlarm() (via soundTheAlarm) is the only place that unmutes and plays.
      alarmEl.src = alarmToneDataUri();
      alarmEl.load();
    }).catch((e) => console.warn('alarm prime play blocked', e));
  } catch (e) { console.warn('alarm element prime failed', e); }
}

// Make the (gesture-unlocked) element blast the tone: arm the over-the-mute-switch session, ensure
// the tone is loaded (the prime may not have swapped it in yet), unmute and play.
function soundTheAlarm() {
  if (!alarmEl) return;
  try {
    if ('audioSession' in navigator) { try { navigator.audioSession.type = 'playback'; } catch (e) { console.warn('alarm audioSession failed', e); } }
    const tone = alarmToneDataUri();
    if (alarmEl.src !== tone) alarmEl.src = tone; // a fresh load starts at 0
    else alarmEl.currentTime = 0;
    alarmEl.muted = false; alarmEl.volume = 1;
    alarmEl.play().catch((e) => console.warn('alarm element play blocked', e));
  } catch (e) { console.warn('alarm play failed', e); }
}

export function startAlarm() {
  if (active) return;
  active = true;
  // Over-mute path (primary on iOS). Arm the playback session NOW (not at prime — see primeAlarm)
  // so the tone plays over the ring/silent switch, then unmute and play. The element kept its
  // gesture-unlock from the silent prime, so the tone plays without a fresh gesture.
  soundTheAlarm();
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
  if (alarmEl) { try { alarmEl.pause(); alarmEl.currentTime = 0; } catch (_e) { /* not started */ } }
  if (osc) { try { clearInterval(gain._pulse); osc.stop(); } catch (_e) { /* already stopped */ } osc = null; gain = null; }
  if (vibrateTimer) { clearInterval(vibrateTimer); vibrateTimer = null; if ('vibrate' in navigator) navigator.vibrate(0); }
}

export function isAlarming() { return active; }
