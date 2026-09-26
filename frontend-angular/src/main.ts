import { applyTheme, readTheme } from './app/theme';
import { currentUrl, reloadOnce, writeReloadMark } from './reload-mark';

// Single entry of index.html (the build emits only `<script type="module" src>` — no inline script: gateway CSP
// `script-src 'self'`, and `inlineCritical: false` keeps the stylesheet link free of inline handlers, R89). The public
// QR pages (/p/*) load their own light chunk without any cabinet code (spec §9.6); everything else loads the cabinet.
applyTheme(readTheme());

/** Ruling FM15: an app chunk that cannot be loaded reloads the document once; failing again, a plain static message
 * with «Повторить» instead of a blank page (no framework, no i18n bundle here: the text is fixed Russian, FM14). */
function failed(): void {
  const main = document.createElement('main');
  main.className = 'at-page';
  main.id = 'main';
  main.tabIndex = -1;
  main.style.maxWidth = '30rem';
  const empty = document.createElement('div');
  empty.className = 'at-empty';
  const text = document.createElement('p');
  text.className = 'at-empty__text';
  text.textContent = 'Не удалось загрузить страницу.';
  const retry = document.createElement('button');
  retry.className = 'at-button';
  retry.type = 'button';
  retry.dataset['variant'] = 'primary';
  retry.textContent = 'Повторить';
  retry.addEventListener('click', () => location.reload());
  empty.append(text, retry);
  main.append(empty);
  document.body.append(main);
}

function start(load: () => Promise<unknown>, clearsMark: boolean): void {
  const target = currentUrl();
  load().then(
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
if (isPublic) start(() => import('./public/main'), true);
else start(() => import('./app/main'), false);
