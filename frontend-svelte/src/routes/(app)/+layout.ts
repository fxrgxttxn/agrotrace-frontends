import { session } from '$lib/app/session.svelte';
import { injectSprite } from '$lib/app/sprite';

// Cabinet and auth screens: the icon sprite as the first child of <body> (README «Иконки»), then the session is restored
// once at start-up (refresh cookie → `/me`) before any of them.
export async function load(): Promise<void> {
  injectSprite();
  await session.start();
}
