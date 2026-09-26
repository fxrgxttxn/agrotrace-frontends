/** Ruling FM17: when a countdown wait is over, the waiting button takes the focus back only if the focus is nowhere
 * else — on the page (`body`), on that button, or on an element that is gone; a field the person moved to keeps it.
 * (A module of its own: the shell's unavailable screen uses it without the forms code.) */
export function focusIfFree(button: HTMLElement | null | undefined): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}
