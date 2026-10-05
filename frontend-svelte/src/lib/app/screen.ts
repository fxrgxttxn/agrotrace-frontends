import { cache, screenAlive } from './cache.svelte';
import { goto } from './goto';
import { toasts, type ToastInput } from '../ui/toast-store.svelte';

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
