import '@agrotrace/design-system/index.css';
import { applyTheme, readTheme } from './app/theme';
import { BASE, stripBase, withBase } from './base';
import { renderBootFailure } from './bootFailure';
import { afterChunkFailure, chunkLoaded, here } from './reload';
import { earlyBatchUrl, startEarly } from './early';

applyTheme(readTheme());
document.getElementById('at-boot')?.remove();

async function startMock(): Promise<void> {
  if (import.meta.env.MODE !== 'mock') return;
  const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
  await startBrowserMock({
    serviceWorkerUrl: withBase('/mockServiceWorker.js'),
    publicBaseUrl: `${location.origin}${BASE}`,
  });
}

async function boot(): Promise<void> {
  const target = here();
  const path = stripBase(location.pathname);
  const isPublic = path === '/p' || path.startsWith('/p/');
  try {
    await startMock();
    if (isPublic) {
      const early = earlyBatchUrl(path, location.origin);
      if (early) startEarly(early);
      await import('./public/main');
      chunkLoaded();
    } else await import('./app/main');
  } catch {
    if (afterChunkFailure(target) === 'failed') renderBootFailure(document.getElementById('root')!);
  }
}

void boot();
