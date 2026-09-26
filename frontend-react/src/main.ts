import '@agrotrace/design-system/index.css';
import { applyTheme, readTheme } from './app/theme';
import { renderBootFailure } from './bootFailure';
import { afterChunkFailure, chunkLoaded, here } from './reload';

// Single entry of index.html (no inline script: gateway CSP `script-src 'self'`). The public QR pages (/p/*) load
// their own light chunk without any cabinet code (spec §9.6); everything else loads the cabinet. A bootstrap chunk that
// fails to load (FM15) reloads once, then leaves a plain static message with «Повторить» — never a blank page.
applyTheme(readTheme());

async function boot(): Promise<void> {
  const target = here();
  const isPublic = location.pathname === '/p' || location.pathname.startsWith('/p/');
  try {
    if (isPublic) {
      await import('./public/main');
      // The public page has no lazy pages of its own: its entry loading fine ends a failure chain.
      chunkLoaded();
    } else await import('./app/main');
  } catch {
    if (afterChunkFailure(target) === 'failed') renderBootFailure(document.getElementById('root')!);
  }
}

void boot();
