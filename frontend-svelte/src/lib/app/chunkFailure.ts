// Ruling FM11: a page chunk that fails to load (a dynamic import error — a redeploy removed it, the network dropped)
// gets ONE full-document load of the target URL; if that fails too, the error page of the route group shows
// «Не удалось загрузить страницу» with «Повторить» (a reload). A sessionStorage guard keyed by the target URL prevents
// reload loops.
//
// History: the full load happens only after SvelteKit has committed the failed navigation (its error page is shown,
// the target URL is the current history entry — pushed for a link/`goto`, already current for back/forward and at
// start-up), and it REPLACES that entry: the history is exactly what a successful navigation would have left.

const KEY = 'agrotrace-chunk-reload';

/** A module script that could not be fetched/evaluated (Chromium, Firefox, WebKit wordings; Vite's CSS preload). */
export function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

function guard(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** `handleError`: whether the one full load of `url` is still to be tried (the guard is armed then). */
export function armReload(url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  if (guard() === target) return false;
  try {
    sessionStorage.setItem(KEY, target);
    return true;
  } catch {
    return false; // no storage, no loop guard: no automatic reload
  }
}

/** `afterNavigate` of the root layout: the error page of an armed failure is committed — load the document again;
 * a page that loaded spends the guard. */
export function afterPageShown(error: { message: string } | null): void {
  if (error?.message === 'reloading') {
    location.replace(`${location.pathname}${location.search}`);
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

/** «Повторить» on the failure page: a plain reload of the current URL. */
export function reloadPage(): void {
  location.reload();
}
