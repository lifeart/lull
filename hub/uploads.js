// User-uploaded audio library. Stores files on disk under an uploads dir plus a small JSON
// index, and exposes them as soundscapes (same id→url mechanism as the baked noise loops).

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ext -> mime (also the allowlist of what we accept)
export const AUDIO_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', caf: 'audio/x-caf',
};
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB per file
const MAX_ITEMS = 50;

export class Uploads {
  constructor(dir) {
    this.dir = dir;
    this.index = [];
    this.order = []; // display order of ALL soundscape ids (baked + uploads); missing ids sort last
    this._writing = Promise.resolve();
    this._load();
  }

  _load() {
    const f = path.join(this.dir, 'index.json');
    if (!existsSync(f)) return;
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      this.index = raw.items || [];
      this.order = raw.order || [];
    } catch (err) { console.error('[uploads] index parse failed, starting empty:', err.message); }
  }

  // Await any in-flight index write (graceful shutdown flushes before exit).
  flush() { return this._writing; }

  getOrder() { return this.order.slice(); }
  async setOrder(ids) { this.order = [...new Set((ids || []).filter((x) => typeof x === 'string'))]; await this._persist(); }

  async _persist() {
    const snapshot = JSON.stringify({ items: this.index, order: this.order }, null, 2);
    this._writing = this._writing.catch(() => {}).then(async () => {
      try {
        await fs.mkdir(this.dir, { recursive: true });
        const tmp = path.join(this.dir, 'index.json.tmp');
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, path.join(this.dir, 'index.json'));
      } catch (err) { console.error('[uploads] persist failed:', err.message); }
    });
    return this._writing;
  }

  extAllowed(ext) { return Object.prototype.hasOwnProperty.call(AUDIO_TYPES, String(ext).toLowerCase()); }
  isFull() { return this.index.length >= MAX_ITEMS; }

  // A per-request temp path under the uploads dir (same filesystem → rename is atomic, never a
  // cross-device copy). The caller streams the body here so the whole file is never held in RAM.
  async reserveTempPath(nowMs) {
    await fs.mkdir(this.dir, { recursive: true });
    return path.join(this.dir, `.incoming-${nowMs.toString(36)}${Math.random().toString(36).slice(2, 8)}.part`);
  }

  // Finalize an already-streamed temp file into the library (atomic rename, no re-buffering).
  async commitTemp({ label, ext, tmpPath, nowMs }) {
    ext = String(ext).toLowerCase();
    if (!this.extAllowed(ext)) { await fs.rm(tmpPath, { force: true }); throw new Error('unsupported audio type'); }
    if (this.isFull()) { await fs.rm(tmpPath, { force: true }); throw new Error('upload library full'); }
    const id = 'up-' + nowMs.toString(36) + Math.random().toString(36).slice(2, 6);
    const file = `${id}.${ext}`;
    await fs.rename(tmpPath, path.join(this.dir, file));
    const item = { id, label: (label || 'Track').slice(0, 60), file, ext };
    this.index.push(item);
    await this._persist();
    return { id: item.id, label: item.label, url: `/uploads/${file}`, kind: 'upload' };
  }

  // Soundscape-shaped entries the library endpoint merges with the baked loops.
  list() { return this.index.map((i) => ({ id: i.id, label: i.label, url: `/uploads/${i.file}`, kind: 'upload' })); }

  async add({ label, ext, bytes, nowMs }) {
    ext = String(ext).toLowerCase();
    if (!this.extAllowed(ext)) throw new Error('unsupported audio type');
    if (this.index.length >= MAX_ITEMS) throw new Error('upload library full');
    const id = 'up-' + nowMs.toString(36) + Math.random().toString(36).slice(2, 6);
    const file = `${id}.${ext}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, file), bytes);
    const item = { id, label: (label || 'Track').slice(0, 60), file, ext };
    this.index.push(item);
    await this._persist();
    return { id: item.id, label: item.label, url: `/uploads/${file}`, kind: 'upload' };
  }

  async rename(id, label) {
    const item = this.index.find((x) => x.id === id);
    if (!item) return null;
    item.label = String(label || item.label).slice(0, 60);
    await this._persist();
    return { id: item.id, label: item.label, url: `/uploads/${item.file}`, kind: 'upload' };
  }

  // Only entries in the index (uploads) can be removed — baked noises aren't here, so they're safe.
  async remove(id) {
    const i = this.index.findIndex((x) => x.id === id);
    if (i === -1) return false;
    const [item] = this.index.splice(i, 1);
    this.order = this.order.filter((x) => x !== id); // don't let deleted ids linger in the order
    try { await fs.unlink(path.join(this.dir, item.file)); }
    catch (err) { console.error('[uploads] unlink failed:', err.message); }
    await this._persist();
    return true;
  }
}
