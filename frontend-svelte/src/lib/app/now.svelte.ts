import { onDestroy } from 'svelte';

export function clock(everyMs = 30000): { readonly now: number } {
  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), everyMs);
  onDestroy(() => clearInterval(timer));
  return {
    get now() {
      return now;
    },
  };
}
