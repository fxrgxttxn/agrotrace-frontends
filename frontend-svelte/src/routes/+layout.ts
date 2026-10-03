import { applyTheme, readTheme } from '$lib/app/theme.svelte';

// A static SPA (adapter-static fallback): every route renders in the browser only (spec §9.2: `ssr = false`).
export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';

// Before the first render of any page (the cabinet and the public QR pages alike): the stored theme on <html>. The
// icon sprite comes with the route group (README «Иконки»): the whole one for the cabinet ((app)/+layout.ts), only the
// three icons of a QR page there (lib/public/sprite.ts — the public JS budget).
export function load(): void {
  applyTheme(readTheme());
  // FM18: the app started — the static «page could not be loaded» fallback of index.html goes away.
  document.getElementById('at-load-failed')?.remove();
}
