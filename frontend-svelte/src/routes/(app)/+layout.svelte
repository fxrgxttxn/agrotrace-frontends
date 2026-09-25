<script lang="ts">
  import type { Snippet } from 'svelte';
  import { live } from '$lib/app/live.svelte';
  import { session } from '$lib/app/session.svelte';
  import { theme } from '$lib/app/theme.svelte';
  import Toasts from '$lib/ui/Toasts.svelte';

  // Everything of the cabinet and the auth screens: both toast regions from the start (README), the live stream while
  // signed in (bell counter, notification toasts).
  let { children }: { children: Snippet } = $props();

  theme.load();

  $effect(() => {
    if (session.status !== 'authenticated') return;
    return live.connect(session);
  });
</script>

{@render children()}
<Toasts />
