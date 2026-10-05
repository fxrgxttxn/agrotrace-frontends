<script lang="ts">
  import type { ParsedArt } from './art';

  let { art }: { art: ParsedArt } = $props();

  function inner(node: SVGSVGElement, markup: string) {
    node.innerHTML = markup;
  }
</script>

<svg class="at-empty__art" aria-hidden="true" viewBox={art.viewBox} use:inner={art.inner}></svg>
