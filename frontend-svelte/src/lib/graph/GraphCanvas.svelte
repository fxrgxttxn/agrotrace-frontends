<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from '../app/i18n';
  import { goto } from '../app/goto';
  import { themeVersion } from '../ui/fullscreen.svelte';
  import type { GraphView } from './cytoscape';
  import type { BatchGraph } from './elements';

  let {
    graph,
    label,
    view,
    onopennode,
  }: {
    graph: BatchGraph;
    label: string;
    view: { current: GraphView | null };
    onopennode: () => void;
  } = $props();

  let el: HTMLDivElement | null = $state(null);
  let failed = $state(false);
  const theme = themeVersion();

  $effect(() => {
    void theme.value;
    const node = el;
    const g = graph;
    if (!node) return;
    let cancelled = false;
    import('./cytoscape').then(
      ({ mountGraph }) => {
        if (cancelled) return;
        view.current = mountGraph(node, g, (n) => {
          untrack(onopennode);
          if (n.accessible) void goto(`/batches/${n.id}?tab=graph`);
          else window.location.assign(`/p/${n.publicCode}`);
        });
      },
      () => {
        if (!cancelled) failed = true;
      },
    );
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  });
</script>

{#if failed}
  <div class="at-graph__canvas"><p role="alert" style="margin: 0; padding: var(--sp-5)">{t('graph.failed')}</p></div>
{:else}
  <div class="at-graph__canvas" role="img" aria-label={label} bind:this={el}></div>
{/if}
