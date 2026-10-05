import { onDestroy } from 'svelte';

const WIDE = '(min-width: 768px)';

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
