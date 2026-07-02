// Seam guard (per the project's Multi-Agent Integration Rule): every layer must speak the
// SAME verbs/units from the SAME shared module. This catches the classic "controller sends
// 'play' but player handles 'start'" drift that compiles fine and fails at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_VERBS, VERBS } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
// Strip comments so verb words written in prose don't count as code literals.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

const LAYERS = [
  'hub/ws.js', 'hub/state.js',
  'web/player/player.js', 'web/player/audio.js',
  'web/controller/controller.js',
];

test('every layer imports the shared protocol (single source of truth)', () => {
  for (const f of LAYERS) {
    assert.match(read(f), /shared\/protocol\.js/, `${f} must import shared/protocol.js`);
  }
});

test('no raw verb string literals outside shared/protocol.js', () => {
  // Verb VALUES may only be defined in protocol.js; everywhere else must use VERBS.*.
  const values = ALL_VERBS; // ['start','stop','setGain','setTimer','setSoundscape']
  for (const f of [...LAYERS, 'web/player/index.html', 'web/controller/index.html']) {
    const src = stripComments(read(f));
    for (const v of values) {
      const literal = new RegExp(`['"\`]${v}['"\`]`);
      assert.ok(!literal.test(src), `${f} contains raw verb literal "${v}" — use VERBS.* instead`);
    }
  }
});

test('controller only emits verbs that exist in VERBS', () => {
  const src = read('web/controller/controller.js');
  const used = [...src.matchAll(/VERBS\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'controller should reference VERBS.*');
  const known = new Set(Object.keys(VERBS)); // derived from the source of truth, not hardcoded
  for (const u of used) assert.ok(known.has(u), `controller uses unknown VERBS.${u}`);
  // The soundscape switcher must stay wired (baked files + verb exist end-to-end).
  for (const v of ['START', 'STOP', 'SET_GAIN', 'SET_TIMER', 'SET_SOUNDSCAPE']) {
    assert.ok(used.includes(v), `controller should emit VERBS.${v}`);
  }
});

test('player reduces commands via the shared reducer (handles all verbs by construction)', () => {
  assert.match(read('web/player/player.js'), /applyCommandToDesired/, 'player must use applyCommandToDesired');
  assert.match(read('hub/state.js'), /applyCommandToDesired/, 'hub must use the same reducer');
});
