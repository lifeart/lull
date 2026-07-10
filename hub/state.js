// Desired/reported state manager + the HUB-OWNED sleep timer.
//
// The sleep timer is authoritative here (not on the flaky player): the hub schedules a
// flip to STOP at the absolute endsAtEpochMs and pushes a fresh snapshot. Combined with
// reconcileTimer() on every read, a reconnect after any outage deterministically computes
// "already elapsed -> stopped" and can NEVER resurrect noise. (docs/DESIGN.md §3.3 / §4)
//
// Every method is scoped by (groupId, deviceId): the store partitions devices per family, and the
// scheduled-timer map is keyed by groupKey() so two families that happen to pick the same deviceId
// keep independent timers.

import {
  applyCommandToDesired,
  reconcileTimer,
  remainingSec,
  groupKey,
  VERBS,
} from '../shared/protocol.js';

const TIMEOUT_MAX = 2147483647; // Node coerces larger setTimeout delays to 1ms — must chunk them.

export class StateManager {
  constructor(store, { onDesiredChanged }) {
    this.store = store;
    this.onDesiredChanged = onDesiredChanged; // (groupId, deviceId, device) => void
    this.timers = new Map(); // groupKey(groupId, deviceId) -> timeout handle
  }

  register({ groupId, deviceId, friendlyName, caps, tier }) {
    const nowMs = Date.now();
    this.store.upsertDevice({ groupId, deviceId, friendlyName, caps, tier }, nowMs);
    // Reconcile any timer that expired while the device was offline.
    this._reconcile(groupId, deviceId, nowMs);
    this._rescheduleTimer(groupId, deviceId);
    return this.store.get(groupId, deviceId);
  }

  applyCommand(groupId, deviceId, cmd) {
    const device = this.store.get(groupId, deviceId);
    if (!device) return null;
    const nextDesired = applyCommandToDesired(device.desired, cmd);
    this.store.setDesired(groupId, deviceId, nextDesired);
    this._rescheduleTimer(groupId, deviceId);
    return this.store.get(groupId, deviceId);
  }

  setReported(groupId, deviceId, reported) {
    return this.store.setReported(groupId, deviceId, reported, Date.now());
  }

  // Reconcile-on-read; persists + reschedules if it flipped.
  _reconcile(groupId, deviceId, nowMs) {
    const device = this.store.get(groupId, deviceId);
    if (!device) return;
    const { desired, changed } = reconcileTimer(device.desired, nowMs);
    if (changed) {
      this.store.setDesired(groupId, deviceId, desired);
      this._clearTimer(groupId, deviceId);
    }
  }

  getDesired(groupId, deviceId) {
    this._reconcile(groupId, deviceId, Date.now());
    const device = this.store.get(groupId, deviceId);
    return device ? device.desired : null;
  }

  // Drop any scheduled sleep-timer for a device being forgotten (store removal is the caller's job).
  forget(groupId, deviceId) {
    this._clearTimer(groupId, deviceId);
  }

  _clearTimer(groupId, deviceId) {
    const k = groupKey(groupId, deviceId);
    const h = this.timers.get(k);
    if (h) {
      clearTimeout(h);
      this.timers.delete(k);
    }
  }

  _rescheduleTimer(groupId, deviceId) {
    this._clearTimer(groupId, deviceId);
    const device = this.store.get(groupId, deviceId);
    if (!device) return;
    const { desired } = device;
    if (desired.verb !== VERBS.START || typeof desired.endsAtEpochMs !== 'number') return;
    const delay = desired.endsAtEpochMs - Date.now();
    if (delay <= 0) {
      this._fireTimer(groupId, deviceId);
      return;
    }
    const k = groupKey(groupId, deviceId);
    // Delays beyond ~24.8 days would overflow setTimeout and fire immediately; chunk and re-check.
    if (delay > TIMEOUT_MAX) {
      const h = setTimeout(() => this._rescheduleTimer(groupId, deviceId), TIMEOUT_MAX);
      if (typeof h.unref === 'function') h.unref();
      this.timers.set(k, h);
      return;
    }
    const h = setTimeout(() => this._fireTimer(groupId, deviceId), delay);
    if (typeof h.unref === 'function') h.unref(); // don't keep the process alive just for a timer
    this.timers.set(k, h);
  }

  _fireTimer(groupId, deviceId) {
    this._clearTimer(groupId, deviceId);
    const device = this.store.get(groupId, deviceId);
    if (!device) return;
    // Re-verify the deadline actually passed before stopping — guards against an early/overflowed
    // fire silencing a still-valid session.
    const { changed } = reconcileTimer(device.desired, Date.now());
    if (!changed) {
      this._rescheduleTimer(groupId, deviceId);
      return;
    }
    const stopped = { ...device.desired, verb: VERBS.STOP, endsAtEpochMs: null };
    this.store.setDesired(groupId, deviceId, stopped);
    const updated = this.store.get(groupId, deviceId);
    if (this.onDesiredChanged) this.onDesiredChanged(groupId, deviceId, updated);
  }

  // Public view for controllers. `online` is injected by the ws layer (it owns sockets).
  view(groupId, deviceId, { online }) {
    const device = this.store.get(groupId, deviceId);
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
