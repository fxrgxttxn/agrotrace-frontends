import { applyTheme, readTheme } from './app/theme';
import { earlyBatchUrl, startEarly } from './early';
import { PAGE_LOAD_FAILED, RETRY } from './boot-texts.generated';
import { startMock } from './mock';
import { loadPublic } from './public-entry';
import { currentUrl, reloadOnce, writeReloadMark } from './reload-mark';

// Single entry of index.html (the build emits only `<script type="module" src>` — no inline script: gateway CSP
// `script-src 'self'`, and `inlineCritical: false` keeps the stylesheet link free of inline handlers, R89). The public
// QR pages (/p/*) load their own light chunk without any cabinet code (spec §9.6); everything else loads the cabinet.

// FM18: index.html's static fallback (shown by CSS after 10 s if this script never runs) is not needed — we run.
document.getElementById('boot-fallback')?.remove();
applyTheme(readTheme());

/** Rulings FM15 / FM17: an app chunk that cannot be loaded reloads the document once; failing again, a plain static
 * screen instead of a blank page — README markup (at-page / at-card / at-empty, a primary at-button), no title, the
 * texts from @agrotrace/i18n at build time (scripts/boot-fallback.mjs; no i18n bundle here). */
function failed(): void {
  const main = document.createElement('main');
  main.className = 'at-page';
  main.id = 'main';
  main.tabIndex = -1;
  main.style.maxWidth = '30rem';
  const card = document.createElement('article');
  card.className = 'at-card';
  const empty = document.createElement('div');
  empty.className = 'at-empty';
  const text = document.createElement('p');
  text.className = 'at-empty__text';
  text.textContent = PAGE_LOAD_FAILED;
  const retry = document.createElement('button');
  retry.className = 'at-button';
  retry.type = 'button';
  retry.dataset['variant'] = 'primary';
  retry.textContent = RETRY;
  retry.addEventListener('click', () => location.reload());
  empty.append(text, retry);
  card.append(empty);
  main.append(card);
  document.body.append(main);
}

function start(load: () => Promise<unknown>, clearsMark: boolean): void {
  const target = currentUrl();
  // mock mode: the service worker answers /api/v1 before the app's first request (FM23; a no-op in production)
  startMock()
    .then(load)
    .then(
      () => {
        // the cabinet clears the mark on its first successful navigation (a page chunk may still fail)
        if (clearsMark) writeReloadMark(null);
      },
      () => {
        if (!reloadOnce(target)) failed();
      },
    );
}

const isPublic = location.pathname === '/p' || location.pathname.startsWith('/p/');
if (isPublic)
  start(() => {
    // The batch answer travels while the public build downloads (src/early.ts).
    const early = earlyBatchUrl(location.pathname, location.origin);
    if (early) startEarly(early);
    return loadPublic();
  }, true);
else start(() => import('./app/main'), false);
