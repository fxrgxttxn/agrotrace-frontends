export function gone(el: Element): boolean {
  if (!el.isConnected) return true;
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    if (n.hasAttribute('hidden')) return true;
    if (n instanceof HTMLElement && n.style.display === 'none') return true;
    if (getComputedStyle(n).display === 'none') return true;
  }
  return false;
}

export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || gone(active);
}

export function focusIfFree(button: HTMLElement | null | undefined): void {
  if (!button) return;
  if (focusLost() || document.activeElement === button) button.focus();
}

const INPUT_TASK_MS = 1000;
let lastInput = Number.NEGATIVE_INFINITY;
if (typeof document !== 'undefined') {
  const mark = () => (lastInput = Date.now());
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('keydown', mark, true);
  document.addEventListener('click', mark, true);
}

export interface ActionOrigin {
  el: Element | null;
  triggered: boolean;
}

export function actionOrigin(): ActionOrigin {
  return { el: document.activeElement, triggered: Date.now() - lastInput < INPUT_TASK_MS };
}

export function restoreFocus(origin: ActionOrigin, revealed?: HTMLElement | null): void {
  if (!origin.triggered) return;
  rescue(origin.el, revealed);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => rescue(origin.el, revealed));
}

function rescue(opener: Element | null, revealed?: HTMLElement | null): void {
  if (revealed && !gone(revealed) && (focusLost() || document.activeElement === opener)) {
    if (document.activeElement !== revealed) revealed.focus();
    return;
  }
  if (!focusLost()) return;
  if (opener instanceof HTMLElement && !gone(opener)) opener.focus();
  else document.querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')?.focus();
}
