// Focus rules after actions (rulings FM17, FM21, FM24–FM26), framework-free.

/** An element that cannot hold the focus any more: detached, or hidden (`hidden`, `display: none` on it or an
 * ancestor) — FM26 counts a hidden control as removed. */
export function gone(el: Element): boolean {
  if (!el.isConnected) return true;
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    if (n.hasAttribute('hidden')) return true;
    if (n instanceof HTMLElement && n.style.display === 'none') return true;
    if (getComputedStyle(n).display === 'none') return true;
  }
  return false;
}

/** The focus is nowhere: on the page, or on an element that is gone. */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || gone(active);
}

/** Ruling FM17: when a countdown wait is over, the waiting button takes the focus back only if the focus is nowhere
 * else — on the page (`body`), on that button, or on an element that is gone; a field the person moved to keeps it.
 * (A module of its own: the shell's unavailable screen uses it without the forms code.) */
export function focusIfFree(button: HTMLElement | null | undefined): void {
  if (!button) return;
  if (focusLost() || document.activeElement === button) button.focus();
}

/** FM26: the focus rescue follows the person's own input only — a removal within this time after their last pointer
 * or key input (passive refreshes never move the focus). */
export const OWN_INPUT_MS = 2000;
let lastInput = Number.NEGATIVE_INFINITY;
if (typeof document !== 'undefined') {
  const mark = () => (lastInput = Date.now());
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('keydown', mark, true);
}

/** Ruling FM21: after a dialog closes or an action removed the focused control, the focus goes back to the opener if
 * it is still on the page, else to the page title — only when the focus is lost (never taken from elsewhere) and the
 * removal follows the person's own input within {@link OWN_INPUT_MS} (FM26). `revealed`: the first field of a form
 * the action just showed (FM24) — it takes the focus first, only when the focus is idle (FM25/FM17). Call it after the
 * view shows the result (`afterNextRender`). */
export function restoreFocus(opener: Element | null | undefined, revealed?: HTMLElement | null): void {
  if (Date.now() - lastInput > OWN_INPUT_MS) return;
  if (revealed && !gone(revealed) && (focusLost() || document.activeElement === opener)) {
    revealed.focus();
    return;
  }
  if (!focusLost()) return;
  if (opener instanceof HTMLElement && !gone(opener)) opener.focus();
  else document.querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')?.focus();
}
