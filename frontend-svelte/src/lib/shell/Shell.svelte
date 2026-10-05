<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Me } from '@agrotrace/api-client';
  import { navigating, page } from '$app/state';
  import { t } from '../app/i18n';
  import { live } from '../app/live.svelte';
  import { navFor } from '../app/nav';
  import PageLoading from '../ui/PageLoading.svelte';
  import BottomNav from './BottomNav.svelte';
  import Sidebar from './Sidebar.svelte';
  import Topbar from './Topbar.svelte';

  let { me, children }: { me: Me; children: Snippet } = $props();

  const items = $derived(navFor(me));

  const pending = $derived(
    navigating.to &&
      navigating.to.url.pathname !== page.url.pathname &&
      navigating.to.route?.id !== page.route.id
      ? navigating.to.url.pathname
      : null,
  );
  const pathname = $derived(pending ?? page.url.pathname);

  let main: HTMLElement | null = $state(null);
  $effect(() => {
    if (!pending || !main) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || main.contains(active))
      main.focus({ preventScroll: true });
  });

  $effect(() => {
    void page.url.pathname;
    window.scrollTo?.(0, 0);
  });
</script>

<div class="at-shell">
  <a class="at-shell__skip" href="#main">{t('shell.skip')}</a>
  <Sidebar {items} {pathname} />
  <Topbar {me} unread={live.unread} />
  <main bind:this={main} class="at-shell__main" id="main" tabindex="-1">
    {#if pending}<PageLoading />{:else}{@render children()}{/if}
  </main>
  <BottomNav {items} {pathname} />
</div>
