<script lang="ts">
  import { t } from '../app/i18n';
  import Button from '../ui/Button.svelte';
  import Chip from '../ui/Chip.svelte';
  import { Fullscreen } from '../ui/fullscreen.svelte';
  import type { GraphView } from './cytoscape';
  import type { BatchGraph } from './elements';
  import GraphCanvas from './GraphCanvas.svelte';

  let {
    graph,
    code,
    labelKey = 'graph.label',
  }: {
    graph: BatchGraph;
    code: string;
    labelKey?: string;
  } = $props();

  const fs = new Fullscreen();
  const view: { current: GraphView | null } = { current: null };
  const up = $derived(graph.nodes.filter((n) => n.depth < 0).length);
  const down = $derived(graph.nodes.filter((n) => n.depth > 0).length);
  const statuses = $derived([...new Set(graph.nodes.map((n) => n.status))]);
</script>

{#if !fs.wide && !fs.full}
  <Button bind:element={fs.opener} icon="graph" onclick={fs.open}>{t('graph.open')}</Button>
{:else}
  <div bind:this={fs.block} class="at-graph" data-fullscreen={fs.full ? '' : undefined}>
    <GraphCanvas {graph} label={t(labelKey, { code, up, down })} {view} onopennode={fs.close} />
    <div class="at-graph__toolbar">
      <Button
        variant="ghost"
        size="s"
        iconOnly
        icon="plus"
        aria-label={t('graph.zoomIn')}
        onclick={() => view.current?.zoom(1.25)}
      />
      <Button
        variant="ghost"
        size="s"
        iconOnly
        icon="minus"
        aria-label={t('graph.zoomOut')}
        onclick={() => view.current?.zoom(0.8)}
      />
      {#if fs.full}
        <Button
          bind:element={fs.closer}
          variant="ghost"
          size="s"
          iconOnly
          icon="close"
          aria-label={t('graph.close')}
          onclick={fs.close}
        />
      {/if}
    </div>
    <ul class="at-graph__legend" aria-label={t('ui.legend')}>
      {#each statuses as s (s)}
        <li><Chip status={s} /></li>
      {/each}
    </ul>
  </div>
{/if}
