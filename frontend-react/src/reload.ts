const GUARD = 'at:chunk-reload';

export const here = (): string => `${window.location.pathname}${window.location.search}`;

interface Mark {
  get(): string | null;
  set(target: string): void;
  clear(): void;
}

function sessionMark(): Mark | null {
  try {
    const store = window.sessionStorage;
    store.getItem(GUARD);
    return {
      get: () => store.getItem(GUARD),
      set: (target) => store.setItem(GUARD, target),
      clear: () => store.removeItem(GUARD),
    };
  } catch {
    return null;
  }
}

const historyMark: Mark = {
  get: () => {
    const state = window.history.state as Record<string, unknown> | null;
    const v = state?.[GUARD];
    return typeof v === 'string' ? v : null;
  },
  set: (target) => {
    const state = (window.history.state as Record<string, unknown> | null) ?? {};
    window.history.replaceState({ ...state, [GUARD]: target }, '');
  },
  clear: () => {
    const state = window.history.state as Record<string, unknown> | null;
    if (!state || !(GUARD in state)) return;
    const rest = { ...state };
    delete rest[GUARD];
    window.history.replaceState(rest, '');
  },
};

const mark = (): Mark => sessionMark() ?? historyMark;

let loadedHere = false;

export function afterChunkFailure(target: string): 'reload' | 'superseded' | 'failed' {
  if (here() !== target) return 'superseded';
  const m = mark();
  if (m.get() === target && !loadedHere) return 'failed';
  m.set(target);
  loadedHere = false;
  window.location.reload();
  return 'reload';
}

export function chunkLoaded(): void {
  loadedHere = true;
  mark().clear();
}
