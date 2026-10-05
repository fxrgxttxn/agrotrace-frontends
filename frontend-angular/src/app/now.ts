import { DestroyRef, inject, signal } from '@angular/core';

export function injectNow(everyMs = 30000): () => number {
  const now = signal(Date.now());
  const timer = setInterval(() => now.set(Date.now()), everyMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return now.asReadonly();
}
