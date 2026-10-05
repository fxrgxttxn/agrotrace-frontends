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

export const navigating: { from: null; to: { url: URL } | null; type: null } = $state({
  from: null,
  to: null,
  type: null,
});
export const updated = { current: false, check: async () => false };
