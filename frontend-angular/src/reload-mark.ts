// The reload-once mark of rulings FM11/FM15/FM26, framework-free (used by src/main.ts before any Angular code exists
// and by the page loaders): when a chunk fails, the current URL is loaded once more as a full document and the mark
// (that URL) survives that reload; a second failure on the reloaded document shows the error instead of reloading
// again. The first successful navigation of a document clears it, so a failure chain costs at most one reload. The
// mark lives in sessionStorage; where that is unavailable (blocked storage) in the history entry's state, which a
// reload of the entry keeps too — so the one reload still happens and never loops (FM26, as the React app).

const RELOAD_MARK = 'agrotrace-chunk-reload';

export function currentUrl(): string {
  return `${location.pathname}${location.search}`;
}

function storage(): Storage | null {
  try {
    const s = sessionStorage;
    s.getItem(RELOAD_MARK);
    return s;
  } catch {
    return null;
  }
}

function historyState(): Record<string, unknown> {
  const s = history.state as unknown;
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
}

export function readReloadMark(): string | null {
  const s = storage();
  if (s) return s.getItem(RELOAD_MARK);
  const v = historyState()[RELOAD_MARK];
  return typeof v === 'string' ? v : null;
}

export function writeReloadMark(value: string | null): void {
  const s = storage();
  if (s) {
    if (value === null) s.removeItem(RELOAD_MARK);
    else s.setItem(RELOAD_MARK, value);
    return;
  }
  const state = historyState();
  if (value === null && !(RELOAD_MARK in state)) return;
  const next = { ...state };
  if (value === null) delete next[RELOAD_MARK];
  else next[RELOAD_MARK] = value;
  history.replaceState(next, '');
}

/** A chunk for `target` failed: reload the document once (returns `true`, the page is going away) or, after that
 * reload, clear the mark and let the caller show the error (`false`). */
export function reloadOnce(target: string, reload: () => void = () => location.reload()): boolean {
  if (readReloadMark() !== target) {
    writeReloadMark(target);
    reload();
    return true;
  }
  writeReloadMark(null);
  return false;
}
