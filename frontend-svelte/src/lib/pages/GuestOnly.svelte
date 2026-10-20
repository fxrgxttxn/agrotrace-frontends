<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { guestTarget } from '../app/guards';
  import { goto } from '../app/goto';
  import { redirectedAfterRender } from '../app/routeFocus';

  /** An auth screen (login, 2FA) for guests only: a signed-in visitor — a direct visit, or Back to a login entry after
   * signing in — goes where `next` says (or home), replacing the entry; the page it lands on takes the focus (F4). The
   * screen's own sign-in navigates by itself. */
  let { children }: { children: Snippet } = $props();

  const target = guestTarget(page.url);

  onMount(() => {
    if (target === null) return;
    redirectedAfterRender();
    void goto(target, { replaceState: true });
  });
</script>

{#if target === null}{@render children()}{/if}
