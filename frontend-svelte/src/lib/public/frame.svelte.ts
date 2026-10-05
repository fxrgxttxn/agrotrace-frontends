import { afterNavigate } from '$app/navigation';
import { injectPublicIcons } from './sprite';

export function publicFrame(title: () => string): void {
  injectPublicIcons();
  $effect(() => {
    document.title = `${title()} — AgroTrace`;
  });
  afterNavigate(({ type, from, to }) => {
    if (type === 'enter' || !from || from.url.pathname === to?.url.pathname) return;
    window.scrollTo?.(0, 0);
    document.querySelector<HTMLElement>('h1.at-page__title')?.focus();
  });
}
