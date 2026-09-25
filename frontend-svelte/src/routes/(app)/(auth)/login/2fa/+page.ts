import { guestOnly } from '$lib/app/guards';

export async function load({ url }: { url: URL }): Promise<void> {
  await guestOnly(url);
}
