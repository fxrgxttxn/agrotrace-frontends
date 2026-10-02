// Rulings FM11/FM15: a page chunk that fails to load (a dynamic import error — a redeploy removed it, the network
// dropped) gets ONE full-document load of the target URL; if that fails too, the error page of the route group shows
// «Не удалось загрузить страницу.» with «Повторить» (a reload).
//
// - Everything is decided when SvelteKit COMMITS the failed navigation (its error page is shown, the target is the
//   current location): a navigation superseded by another click or by Back never commits, so it never reloads the page
//   the user is on and leaves no mark.
// - The reload mark (sessionStorage, the target URL) allows at most one reload per failure chain; the first navigation
//   of a document that shows a page clears it.
// - The reload replaces the (target) history entry: the history is what a successful navigation would have left.
// - The browser keeps a failed module in the document's module map, so the same document can never import it again:
//   after a chunk failure in the document (committed or not), the next link/`goto` navigation is a full document load (the import is retried).
// - The bootstrap (kit entry chunks) has the same guard in the post-build boot script (scripts/csp-bootstrap.mjs).

const KEY = 'agrotrace-chunk-reload';
/** Also set by the boot script (scripts/csp-bootstrap.mjs). */
export const TITLE_FOCUS = 'agrotrace-focus-title';

/** A chunk failed to load in this document (the browser keeps the failure in its module map, whatever happened to the
 * navigation): later in-app navigations load a fresh document. Set by `handleError`, before any page reacts. */
let failedHere = false;

/** `handleError` saw a chunk failure. */
export function noteChunkFailure(): void {
  failedHere = true;
}

/** The message `handleError` gives a chunk failure (the error pages recognise it). */
export const CHUNK_FAILED = 'chunk';

/** A module script that could not be fetched/evaluated (Chromium, Firefox, WebKit wordings; Vite's CSS preload). */
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

/** The key of the mark in the history entry's state (also used by the boot script, scripts/csp-bootstrap.mjs). */
export const HISTORY_KEY = 'agrotrace:chunk-reload';

declare global {
  interface Window {
    /** The history-state mark as the boot script found it, before SvelteKit's first navigation replaced the entry's
     * state with its own (scripts/csp-bootstrap.mjs). */
    __agrotraceChunkMark?: string | null;
  }
}

/** FM26: without sessionStorage the mark lives in the history entry's state (as in the React app): it survives a
 * reload of that entry only, never leaves the tab's entry and is gone with it. SvelteKit's first navigation of a
 * document replaces the entry's state with its own keys, so the mark is read by the boot script before SvelteKit
 * starts (`window.__agrotraceChunkMark`) — reading it later found nothing and the reload looped. */
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

/** The error page of a chunk failure: is the one automatic full load about to start (show the loading page)? */
export function reloadPending(error: { message: string } | null): boolean {
  return error?.message === CHUNK_FAILED && mark().get() !== here();
}

/** `afterNavigate` of the root layout: a committed chunk failure → the one full load (or, already tried, the error page
 * stays); a page shown → the mark is spent. */
export function afterPageShown(error: { message: string } | null): void {
  if (error?.message === CHUNK_FAILED) {
    const m = mark();
    if (m.get() === here()) {
      clearTitleFocus();
      return;
    }
    m.set(here());
    markTitleFocus();
    location.reload(); // committed: the current entry IS the target — a reload replaces it and keeps the #fragment
    return;
  }
  if (!error) mark().clear();
  // The focus flag belongs to the first page of this document only (its title has read it by now, routeFocus.ts): a
  // page without a title to take it (the public QR page) must not leave it for a later document.
  clearTitleFocus();
}

/** Set by the app's `goto` (lib/app/goto.ts) while a navigation that replaces its history entry is under way. */
let replacing = false;

export function setReplacing(value: boolean): void {
  replacing = value;
}

/** A link navigation replaces the entry when its anchor (or an ancestor) says so, as SvelteKit reads it. */
function linkReplaces(event: Event | undefined): boolean {
  const a = (event?.target as Element | null | undefined)?.closest?.('a');
  const holder = a?.closest('[data-sveltekit-replacestate]');
  return Boolean(holder) && holder!.getAttribute('data-sveltekit-replacestate') !== 'false';
}

/** `beforeNavigate` of the root layout: after a committed chunk failure in this document, every in-app link/`goto`
 * becomes a full document load (a fresh module map retries the import) — the same URL too: the failure page's own
 * section link retries it. A navigation that would have replaced its history entry replaces it here too. */
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

/** Forgets the «focus the first title» flag (the boot script does the same when it shows the static screen). */
export function clearTitleFocus(): void {
  try {
    sessionStorage.removeItem(TITLE_FOCUS);
  } catch {
    // storage unavailable
  }
}

/** The next document (after an automatic full load) focuses its page title on its first page (review round 3). */
function markTitleFocus(): void {
  try {
    sessionStorage.setItem(TITLE_FOCUS, '1');
  } catch {
    // storage unavailable
  }
}

/** «Повторить» on the failure page: a plain reload of the current URL. */
export function reloadPage(): void {
  location.reload();
}

/** «Повторить» of a part of a page whose chunk failed in this document (a chart): the browser keeps the failed module,
 * so only a new document can ask for it again — one full load of this page, marked like the automatic one (FM15). */
export function reloadForChunk(): void {
  mark().set(here());
  location.reload();
}
