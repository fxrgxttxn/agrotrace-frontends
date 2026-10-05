import '@agrotrace/design-system/index.css';
import { applyTheme, readTheme } from './app/theme';
import { renderBootFailure } from './bootFailure';
import { afterChunkFailure, chunkLoaded, here } from './reload';
import { earlyBatchUrl, startEarly } from './early';

applyTheme(readTheme());
document.getElementById('at-boot')?.remove();

async function startMock(): Promise<void> {
  if (import.meta.env.MODE !== 'mock') return;
  const { startBrowserMock } = await import('@agrotrace/mock-api/browser');
  await startBrowserMock();
}

async function boot(): Promise<void> {
  const target = here();
  const isPublic = location.pathname === '/p' || location.pathname.startsWith('/p/');
  try {
    await startMock();
    if (isPublic) {
      const early = earlyBatchUrl(location.pathname, location.origin);
      if (early) startEarly(early);
      await import('./public/main');
      chunkLoaded();
    } else await import('./app/main');
  } catch {
    if (afterChunkFailure(target) === 'failed') renderBootFailure(document.getElementById('root')!);
  }
}

void boot();
