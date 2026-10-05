<script lang="ts">
  import type { Snippet } from 'svelte';

  let { facts }: { facts: { term: string; value: string | Snippet; key?: string }[] } = $props();
</script>

<dl class="at-card__facts">
  {#each facts as f, i (f.key ?? i)}<div>
      <dt>{f.term}</dt><dd>{#if typeof f.value === 'string'}{f.value}{:else}{@render f.value()}{/if}</dd>
    </div>{/each}
</dl>
