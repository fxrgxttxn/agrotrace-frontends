import type { Plugin } from 'vite';

// Ruling FM18: when the entry script itself cannot load, nothing of ours runs — index.html carries a static block
// (README markup at-page / at-card / at-empty, one primary link «Повторить» to the current page, `href=""`), hidden
// by the design system's `.at-boot` and revealed by a CSS animation after 10 s; main.ts removes it on start. The
// texts are those of @agrotrace/i18n (`empty.pageLoadFailed`, `action.retry`), read at build time. The same texts
// reach the runtime bootstrap failure screen (src/bootFailure.ts) through the `__AT_BOOT_TEXTS__` define.

export interface BootTexts {
  text: string;
  retry: string;
}

export interface BootDictionary {
  empty: { pageLoadFailed: string };
  action: { retry: string };
}

/** The two texts of a full dictionary of @agrotrace/i18n (vite.config.ts reads locales/ru.json). */
export function bootTexts(dict: BootDictionary): BootTexts {
  return { text: dict.empty.pageLoadFailed, retry: dict.action.retry };
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function bootFallbackHtml(texts: BootTexts): string {
  return (
    '<main class="at-page at-boot" id="at-boot"><article class="at-card"><div class="at-empty">' +
    `<p class="at-empty__text">${escape(texts.text)}</p>` +
    `<a class="at-button" data-variant="primary" href="">${escape(texts.retry)}</a>` +
    '</div></article></main>'
  );
}

const ROOT = '<div id="root"></div>';

export function injectBootFallback(html: string, texts: BootTexts): string {
  if (!html.includes(ROOT)) throw new Error(`boot fallback: ${ROOT} not found in index.html`);
  return html.replace(ROOT, `${ROOT}\n    ${bootFallbackHtml(texts)}`);
}

export function bootFallback(texts: BootTexts): Plugin {
  return {
    name: 'agrotrace-boot-fallback',
    transformIndexHtml: (html) => injectBootFallback(html, texts),
  };
}
