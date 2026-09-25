<script lang="ts">
  import type { IconName } from './icons';

  /** A sprite icon (README «Иконки»): always decorative, sized and coloured by the component class. */
  let { name, class: className }: { name: IconName; class?: string } = $props();
</script>

<svg class={className} aria-hidden="true"><use href="#i-{name}" /></svg>
