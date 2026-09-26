// The reload-once mark of rulings FM11/FM15, framework-free (used by src/main.ts before any Angular code exists and by
// the page loaders): when a chunk fails, the current URL is loaded once more as a full document and the mark (that URL)
// is kept in sessionStorage; a second failure on the reloaded document shows the error instead of reloading again.
// The first successful navigation of a document clears it, so a failure chain costs at most one reload.

const RELOAD_MARK = 'agrotrace-chunk-reload';

export function currentUrl(): string {
  return `${location.pathname}${location.search}`;
}

export function readReloadMark(): string | null {
  try {
    return sessionStorage.getItem(RELOAD_MARK);
  } catch {
    return null;
  }
}

/** `false` when storage is unavailable: then there is no loop guard, so no automatic reload either. */
export function writeReloadMark(value: string | null): boolean {
  try {
    if (value === null) sessionStorage.removeItem(RELOAD_MARK);
    else sessionStorage.setItem(RELOAD_MARK, value);
    return true;
  } catch {
    return false;
  }
}

/** A chunk for `target` failed: reload the document once (returns `true`, the page is going away) or, after that
 * reload, clear the mark and let the caller show the error (`false`). */
export function reloadOnce(target: string, reload: () => void = () => location.reload()): boolean {
  if (readReloadMark() !== target && writeReloadMark(target)) {
    reload();
    return true;
  }
  writeReloadMark(null);
  return false;
}
