// mesh-playback wire protocol — the ONE shared contract.
//
// Imported unchanged by the hub (Node), the Player PWA, and the Controller PWA
// (served at /shared/protocol.js). This is the single source of truth for
// message shapes, verb names, and units, so parallel layers cannot drift.
// Rule: no layer may hard-code a verb string or state string — always use the
// constants below. `test/seam.test.js` enforces this by scanning the sources.
//
// Units are baked into field names on purpose: gainLinear (0..1), endsAtEpochMs
// (absolute wall-clock ms), remainingSec (seconds). No ambiguous "volume"/"time".

export const PROTOCOL_VERSION = 1;

export const ROLES = Object.freeze({ PLAYER: 'player', CONTROLLER: 'controller' });

// Message envelope types (field `t`).
export const MSG = Object.freeze({
  HELLO: 'hello', // client -> hub  : identify (role, deviceId, caps)
  WELCOME: 'welcome', // hub -> client : accepted; controller also gets full registry
  SNAPSHOT: 'snapshot', // hub -> player : authoritative desired state (REPLACE-ALL) on every connect
  COMMAND: 'command', // controller -> hub -> player : intent delta (needs ACK)
  ACK: 'ack', // player -> hub -> controller : echoes cmdId (ok/false + error)
  REPORT: 'report', // player -> hub -> controllers : telemetry (player-owned)
  DEVICES: 'devices', // hub -> controllers : registry + live state broadcast
  PROBE: 'probe', // controller -> hub -> player -> ack : bedtime pre-flight liveness
  PING: 'ping', // hub -> client : app-level heartbeat (a dead iOS socket fires no close)
  PONG: 'pong', // client -> hub : heartbeat reply
  LIBRARY: 'library', // hub -> clients : the sound library changed (uploaded track added) → refetch
  ERROR: 'error', // hub -> client : protocol/validation error
});

// The ONLY command verbs. Controller emits a subset; player handles all; hub relays all.
export const VERBS = Object.freeze({
  START: 'start',
  STOP: 'stop',
  SET_GAIN: 'setGain',
  SET_TIMER: 'setTimer',
  SET_SOUNDSCAPE: 'setSoundscape',
});
export const ALL_VERBS = Object.freeze(Object.values(VERBS));

// Reported player states.
export const STATES = Object.freeze({
  ARMING: 'arming', // before the unlock gesture
  PLAYING: 'playing',
  STOPPED: 'stopped',
  REQUIRES_GESTURE: 'requires_gesture', // tab was reloaded/reclaimed; audio re-locked, needs a tap
  ERROR: 'error', // asset 404 / stalled / decode failure — must NEVER masquerade as playing
});

// Capability tiers (see docs/DESIGN.md §1.7). Detected from feature presence, never version-sniffed.
export const TIERS = Object.freeze({
  LEGACY: 'LEGACY', // iOS 12–15.3-ish: always-audible loop, fixed volume, start/stop + timer
  MID: 'MID', // 15.4–16.3: background audio + MediaSession, fixed volume
  MODERN: 'MODERN', // 16.4+: GainNode remote volume/fades, over-mute playback, remote start-from-silence (best-effort)
});

// Safety + defaults. GAIN_SOFT_CAP caps the DIGITAL signal (not acoustic SPL — see docs safety note).
export const GAIN_SOFT_CAP = 0.6;
export const GAIN_DEFAULT = 0.3;
export const SOUNDSCAPE_DEFAULT = 'white';

// Timing.
export const ACK_TIMEOUT_MS = 3000; // controller alarms if a command isn't ACKed within this
export const HEARTBEAT_MS = 25000; // hub pings each socket this often
export const HEARTBEAT_GRACE_MS = 12000; // ...and marks it offline if no pong arrives within this
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15000;

// ---- Pure helpers (shared reducers/validators so hub & player interpret intent identically) ----

export function clampGain(g) {
  const n = Number(g);
  if (!Number.isFinite(n)) return GAIN_DEFAULT;
  return Math.min(GAIN_SOFT_CAP, Math.max(0, n));
}

export function tierFromCaps(caps) {
  if (!caps) return TIERS.LEGACY;
  if (caps.audioSession) return TIERS.MODERN;
  if (caps.mediaSession) return TIERS.MID;
  return TIERS.LEGACY;
}

// Only MODERN devices route through a GainNode for remote volume/fades and can be
// started-from-silence remotely. Others play an unrouted element at a fixed volume.
export function usesGain(tier) {
  return tier === TIERS.MODERN;
}

// MID uses element.volume as a best-effort, foreground-only volume (honored off-iOS; old iOS
// ignores it). It stays UNROUTED so background/lock playback is preserved.
export function foregroundVolume(tier) {
  return tier === TIERS.MID;
}

// A device answers the bedtime pre-flight only if it's armed AND in an audible-capable state.
// REQUIRES_GESTURE (needs a tap) / ERROR / ARMING must FAIL so a silent room can't pass.
export function probeAudibleReady(armed, state) {
  return !!armed && (state === STATES.PLAYING || state === STATES.STOPPED);
}

export function defaultDesired() {
  return {
    verb: VERBS.STOP,
    gainLinear: GAIN_DEFAULT,
    soundscape: SOUNDSCAPE_DEFAULT,
    endsAtEpochMs: null,
  };
}

// The anti-drift core: hub AND player both reduce a command onto desired state
// with THIS function, so intent can never be interpreted two different ways.
// Returns a NEW desired object (does not mutate input).
export function applyCommandToDesired(desired, cmd) {
  const d = { ...desired };
  switch (cmd.verb) {
    case VERBS.START:
      d.verb = VERBS.START;
      if (cmd.endsAtEpochMs !== undefined) d.endsAtEpochMs = cmd.endsAtEpochMs == null ? null : Number(cmd.endsAtEpochMs);
      if (cmd.gainLinear !== undefined) d.gainLinear = clampGain(cmd.gainLinear);
      break;
    case VERBS.STOP:
      d.verb = VERBS.STOP;
      d.endsAtEpochMs = null;
      break;
    case VERBS.SET_GAIN:
      d.gainLinear = clampGain(cmd.gainLinear);
      break;
    case VERBS.SET_TIMER:
      if (cmd.endsAtEpochMs !== undefined) {
        d.endsAtEpochMs = cmd.endsAtEpochMs == null ? null : Number(cmd.endsAtEpochMs);
      }
      if (d.endsAtEpochMs && d.verb === VERBS.STOP) d.verb = VERBS.START; // "sleep for N" implies play now
      break;
    case VERBS.SET_SOUNDSCAPE:
      d.soundscape = String(cmd.soundscape || SOUNDSCAPE_DEFAULT);
      break;
    default:
      throw new Error(`unknown verb: ${cmd.verb}`);
  }
  return d;
}

// Hub-owned sleep timer: if the absolute deadline has passed, desired is authoritatively
// stopped. Called before every snapshot send AND on a live timer, so a 3am reconnect can
// NEVER resurrect noise. Returns { desired, changed }.
export function reconcileTimer(desired, nowMs) {
  if (
    desired.verb === VERBS.START &&
    typeof desired.endsAtEpochMs === 'number' &&
    nowMs >= desired.endsAtEpochMs
  ) {
    return { desired: { ...desired, verb: VERBS.STOP, endsAtEpochMs: null }, changed: true };
  }
  return { desired, changed: false };
}

export function remainingSec(desired, nowMs) {
  if (desired.verb !== VERBS.START || typeof desired.endsAtEpochMs !== 'number') return null;
  return Math.max(0, Math.round((desired.endsAtEpochMs - nowMs) / 1000));
}

export function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'command not an object' };
  if (!ALL_VERBS.includes(cmd.verb)) return { ok: false, error: `unknown verb: ${cmd.verb}` };
  if (typeof cmd.target !== 'string' || !cmd.target) return { ok: false, error: 'missing target' };
  if (cmd.verb === VERBS.SET_GAIN && !Number.isFinite(Number(cmd.gainLinear)))
    return { ok: false, error: 'setGain needs numeric gainLinear' };
  // A timer deadline may arrive as durationMs (relative, hub re-bases to its own clock) or
  // endsAtEpochMs (absolute). Validate BOTH for every verb that can carry one (START too),
  // so a bad value can't silently disable the "never play forever" safety timer.
  if (cmd.durationMs !== undefined && !Number.isFinite(Number(cmd.durationMs)))
    return { ok: false, error: 'durationMs must be numeric' };
  if (cmd.endsAtEpochMs !== undefined && cmd.endsAtEpochMs !== null && !Number.isFinite(Number(cmd.endsAtEpochMs)))
    return { ok: false, error: 'endsAtEpochMs must be a number or null' };
  if (cmd.verb === VERBS.SET_TIMER && cmd.durationMs === undefined && cmd.endsAtEpochMs === undefined)
    return { ok: false, error: 'setTimer needs durationMs or endsAtEpochMs' };
  return { ok: true };
}

// Decide whether a START-intent command failed to reach audible playback, so its ACK must NACK
// (and the controller alarms the parent). Keyed on the COMMAND verb, not the reduced desired verb:
// a routine SET_GAIN / SET_SOUNDSCAPE / STOP on an already-silent (desired=START) device applied
// fine and must ACK ok — otherwise every volume nudge would NACK and re-blare the alarm.
// (findings #4 + review #2)
export function startIntentFailed(cmdVerb, reducedVerb, realizedState) {
  const startIntent = cmdVerb === VERBS.START || (cmdVerb === VERBS.SET_TIMER && reducedVerb === VERBS.START);
  return startIntent && realizedState !== STATES.PLAYING;
}

// Player-side command handling as a pure, Node-testable function: reduce the command onto
// desired and produce the ACK. player.js uses this so the exact wiring under test is the
// wiring that runs in production (the DOM side-effect `realize()` stays in player.js).
export function reduceCommand(desired, msg, deviceId) {
  try {
    const next = applyCommandToDesired(desired, msg);
    return { desired: next, ack: makeAck({ deviceId, cmdId: msg.cmdId, ok: true }), ok: true };
  } catch (e) {
    return { desired, ack: makeAck({ deviceId, cmdId: msg.cmdId, ok: false, error: e.message }), ok: false };
  }
}

// ---- Envelope builders (use these everywhere; never build message literals by hand) ----

export function newId(prefix = 'id') {
  // Runtime randomness is fine here (NOT a workflow script).
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export const makeHello = ({ role, deviceId, friendlyName, caps }) => ({
  t: MSG.HELLO, v: PROTOCOL_VERSION, role, deviceId, friendlyName, caps,
});
export const makeWelcome = ({ serverEpochMs, devices }) => ({
  t: MSG.WELCOME, serverEpochMs, devices,
});
export const makeSnapshot = ({ deviceId, desired, serverEpochMs }) => ({
  t: MSG.SNAPSHOT, deviceId, desired, serverEpochMs,
});
export const makeCommand = ({ target, verb, gainLinear, endsAtEpochMs, durationMs, soundscape, cmdId }) => {
  const m = { t: MSG.COMMAND, target, verb, cmdId: cmdId || newId('cmd') };
  if (gainLinear !== undefined) m.gainLinear = gainLinear;
  if (endsAtEpochMs !== undefined) m.endsAtEpochMs = endsAtEpochMs;
  if (durationMs !== undefined) m.durationMs = durationMs;
  if (soundscape !== undefined) m.soundscape = soundscape;
  return m;
};
export const makeAck = ({ deviceId, cmdId, ok, error }) => ({
  t: MSG.ACK, deviceId, cmdId, ok: !!ok, error: error || null,
});
export const makeReport = ({ deviceId, state, gainLinear, remainingSec, soundscape, tier, micLevel }) => {
  const m = { t: MSG.REPORT, deviceId, state, gainLinear, remainingSec, soundscape, tier };
  if (micLevel !== undefined && micLevel !== null) m.micLevel = micLevel; // 0..1 room loudness (baby monitor, M8a)
  return m;
};
export const makeDevices = ({ devices }) => ({ t: MSG.DEVICES, devices });
export const makeProbe = ({ target, cmdId }) => ({ t: MSG.PROBE, target, cmdId: cmdId || newId('probe') });
