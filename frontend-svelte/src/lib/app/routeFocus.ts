interface RouteFocusState {
  last: string | null;
  skip: string | null;
  pending: HTMLElement | null;
}

const state: RouteFocusState = { last: null, skip: null, pending: null };

export function skipRouteFocus(pathname: string): void {
  state.skip = pathname;
}

export function arrive(pathname: string, title: HTMLElement | null | undefined): void {
  if (state.last === null) {
    state.last = pathname;
    if (takeTitleFocus() && title) {
      state.pending = title;
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

function takeTitleFocus(): boolean {
  try {
    const set = sessionStorage.getItem('agrotrace-focus-title') === '1';
    sessionStorage.removeItem('agrotrace-focus-title');
    return set;
  } catch {
    return false;
  }
}

export function resetRouteFocus(): void {
  state.last = null;
  state.skip = null;
  state.pending = null;
}

let kept: HTMLElement | null = null;
let movedByPerson = false;
if (typeof document !== 'undefined') {
  const input = () => {
    if (kept) movedByPerson = true;
  };
  document.addEventListener('pointerdown', input, true);
  document.addEventListener('keydown', input, true);
}

export function keepFocusFor(from: URL | null | undefined, to: URL | null | undefined): void {
  movedByPerson = false;
  kept =
    from && to && from.pathname === to.pathname && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
}

export function restoreKeptFocus(): void {
  const el = kept;
  kept = null;
  if (!el) return;
  if (el === document.body) {
    const person = movedByPerson;
    movedByPerson = false;
    if (!person && document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
      document.activeElement.blur();
    return;
  }
  if (el.isConnected && !el.closest('dialog:not([open])')) el.focus({ preventScroll: true });
  else document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
}

export function redirectedAfterRender(): void {
  if (state.last !== null) state.last = '';
}
