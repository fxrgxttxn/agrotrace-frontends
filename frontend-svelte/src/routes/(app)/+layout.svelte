<script lang="ts">
  import type { Snippet } from 'svelte';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { live } from '$lib/app/live.svelte';
  import { keepFocusFor, restoreKeptFocus } from '$lib/app/routeFocus';
  import { cabinetRoute } from '$lib/app/routes';
  import { session } from '$lib/app/session.svelte';
  import { theme } from '$lib/app/theme.svelte';
  import Shell from '$lib/shell/Shell.svelte';
  import Toasts from '$lib/ui/Toasts.svelte';

  // Everything of the cabinet and the auth screens: both toast regions from the start (README), the live stream while
  // signed in (bell counter, notification toasts).
  let { children }: { children: Snippet } = $props();

  theme.load();

  // README «Фокус при смене маршрута»: a query-only change (back/forward included) keeps focus where it was.
  beforeNavigate(({ from, to }) => keepFocusFor(from?.url, to?.url));
  afterNavigate(() => restoreKeptFocus());

  // FM10/FM11: entering the cabinet from a screen outside the shell (login, 2FA, 403/404…) shows the shell at once,
  // with the target section current and the loading page in main, while the target page's code loads.
  const entering = $derived(
    session.status === 'authenticated' &&
      navigating.to !== null &&
      cabinetRoute(navigating.to.url.pathname) !== undefined &&
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
