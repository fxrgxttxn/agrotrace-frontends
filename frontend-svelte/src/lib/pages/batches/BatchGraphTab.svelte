<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { formatDecimal } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import BatchGraph from '../../graph/BatchGraph.svelte';
  import type { GraphNode } from '../../graph/elements';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Table from '../../ui/Table.svelte';
  import TablePrimary from '../../ui/TablePrimary.svelte';
  import type { Column } from '../../ui/table';
  import { GAP, type Batch } from './batches';

  let { batch }: { batch: Batch } = $props();

  const graphQuery = query(
    () => ['batch', batch.id, 'graph'],
    ([, id]) =>
      call<Schemas['BatchGraph']>(
        session.api.GET('/batches/{id}/graph', { params: { path: { id: String(id) }, query: { depth: 2 } } }),
      ),
    { failed: 'graph.failed' },
  );

  const relation = (n: GraphNode) =>
    n.depth === 0 ? t('graph.root') : n.depth < 0 ? t('graph.up', { level: -n.depth }) : t('graph.down', { level: n.depth });

  const columns = $derived<Column<GraphNode>[]>([
    { key: 'code', header: t('batches.code'), primary: true },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'holder', header: t('batches.holder') },
    { key: 'link', header: t('graph.link'), text: relation },
    { key: 'used', header: t('graph.used'), numeric: true },
  ]);
</script>

{#snippet cell(n: GraphNode, c: Column<GraphNode>)}
  {#if c.key === 'code'}
    {#if n.accessible && n.id !== batch.id}
      <TablePrimary href="/batches/{n.id}?tab=graph" code={n.publicCode} sub={n.product.name} />
    {:else if n.accessible}
      <span class="at-table__primary"><span class="at-mono">{n.publicCode}</span><span class="at-table__sub">{n.product.name}</span></span>
    {:else}
      <span class="at-table__primary"
        ><a class="at-mono" href="/p/{n.publicCode}">{n.publicCode}</a><span class="at-table__sub"
          >{n.product.name}, {t('graph.noAccess').toLocaleLowerCase('ru')}</span
        ></span
      >
    {/if}
  {:else if c.key === 'status'}
    <Chip status={n.status} />
  {:else if c.key === 'holder'}{n.holder.name}{:else if c.key === 'link'}{relation(n)}{:else if c.key === 'used'}{@const graph = graphQuery.data}{@const edge =
      graph?.edges.find((e) => (n.depth < 0 ? e.parent === n.id : e.child === n.id))}{n.depth !== 0 && edge
      ? formatDecimal(edge.massUsedKg, LOCALE)
      : '—'}{/if}
{/snippet}

{#if !graphQuery.data && graphQuery.failed}
  <AreaFailed text={t('graph.failed')} busy={graphQuery.fetching} onretry={() => void userAction(graphQuery.refetch)} />
{:else if !graphQuery.data}
  <AreaLoading blocks={1} />
{:else}
  <div style={GAP}>
    <BatchGraph graph={graphQuery.data} code={batch.publicCode} />
    <Table cards caption={t('graph.related')} {columns} rows={graphQuery.data.nodes} rowKey={(n) => n.id} {cell} />
  </div>
{/if}
