import { DestroyRef, inject } from '@angular/core';

/** Ruling FM25: an action's UI steps (messages, focus, local state, reloads of its screen) are skipped once its screen
 * is gone — `alive()` says whether the component that created it (injection context) still stands. */
export function injectAlive(): () => boolean {
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));
  return () => alive;
}
