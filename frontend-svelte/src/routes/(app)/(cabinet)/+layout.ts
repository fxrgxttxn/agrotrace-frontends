import { requireAuth } from '$lib/app/guards';

// Cabinet guard (spec §9.2 «guard в +layout.ts»): anonymous users go to `/login?next=`.
export async function load({ url }: { url: URL }): Promise<void> {
  await requireAuth(url);
}
