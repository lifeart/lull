// Desired/reported state manager + the HUB-OWNED sleep timer.
//
// The sleep timer is authoritative here (not on the flaky player): the hub schedules a
// flip to STOP at the absolute endsAtEpochMs and pushes a fresh snapshot. Combined with
// reconcileTimer() on every read, a reconnect after any outage deterministically computes
// "already elapsed -> stopped" and can NEVER resurrect noise. (docs/DESIGN.md §3.3 / §4)

import {
  applyCommandToDesired,
  reconcileTimer,
  remainingSec,
  VERBS,
} from '../shared/protocol.js';

const TIMEOUT_MAX = 2147483647; // Node coerces larger setTimeout delays to 1ms — must chunk them.

export class StateManager {
  constructor(store, { onDesiredChanged }) {
    this.store = store;
    this.onDesiredChanged = onDesiredChanged; // (deviceId, device) => void
    this.timers = new Map(); // deviceId -> timeout handle
  }

  register({ deviceId, friendlyName, caps, tier }) {
    const nowMs = Date.now();
    const device = this.store.upsertDevice({ deviceId, friendlyName, caps, tier }, nowMs);
    // Reconcile any timer that expired while the device was offline.
    this._reconcile(deviceId, nowMs);
    this._rescheduleTimer(deviceId);
    return this.store.get(deviceId);
  }

  applyCommand(deviceId, cmd) {
    const device = this.store.get(deviceId);
    if (!device) return null;
    const nextDesired = applyCommandToDesired(device.desired, cmd);
    this.store.setDesired(deviceId, nextDesired);
    this._rescheduleTimer(deviceId);
    return this.store.get(deviceId);
  }

  setReported(deviceId, reported) {
    return this.store.setReported(deviceId, reported, Date.now());
  }

  // Reconcile-on-read; persists + reschedules if it flipped.
  _reconcile(deviceId, nowMs) {
    const device = this.store.get(deviceId);
    if (!device) return;
    const { desired, changed } = reconcileTimer(device.desired, nowMs);
    if (changed) {
      this.store.setDesired(deviceId, desired);
      this._clearTimer(deviceId);
    }
  }

  getDesired(deviceId) {
    this._reconcile(deviceId, Date.now());
    const device = this.store.get(deviceId);
    return device ? device.desired : null;
  }

  // Drop any scheduled sleep-timer for a device being forgotten (store removal is the caller's job).
  forget(deviceId) {
    this._clearTimer(deviceId);
  }

  _clearTimer(deviceId) {
    const h = this.timers.get(deviceId);
    if (h) {
      clearTimeout(h);
      this.timers.delete(deviceId);
    }
  }

  _rescheduleTimer(deviceId) {
    this._clearTimer(deviceId);
    const device = this.store.get(deviceId);
    if (!device) return;
    const { desired } = device;
    if (desired.verb !== VERBS.START || typeof desired.endsAtEpochMs !== 'number') return;
    const delay = desired.endsAtEpochMs - Date.now();
    if (delay <= 0) {
      this._fireTimer(deviceId);
      return;
    }
    // Delays beyond ~24.8 days would overflow setTimeout and fire immediately; chunk and re-check.
    if (delay > TIMEOUT_MAX) {
      const h = setTimeout(() => this._rescheduleTimer(deviceId), TIMEOUT_MAX);
      if (typeof h.unref === 'function') h.unref();
      this.timers.set(deviceId, h);
      return;
    }
    const h = setTimeout(() => this._fireTimer(deviceId), delay);
    if (typeof h.unref === 'function') h.unref(); // don't keep the process alive just for a timer
    this.timers.set(deviceId, h);
  }

  _fireTimer(deviceId) {
    this._clearTimer(deviceId);
    const device = this.store.get(deviceId);
    if (!device) return;
    // Re-verify the deadline actually passed before stopping — guards against an early/overflowed
    // fire silencing a still-valid session.
    const { changed } = reconcileTimer(device.desired, Date.now());
    if (!changed) {
      this._rescheduleTimer(deviceId);
      return;
    }
    const stopped = { ...device.desired, verb: VERBS.STOP, endsAtEpochMs: null };
    this.store.setDesired(deviceId, stopped);
    const updated = this.store.get(deviceId);
    if (this.onDesiredChanged) this.onDesiredChanged(deviceId, updated);
  }

  // Public view for controllers. `online` is injected by the ws layer (it owns sockets).
  view(deviceId, { online }) {
    const device = this.store.get(deviceId);
    if (!device) return null;
    const nowMs = Date.now();
    return {
      deviceId: device.deviceId,
      friendlyName: device.friendlyName,
      caps: device.caps,
      tier: device.tier,
      desired: device.desired,
      reported: device.reported,
      online: !!online,
      lastSeenEpochMs: device.lastSeenEpochMs,
      remainingSec: remainingSec(device.desired, nowMs),
    };
  }
}
