import { DestroyRef, inject } from '@angular/core';
import { noteInput, rescueWindow } from './actions';

// The app-wide focus rescue, as the React app's focusRescue.ts (rulings FM21/FM24/FM26/FM29/FM30): when the person's
// own action removes the control that had the focus (a row re-read without its button, a form that closed on success,
// a card re-rendered without it), the focus does not stay on the document body: it goes to the page title
// `h1.at-page__title`. Only a removal that belongs to an action the person triggered counts — from the key or pointer
// press to the answer of its requests, however long they take (actions.ts); a passive refresh never moves the focus.
// Screens that know a better target (a dialog's opener, a revealed field) move it themselves first. A control that is
// only disabled (a 429 wait) keeps its claim: FM17 gives it the focus back. Browsers fire no blur when a focused
// element is removed, so the last focused element is remembered and checked after each DOM change; a control hidden
// with `hidden` / `display: none` keeps the focus until the browser's focus fixup (the next frame): checked again then.

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

/** Installs the rescue for the life of the calling component (the cabinet shell). */
export function installFocusRescue(): void {
  let last: Element | null = null;
  const onFocusIn = (e: FocusEvent) => {
    last = e.target as Element;
  };
  const check = (again: boolean) => {
    if (!last || !gone(last)) return;
    const active = document.activeElement;
    if (active === last) {
      // Hidden but still focused: the browser moves the focus away at its next frame — look again then.
      if (again) nextFrame(() => nextFrame(() => check(false)));
      return;
    }
    // FM30: a removal outside an own press / own answer is not the person's: the lost control is forgotten, the
    // focus is not moved — neither now nor after a later own answer.
    last = null;
    // Someone already moved the focus (a dialog back to its opener, the screen to a better target).
    if (active && active !== document.body) return;
    if (!rescueWindow()) return;
    document
      .querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')
      ?.focus({ preventScroll: true });
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
  inject(DestroyRef).onDestroy(() => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('keydown', noteInput, true);
    document.removeEventListener('pointerdown', noteInput, true);
    if (timer) clearTimeout(timer);
  });
}
