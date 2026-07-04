// Old-iOS compatibility linter for the BROWSER code (web/). Zero deps.
//
// The apps ship as untranspiled ES modules so they run straight from the hub with no build step —
// which means the SOURCE syntax must parse on the oldest iOS we support: iOS 10.3 (Safari 10.1), the
// oldest Safari with native ES modules + async/await, and the version every iOS-10-capped device
// (iPhone 5/5c, iPad 4) actually runs. This scanner fails the build if any syntax newer than that
// slips in, so "give the old phones a second life" can't silently regress on the exact devices it
// targets. Node/pipeline code is exempt (it never ships to the browser). (finding: iOS 10 support)
//
// Run:  node pipeline/compat-lint.js   (exits 1 on violation)  ·  imported by test/ios-compat.test.js

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// Object spread/rest ({ ...x }, { a, ...x }) is ES2018 (iOS 11.3); ARRAY spread ([...x]) and call
// spread (f(...x)) are ES2015 and fine. A regex can't tell them apart, so for each "...ident" we scan
// back to its innermost UNCLOSED bracket on the line: only `{` (an object literal — a bare `...` in a
// block is a syntax error, so an enclosing `{` is always an object) is the ES2018 form we must flag.
export function objectSpreadOnLine(line) {
  const re = /\.\.\.[\w$]/g;
  let r;
  while ((r = re.exec(line))) {
    const stack = [];
    for (let j = r.index - 1; j >= 0; j--) {
      const c = line[j];
      if (c === ')' || c === ']' || c === '}') stack.push(c);
      else if (c === '(' || c === '[' || c === '{') {
        if (stack.length) stack.pop();       // matched an inner close
        else { if (c === '{') return true; break; } // innermost enclosing opener: { = object spread
      }
    }
  }
  return false;
}

// Each rule: a name, the iOS version that first shipped it, and a regex run against comment/string-
// stripped source. Patterns are chosen to be specific to code syntax (not prose).
export const RULES = [
  { name: 'optional chaining (?.)', since: 'iOS 13.4', re: /\?\.\s*[\w$([]/ },
  { name: 'nullish coalescing (??)', since: 'iOS 13.4', re: /\?\?/ },
  { name: 'logical assignment (||= &&= ??=)', since: 'iOS 14', re: /(\|\|=|&&=|\?\?=)/ },
  { name: 'optional catch binding (catch {)', since: 'iOS 11.3', re: /\bcatch\s*\{/ },
  { name: 'object spread/rest ({ ...x } or { a, ...x })', since: 'iOS 11.3', fn: objectSpreadOnLine },
  { name: 'Object.fromEntries', since: 'iOS 12.2', re: /\bObject\.fromEntries\b/ },
  { name: 'Array.flat / flatMap', since: 'iOS 12', re: /\.(flat|flatMap)\s*\(/ },
  { name: 'String.matchAll / replaceAll', since: 'iOS 13 / 13.4', re: /\.(matchAll|replaceAll)\s*\(/ },
  { name: 'Array/String.at()', since: 'iOS 15.4', re: /\.at\s*\(/ },
  { name: 'Promise.allSettled / any', since: 'iOS 13 / 15', re: /\bPromise\.(allSettled|any)\b/ },
  { name: 'globalThis', since: 'iOS 12.1', re: /\bglobalThis\b/ },
  { name: 'structuredClone', since: 'iOS 15.4', re: /\bstructuredClone\b/ },
  { name: 'crypto.randomUUID', since: 'iOS 15.4', re: /\brandomUUID\b/ },
  { name: 'numeric separator (1_000)', since: 'iOS 13', re: /\b\d[\d_]*_[\d_]*\b/ },
  { name: 'private class field (.#x)', since: 'iOS 14.5', re: /\.#[\w$]/ },
];

// Strip block comments, line comments, and single/double-quoted strings so prose/URLs/messages can't
// trip a rule. Template literals are KEPT — their ${…} holds real code we want to lint.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')        // // line (the [^:] guard spares http:// in code, rare)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")       // '…'
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');       // "…"
}

function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'assets') out.push(...listJs(p)); }
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Returns [{ file, line, rule, since, text }] for every violation across web/.
export function scanWeb() {
  const violations = [];
  for (const file of listJs(WEB_DIR)) {
    const rel = path.relative(path.join(WEB_DIR, '..'), file);
    const rawLines = readFileSync(file, 'utf8').split('\n');
    const cleanLines = strip(readFileSync(file, 'utf8')).split('\n');
    cleanLines.forEach((clean, i) => {
      for (const rule of RULES) {
        const hit = rule.fn ? rule.fn(clean) : rule.re.test(clean);
        if (hit) violations.push({ file: rel, line: i + 1, rule: rule.name, since: rule.since, text: rawLines[i].trim() });
      }
    });
  }
  return violations;
}

// CLI: report and exit non-zero on any violation.
if (import.meta.url === `file://${process.argv[1]}`) {
  const v = scanWeb();
  if (!v.length) {
    console.log('[compat-lint] web/ is clean — parses on iOS 10.3+ (Safari 10.1).');
    process.exit(0);
  }
  console.error(`[compat-lint] ${v.length} old-iOS incompatibility${v.length > 1 ? 'ies' : 'y'} in web/:\n`);
  for (const x of v) console.error(`  ${x.file}:${x.line}  ${x.rule} (${x.since})\n      ${x.text}`);
  console.error('\nRewrite these to ES2016-safe syntax so the apps still parse on iOS 10.3 devices.');
  process.exit(1);
}
