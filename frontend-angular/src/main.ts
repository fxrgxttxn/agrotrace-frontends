import './deep-link';
import { applyTheme, readTheme } from './app/theme';
import { stripBase } from './base';
import { earlyBatchUrl, startEarly } from './early';
import { PAGE_LOAD_FAILED, RETRY } from './boot-texts.generated';
import { startMock } from './mock';
import { loadPublic } from './public-entry';
import { currentUrl, reloadOnce, writeReloadMark } from './reload-mark';

document.getElementById('boot-fallback')?.remove();
applyTheme(readTheme());

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
  startMock()
    .then(load)
    .then(
      () => {
        if (clearsMark) writeReloadMark(null);
      },
      () => {
        if (!reloadOnce(target)) failed();
      },
    );
}

const here = stripBase(location.pathname);
const isPublic = here === '/p' || here.startsWith('/p/');
if (isPublic)
  start(() => {
    const early = earlyBatchUrl(here, location.origin);
    if (early) startEarly(early);
    return loadPublic();
  }, true);
else start(() => import('./app/main'), false);
