<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { guestTarget } from '../app/guards';
  import { goto } from '../app/goto';
  import { redirectedAfterRender } from '../app/routeFocus';

  let { children }: { children: Snippet } = $props();

  const target = guestTarget(page.url);

  onMount(() => {
    if (target === null) return;
    redirectedAfterRender();
    void goto(target, { replaceState: true });
  });
</script>

{#if target === null}{@render children()}{/if}
