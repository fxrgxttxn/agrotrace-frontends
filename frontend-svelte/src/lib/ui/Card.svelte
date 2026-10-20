<script lang="ts">
  import type { Snippet } from 'svelte';

  /** `at-card` (README «Карточка»). `furrow` — only the public QR page and the login screen. */
  let { furrow = false, style, children }: { furrow?: boolean; style?: string; children: Snippet } = $props();
</script>

<article class="at-card" data-furrow={furrow ? '' : undefined} {style}>{@render children()}</article>
