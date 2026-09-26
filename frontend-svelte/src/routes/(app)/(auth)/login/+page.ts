import { guestOnly } from '$lib/app/guards';

// A signed-in visitor is sent on by the page (lib/pages/GuestOnly.svelte).
export async function load(): Promise<void> {
  await guestOnly();
}
