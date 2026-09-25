<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Me } from '@agrotrace/api-client';
  import { page } from '$app/state';
  import { t } from '../app/i18n';
  import { live } from '../app/live.svelte';
  import { navFor } from '../app/nav';
  import BottomNav from './BottomNav.svelte';
  import Sidebar from './Sidebar.svelte';
  import Topbar from './Topbar.svelte';

  /** `at-shell` (README «Оболочка»): both navigations are always in the markup, the CSS shows one per width. */
  let { me, children }: { me: Me; children: Snippet } = $props();

  const items = $derived(navFor(me));

  // README «Фокус при смене маршрута»: scroll to the top of the new page.
  $effect(() => {
    void page.url.pathname;
    window.scrollTo?.(0, 0);
  });
</script>

<div class="at-shell">
  <a class="at-shell__skip" href="#main">{t('shell.skip')}</a>
  <Sidebar {items} />
  <Topbar {me} unread={live.unread} />
  <main class="at-shell__main" id="main" tabindex="-1">{@render children()}</main>
  <BottomNav {items} />
</div>
