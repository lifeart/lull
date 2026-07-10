// Durable state store. MVP uses an atomic JSON file (zero native deps → installs cleanly
// on a Pi/NAS with no node-gyp). The API is deliberately narrow so it can be swapped for
// SQLite (WAL) later (see docs/DESIGN.md §5) without touching callers.
//
// Persists the device registry with SEPARATE desired (intent, controller-owned) and
// reported (telemetry, player-owned) — that split is what stops a resync resurrecting noise.
//
// Multi-tenancy: devices are partitioned by groupId (one family per group). In memory this is a
// Map<groupId, Map<deviceId, device>>; on disk it stays a flat `devices` array (each record carries
// its groupId), so the file format is backward-compatible — a pre-multi-tenant device with no
// groupId simply loads into DEFAULT_GROUP. Every accessor is group-scoped so a bare deviceId can
// never resolve across a group boundary (the isolation seam).

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultDesired, DEFAULT_GROUP } from '../shared/protocol.js';

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.groups = new Map(); // groupId -> Map<deviceId, device{ deviceId, groupId, friendlyName, caps, tier, desired, reported, lastSeenEpochMs }>
    this._writing = Promise.resolve();
    this._loadSync();
  }

  _loadSync() {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      for (const d of raw.devices || []) {
        const g = d.groupId || DEFAULT_GROUP; // legacy records predate groups → DEFAULT_GROUP
        d.groupId = g;
        this._groupMap(g).set(d.deviceId, d);
      }
    } catch (err) {
      // Corrupt store: surface loudly, start clean (do not silently swallow).
      console.error(`[store] could not parse ${this.filePath}, starting empty:`, err.message);
    }
  }

  _groupMap(groupId) {
    let m = this.groups.get(groupId);
    if (!m) { m = new Map(); this.groups.set(groupId, m); }
    return m;
  }

  // Serialize writes; atomic via temp file + rename so a crash mid-write can't corrupt state.
  // A failed write is logged, never rethrown, and never poisons later writes: `.catch(()=>{})`
  // isolates each write from the prior one and the returned promise always resolves, so the
  // fire-and-forget call sites can't produce an unhandledRejection that would crash the hub.
  async _persist() {
    const devices = [];
    for (const m of this.groups.values()) for (const d of m.values()) devices.push(d);
    const snapshot = JSON.stringify({ devices }, null, 2);
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

  upsertDevice({ deviceId, groupId = DEFAULT_GROUP, friendlyName, caps, tier }, nowMs) {
    const m = this._groupMap(groupId);
    let d = m.get(deviceId);
    if (!d) {
      d = { deviceId, groupId, friendlyName, caps, tier, desired: defaultDesired(), reported: null, lastSeenEpochMs: nowMs };
      m.set(deviceId, d);
    } else {
      if (friendlyName) d.friendlyName = friendlyName;
      if (caps) d.caps = caps;
      if (tier) d.tier = tier;
      d.lastSeenEpochMs = nowMs;
    }
    this._persist();
    return d;
  }

  setDesired(groupId, deviceId, desired) {
    const d = this.get(groupId, deviceId);
    if (!d) return null;
    d.desired = desired;
    this._persist();
    return d;
  }

  setReported(groupId, deviceId, reported, nowMs) {
    const d = this.get(groupId, deviceId);
    if (!d) return null;
    d.reported = reported;
    d.lastSeenEpochMs = nowMs;
    this._persist();
    return d;
  }

  removeDevice(groupId, deviceId) {
    const m = this.groups.get(groupId);
    if (!m || !m.has(deviceId)) return false;
    m.delete(deviceId);
    if (!m.size) this.groups.delete(groupId); // don't leak empty group maps
    this._persist();
    return true;
  }

  // Evict devices not seen since (nowMs - maxAgeMs). Guards the registry against ghost
  // deviceIds (iOS ITP storage eviction / reinstalls regenerate a fresh localStorage id) that
  // would otherwise accumulate forever and eventually fill the MAX_DEVICES cap. Returns removed
  // { groupId, deviceId } pairs.
  pruneStale(maxAgeMs, nowMs) {
    if (!(maxAgeMs > 0)) return [];
    const cutoff = nowMs - maxAgeMs;
    const removed = [];
    for (const [groupId, m] of this.groups) {
      for (const [id, d] of m) {
        if (typeof d.lastSeenEpochMs === 'number' && d.lastSeenEpochMs < cutoff) removed.push({ groupId, deviceId: id });
      }
    }
    for (const { groupId, deviceId } of removed) {
      const m = this.groups.get(groupId);
      if (m) { m.delete(deviceId); if (!m.size) this.groups.delete(groupId); }
    }
    if (removed.length) this._persist();
    return removed;
  }

  get(groupId, deviceId) {
    const m = this.groups.get(groupId);
    return (m && m.get(deviceId)) || null;
  }

  list(groupId) {
    const m = this.groups.get(groupId);
    return m ? [...m.values()] : [];
  }

  // Every device across every group (health totals, persistence, admin views).
  listAll() {
    const out = [];
    for (const m of this.groups.values()) for (const d of m.values()) out.push(d);
    return out;
  }

  groupCount() { return this.groups.size; }
  countInGroup(groupId) { const m = this.groups.get(groupId); return m ? m.size : 0; }

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
