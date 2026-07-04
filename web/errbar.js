// On-screen error bar — the "no console on an old iPhone" safety net.
//
// A CLASSIC (non-module) script loaded BEFORE the app's <script type="module">, deliberately written
// in ES5 so it runs on the very oldest target (iOS 10.3) even if a later module fails to parse. It
// installs window error/rejection handlers and exposes window.__lullError(msg) for the app to report
// caught failures. On an old device with no dev console, a silent throw looked like "the button does
// nothing"; now the actual error is visible and reportable. (finding: silent errors on old iOS)
(function () {
  var box, list;
  function ensure() {
    if (box) return;
    box = document.createElement('div');
    box.id = 'lull-errbar';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:45%;' +
      'overflow:auto;-webkit-overflow-scrolling:touch;background:#3a0d0d;color:#ffd9d9;' +
      'font:12px/1.45 ui-monospace,Menlo,monospace;padding:10px 12px;border-top:2px solid #ff6b6b;' +
      'box-shadow:0 -4px 16px rgba(0,0,0,.45)';
    var title = document.createElement('div');
    title.textContent = '⚠ Error — tap to dismiss';
    title.style.cssText = 'font-weight:600;margin-bottom:6px;font-family:-apple-system,sans-serif';
    box.appendChild(title);
    list = document.createElement('div');
    box.appendChild(list);
    box.addEventListener('click', function () { box.style.display = 'none'; });
    (document.body || document.documentElement).appendChild(box);
  }
  function show(msg) {
    try {
      ensure();
      box.style.display = 'block';
      var row = document.createElement('div');
      row.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:3px 0;padding-top:3px;border-top:1px solid rgba(255,107,107,.22)';
      row.textContent = String(msg);
      list.appendChild(row);
    } catch (e) { /* last resort: never let the error reporter throw */ }
  }
  // App-callable: surface a CAUGHT error that would otherwise be swallowed.
  window.__lullError = show;
  // Uncaught errors — including a module that fails to PARSE/evaluate (reported to the window).
  window.addEventListener('error', function (e) {
    if (!e) { show('error'); return; }
    var m = e.error ? (e.error.stack || e.error.message || e.error) : (e.message || 'error');
    if (e.filename) m = m + '\n@ ' + e.filename + ':' + (e.lineno || '?') + ':' + (e.colno || '?');
    show(m);
  }, true);
  // Rejected promises with no .catch (e.g. an await in arm()/getUserMedia that threw).
  window.addEventListener('unhandledrejection', function (e) {
    var r = e ? e.reason : null;
    show('Unhandled rejection: ' + (r && (r.stack || r.message) ? (r.stack || r.message) : r));
  });
})();
