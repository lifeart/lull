// The browser apps ship untranspiled (no build step), so their source syntax must parse on the
// oldest iOS we support (10.3 / Safari 10.1). This test fails if any newer syntax or API slips into
// web/ OR shared/ (the browser imports shared/protocol.js + shared/tiers.js). The linter parses with
// acorn at ecmaVersion 2017 — a real parser, after a regex version missed real breakage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWeb, API_RULES, parsesAtIos103 } from '../pipeline/compat-lint.js';

test('web/ + shared/ use only iOS 10.3-safe syntax and APIs (no build step to transpile)', () => {
  const violations = scanWeb();
  const report = violations.map((v) => `  ${v.file}:${v.line}  ${v.rule} (${v.since})\n      ${v.text}`).join('\n');
  assert.equal(violations.length, 0, `Old-iOS-incompatible code:\n${report}`);
});

test('the ES2017 parser accepts iOS 10.3 syntax and rejects newer syntax', () => {
  // Allowed on Safari 10.1 (iOS 10.3):
  assert.ok(parsesAtIos103('async function f() { await g(); return [...a]; }', 'module'), 'async/await + array spread');
  assert.ok(parsesAtIos103('import { x } from "./m.js"; export const y = 1;', 'module'), 'ES modules');
  assert.ok(parsesAtIos103('try { f(); } catch (e) { g(); }', 'script'), 'bound catch');
  // Rejected — the exact things that slipped past the old regex lint and broke real devices:
  assert.ok(!parsesAtIos103('const d = { ...o };', 'module'), 'object spread (ES2018)');
  assert.ok(!parsesAtIos103('const d = { a, ...o };', 'module'), 'mid-literal object spread');
  assert.ok(!parsesAtIos103('await loadSoundscapes();', 'module'), 'top-level await (iOS 15)');
  assert.ok(!parsesAtIos103('const y = a?.b;', 'module'), 'optional chaining (iOS 13.4)');
  assert.ok(!parsesAtIos103('const y = a ?? b;', 'module'), 'nullish coalescing (iOS 13.4)');
  assert.ok(!parsesAtIos103('try { f(); } catch { g(); }', 'script'), 'optional catch binding (iOS 11.3)');
});

test('runtime-API rules detect methods missing on iOS 10.3', () => {
  const samples = {
    'Array.flat / flatMap': 'const y = a.flat();',
    'Object.fromEntries': 'const o = Object.fromEntries(e);',
    'structuredClone': 'const c = structuredClone(o);',
  };
  for (const [name, code] of Object.entries(samples)) {
    const rule = API_RULES.find((r) => r.name === name);
    assert.ok(rule, `rule "${name}" exists`);
    assert.ok(rule.re.test(code), `rule "${name}" should match: ${code}`);
  }
});
