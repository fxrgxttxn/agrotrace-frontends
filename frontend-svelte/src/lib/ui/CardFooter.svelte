<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<footer class="at-card__footer">{@render children()}</footer>
