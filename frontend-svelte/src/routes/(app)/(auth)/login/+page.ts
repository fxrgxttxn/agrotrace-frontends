import { guestOnly } from '$lib/app/guards';

export async function load(): Promise<void> {
  await guestOnly();
}
