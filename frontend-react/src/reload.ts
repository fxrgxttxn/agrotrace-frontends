// Reload-once guard of failed chunks (rulings FM11/FM15), shared by the entry (bootstrap chunks) and the lazy pages.
// No dependencies: the entry must stay light (the public QR page budget).
//
// A chunk that fails to load (a deploy replaced the files, the network dropped) makes ONE full load of the target URL —
// the new build's files — only while the location still is that target (a superseded or Back-cancelled navigation
// never reloads the page the person is on). The mark (sessionStorage) survives the reload and is cleared by the first
// page that loads fine; while it names the target, a second failure is shown instead of reloading again.

const GUARD = 'at:chunk-reload';

/** The current location as a navigation target. */
export const here = (): string => `${window.location.pathname}${window.location.search}`;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** After a chunk of `target` failed: reloads (and returns `'reload'`) once per failure chain; `'superseded'` — the
 * person is elsewhere now, nothing to do; `'failed'` — the reload already happened, show the failure. */
export function afterChunkFailure(target: string): 'reload' | 'superseded' | 'failed' {
  if (here() !== target) return 'superseded';
  const store = storage();
  if (!store || store.getItem(GUARD) === target) return 'failed';
  store.setItem(GUARD, target);
  window.location.reload();
  return 'reload';
}

/** A page loaded fine: the failure chain is over. */
export function chunkLoaded(): void {
  storage()?.removeItem(GUARD);
}
