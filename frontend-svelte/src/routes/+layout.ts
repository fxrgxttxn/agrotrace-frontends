import { applyTheme, readTheme } from '$lib/app/theme.svelte';
import { injectSprite } from '$lib/app/sprite';

// A static SPA (adapter-static fallback): every route renders in the browser only (spec §9.2: `ssr = false`).
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';

// Before the first render of any page (the cabinet and the public QR pages alike): the stored theme on <html> and the
// icon sprite as the first child of <body> (README «Иконки»).
export function load(): void {
  applyTheme(readTheme());
  injectSprite();
  // FM18: the app started — the static «page could not be loaded» fallback of index.html goes away.
  document.getElementById('at-load-failed')?.remove();
}
