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

export function focusIfIdle(button: HTMLElement | null | undefined): void {
  if (!button) return;
  const active = document.activeElement;
  if (!active || active === document.body || active === button || !active.isConnected) button.focus();
}

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
  afterRender(() => {
    const el = ref()?.nativeElement;
    if (!pending || !el || (el as HTMLButtonElement).disabled) return;
    pending = false;
    focusIfIdle(el);
  });
}
