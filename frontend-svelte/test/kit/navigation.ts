import { onMount } from 'svelte';
import { router, type Navigation } from './router.svelte';

// Test stand-in for `$app/navigation` (vitest.config.ts alias), backed by the in-memory router (router.svelte.ts).

export function goto(
  url: string | URL,
  opts: { replaceState?: boolean; state?: Record<string, unknown> } = {},
): Promise<void> {
  const u = typeof url === 'string' ? url : url.pathname + url.search + url.hash;
  return router.goto(u, opts);
}

/** Like SvelteKit: registered when the component mounts, called after every navigation while it is mounted. */
export function afterNavigate(callback: (nav: Navigation) => void): void {
  onMount(() => {
    router.afterNavigate.add(callback);
    return () => router.afterNavigate.delete(callback);
  });
}

export function beforeNavigate(): void {}
export function onNavigate(): void {}
export async function invalidate(): Promise<void> {}
export async function invalidateAll(): Promise<void> {}
export async function preloadData(): Promise<void> {}
export async function preloadCode(): Promise<void> {}
export function pushState(): void {}
export function replaceState(): void {}
export function disableScrollHandling(): void {}
