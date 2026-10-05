import { requireAuth } from '$lib/app/guards';

export async function load({ url }: { url: URL }): Promise<void> {
  await requireAuth(url);
}
