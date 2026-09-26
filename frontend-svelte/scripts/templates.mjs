// FM18: the static «page could not be loaded» screen of index.html (revealed by CSS after 10 s if the app never
// starts) and of SvelteKit's error template (the root layout failed). Texts come from @agrotrace/i18n at build time;
// the markup is the README's (at-page / at-card / at-empty / primary at-button), with a JS-free «Повторить» link to
// the current page (`href=""`). Written to .templates/ (git-ignored) by svelte.config.js before SvelteKit reads them.
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

export function writeTemplates() {
  const out = here('../.templates/');
  mkdirSync(out, { recursive: true });
  const fill = (file) =>
    readFileSync(here(`../src/templates/${file}`), 'utf8')
      .replace('%at.fallback.style%', STYLE)
      .replace('%at.fallback.now%', screen(true))
      .replace('%at.fallback%', screen(false));
  writeFileSync(`${out}app.html`, fill('app.html'));
  writeFileSync(`${out}error.html`, fill('error.html'));
  return { appTemplate: '.templates/app.html', errorTemplate: '.templates/error.html' };
}
