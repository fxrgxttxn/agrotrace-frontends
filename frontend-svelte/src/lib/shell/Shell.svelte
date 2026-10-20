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

  /** `at-shell` (README «Оболочка»): both navigations are always in the markup, the CSS shows one per width. */
  let { me, children }: { me: Me; children: Snippet } = $props();

  const items = $derived(navFor(me));

  // FM10: while an in-app navigation to another page waits for its code or data, the menus already mark the target
  // section and the content area shows the `aria-busy` loading page (the new page then takes the focus, F4).
  // The same route with other parameters (a dictionary tab, another batch) keeps its page: its code is here already,
  // so the page stays (and so does the focus on its tab, README «Вкладки») — as React keeps the same route element.
  const pending = $derived(
    navigating.to &&
      navigating.to.url.pathname !== page.url.pathname &&
      navigating.to.route?.id !== page.route.id
      ? navigating.to.url.pathname
      : null,
  );
  const pathname = $derived(pending ?? page.url.pathname);

  // The page under the focus may disappear for the loading page (focus inside main, e.g. a link of the page): the
  // focus goes to main (the loading region) instead of falling to <body>; the new page then takes it (F4).
  let main: HTMLElement | null = $state(null);
  $effect(() => {
    if (!pending || !main) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || main.contains(active))
      main.focus({ preventScroll: true });
  });

  // README «Фокус при смене маршрута»: scroll to the top of the new page.
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
