const KEY = 'agrotrace-chunk-reload';
export const TITLE_FOCUS = 'agrotrace-focus-title';

let failedHere = false;

export function noteChunkFailure(): void {
  failedHere = true;
}

export const CHUNK_FAILED = 'chunk';

export function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

const here = () => `${location.pathname}${location.search}`;
const target = (url: URL) => `${url.pathname}${url.search}`;

interface Mark {
  get(): string | null;
  set(target: string): void;
  clear(): void;
}

function sessionMark(): Mark | null {
  try {
    const store = sessionStorage;
    store.getItem(KEY);
    return {
      get: () => store.getItem(KEY),
      set: (value) => store.setItem(KEY, value),
      clear: () => store.removeItem(KEY),
    };
  } catch {
    return null;
  }
}

export const HISTORY_KEY = 'agrotrace:chunk-reload';

declare global {
  interface Window {
    __agrotraceChunkMark?: string | null;
  }
}

const historyMark: Mark = {
  get: () => {
    const v = (history.state as Record<string, unknown> | null)?.[HISTORY_KEY] ?? window.__agrotraceChunkMark;
    return typeof v === 'string' ? v : null;
  },
  set: (value) => {
    history.replaceState({ ...((history.state as object | null) ?? {}), [HISTORY_KEY]: value }, '');
  },
  clear: () => {
    window.__agrotraceChunkMark = null;
    const state = history.state as Record<string, unknown> | null;
    if (!state || !(HISTORY_KEY in state)) return;
    const rest = { ...state };
    delete rest[HISTORY_KEY];
    history.replaceState(rest, '');
  },
};

const mark = (): Mark => sessionMark() ?? historyMark;

export function reloadPending(error: { message: string } | null): boolean {
  return error?.message === CHUNK_FAILED && mark().get() !== here();
}

export function afterPageShown(error: { message: string } | null): void {
  if (error?.message === CHUNK_FAILED) {
    const m = mark();
    if (m.get() === here()) {
      clearTitleFocus();
      return;
    }
    m.set(here());
    markTitleFocus();
    location.reload();
    return;
  }
  if (!error) mark().clear();
  clearTitleFocus();
}

let replacing = false;

export function setReplacing(value: boolean): void {
  replacing = value;
}

function linkReplaces(event: Event | undefined): boolean {
  const a = (event?.target as Element | null | undefined)?.closest?.('a');
  const holder = a?.closest('[data-sveltekit-replacestate]');
  return Boolean(holder) && holder!.getAttribute('data-sveltekit-replacestate') !== 'false';
}

export function fullLoadAfterFailure(
  type: string,
  to: URL | null | undefined,
  cancel: () => void,
  event?: Event,
): void {
  if (!failedHere || !to || (type !== 'link' && type !== 'goto') || to.origin !== location.origin) return;
  const replace = type === 'goto' ? replacing : linkReplaces(event);
  cancel();
  markTitleFocus();
  const href = `${target(to)}${to.hash}`;
  if (replace) location.replace(href);
  else location.assign(href);
}

export function clearTitleFocus(): void {
  try {
    sessionStorage.removeItem(TITLE_FOCUS);
  } catch {}
}

function markTitleFocus(): void {
  try {
    sessionStorage.setItem(TITLE_FOCUS, '1');
  } catch {}
}

export function reloadPage(): void {
  location.reload();
}

export function reloadForChunk(): void {
  mark().set(here());
  location.reload();
}
