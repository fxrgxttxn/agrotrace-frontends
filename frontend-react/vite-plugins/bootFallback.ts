import type { Plugin } from 'vite';

export interface BootTexts {
  text: string;
  retry: string;
}

export interface BootDictionary {
  empty: { pageLoadFailed: string };
  action: { retry: string };
}

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
