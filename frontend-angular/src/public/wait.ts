import {
  afterRender,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

// Waiting out a 429 (rulings F7, FM17) on the public page, without the cabinet's code: a countdown, and the waiting
// button takes the focus back when it can act again — only if nothing else holds it.

/** Countdown (seconds): `start(seconds)`, `left()` — seconds remaining (0 — free). Create it in an injection context. */
export function countdown(): { left: Signal<number>; start: (seconds: number) => void } {
  const left = signal(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  inject(DestroyRef).onDestroy(stop);
  return {
    left,
    start: (seconds) => {
      stop();
      left.set(Math.max(1, Math.ceil(seconds)));
      timer = setInterval(() => {
        left.update((s) => s - 1);
        if (left() <= 0) stop();
      }, 1000);
    },
  };
}

/** FM17: the focus goes to `button` only if the focus is on the body, on that button, or on an element that left. */
export function focusIfIdle(button: HTMLElement | null | undefined): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

/** The button (`ref`) a 429 wait disabled gets the focus back when the wait is over (create in injection context). */
export function focusAfterWait(left: Signal<number>, ref: () => ElementRef<HTMLElement> | undefined): void {
  let waited = false;
  let pending = false;
  effect(() => {
    const l = left();
    untracked(() => {
      if (l > 0) waited = true;
      else if (waited) {
        waited = false;
        pending = true;
      }
    });
  });
  // once a render has enabled the button again
  afterRender(() => {
    const el = ref()?.nativeElement;
    if (!pending || !el || (el as HTMLButtonElement).disabled) return;
    pending = false;
    focusIfIdle(el);
  });
}
