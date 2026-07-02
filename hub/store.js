// Durable state store. MVP uses an atomic JSON file (zero native deps → installs cleanly
// on a Pi/NAS with no node-gyp). The API is deliberately narrow so it can be swapped for
// SQLite (WAL) later (see docs/DESIGN.md §5) without touching callers.
//
// Persists the device registry with SEPARATE desired (intent, controller-owned) and
// reported (telemetry, player-owned) — that split is what stops a resync resurrecting noise.

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultDesired } from '../shared/protocol.js';

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.devices = new Map(); // deviceId -> { deviceId, friendlyName, caps, tier, desired, reported, lastSeenEpochMs }
    this._writing = Promise.resolve();
    this._loadSync();
  }

  _loadSync() {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      for (const d of raw.devices || []) this.devices.set(d.deviceId, d);
    } catch (err) {
      // Corrupt store: surface loudly, start clean (do not silently swallow).
      console.error(`[store] could not parse ${this.filePath}, starting empty:`, err.message);
    }
  }

  // Serialize writes; atomic via temp file + rename so a crash mid-write can't corrupt state.
  // A failed write is logged, never rethrown, and never poisons later writes: `.catch(()=>{})`
  // isolates each write from the prior one and the returned promise always resolves, so the
  // fire-and-forget call sites can't produce an unhandledRejection that would crash the hub.
  async _persist() {
    const snapshot = JSON.stringify({ devices: [...this.devices.values()] }, null, 2);
    this._writing = this._writing
      .catch(() => {})
      .then(async () => {
        try {
          const tmp = `${this.filePath}.tmp`;
          await fs.mkdir(path.dirname(this.filePath), { recursive: true });
          await fs.writeFile(tmp, snapshot);
          await fs.rename(tmp, this.filePath);
          this._persistOk = true;
        } catch (err) {
          this._persistOk = false;
          console.error('[store] persist failed:', err.message); // surface loudly, do not rethrow
        }
      });
    return this._writing;
  }

  upsertDevice({ deviceId, friendlyName, caps, tier }, nowMs) {
    let d = this.devices.get(deviceId);
    if (!d) {
      d = { deviceId, friendlyName, caps, tier, desired: defaultDesired(), reported: null, lastSeenEpochMs: nowMs };
      this.devices.set(deviceId, d);
    } else {
      if (friendlyName) d.friendlyName = friendlyName;
      if (caps) d.caps = caps;
      if (tier) d.tier = tier;
      d.lastSeenEpochMs = nowMs;
    }
    this._persist();
    return d;
  }

  setDesired(deviceId, desired) {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    d.desired = desired;
    this._persist();
    return d;
  }

  setReported(deviceId, reported, nowMs) {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    d.reported = reported;
    d.lastSeenEpochMs = nowMs;
    this._persist();
    return d;
  }

  removeDevice(deviceId) {
    if (!this.devices.has(deviceId)) return false;
    this.devices.delete(deviceId);
    this._persist();
    return true;
  }

  // Evict devices not seen since (nowMs - maxAgeMs). Guards the registry against ghost
  // deviceIds (iOS ITP storage eviction / reinstalls regenerate a fresh localStorage id) that
  // would otherwise accumulate forever and eventually fill the MAX_DEVICES cap. Returns removed ids.
  pruneStale(maxAgeMs, nowMs) {
    if (!(maxAgeMs > 0)) return [];
    const cutoff = nowMs - maxAgeMs;
    const removed = [];
    for (const [id, d] of this.devices) {
      if (typeof d.lastSeenEpochMs === 'number' && d.lastSeenEpochMs < cutoff) removed.push(id);
    }
    for (const id of removed) this.devices.delete(id);
    if (removed.length) this._persist();
    return removed;
  }

  get(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  list() {
    return [...this.devices.values()];
  }

  // Await any in-flight persist so a caller (graceful shutdown) can guarantee the last state
  // change hit disk before exit. Safe to call repeatedly.
  flush() {
    return this._writing;
  }

  // True if the last persist attempt succeeded (surfaced in /api/health so an unwritable
  // /data volume can't masquerade as healthy while every state change is silently lost).
  get persistHealthy() {
    return this._persistOk !== false;
  }
}
