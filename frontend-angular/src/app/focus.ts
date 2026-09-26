/** Ruling FM17: when a countdown wait is over, the waiting button takes the focus back only if the focus is nowhere
 * else — on the page (`body`), on that button, or on an element that is gone; a field the person moved to keeps it.
 * (A module of its own: the shell's unavailable screen uses it without the forms code.) */
export function focusIfFree(button: HTMLElement | null | undefined): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

/** The focus is nowhere: on the page, or on an element that is gone. */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** Ruling FM21: after a dialog closes or an action removed the focused control, the focus goes back to the opener if
 * it is still on the page, else to the page title — and only when the focus is lost (never taken from elsewhere).
 * Call it after the view shows the result (`afterNextRender`). */
export function restoreFocus(opener: Element | null | undefined): void {
  if (!focusLost()) return;
  if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  else document.querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')?.focus();
}
