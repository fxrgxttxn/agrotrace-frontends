// Reload-once guard of failed chunks (rulings FM11/FM15/FM26), shared by the entry (bootstrap chunks) and the lazy
// pages. No dependencies: the entry must stay light (the public QR page budget).
//
// A chunk that fails to load (a deploy replaced the files, the network dropped) makes ONE full load of the target URL —
// the new build's files — only while the location still is that target (a superseded or Back-cancelled navigation
// never reloads the page the person is on). The mark survives the reload and is cleared by the first page that loads
// fine; while it names the target, a second failure is shown instead of reloading again. The mark lives in
// sessionStorage; where that is unavailable (blocked storage), in the history entry's state — which also survives a
// reload of this tab — so the one reload still happens and never loops (FM26).

const GUARD = 'at:chunk-reload';

/** The current location as a navigation target. */
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

/** The history entry's state (kept by the browser across a reload of the entry). */
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

/** After a chunk of `target` failed: reloads (and returns `'reload'`) once per failure chain; `'superseded'` — the
 * person is elsewhere now, nothing to do; `'failed'` — the reload already happened, show the failure. */
export function afterChunkFailure(target: string): 'reload' | 'superseded' | 'failed' {
  if (here() !== target) return 'superseded';
  const m = mark();
  if (m.get() === target) return 'failed';
  m.set(target);
  window.location.reload();
  return 'reload';
}

/** A page loaded fine: the failure chain is over. */
export function chunkLoaded(): void {
  mark().clear();
}
