import { onDestroy } from 'svelte';

/** The current time (ms), refreshed every `everyMs`: screens whose buttons depend on a deadline (the 24 h edit window
 * of a treatment) re-render when it passes. Call during component initialisation. */
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
