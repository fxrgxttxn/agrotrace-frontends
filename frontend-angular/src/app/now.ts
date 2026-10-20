import { DestroyRef, inject, signal } from '@angular/core';

/** The current time (ms), refreshed every `everyMs` (the React app's useNow): screens whose content depends on a
 * deadline (the 24 h edit window of a treatment, the time left to a withdrawal) follow it. Create it in an injection
 * context. */
export function injectNow(everyMs = 30000): () => number {
  const now = signal(Date.now());
  const timer = setInterval(() => now.set(Date.now()), everyMs);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
  return now.asReadonly();
}
