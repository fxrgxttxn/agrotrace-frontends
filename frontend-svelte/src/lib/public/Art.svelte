<script lang="ts">
  import type { ParsedArt } from './art';

  let { art }: { art: ParsedArt } = $props();

  /** The illustration's own markup (a build-time file of the design system, never data) — set once, without the
   * runtime of `{@html}` (the public page's JS budget). */
  function inner(node: SVGSVGElement, markup: string) {
    node.innerHTML = markup;
  }
</script>

<svg class="at-empty__art" aria-hidden="true" viewBox={art.viewBox} use:inner={art.inner}></svg>
