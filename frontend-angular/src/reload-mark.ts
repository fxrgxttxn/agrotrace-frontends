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

export function reloadOnce(target: string, reload: () => void = () => location.reload()): boolean {
  if (readReloadMark() !== target) {
    writeReloadMark(target);
    reload();
    return true;
  }
  writeReloadMark(null);
  return false;
}
