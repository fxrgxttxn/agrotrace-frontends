import { onDestroy } from 'svelte';

const WIDE = '(min-width: 768px)';

/** `true` from 768 px (the tablet and desktop layouts), live (call during component initialisation). */
export function wideScreen(): { readonly wide: boolean } {
  const mq = window.matchMedia(WIDE);
  let wide = $state(mq.matches);
  const on = () => (wide = mq.matches);
  mq.addEventListener('change', on);
  onDestroy(() => mq.removeEventListener('change', on));
  return {
    get wide() {
      return wide;
    },
  };
}
