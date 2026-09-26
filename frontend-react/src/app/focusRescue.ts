import { useEffect } from 'react';

// Rulings FM21/FM24/FM26: when the person's own action removes the control that had the focus (a selection cleared
// with its «Отметить прочитанным», a form that closed on success, a card re-rendered without it), the focus does not
// stay on the document body: it goes to the page title `h1.at-page__title`. Only a removal that follows the person's
// own input (a key or a pointer press) within 2 s counts — a passive refresh of a list never moves the focus. Screens
// that know a better target (a dialog's opener, a button that comes back) move it themselves first. A control that is
// only disabled (a 429 wait) keeps its claim: FM17 gives it the focus back when it can act. Browsers fire no blur
// when a focused element is removed, so the last focused element is remembered and checked after each DOM change.

/** How long after the person's input a removal is theirs. */
export const RESCUE_WINDOW_MS = 2000;

/** Whether the page is laid out (a browser; jsdom has no layout). */
const laidOut = () => document.body.getClientRects().length > 0;

/** A control that left the page, whose dialog closed, or that is hidden (`hidden`, `display: none`). */
function gone(el: Element): boolean {
  if (!el.isConnected) return true;
  const dialog = el.closest('dialog');
  if (dialog !== null && !dialog.open) return true;
  if (el.closest('[hidden]')) return true;
  if (laidOut()) return el.getClientRects().length === 0;
  return getComputedStyle(el).display === 'none';
}

export function useFocusRescue(): void {
  useEffect(() => {
    let last: Element | null = null;
    let inputAt = -Infinity;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target as Element;
    };
    const onInput = () => {
      inputAt = performance.now();
    };
    const check = () => {
      const active = document.activeElement;
      if (!last || (active && active !== document.body)) return;
      if (performance.now() - inputAt > RESCUE_WINDOW_MS) return;
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
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class'],
    });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onInput, true);
    document.addEventListener('pointerdown', onInput, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onInput, true);
      document.removeEventListener('pointerdown', onInput, true);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
