// Old-iOS compatibility linter for the BROWSER code (web/ + shared/). Uses a real parser.
//
// The apps ship as untranspiled ES modules so they run straight from the hub with no build step —
// so the SOURCE syntax must parse on the oldest iOS we support: iOS 10.3 (Safari 10.1), the oldest
// Safari with native ES modules + async/await, and the version every iOS-10-capped device (iPhone
// 5/5c, iPad 4) runs. An earlier regex version of this linter MISSED real breakage (a spread in the
// middle of a literal, an object spread in shared/protocol.js, a top-level await) — so we now parse
// every browser file with acorn at ecmaVersion 2017 (a tight proxy for Safari 10.1: async/await yes,
// ES2018 object-spread / top-level-await / etc. no). A second pass flags runtime APIs that PARSE
// fine but don't exist on iOS 10.3. shared/ is scanned too — the browser imports it. (finding: iOS 10)
//
// Run:  node pipeline/compat-lint.js   (exits 1 on violation)  ·  imported by test/ios-compat.test.js

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['web', 'shared']; // everything the browser loads (web apps + the shared protocol)
const IOS_ECMA = 2017; // Safari 10.1 / iOS 10.3

// Runtime APIs that PARSE as ES2017 but are ABSENT on iOS 10.3 — regex over comment/string-stripped
// source (syntax the parser already covers; these are the missing-method cases it can't).
export const API_RULES = [
  { name: 'Array.flat / flatMap', since: 'iOS 12', re: /\.(flat|flatMap)\s*\(/ },
  { name: 'Object.fromEntries', since: 'iOS 12.2', re: /\bObject\.fromEntries\b/ },
  { name: 'Array/String.at()', since: 'iOS 15.4', re: /\.at\s*\(/ },
  { name: 'String.matchAll / replaceAll', since: 'iOS 13 / 13.4', re: /\.(matchAll|replaceAll)\s*\(/ },
  { name: 'Promise.prototype.finally', since: 'iOS 11.1', re: /\.finally\s*\(/ },
  { name: 'Promise.allSettled / any', since: 'iOS 13 / 15', re: /\bPromise\.(allSettled|any)\b/ },
  { name: 'globalThis', since: 'iOS 12.1', re: /\bglobalThis\b/ },
  { name: 'structuredClone', since: 'iOS 15.4', re: /\bstructuredClone\b/ },
  { name: 'crypto.randomUUID', since: 'iOS 15.4', re: /\brandomUUID\b/ },
];

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

// ES modules (import/export) parse as 'module'; classic scripts (errbar.js, sw.js) as 'script'.
function sourceTypeOf(src) { return /(^|\n)\s*(import|export)\b/.test(src) ? 'module' : 'script'; }

// True if `src` parses at iOS 10.3's ES level (Safari 10.1 ≈ ES2017). Exported for tests.
export function parsesAtIos103(src, sourceType) {
  try { Parser.parse(src, { ecmaVersion: IOS_ECMA, sourceType: sourceType || sourceTypeOf(src) }); return true; }
  catch (e) { return false; }
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

// Returns [{ file, line, rule, since, text }] for every violation across web/ + shared/.
export function scanWeb() {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of listJs(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      const src = readFileSync(file, 'utf8');
      const rawLines = src.split('\n');
      // 1) Syntax: does it parse at iOS 10.3's ES level?
      try {
        Parser.parse(src, { ecmaVersion: IOS_ECMA, sourceType: sourceTypeOf(src) });
      } catch (e) {
        const line = e.loc ? e.loc.line : 0;
        violations.push({
          file: rel, line, since: 'iOS 10.3', rule: 'syntax newer than ES2017',
          text: (e.message || String(e)).replace(/\s*\(\d+:\d+\)\s*$/, ''),
        });
      }
      // 2) Runtime APIs absent on iOS 10.3.
      const clean = strip(src).split('\n');
      clean.forEach((c, i) => {
        for (const rule of API_RULES) {
          if (rule.re.test(c)) violations.push({ file: rel, line: i + 1, rule: rule.name, since: rule.since, text: rawLines[i].trim() });
        }
      });
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = scanWeb();
  if (!v.length) {
    console.log('[compat-lint] web/ + shared/ parse on iOS 10.3+ (Safari 10.1), no post-10.3 APIs.');
    process.exit(0);
  }
  console.error(`[compat-lint] ${v.length} old-iOS incompatibilit${v.length > 1 ? 'ies' : 'y'}:\n`);
  for (const x of v) console.error(`  ${x.file}:${x.line}  ${x.rule} (${x.since})\n      ${x.text}`);
  console.error('\nRewrite these to ES2016-safe syntax / APIs so the apps still run on iOS 10.3 devices.');
  process.exit(1);
}
