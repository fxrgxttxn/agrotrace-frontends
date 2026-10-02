// Post-build step (ruling R89, gateway CSP `script-src 'self'`): SvelteKit writes its start-up code as an inline
// <script> into every generated page (here: the SPA fallback index.html). A static gateway header cannot carry a
// per-build hash, so the inline code is moved into an external, content-hashed classic script next to the other
// immutable assets, and the page references it instead. The external script keeps the semantics SvelteKit relies on:
// it is a classic, parser-blocking script in the same place, so `document.currentScript.parentElement` is still the
// container SvelteKit renders into. Relative `import("./assets/…")` specifiers would resolve against the script's own
// URL, so they are rewritten to absolute paths (`paths.relative: false` already makes them absolute; both handled).
// The step fails the build if an inline script remains or the start-up code does not look as expected.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const out = process.argv[2] ?? 'build';
const APP_DIR = 'assets';
const INLINE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;

// FM15/FM18: the start-up chunks failed (the kit entry, the app manifest, the root layout — in the last case SvelteKit
// has already replaced the document with its error template). The same reload-once mark as the pages
// (src/lib/app/chunkFailure.ts: sessionStorage `agrotrace-chunk-reload` = the URL, the #fragment kept), then the
// static FM18 screen of index.html / the error template (scripts/templates.mjs: README markup, texts from
// @agrotrace/i18n) is shown at once — put back into the document if it was replaced — with the app's stylesheets and
// the stored theme; the «focus the first title» flag of the reload is dropped (no page will read it).
const BOOT_FAILED = `var __agrotraceFallback = document.getElementById('at-load-failed');
var __agrotraceStyles = Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
  return l.href;
});
// FM26: without sessionStorage the reload mark lives in the history entry's state; SvelteKit's first navigation
// replaces that state, so it is read here, before SvelteKit starts (src/lib/app/chunkFailure.ts reads this copy).
var __agrotraceHistoryKey = 'agrotrace:chunk-reload';
window.__agrotraceChunkMark =
  history.state && typeof history.state[__agrotraceHistoryKey] === 'string' ? history.state[__agrotraceHistoryKey] : null;
function __agrotraceBootFailed(error) {
  var key = 'agrotrace-chunk-reload';
  var here = location.pathname + location.search;
  var tried = here;
  var inHistory = false;
  try {
    tried = sessionStorage.getItem(key);
  } catch (e) {
    // FM26: no sessionStorage — the mark lives in the history entry's state, which a reload of the entry keeps
    inHistory = true;
    tried = window.__agrotraceChunkMark;
  }
  if (tried !== here) {
    try {
      if (inHistory) {
        var state = {};
        for (var k in history.state || {}) state[k] = history.state[k];
        state[__agrotraceHistoryKey] = here;
        history.replaceState(state, '');
      } else {
        sessionStorage.setItem(key, here);
        sessionStorage.setItem('agrotrace-focus-title', '1');
      }
      location.reload();
      return;
    } catch (e) {}
  }
  console.warn('AgroTrace: start-up failed', error);
  try {
    // no page will read the «focus the first title» flag of the reload (src/lib/app/chunkFailure.ts)
    sessionStorage.removeItem('agrotrace-focus-title');
  } catch (e) {}
  try {
    // the stored theme (src/lib/app/theme.svelte.ts: localStorage 'agrotrace-theme'; «system» = no attribute)
    var theme = localStorage.getItem('agrotrace-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
  __agrotraceStyles.forEach(function (href) {
    var has = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
      return l.href === href;
    });
    if (has) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  });
  var box = document.getElementById('at-load-failed') || __agrotraceFallback;
  if (!box) return;
  box.setAttribute('data-now', '');
  if (!box.isConnected) document.body.appendChild(box);
}
`;
const START = /\]\)\.then\(\(\[kit, app\]\) => \{\s*kit\.start\(app, element\);\s*\}\);/;

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === APP_DIR ? [] : htmlFiles(p);
    return name.endsWith('.html') ? [p] : [];
  });
}

const pages = htmlFiles(out);
if (pages.length === 0) throw new Error(`csp-bootstrap: no HTML pages in ${out}`);

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  let moved = 0;
  const next = html.replace(INLINE, (_, attrs, code) => {
    if (/\btype=["']?(module|application\/json)/.test(attrs))
      throw new Error(`csp-bootstrap: unexpected inline <script${attrs}> in ${page}`);
    if (!code.includes('.start(') || !code.includes('document.currentScript'))
      throw new Error(`csp-bootstrap: unexpected inline script in ${page}:\n${code}`);
    let js = code.trim().replace(/import\((["'])\.\/(?=assets\/)/g, 'import($1/');
    if (/import\((["'])\.\//.test(js)) throw new Error(`csp-bootstrap: relative import left in ${page}`);
    if (!START.test(js)) throw new Error(`csp-bootstrap: unexpected start-up call in ${page}:\n${js}`);
    js = `${BOOT_FAILED}${js.replace(
      START,
      ']).then(([kit, app]) => kit.start(app, element)).catch(__agrotraceBootFailed);',
    )}`;
    const hash = createHash('sha256').update(js).digest('hex').slice(0, 10);
    const dir = join(out, APP_DIR, 'immutable', 'entry');
    mkdirSync(dir, { recursive: true });
    const file = `boot.${hash}.js`;
    writeFileSync(join(dir, file), `${js}\n`);
    moved += 1;
    return `<script src="/${APP_DIR}/immutable/entry/${file}"></script>`;
  });
  if (moved === 0) throw new Error(`csp-bootstrap: no start-up script found in ${page}`);
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(next))
    throw new Error(`csp-bootstrap: inline script left in ${page}`);
  writeFileSync(page, next);
  console.log(`csp-bootstrap: ${relative(out, page)} — ${moved} inline script(s) moved out`);
}
