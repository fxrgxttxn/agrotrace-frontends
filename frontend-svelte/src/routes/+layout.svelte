<script lang="ts">
  import '@agrotrace/design-system/index.css';
  import type { Snippet } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { afterPageShown, fullLoadAfterFailure } from '$lib/app/chunkFailure';

  let { children }: { children: Snippet } = $props();

  beforeNavigate((nav) => {
    fullLoadAfterFailure(nav.type, nav.to?.url, nav.cancel, nav.type === 'link' ? nav.event : undefined);
  });
  afterNavigate(() => afterPageShown(page.error));
</script>

{@render children()}
