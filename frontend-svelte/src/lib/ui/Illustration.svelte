<script lang="ts">
  import { illustration, type IllustrationName } from './illustrations';

  let {
    name,
    class: className = 'at-empty__art',
    style,
  }: { name: IllustrationName; class?: string; style?: string } = $props();

  const art = $derived(illustration(name));
</script>

<!-- The design system's own illustration files, inlined at build time (README: Svelte puts the SVG markup in the component). -->
<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<svg class={className} aria-hidden="true" viewBox={art.viewBox} {style}>{@html art.inner}</svg>
