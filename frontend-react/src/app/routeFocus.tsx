import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

// Focus on route change (ruling F4, design-system README «Фокус при смене маршрута»): after every client-side change of
// the pathname — not on the first load of the app, redirects at start-up included — focus moves to the new page's
// `h1.at-page__title` once it is rendered. Query-only changes do not move focus. A navigation that ends on the same
// pathname through a redirect (signed in on «/», a link to /login sends back to «/»; on /403 a link to another
// forbidden route comes back to /403 — FM7) renders a new page: a new navigation (location key) with a newly mounted
// title moves the focus too. A pick in the «Ещё» menu keeps its own rule (focus back on «Ещё»): it announces the target
// path beforehand and that page skips the move.

interface RouteFocusState {
  /** Pathname of the last page that rendered its title; `null` until the first page (first load). */
  last: string | null;
  /** Location key of the last navigation handled. */
  key: string | null;
  /** The title element of the last page handled. */
  title: HTMLElement | null;
  /** A navigation whose focus is handled by its origin (the «Ещё» menu). */
  skip: string | null;
}

const RouteFocusContext = createContext<RouteFocusState | null>(null);

export function RouteFocusProvider({ children }: { children: ReactNode }) {
  const state = useRef<RouteFocusState>({ last: null, key: null, title: null, skip: null });
  return <RouteFocusContext.Provider value={state.current}>{children}</RouteFocusContext.Provider>;
}

/** Called by a menu that restores focus itself, right before it navigates to `pathname`. */
export function useSkipRouteFocus(): (pathname: string) => void {
  const state = useContext(RouteFocusContext);
  return (pathname) => {
    if (state) state.skip = pathname;
  };
}

/** Put on the page's `h1.at-page__title` (tabindex="-1"). */
export function useRouteFocus(title: RefObject<HTMLElement>): void {
  const state = useContext(RouteFocusContext);
  const { pathname, key } = useLocation();
  useEffect(() => {
    if (!state) return;
    const el = title.current;
    if (state.last === null) {
      // First load: focus stays where the browser put it.
      Object.assign(state, { last: pathname, key, title: el });
      return;
    }
    if (state.key === key && state.title === el) return;
    // A new pathname, or the same pathname rendered anew by another navigation (a redirect back); a query-only change
    // keeps the same page and title element.
    const moved = state.last !== pathname || (state.key !== key && state.title !== el);
    Object.assign(state, { last: pathname, key, title: el });
    if (!moved) return;
    const skipped = state.skip === pathname;
    state.skip = null;
    if (!skipped) el?.focus({ preventScroll: true });
  }, [state, pathname, key, title]);
}
