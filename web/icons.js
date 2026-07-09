// Apple-style (SF Symbols–esque) inline-SVG icon set — replaces the app's emoji.
//
// Why inline SVG: emoji render inconsistently across the iOS-10.3→18 range we target (different
// glyph sets, forced color, mismatched baselines) and clash with the calm HIG look. These are
// monochrome line/solid marks on a 24×24 grid, drawn with `currentColor`, so they inherit the
// surrounding text color and theme with light/dark automatically. Inline SVG works on iOS 10+.
//
// `icon(name, opts)` returns an SVG **string** (assign via innerHTML). Decorative by default
// (aria-hidden) because a visible text label or the button's own aria-label carries the meaning;
// pass `label` to make the icon itself the accessible name (standalone icon buttons).
//
// Sizing/alignment is CSS (.ico in app.css): 1.1em square, baseline-nudged, flex-safe — so an icon
// scales with its text and centers inside the inline-flex .btn/.iconbtn/.link-btn/.hub containers.

// Inner markup per icon. Stroke icons inherit the <svg> presentation attrs; solid icons set their
// own fill/stroke. Keep the visual weight even (~1.7 stroke, filled shapes ~same optical mass).
const PATHS = {
  // — replaced emoji —
  speaker: '<path d="M4 9.5h3l4.2-3.4v11.8L7 14.5H4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6"/><path d="M17.4 6.8a7.4 7.4 0 0 1 0 10.4"/>',
  sliders: '<path d="M3 7h9"/><path d="M17 7h4"/><circle cx="14.5" cy="7" r="2.1"/><path d="M3 17h4"/><path d="M12 17h9"/><circle cx="9.5" cy="17" r="2.1"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/><path d="M8.5 21h7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  power: '<path d="M9 3v4"/><path d="M15 3v4"/><path d="M6.5 7h11v3.2a5.5 5.5 0 0 1-11 0z"/><path d="M12 15.7V21"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V10h-5.5"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.7 2H4.8z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/>',
  battery: '<rect x="2.5" y="8.5" width="16" height="7" rx="2"/><path d="M21 11.2v1.6"/><rect x="4.5" y="10.3" width="3.6" height="3.4" rx="0.7" fill="currentColor" stroke="none"/>',
  tabs: '<rect x="8" y="4.5" width="11.5" height="11.5" rx="2.2"/><path d="M15.5 16v1.3A2.2 2.2 0 0 1 13.3 19.5H6.5A2.2 2.2 0 0 1 4.3 17.3V8.5A2.2 2.2 0 0 1 6.5 6.3H8"/>',
  moon: '<path d="M20 14.2A8 8 0 0 1 9.6 4 8 8 0 1 0 20 14.2z"/>',
  baby: '<circle cx="12" cy="8" r="4.5"/><path d="M9.5 8.2h.01M14.5 8.2h.01"/><path d="M9.8 10.4a3 3 0 0 0 4.4 0"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  // Bow drawn as a ring WITH a hole (concentric circles) + two teeth, so it reads unmistakably as a
  // key — the earlier single-circle-on-a-stem looked like a magnifying glass / watching eye. (creepy-header)
  key: '<circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.35"/><path d="M11 11 18.6 18.6"/><path d="M14.8 14.8 16.7 12.9"/><path d="M16.8 16.8 18.7 14.9"/>',
  wrench: '<path d="M14.7 3.3a5 5 0 0 0-4.3 7.9L3.8 17.8a1.7 1.7 0 0 0 2.4 2.4l6.6-6.6a5 5 0 0 0 6.3-6.3l-2.7 2.7-2.6-.6-.6-2.6z"/>',
  // — replaced symbol glyphs —
  play: '<path d="M8 5.4v13.2l10.5-6.6z" fill="currentColor" stroke="none"/>',
  // Keyed 'stop-square' (not 'stop') so the string never reads as the VERBS.STOP literal that
  // test/seam.test.js forbids outside protocol.js. It's the filled square of the Stop control.
  'stop-square': '<rect x="6.5" y="6.5" width="11" height="11" rx="2.4" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5.5" width="3.3" height="13" rx="1.4" fill="currentColor" stroke="none"/><rect x="13.7" y="5.5" width="3.3" height="13" rx="1.4" fill="currentColor" stroke="none"/>',
  warning: '<path d="M12 4.3 21 19.3H3z"/><path d="M12 10v4.4"/><path d="M12 17.4h.01"/>',
  check: '<path d="M5 12.5 9.5 17 19 7.2"/>',
  xmark: '<path d="M6.5 6.5 17.5 17.5"/><path d="M17.5 6.5 6.5 17.5"/>',
  'star-fill': '<path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17.1 6.8 19.9l1-5.9L3.5 9.8l5.9-.8z" fill="currentColor" stroke="none"/>',
  star: '<path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17.1 6.8 19.9l1-5.9L3.5 9.8l5.9-.8z"/>',
  'chevron-up': '<path d="M5.5 15 12 8.5 18.5 15"/>',
  'chevron-down': '<path d="M5.5 9 12 15.5 18.5 9"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  'dot-open': '<circle cx="12" cy="12" r="4.6"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></g>',
};

// Escape text destined for innerHTML (icon strings are concatenated with app text; keep it safe/valid).
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// name → SVG string. opts:
//   cls   extra classes (e.g. 'ico-lg', 'ico-dot')
//   label accessible name (else the icon is decorative / aria-hidden)
//   px    explicit pixel size + inline baseline nudge — for contexts that DON'T load app.css
//         (diag.html, demo/*, errbar.js); omit it when app.css's .ico rule is present.
export function icon(name, opts) {
  const o = opts || {};
  const inner = PATHS[name];
  if (!inner) { console.warn('icon: unknown name', name); return ''; }
  const cls = 'ico' + (o.cls ? ' ' + o.cls : '');
  const a11y = o.label ? `role="img" aria-label="${esc(o.label)}"` : 'aria-hidden="true"';
  const sized = o.px ? ` width="${o.px}" height="${o.px}" style="vertical-align:-0.16em"` : '';
  return `<svg class="${cls}"${sized} viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${a11y} focusable="false">`
    + inner + '</svg>';
}

// Hydrate static markup: replace <tag data-icon="name" [data-ico-cls="..."]> by prepending the SVG.
// Lets HTML declare an icon without duplicating SVG paths; the label text stays as the tag's content.
export function hydrateIcons(root) {
  const els = (root || document).querySelectorAll('[data-icon]');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    el.insertAdjacentHTML('afterbegin', icon(el.getAttribute('data-icon'), { cls: el.getAttribute('data-ico-cls') || '' }));
    el.removeAttribute('data-icon');
  }
}

export const ICON_NAMES = Object.keys(PATHS);
