<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    level = 2,
    titleId,
    children,
  }: { title: string; level?: 1 | 2 | 3; titleId?: string; children?: Snippet } = $props();
</script>

<header class="at-card__header">
  <svelte:element this={`h${level}`} class="at-card__title" id={titleId}>{title}</svelte:element
  >{@render children?.()}
</header>
