<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$lib/app/goto';
  import { page } from '$app/state';
  import { mayOpen } from '$lib/app/guards';
  import { loginUrl, session } from '$lib/app/session.svelte';
  import Unavailable from '$lib/pages/Unavailable.svelte';
  import Shell from '$lib/shell/Shell.svelte';
  import PageLoading from '$lib/ui/PageLoading.svelte';

  let { children }: { children: Snippet } = $props();

  const allowed = $derived(mayOpen(page.url.pathname));

  $effect(() => {
    if (session.status === 'anonymous')
      void goto(session.loggedOut ? '/login' : loginUrl(`${page.url.pathname}${page.url.search}`), {
        replaceState: true,
      });
    else if (session.status === 'authenticated' && !allowed) void goto('/403', { replaceState: true });
  });
</script>

{#if session.status === 'authenticated' && session.me}
  {#if allowed}<Shell me={session.me}>{@render children()}</Shell>{/if}
{:else if session.status === 'unavailable'}
  <Unavailable />
{:else if session.status === 'loading'}
  <PageLoading />
{/if}
