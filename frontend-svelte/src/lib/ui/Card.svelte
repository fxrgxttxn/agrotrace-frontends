<script lang="ts">
  import type { Snippet } from 'svelte';

  let { furrow = false, style, children }: { furrow?: boolean; style?: string; children: Snippet } = $props();
</script>

<article class="at-card" data-furrow={furrow ? '' : undefined} {style}>{@render children()}</article>
