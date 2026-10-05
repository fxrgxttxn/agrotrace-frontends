const PRESS_MS = 1000;
const ANSWER_MS = 500;

interface Moment {
  at: number;
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

export async function userAction<T>(run: () => Promise<T>): Promise<T> {
  const root = rootOf(document.activeElement);
  try {
    return await run();
  } finally {
    if (root?.isConnected) answer = { at: now(), root };
  }
}

export async function passive<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    passiveAt = now();
  }
}

function rescueWindow(root: Element | null): boolean {
  const t = now();
  const pressed = t - press.at < PRESS_MS && press.at > passiveAt && press.root === root;
  const answered = t - answer.at < ANSWER_MS && answer.at > passiveAt && answer.root === root;
  return pressed || answered;
}

const laidOut = () => document.body.getClientRects().length > 0;

function gone(el: Element): boolean {
  if (!el.isConnected) return true;
  const dialog = el.closest('dialog');
  if (dialog !== null && !dialog.open) return true;
  if (el.closest('[hidden]')) return true;
  if (laidOut()) return el.getClientRects().length === 0;
  return getComputedStyle(el).display === 'none';
}

const nextFrame = (fn: () => void) => requestAnimationFrame(() => fn());

export function focusRescue(): () => void {
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
      if (again) nextFrame(() => nextFrame(() => check(false)));
      return;
    }
    const root = lastRoot;
    last = null;
    lastRoot = null;
    if (active && active !== document.body) return;
    if (!rescueWindow(root)) return;
    document.querySelector<HTMLElement>('h1.at-page__title')?.focus({ preventScroll: true });
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
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
