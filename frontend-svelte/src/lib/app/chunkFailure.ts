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

function mark(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return here(); // no storage, no loop guard: behave as «already tried» — never reload automatically
  }
}

/** The error page of a chunk failure: is the one automatic full load about to start (show the loading page)? */
export function reloadPending(error: { message: string } | null): boolean {
  return error?.message === CHUNK_FAILED && mark() !== here();
}

/** `afterNavigate` of the root layout: a committed chunk failure → the one full load (or, already tried, the error page
 * stays); a page shown → the mark is spent. */
export function afterPageShown(error: { message: string } | null): void {
  if (error?.message === CHUNK_FAILED) {
    if (mark() === here()) return;
    try {
      sessionStorage.setItem(KEY, here());
    } catch {
      return;
    }
    markTitleFocus();
    location.reload(); // committed: the current entry IS the target — a reload replaces it and keeps the #fragment
    return;
  }
  if (!error) {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // storage unavailable
    }
  }
}

/** `beforeNavigate` of the root layout: after a committed chunk failure in this document, every in-app link/`goto`
 * becomes a full document load (a fresh module map retries the import) — the same URL too: the failure page's own
 * section link retries it. */
export function fullLoadAfterFailure(type: string, to: URL | null | undefined, cancel: () => void): void {
  if (!failedHere || !to || (type !== 'link' && type !== 'goto') || to.origin !== location.origin) return;
  cancel();
  markTitleFocus();
  location.assign(`${target(to)}${to.hash}`);
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
