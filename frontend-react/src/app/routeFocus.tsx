import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

interface RouteFocusState {
  last: string | null;
  key: string | null;
  title: HTMLElement | null;
  skip: string | null;
}

const RouteFocusContext = createContext<RouteFocusState | null>(null);

export function RouteFocusProvider({ children }: { children: ReactNode }) {
  const state = useRef<RouteFocusState>({ last: null, key: null, title: null, skip: null });
  return <RouteFocusContext.Provider value={state.current}>{children}</RouteFocusContext.Provider>;
}

export function useSkipRouteFocus(): (pathname: string) => void {
  const state = useContext(RouteFocusContext);
  return (pathname) => {
    if (state) state.skip = pathname;
  };
}

export function useRouteFocus(title: RefObject<HTMLElement>): void {
  const state = useContext(RouteFocusContext);
  const { pathname, key } = useLocation();
  useEffect(() => {
    if (!state) return;
    const el = title.current;
    if (state.last === null) {
      Object.assign(state, { last: pathname, key, title: el });
      return;
    }
    if (state.key === key && state.title === el) return;
    const moved = state.last !== pathname || (state.key !== key && state.title !== el);
    Object.assign(state, { last: pathname, key, title: el });
    if (!moved) return;
    const skipped = state.skip === pathname;
    state.skip = null;
    if (!skipped) el?.focus({ preventScroll: true });
  }, [state, pathname, key, title]);
}
