import { session } from '$lib/app/session.svelte';
import { injectSprite } from '$lib/app/sprite';

export async function load(): Promise<void> {
  injectSprite();
  await session.start();
}
