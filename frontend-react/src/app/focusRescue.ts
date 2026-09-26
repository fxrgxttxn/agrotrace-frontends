import { useEffect } from 'react';

// Ruling FM21/FM24: when an action removes the control that had the focus (a selection cleared with its «Отметить
// прочитанным», a form that closed on success, a card re-rendered without it), the focus does not stay on the document
// body: it goes to the page title `h1.at-page__title`. Screens that know a better target (the opener of a dialog, a
// button that comes back) move it themselves first. A control that is only disabled (a 429 wait) keeps its claim:
// FM17 gives it the focus back when it can act again. Browsers fire no blur when a focused element is removed, so the
// last focused element is remembered and checked after each change of the DOM.

/** A control that left the page or whose dialog closed. */
function gone(el: Element): boolean {
  const dialog = el.closest('dialog');
  return !el.isConnected || (dialog !== null && !dialog.open);
}

export function useFocusRescue(): void {
  useEffect(() => {
    let last: Element | null = null;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target as Element;
    };
    const check = () => {
      const active = document.activeElement;
      if (!last || (active && active !== document.body)) return;
      if (!gone(last)) return;
      last = null;
      document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // After the DOM settled (a dialog returning its focus runs first).
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        check();
      }, 0);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', onFocusIn);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
