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
    const js = code.trim().replace(/import\((["'])\.\/(?=assets\/)/g, 'import($1/');
    if (/import\((["'])\.\//.test(js)) throw new Error(`csp-bootstrap: relative import left in ${page}`);
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
