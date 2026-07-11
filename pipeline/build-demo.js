// Assemble the static GitHub Pages demo into ./_site.
//
// The demo runs the UNMODIFIED Player + Controller PWAs against an in-browser mock hub
// (demo/mock-hub.js). This script copies the web assets, injects the mock as a module that loads
// BEFORE the app, rewrites the app's absolute (/…) asset paths to page-relative so it works under
// a project-pages subpath (…github.io/<repo>/), and disables the service worker for the demo.
//
// Run: npm run build:demo   (bake runs first so the baked loops/icons exist).

import { execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '_site');
const R = (...p) => path.join(ROOT, ...p);
const O = (...p) => path.join(OUT, ...p);

// 1) Make sure the baked loops + icons exist (idempotent).
if (!existsSync(R('web', 'player', 'assets', 'manifest.json')) || !existsSync(R('web', 'icon-180.png'))) {
  console.log('[demo] baking assets…');
  execSync('node pipeline/bake.js', { cwd: ROOT, stdio: 'inherit' });
}

// 2) Fresh output dir with the web app + shared modules + the mock hub.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(R('web'), OUT, { recursive: true });            // player/, controller/, app.css, icons, assets
cpSync(R('shared'), O('shared'), { recursive: true }); // /shared/*.js the app imports
mkdirSync(O('demo'), { recursive: true });
cpSync(R('demo', 'mock-hub.js'), O('demo', 'mock-hub.js'));
cpSync(R('demo', 'rtc-hub.js'), O('demo', 'rtc-hub.js')); // WebRTC transport (inert unless ?rtc)

// 3) Landing = the showcase intro (screenshots + an embedded live demo); the full-screen
//    Player+Controller demo lives at /live/. Screenshots are served from /shots/.
cpSync(R('demo', 'shots'), O('shots'), { recursive: true });
cpSync(R('demo', 'intro.html'), O('index.html'));
mkdirSync(O('live'), { recursive: true });
cpSync(R('demo', 'index.html'), O('live', 'index.html'));
mkdirSync(O('rtc'), { recursive: true }); // WebRTC-transport prototype (loads the apps with ?rtc)
cpSync(R('demo', 'rtc.html'), O('rtc', 'index.html'));

// 4) Patch the two app shells + their JS so they run under a subpath with the mock, no SW.
const edit = (file, fn) => { writeFileSync(file, fn(readFileSync(file, 'utf8'))); };

// Absolute /-rooted asset refs → page-relative (all app files live one dir below the site root).
// NOTE: keep this allowlist in sync with every root-absolute ref the apps use — `icons.js` (the SVG
// icon module) was added later and, until listed here, shipped as `/icons.js` → 404 under the
// project-pages subpath. The post-build guard below fails loudly if a root import ever slips through.
const toRelative = (s) => s.replace(/(["'(=])\/(shared\/|icons\.js|app\.css|icon-\d+\.png|player\/assets\/)/g, '$1../$2');
// The mock must patch WebSocket/fetch before the app module runs → inject it first.
// rtc-hub must load BEFORE mock-hub (it may install the WebRTC bus on self.__MP_BUS__ that mock-hub reads).
const injectMock = (html, appSrc) =>
  html.replace(`<script type="module" src="${appSrc}"></script>`,
    `<script type="module" src="../demo/rtc-hub.js"></script>\n  <script type="module" src="../demo/mock-hub.js"></script>\n  <script type="module" src="${appSrc}"></script>`);
// The demo has no server to serve the SW's cached shell paths → don't register it.
const disableSw = (s) => s.replace(/navigator\.serviceWorker\.register\('sw\.js'\)/g, 'Promise.resolve()');

edit(O('player', 'index.html'), (s) => injectMock(toRelative(s), 'player.js'));
edit(O('controller', 'index.html'), (s) => injectMock(toRelative(s), 'controller.js'));
edit(O('player', 'player.js'), (s) => disableSw(toRelative(s)));
edit(O('controller', 'controller.js'), (s) => disableSw(toRelative(s)));
// audio.js imports `../../shared/protocol.js` — a trick that CLAMPS to `/shared/…` at origin root (and
// resolves for Node tests). That breaks under a project-pages SUBPATH (…/lull/), where it still clamps to
// the origin root → /shared/protocol.js (404). Normalize it to `../shared/…`, which is correct at both / and /lull/.
edit(O('player', 'audio.js'), (s) => s.replace(/\.\.\/\.\.\/shared\//g, '../shared/'));
edit(O('player', 'manifest.webmanifest'), toRelative);
edit(O('controller', 'manifest.webmanifest'), toRelative);

// 4b) Fail loud on the exact bug that shipped once: a root-absolute import (`from '/…'`) resolves to
//     the DOMAIN root, not the site root, so it 404s under a project-pages subpath (…github.io/<repo>/).
//     After toRelative() every app-module import must be page-relative; if one isn't (e.g. a newly
//     added `/icons.js`), throw so the demo can never deploy broken. (finding: demo subpath 404)
for (const parts of [['player', 'player.js'], ['controller', 'controller.js'], ['player', 'audio.js']]) {
  const rooted = readFileSync(O(...parts), 'utf8').match(/\bfrom\s+['"]\/[^'"]+['"]/g);
  if (rooted) throw new Error(`[demo] ${parts.join('/')} keeps root-absolute import(s) that 404 under a subpath: ${rooted.join(', ')} — add the asset to toRelative()`);
}

// 5) Pages served straight (no Jekyll processing of the _-prefixed dirs / underscores).
writeFileSync(O('.nojekyll'), '');

console.log(`[demo] built → ${path.relative(ROOT, OUT)}/  (open ${path.relative(ROOT, OUT)}/index.html via a static server)`);
