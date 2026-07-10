// Store durability (finding: corrupt recovery, atomic write, and the failed-write-doesn't-poison
// -later-writes catch-chain were untested).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { Store } from '../hub/store.js';

const tmp = () => path.join(os.tmpdir(), `mp-store-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

test('corrupt state file -> starts empty, does not throw', () => {
  const f = tmp();
  writeFileSync(f, '{ this is not json');
  const s = new Store(f); // _loadSync catch
  assert.equal(s.listAll().length, 0);
  rmSync(f, { force: true });
});

test('atomic write persists the registry', async () => {
  const f = tmp();
  const s = new Store(f);
  s.upsertDevice({ deviceId: 'a', caps: {}, tier: 'LEGACY' }, 1);
  await s._persist();
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(j.devices.length, 1);
  assert.equal(j.devices[0].deviceId, 'a');
  rmSync(f, { force: true });
});

test('a failed write neither rejects nor poisons later writes', async () => {
  const f = tmp();
  const s = new Store(f);
  s.filePath = '/dev/null/nope/state.json'; // mkdir/write will fail (ENOTDIR)
  await assert.doesNotReject(s._persist(), 'failed write resolves, never rejects');
  s.filePath = f; // recover
  s.upsertDevice({ deviceId: 'b', caps: {}, tier: 'MID' }, 2);
  await s._persist();
  const j = JSON.parse(readFileSync(f, 'utf8'));
  assert.equal(j.devices[0].deviceId, 'b', 'later write still succeeds (chain not poisoned)');
  rmSync(f, { force: true });
});
