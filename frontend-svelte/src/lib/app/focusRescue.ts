// Rulings FM21/FM24/FM26 (+ FM26 clarification): when an action the person triggered removes the control that had the
// focus (a selection cleared with its «Отметить прочитанным», a form that closed on success, a card re-rendered without
// it), the focus does not stay on the document body: it goes to the page title `h1.at-page__title`. An action is
// tracked from the person's click / key press to its answer, however long that takes (`userAction`), plus the input
// itself for what it changes at once; a passive refresh (a live event, a poll) never moves the focus. Screens that
// know a better target (a revealed form's field, the control that revealed a form) move it themselves first. A control
// that is only disabled (a 429 wait) keeps its claim: FM17 gives it the focus back when it can act. Browsers fire no
// blur when a focused element is removed, so the last focused element is remembered and checked after each DOM change.

/** How long after an input, or after an action's answer, the DOM changes that follow still belong to it (the screen
 * renders its answer within a frame or two). */
const SETTLE_MS = 300;

let pending = 0;
let settledAt = Number.NEGATIVE_INFINITY;
let inputAt = Number.NEGATIVE_INFINITY;

/** Runs an action the person triggered (a submit, a button's request): while it runs and as its answer renders, a
 * removal of the focused control is theirs. */
export async function userAction<T>(run: () => Promise<T>): Promise<T> {
  pending += 1;
  try {
    return await run();
  } finally {
    pending -= 1;
    settledAt = performance.now();
  }
}

/** Whether the DOM change now on its way belongs to the person's own action. */
function own(): boolean {
  return pending > 0 || performance.now() - Math.max(settledAt, inputAt) < SETTLE_MS;
}

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

/** Starts watching (the app layout, once); returns the stop function. */
export function focusRescue(): () => void {
  let last: Element | null = null;
  // a new app (tests mount one per case): nothing of an earlier one counts
  pending = 0;
  settledAt = Number.NEGATIVE_INFINITY;
  inputAt = Number.NEGATIVE_INFINITY;
  const onFocusIn = (e: FocusEvent) => {
    last = e.target as Element;
  };
  const onInput = () => {
    inputAt = performance.now();
  };
  const check = (again = true) => {
    if (!last) return;
    const active = document.activeElement;
    // a hidden control keeps `activeElement` in some browsers: it counts as removed too
    if (active && active !== document.body && !(active === last && gone(last))) {
      // FM29: the browser's own focus fix-up for a control that became hidden comes later — look again next frame
      if (again && active === last && own()) requestAnimationFrame(() => check(false));
      return;
    }
    if (!own() || !gone(last)) return;
    last = null;
    document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  // After the DOM settled (a screen's own focus move runs first).
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
}
