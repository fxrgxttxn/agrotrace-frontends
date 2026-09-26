// FM18: the static «page could not be loaded» screen of index.html (revealed by CSS after 10 s if the app never
// starts) and of SvelteKit's error template (the root layout failed). Texts come from @agrotrace/i18n at build time;
// the markup is the README's (at-page / at-card / at-empty / primary at-button), with a JS-free «Повторить» link to
// the current page (`href=""`). Written to .templates/ (git-ignored) by svelte.config.js before SvelteKit reads them —
// only when they change (config loads alone never rewrite them).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ru = JSON.parse(readFileSync(here('../../packages/i18n/locales/ru.json'), 'utf8'));
const escape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const FALLBACK_TEXT = ru.empty.pageLoadFailed;
export const FALLBACK_RETRY = ru.action.retry;

/** The static screen; `now` — visible at once, otherwise only after 10 s. */
function screen(now) {
  return [
    `<div id="at-load-failed" class="at-load-failed"${now ? ' data-now' : ''}>`,
    '<main class="at-page"><article class="at-card"><div class="at-empty">',
    `<p class="at-empty__text">${escape(FALLBACK_TEXT)}</p>`,
    `<a class="at-button" data-variant="primary" href="">${escape(FALLBACK_RETRY)}</a>`,
    '</div></article></main></div>',
  ].join('');
}

const STYLE = [
  '<style>',
  '.at-load-failed{position:fixed;inset:0;overflow:auto;background:var(--c-ground,Canvas);visibility:hidden;',
  'animation:at-load-failed-show 0s linear 10s forwards}',
  '.at-load-failed[data-now]{animation:none;visibility:visible}',
  '@keyframes at-load-failed-show{to{visibility:visible}}',
  '</style>',
].join('');

/** Content of `file` if it exists, else null. */
function current(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Fills the templates. Every tool that loads svelte.config.js (svelte-check, ESLint, Vitest, the build) calls this:
 * a file is written only when its content changes, and an up-to-date copy on a read-only file system is fine — only a
 * missing or outdated template that cannot be written is an error. */
export function writeTemplates() {
  const out = here('../.templates/');
  const fill = (file) =>
    readFileSync(here(`../src/templates/${file}`), 'utf8')
      .replace('%at.fallback.style%', STYLE)
      .replace('%at.fallback.now%', screen(true))
      .replace('%at.fallback%', screen(false));
  for (const file of ['app.html', 'error.html']) {
    const text = fill(file);
    if (current(`${out}${file}`) === text) continue;
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}${file}`, text);
  }
  return { appTemplate: '.templates/app.html', errorTemplate: '.templates/error.html' };
}
