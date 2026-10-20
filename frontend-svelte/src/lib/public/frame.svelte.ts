import { afterNavigate } from '$app/navigation';
import { injectPublicIcons } from './sprite';

/** The public page (README «Публичная QR-страница»; call during component initialisation, the view writes the
 * `main.at-page.at-public` markup itself — no children snippet, the public JS budget): the document title, the page's
 * three icons, and after every client-side path change except the first load the focus on the title (ruling F4) with
 * the page scrolled to the top. */
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
