<script lang="ts">
  import '@agrotrace/design-system/index.css';
  import type { Snippet } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { afterPageShown, fullLoadAfterFailure } from '$lib/app/chunkFailure';

  // Root of both route groups: `(app)` — the cabinet and auth screens (session, shell), `(public)` — the QR pages
  // (spec §9.6: no cabinet code). Nothing else lives here, so the public chunks stay light. The chunk-failure recovery
  // (FM11/FM15) is shared: one full load after a committed failure, the mark spent once a page is shown, a fresh
  // document for the navigation after a failure.
  let { children }: { children: Snippet } = $props();

  beforeNavigate((nav) => {
    fullLoadAfterFailure(nav.type, nav.to?.url, nav.cancel, nav.type === 'link' ? nav.event : undefined);
  });
  afterNavigate(() => afterPageShown(page.error));
</script>

{@render children()}
