import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

// Focus on route change (ruling F4, design-system README «Фокус при смене маршрута»): after every client-side change of
// the pathname — not on the first load of the app, redirects at start-up included — focus moves to the new page's
// `h1.at-page__title` once it is rendered. Query-only changes do not move focus. A pick in the «Ещё» menu keeps its own
// rule (focus back on «Ещё»): it announces the target path beforehand and that page skips the move.

interface RouteFocusState {
  /** Pathname of the last page that rendered its title; `null` until the first page (first load). */
  last: string | null;
  /** A navigation whose focus is handled by its origin (the «Ещё» menu). */
  skip: string | null;
}

const RouteFocusContext = createContext<RouteFocusState | null>(null);

export function RouteFocusProvider({ children }: { children: ReactNode }) {
  const state = useRef<RouteFocusState>({ last: null, skip: null });
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
  const { pathname } = useLocation();
  useEffect(() => {
    if (!state) return;
    if (state.last === null) {
      state.last = pathname; // first load: focus stays where the browser put it
      return;
    }
    if (state.last === pathname) return;
    state.last = pathname;
    const skipped = state.skip === pathname;
    state.skip = null;
    if (!skipped) title.current?.focus({ preventScroll: true });
  }, [state, pathname, title]);
}
