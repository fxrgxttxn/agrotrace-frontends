<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { focusRescue } from '$lib/app/focusRescue';
  import { live } from '$lib/app/live.svelte';
  import { keepFocusFor, restoreKeptFocus } from '$lib/app/routeFocus';
  import { stripBase } from '$lib/app/paths';
  import { cabinetRoute } from '$lib/app/routes';
  import { session } from '$lib/app/session.svelte';
  import { theme } from '$lib/app/theme.svelte';
  import Shell from '$lib/shell/Shell.svelte';
  import Toasts from '$lib/ui/Toasts.svelte';

  let { children }: { children: Snippet } = $props();

  theme.load();

  onMount(focusRescue);

  beforeNavigate(({ from, to }) => keepFocusFor(from?.url, to?.url));
  afterNavigate(() => restoreKeptFocus());

  const entering = $derived(
    session.status === 'authenticated' &&
      navigating.to !== null &&
      cabinetRoute(stripBase(navigating.to.url.pathname)) !== undefined &&
      !page.route.id?.startsWith('/(app)/(cabinet)'),
  );

  $effect(() => {
    if (session.status !== 'authenticated') return;
    return live.connect(session);
  });
</script>

{#if entering && session.me}
  <Shell me={session.me}>{@render children()}</Shell>
{:else}
  {@render children()}
{/if}
<Toasts />
