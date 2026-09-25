<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { loginUrl, session } from '$lib/app/session.svelte';
  import Unavailable from '$lib/pages/Unavailable.svelte';
  import Shell from '$lib/shell/Shell.svelte';
  import PageLoading from '$lib/ui/PageLoading.svelte';

  // The shell around every cabinet screen. The session can change under it: a retry after «Сервис недоступен» that
  // finds no session goes to the login like the guard would.
  let { children }: { children: Snippet } = $props();

  $effect(() => {
    if (session.status === 'anonymous')
      void goto(session.loggedOut ? '/login' : loginUrl(`${page.url.pathname}${page.url.search}`), {
        replaceState: true,
      });
  });
</script>

{#if session.status === 'authenticated' && session.me}
  <Shell me={session.me}>{@render children()}</Shell>
{:else if session.status === 'unavailable'}
  <Unavailable />
{:else if session.status === 'loading'}
  <PageLoading />
{/if}
