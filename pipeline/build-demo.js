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

// 3) The demo landing (Player + Controller side-by-side) replaces the plain app landing.
cpSync(R('demo', 'index.html'), O('index.html'));

// 4) Patch the two app shells + their JS so they run under a subpath with the mock, no SW.
const edit = (file, fn) => { writeFileSync(file, fn(readFileSync(file, 'utf8'))); };

// Absolute /-rooted asset refs → page-relative (all app files live one dir below the site root).
const toRelative = (s) => s.replace(/(["'(=])\/(shared\/|app\.css|icon-\d+\.png|player\/assets\/)/g, '$1../$2');
// The mock must patch WebSocket/fetch before the app module runs → inject it first.
const injectMock = (html, appSrc) =>
  html.replace(`<script type="module" src="${appSrc}"></script>`,
    `<script type="module" src="../demo/mock-hub.js"></script>\n  <script type="module" src="${appSrc}"></script>`);
// The demo has no server to serve the SW's cached shell paths → don't register it.
const disableSw = (s) => s.replace(/navigator\.serviceWorker\.register\('sw\.js'\)/g, 'Promise.resolve()');

edit(O('player', 'index.html'), (s) => injectMock(toRelative(s), 'player.js'));
edit(O('controller', 'index.html'), (s) => injectMock(toRelative(s), 'controller.js'));
edit(O('player', 'player.js'), (s) => disableSw(toRelative(s)));
edit(O('controller', 'controller.js'), (s) => disableSw(toRelative(s)));
edit(O('player', 'manifest.webmanifest'), toRelative);
edit(O('controller', 'manifest.webmanifest'), toRelative);

// 5) Pages served straight (no Jekyll processing of the _-prefixed dirs / underscores).
writeFileSync(O('.nojekyll'), '');

console.log(`[demo] built → ${path.relative(ROOT, OUT)}/  (open ${path.relative(ROOT, OUT)}/index.html via a static server)`);
