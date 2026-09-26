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
  const pending = $derived(
    navigating.to && navigating.to.url.pathname !== page.url.pathname ? navigating.to.url.pathname : null,
  );
  const pathname = $derived(pending ?? page.url.pathname);

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
  <main class="at-shell__main" id="main" tabindex="-1">
    {#if pending}<PageLoading />{:else}{@render children()}{/if}
  </main>
  <BottomNav {items} {pathname} />
</div>
