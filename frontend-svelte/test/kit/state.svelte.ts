// Test stand-in for `$app/state` (vitest.config.ts alias): the `page` object of the in-memory router
// (test/kit/router.svelte.ts). Same shape as SvelteKit's for what the app reads: url, params, route.id, status, data.

interface PageState {
  url: URL;
  params: Record<string, string>;
  route: { id: string | null };
  status: number;
  error: { message: string } | null;
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  form: unknown;
}

export const page: PageState = $state({
  url: new URL('http://localhost/'),
  params: {},
  route: { id: null },
  status: 200,
  error: null,
  data: {},
  state: {},
  form: null,
});

export const navigating = { current: null };
export const updated = { current: false, check: async () => false };
