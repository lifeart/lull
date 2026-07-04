// The browser apps ship untranspiled (no build step), so their source syntax must parse on the
// oldest iOS we support (10.3 / Safari 10.1). This test fails if any newer syntax slips into web/,
// so "second life for old phones" can't silently regress on the very devices it targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWeb, RULES } from '../pipeline/compat-lint.js';

test('web/ uses only iOS 10.3-safe syntax (no build step to transpile it)', () => {
  const violations = scanWeb();
  const report = violations.map((v) => `  ${v.file}:${v.line}  ${v.rule} (${v.since})\n      ${v.text}`).join('\n');
  assert.equal(violations.length, 0, `Old-iOS-incompatible syntax in web/:\n${report}`);
});

test('the linter actually detects each forbidden construct (guards against a dead rule)', () => {
  const samples = {
    'optional chaining (?.)': 'const y = a?.b;',
    'nullish coalescing (??)': 'const y = a ?? b;',
    'optional catch binding (catch {)': 'try { f(); } catch { g(); }',
    'object spread ({ ...x })': 'const y = { ...a, b: 1 };',
    'Array.flat / flatMap': 'const y = a.flat();',
  };
  for (const [name, code] of Object.entries(samples)) {
    const rule = RULES.find((r) => r.name === name);
    assert.ok(rule, `rule "${name}" exists`);
    assert.ok(rule.re.test(code), `rule "${name}" should match: ${code}`);
  }
});
