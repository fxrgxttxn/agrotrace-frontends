<script lang="ts">
  import '@agrotrace/design-system/index.css';
  import type { Snippet } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { afterPageShown } from '$lib/app/chunkFailure';

  // Root of both route groups: `(app)` — the cabinet and auth screens (session, shell), `(public)` — the QR pages
  // (spec §9.6: no cabinet code). Nothing else lives here, so the public chunks stay light. The chunk-failure recovery
  // (FM11) is shared: one full load after a committed chunk failure, the guard spent once a page has loaded.
  let { children }: { children: Snippet } = $props();

  afterNavigate(() => afterPageShown(page.error));
</script>

{@render children()}
