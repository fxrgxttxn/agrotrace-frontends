// Focus on route change (ruling F4, design-system README «Фокус при смене маршрута»): after every client-side change of
// the pathname — not on the first load of the app, redirects at start-up included — focus moves to the new page's
// `h1.at-page__title` once it is rendered. Query-only changes do not move focus. A pick in the «Ещё» menu keeps its own
// rule (focus back on «Ещё»): it announces the target path beforehand and that page skips the move.
//
// `Page.svelte` reports every arrival — when it mounts and from `afterNavigate` (a page component kept across a
// parameter change) — with its pathname; the first arrival only records the path.

interface RouteFocusState {
  /** Pathname of the last page that rendered its title; `null` until the first page (first load). */
  last: string | null;
  /** A navigation whose focus is handled by its origin (the «Ещё» menu). */
  skip: string | null;
  /** The first page's title to focus once the router has finished its start (the document replaced a failed
   * navigation): SvelteKit resets focus to <body> after mounting, so the move is repeated from `afterNavigate`. */
  pending: HTMLElement | null;
}

const state: RouteFocusState = { last: null, skip: null, pending: null };

/** Called by a menu that restores focus itself, right before it navigates to `pathname`. */
export function skipRouteFocus(pathname: string): void {
  state.skip = pathname;
}

/** A page with its title `h1` is shown at `pathname`. */
export function arrive(pathname: string, title: HTMLElement | null | undefined): void {
  if (state.last === null) {
    state.last = pathname; // first load: focus stays where the browser put it…
    if (takeTitleFocus() && title) {
      state.pending = title; // …unless this document replaced a failed navigation
      title.focus({ preventScroll: true });
    }
    return;
  }
  if (state.last === pathname) {
    const pending = state.pending;
    state.pending = null;
    if (pending?.isConnected) pending.focus({ preventScroll: true });
    return;
  }
  state.pending = null;
  state.last = pathname;
  const skipped = state.skip === pathname;
  state.skip = null;
  if (!skipped) title?.focus({ preventScroll: true });
}

/** The document was loaded by the chunk-failure recovery in place of an in-app navigation (chunkFailure.ts): its
 * first page takes the focus like any navigation would have given it (read once). */
function takeTitleFocus(): boolean {
  try {
    const set = sessionStorage.getItem('agrotrace-focus-title') === '1';
    sessionStorage.removeItem('agrotrace-focus-title');
    return set;
  } catch {
    return false;
  }
}

/** Tests: a fresh app (the next page is a first load again). */
export function resetRouteFocus(): void {
  state.last = null;
  state.skip = null;
  state.pending = null;
}

// Query-only navigations keep focus where it was. Links already do (`data-sveltekit-keepfocus` on <body>), but the
// router still resets focus on back/forward and on `goto` without `keepFocus`: the (app) layout remembers the focused
// element before such a navigation and puts the focus back afterwards — or, when that element is gone (or inside a
// closed dialog), on the page title.
let kept: HTMLElement | null = null;

/** `beforeNavigate`: remember the focus when only the query (or hash) changes. */
export function keepFocusFor(from: URL | null | undefined, to: URL | null | undefined): void {
  kept =
    from && to && from.pathname === to.pathname && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
}

/** `afterNavigate`: restore it. */
export function restoreKeptFocus(): void {
  const el = kept;
  kept = null;
  if (!el) return;
  if (el !== document.body && el.isConnected && !el.closest('dialog:not([open])'))
    el.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
}
