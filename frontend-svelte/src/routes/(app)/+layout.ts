import { session } from '$lib/app/session.svelte';

// Cabinet and auth screens: the session is restored once at start-up (refresh cookie → `/me`) before any of them.
export async function load(): Promise<void> {
  await session.start();
}
