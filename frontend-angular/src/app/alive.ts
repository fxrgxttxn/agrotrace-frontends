import { DestroyRef, inject } from '@angular/core';
import { SessionService } from './session';

export function injectAlive(): () => boolean {
  let alive = true;
  inject(DestroyRef).onDestroy(() => (alive = false));
  return () => alive;
}

export function injectLive(): (generation: number) => boolean {
  const alive = injectAlive();
  const session = inject(SessionService);
  return (generation) => alive() && generation === session.generation;
}
