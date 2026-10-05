import { applyTheme, readTheme } from '$lib/app/theme.svelte';

export const ssr = false;
export const prerender = false;
export const trailingSlash = 'never';

export function load(): void {
  applyTheme(readTheme());
  document.getElementById('at-load-failed')?.remove();
}
