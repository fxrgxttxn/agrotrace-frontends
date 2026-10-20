// Rulings FM21/FM24/FM26 (+ clarification)/FM29/FM30 — the same rule as the React app (src/app/focusRescue.ts,
// actions.ts there): when the person's own action removes the control that had the focus (a selection cleared with its
// «Отметить прочитанным», a form that closed on success, a card re-rendered without it), the focus does not stay on
// the document body: it goes to the page title `h1.at-page__title`.
//   - Only right after the person's own press, or right after the answer of a request their action started
//     (`userAction`, however long it took) — never merely while such a request is pending.
//   - Only on the screen that acted: a press or an answer counts for the screen (`.at-page`) it came from, and an
//     answer of a screen that is gone counts for nothing (an old PATCH answering on another screen moves nothing).
//   - A passive refresh (a live-event invalidation, a poll: `passive`) never moves the focus, and a passive answer after
//     the last own step closes the window.
// Screens that know a better target (a revealed form's field, the control that revealed a form) move it themselves
// first. A control that is only disabled (a 429 wait) keeps its claim: FM17 gives it the focus back. Browsers fire no
// blur when a focused element is removed, so the last focused element is remembered and checked after each DOM change;
// a control hidden with `hidden` / `display: none` keeps the focus until the browser's focus fix-up (the next frame),
// so it is checked again then.

/** A removal this soon after a press belongs to it. */
const PRESS_MS = 1000;
/** A removal this soon after an own answer belongs to the action (its render). */
const ANSWER_MS = 500;

interface Moment {
  at: number;
  /** The screen it belongs to (`.at-page`), or null outside a page. */
  root: Element | null;
}

const NEVER: Moment = { at: Number.NEGATIVE_INFINITY, root: null };
let press = NEVER;
let answer = NEVER;
let passiveAt = Number.NEGATIVE_INFINITY;

const now = () => performance.now();
const rootOf = (el: EventTarget | Element | null | undefined): Element | null =>
  el instanceof Element ? el.closest('.at-page') : null;

function noteInput(e: Event): void {
  press = { at: now(), root: rootOf(e.target) };
}

/** Runs an action the person triggered (a submit, a button's request): its answer opens the rescue window of the
 * screen it started on — if that screen is still there. */
export async function userAction<T>(run: () => Promise<T>): Promise<T> {
  const root = rootOf(document.activeElement);
  try {
    return await run();
  } finally {
    if (root?.isConnected) answer = { at: now(), root };
  }
}

/** Runs a passive request (a live-event refresh, a poll): its answer never opens the window and closes an open one. */
export async function passive<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    passiveAt = now();
  }
}

/** Whether a removal on the screen `root` belongs to the person's own action now. */
function rescueWindow(root: Element | null): boolean {
  const t = now();
  const pressed = t - press.at < PRESS_MS && press.at > passiveAt && press.root === root;
  const answered = t - answer.at < ANSWER_MS && answer.at > passiveAt && answer.root === root;
  return pressed || answered;
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

const nextFrame = (fn: () => void) => requestAnimationFrame(() => fn());

/** Starts watching (the app layout, once); returns the stop function. */
export function focusRescue(): () => void {
  // a new app (tests mount one per case): nothing of an earlier one counts
  press = NEVER;
  answer = NEVER;
  passiveAt = Number.NEGATIVE_INFINITY;
  let last: Element | null = null;
  let lastRoot: Element | null = null;
  const onFocusIn = (e: FocusEvent) => {
    last = e.target as Element;
    lastRoot = rootOf(last);
  };
  const check = (again: boolean) => {
    if (!last || !gone(last)) return;
    const active = document.activeElement;
    if (active === last) {
      // Hidden but still focused: the browser moves the focus away at its next frame — look again then (FM29).
      if (again) nextFrame(() => nextFrame(() => check(false)));
      return;
    }
    const root = lastRoot;
    // A removal outside an own press / own answer is not the person's: the lost control is forgotten, the focus is
    // not moved — neither now nor after a later own answer (FM30).
    last = null;
    lastRoot = null;
    // Someone already moved the focus (the screen to a better target).
    if (active && active !== document.body) return;
    if (!rescueWindow(root)) return;
    document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  // After the DOM settled (a screen's own focus move runs first).
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
}
