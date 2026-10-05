<script lang="ts">
  import Nest from './Nest.svelte';
  import type { ChainNode } from './router.svelte';

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
