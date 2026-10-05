<script lang="ts">
  import { illustration, type IllustrationName } from './illustrations';

  let {
    name,
    class: className = 'at-empty__art',
    style,
  }: { name: IllustrationName; class?: string; style?: string } = $props();

  const art = $derived(illustration(name));
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<svg class={className} aria-hidden="true" viewBox={art.viewBox} {style}>{@html art.inner}</svg>
