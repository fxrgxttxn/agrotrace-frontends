import { cache, screenAlive } from './cache.svelte';
import { goto } from './goto';
import { toasts, type ToastInput } from '../ui/toast-store.svelte';

/** The late UI steps of a screen's actions (rulings FM26, FM29, FM30) — React's useScreenToast / useScreenNavigate:
 * `push` (a failure, a conflict, any message about the screen) and `navigate` need the screen mounted and its session;
 * `done` (a success of the person's action) needs only the session, so it is said even after the screen is gone. Call
 * during component initialisation. */
export function screenScope() {
  const alive = screenAlive();
  const born = cache.generation;
  return {
    alive,
    sameSession: () => cache.generation === born,
    push: (input: ToastInput): number => (alive() ? toasts.push(input) : -1),
    done: (input: ToastInput): number => (cache.generation === born ? toasts.push(input) : -1),
    navigate: (url: string, options?: Parameters<typeof goto>[1]): void => {
      if (alive()) void goto(url, options);
    },
  };
}
