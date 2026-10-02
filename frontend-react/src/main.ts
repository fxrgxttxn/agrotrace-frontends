import '@agrotrace/design-system/index.css';
import { applyTheme, readTheme } from './app/theme';
import { renderBootFailure } from './bootFailure';
import { afterChunkFailure, chunkLoaded, here } from './reload';
import { earlyBatchUrl, startEarly } from './early';

// Single entry of index.html (no inline script: gateway CSP `script-src 'self'`). The public QR pages (/p/*) load
// their own light chunk without any cabinet code (spec §9.6); everything else loads the cabinet. A bootstrap chunk that
// fails to load (FM15) reloads once, then leaves a plain static message with «Повторить» — never a blank page.
// Mock mode (`vite build --mode mock` → dist-mock, ruling FM23): the in-browser backend of @agrotrace/mock-api (MSW
// service worker) answers /api/v1 before the app starts; the production build never contains it (dead branch).
applyTheme(readTheme());
// FM18: the static «could not load» block of index.html is for a script that never ran — this one runs.
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
      // The batch answer travels while the public chunk downloads (src/early.ts).
      const early = earlyBatchUrl(location.pathname, location.origin);
      if (early) startEarly(early);
      await import('./public/main');
      // The public page has no lazy pages of its own: its entry loading fine ends a failure chain.
      chunkLoaded();
    } else await import('./app/main');
  } catch {
    if (afterChunkFailure(target) === 'failed') renderBootFailure(document.getElementById('root')!);
  }
}

void boot();
