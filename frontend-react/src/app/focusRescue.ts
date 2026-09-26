import { useEffect } from 'react';
import { actionOpen, noteInput } from './actions';

// Rulings FM21/FM24/FM26/FM29: when the person's own action removes the control that had the focus (a selection
// cleared with its «Отметить прочитанным», a form that closed on success, a card re-rendered without it), the focus
// does not stay on the document body: it goes to the page title `h1.at-page__title`. Only a removal that belongs to an
// action the person triggered counts — from the key or pointer press to the answer of its requests, however long they
// take (actions.ts); a passive refresh never moves the focus. Screens that know a better target (a dialog's opener, a
// button that comes back) move it themselves first. A control that is only disabled (a 429 wait) keeps its claim:
// FM17 gives it the focus back. Browsers fire no blur when a focused element is removed, so the last focused element
// is remembered and checked after each DOM change; a control hidden with `hidden` / `display: none` keeps the focus
// until the browser's focus fixup (the next frame), so it is checked again then.

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

const nextFrame = (fn: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => fn()) : setTimeout(fn, 16);

export function useFocusRescue(): void {
  useEffect(() => {
    let last: Element | null = null;
    const onFocusIn = (e: FocusEvent) => {
      last = e.target as Element;
    };
    const check = (again: boolean) => {
      if (!last || !actionOpen() || !gone(last)) return;
      const active = document.activeElement;
      if (active === last) {
        // Hidden but still focused: the browser moves the focus away at its next frame — look again then.
        if (again) nextFrame(() => nextFrame(() => check(false)));
        return;
      }
      if (active && active !== document.body) return;
      last = null;
      document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // After the DOM settled (a dialog returning its focus runs first).
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        check(true);
      }, 0);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class'],
    });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', noteInput, true);
    document.addEventListener('pointerdown', noteInput, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', noteInput, true);
      document.removeEventListener('pointerdown', noteInput, true);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
