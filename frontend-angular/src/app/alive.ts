import { DestroyRef, inject } from '@angular/core';
import { SessionService } from './session';

/** Ruling FM25: an action's UI steps (messages, focus, local state, reloads of its screen) are skipped once its screen
 * is gone — `alive()` says whether the component that created it (injection context) still stands. */
export function injectAlive(): () => boolean {
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));
  return () => alive;
}

/** Rulings FM26 / FM28: a late answer's UI steps (toast, navigation, focus, form messages) run only while the screen
 * stands AND the session it was asked in is still the one (`generation` taken when the request started). */
export function injectLive(): (generation: number) => boolean {
  const alive = injectAlive();
  const session = inject(SessionService);
  return (generation) => alive() && generation === session.generation;
}
