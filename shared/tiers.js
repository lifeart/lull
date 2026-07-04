// Capability detection + per-tier UI affordances.
// Shared by the player (to report caps) and the controller (to show the right controls).
// Safe to import in Node (globals are guarded) so tests can exercise it.

import { TIERS, tierFromCaps, usesGain, foregroundVolume } from './protocol.js';

// Installed to the Home Screen (standalone). matchMedia with an unknown feature is guarded because a
// very old WebKit can throw on an unrecognized media query rather than returning no-match.
function isStandalone(win, nav) {
  if (nav && nav.standalone === true) return true;
  try {
    if (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (e) { /* old engine — treat as not-standalone */ }
  return false;
}

// Feature-detect on the device. NEVER version-sniff the user agent.
export function detectCaps() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};
  const hasAudioCtx = !!(win.AudioContext || win.webkitAudioContext);
  // Probe whether element.volume is actually honored — old iOS silently ignores it (getter
  // stays 1.0), so we only offer a MID foreground-volume slider where it truly works.
  let elementVolume = false;
  try {
    if (typeof win.Audio === 'function') { const a = new win.Audio(); a.volume = 0.5; elementVolume = Math.abs(a.volume - 0.5) < 0.01; }
  } catch (e) { /* no Audio constructor (Node) */ }
  return {
    audioContext: hasAudioCtx,
    gainNode: hasAudioCtx, // GainNode implies an AudioContext
    elementVolume, // element.volume is honored (desktop/Android; not old iOS)
    audioSession: typeof nav === 'object' && 'audioSession' in nav, // iOS 16.4+
    mediaSession: typeof nav === 'object' && 'mediaSession' in nav, // iOS 15+
    wakeLock: typeof nav === 'object' && 'wakeLock' in nav, // iOS 16.4+ (PWA: 18.4+)
    serviceWorker: typeof nav === 'object' && 'serviceWorker' in nav,
    standalone: isStandalone(win, nav),
  };
}

// What each tier can actually do — the single source the Controller UI reads so it never
// shows a volume slider on a device that can't honor it (avoids the "mystery on/off switch").
export function tierControls(tier, caps) {
  const modern = tier === TIERS.MODERN;
  const mid = tier === TIERS.MID;
  const fg = mid && !!(caps && caps.elementVolume); // only where element.volume actually works
  return {
    tier,
    remoteVolume: modern, // GainNode gain + fades; works (best-effort) while locked
    foregroundVolume: fg, // element.volume; screen-on only, honored off-iOS (old iOS ignores it)
    remoteStartFromSilence: modern, // start when currently silent & locked (best-effort)
    overMuteSwitch: modern, // audioSession='playback' plays over the ring switch
    lockScreenControls: mid || modern, // MediaSession
    fixedVolumeNote: !modern && !fg, // no software volume control → hardware buttons at arm time
    startStop: true,
    sleepTimer: true,
  };
}

// One honest sentence per tier about what works while the device's screen is LOCKED.
export function lockSummary(tier) {
  if (tier === TIERS.MODERN) return 'Plays over the mute switch; remote volume & start work while locked (best-effort).';
  if (tier === TIERS.MID) return 'Keeps playing while locked; volume adjustable only with the screen on (old iOS: hardware buttons).';
  return 'Always audible while locked; can’t be started from silence remotely.';
}

export { TIERS, tierFromCaps, usesGain, foregroundVolume };
