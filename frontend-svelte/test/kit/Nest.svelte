<script lang="ts">
  import Nest from './Nest.svelte';
  import type { ChainNode } from './router.svelte';

  // Layouts wrap what follows them through `children`, the page is last — as SvelteKit renders a route.
  let { chain, i = 0 }: { chain: ChainNode[]; i?: number } = $props();
  const node = $derived(chain[i]);
</script>

{#if node}
  {#if i < chain.length - 1}
    <node.component data={node.data}><Nest {chain} i={i + 1} /></node.component>
  {:else}
    <node.component data={node.data} />
  {/if}
{/if}
