<script lang="ts">
  import type { IconName } from './icons';

  let { name, class: className }: { name: IconName; class?: string } = $props();
</script>

<svg class={className} aria-hidden="true"><use href="#i-{name}" /></svg>
