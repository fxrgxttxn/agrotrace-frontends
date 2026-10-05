<script lang="ts">
  import { page } from '$app/state';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { clock } from '../../app/now.svelte';
  import { RECALL_TONE } from '../../app/recalls';
  import { session } from '../../app/session.svelte';
  import BatchGraph from '../../graph/BatchGraph.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import Table from '../../ui/Table.svelte';
  import TablePrimary from '../../ui/TablePrimary.svelte';
  import type { Column } from '../../ui/table';
  import RecallProgress from './RecallProgress.svelte';
  import { asBatchGraph, at, GAP, STACK, TICK_MS, type Recall, type RecallBatch, type Task } from './recalls';
  import TaskChip from './TaskChip.svelte';
  import TaskConfirmed from './TaskConfirmed.svelte';
  import TaskDue from './TaskDue.svelte';

  const id = $derived(page.params.id ?? '');
  const now = clock(TICK_MS);
  const recallQuery = query(
    () => ['recall', id],
    ([, rid]) => call<Recall>(session.api.GET('/recalls/{id}', { params: { path: { id: String(rid) } } })),
    { failed: 'recalls.cardFailed' },
  );
  const recall = $derived(recallQuery.data);
  const notFound = $derived(!recall && recallQuery.error instanceof ApiProblem && recallQuery.error.status === 404);

  const graphQuery = query(
    () => (recall ? ['recall', recall.id, 'graph'] : null),
    ([, rid]) =>
      call<Schemas['RecallGraph']>(session.api.GET('/recalls/{id}/graph', { params: { path: { id: String(rid) } } })),
    { failed: 'graph.failed' },
  );

  const relation = (b: Pick<RecallBatch, 'direction' | 'depth'>) =>
    b.direction === 'SOURCE'
      ? enumLabel(t, 'RecallDirection', 'SOURCE')
      : b.direction === 'UP'
        ? t('graph.up', { level: b.depth })
        : t('graph.down', { level: b.depth });

  const taskColumns: Column<Task>[] = [
    { key: 'batch', header: t('recallTasks.batch'), primary: true },
    { key: 'status', header: t('recallTasks.status'), status: true },
    { key: 'holder', header: t('recallTasks.holder') },
    { key: 'due', header: t('recallTasks.dueAt') },
    { key: 'confirmed', header: t('recallTasks.confirmedAt') },
  ];
  const batchColumns: Column<RecallBatch>[] = [
    { key: 'batch', header: t('recallTasks.batch'), primary: true },
    { key: 'now', header: t('recalls.statusNow'), status: true },
    { key: 'link', header: t('recalls.direction') },
    { key: 'before', header: t('recalls.statusBefore') },
    { key: 'holder', header: t('recalls.holder') },
  ];
</script>

{#snippet taskCell(x: Task, c: Column<Task>)}
  {#if c.key === 'batch'}
    <TablePrimary href="/batches/{x.batch.id}" code={x.batch.publicCode} sub={x.batch.product.name} />
  {:else if c.key === 'status'}
    <TaskChip task={x} now={now.now} />
  {:else if c.key === 'holder'}
    {x.holder.name}
  {:else if c.key === 'due'}
    <TaskDue task={x} now={now.now} />
  {:else}
    <TaskConfirmed task={x} />
  {/if}
{/snippet}

{#snippet batchCell(x: RecallBatch, c: Column<RecallBatch>)}
  {#if c.key === 'batch'}
    <TablePrimary href="/batches/{x.batch.id}" code={x.batch.publicCode} sub={x.batch.product.name} />
  {:else if c.key === 'now'}
    <Chip status={x.batch.status} />
  {:else if c.key === 'link'}
    {relation(x)}
  {:else if c.key === 'before'}
    <Chip status={x.statusBefore} />
  {:else}
    {x.batch.holder.name}
  {/if}
{/snippet}

{#snippet sourceLink()}<a class="at-mono" href="/batches/{recall!.sourceBatch.id}">{recall!.sourceBatch.publicCode}</a>{/snippet}
{#snippet complaintLink()}<a href="/complaints/{recall!.complaintId}">{t('recalls.complaintOpen')}</a>{/snippet}
{#snippet labLink()}<a href="/batches/{recall!.sourceBatch.id}?tab=tests">{t('recalls.labTestOpen')}</a>{/snippet}

{#if notFound}
  <Page title={t('page.recall')}>
    <Card>
      <Empty art="not-found" text={t('recalls.notFound')}>
        {#snippet action()}<Button variant="primary" href="/recalls">{t('recalls.toList')}</Button>{/snippet}
      </Empty>
    </Card>
  </Page>
{:else}
  <Page title={recall ? t('recalls.title', { code: recall.sourceBatch.publicCode }) : t('page.recall')}>
    {#if !recall && recallQuery.failed}
      <AreaFailed
        text={t('recalls.cardFailed')}
        busy={recallQuery.fetching}
        onretry={() => void userAction(recallQuery.refetch)}
      />
    {:else if !recall}
      <AreaLoading />
    {:else}
      {@const r = recall}
      {@const facts = [
        { key: 'source', term: t('recalls.source'), value: sourceLink },
        { key: 'trigger', term: t('recalls.trigger'), value: enumLabel(t, 'RecallTrigger', r.trigger) },
        { key: 'opened', term: t('recalls.openedAt'), value: at(r.openedAt) },
        ...(r.openedBy ? [{ key: 'by', term: t('recalls.openedBy'), value: r.openedBy.fullName }] : []),
        ...(r.closedAt ? [{ key: 'closed', term: t('recalls.closedAt'), value: at(r.closedAt) }] : []),
        {
          key: 'upstream',
          term: t('recalls.blockUpstream'),
          value: r.blockUpstream ? t('recalls.upstreamBlocked') : t('recalls.upstreamKept'),
        },
        ...(r.complaintId ? [{ key: 'complaint', term: t('recalls.complaint'), value: complaintLink }] : []),
        ...(r.labTestId ? [{ key: 'lab', term: t('recalls.labTest'), value: labLink }] : []),
      ]}
      <div style={GAP}>
        <Card>
          <CardHeader title={r.sourceBatch.product.name}>
            <Chip tone={RECALL_TONE[r.status]} size="l">{enumLabel(t, 'RecallStatus', r.status)}</Chip>
          </CardHeader>
          <CardBody>
            <div style={STACK}>
              <dl class="at-card__facts">
                <div style="grid-column: 1 / -1">
                  <dt>{t('recalls.reason')}</dt>
                  <dd>{r.reason}</dd>
                </div>
              </dl>
              <CardFacts {facts} />
              <RecallProgress id="recall-progress" progress={r.progress} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('recalls.tasks')} />
          <CardBody>
            {#if r.tasks.length === 0}
              <p style="margin: 0">{t('recalls.noTasks')}</p>
            {:else}
              <Table cards caption={t('recalls.tasks')} columns={taskColumns} rows={r.tasks} rowKey={(x) => x.id} cell={taskCell} />
            {/if}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t('recalls.affected')} />
          <CardBody>
            <div style={STACK}>
              {#if graphQuery.data}
                <BatchGraph
                  graph={asBatchGraph(r, graphQuery.data)}
                  code={r.sourceBatch.publicCode}
                  labelKey="recalls.graphLabel"
                />
              {:else if graphQuery.failed}
                <AreaFailed
                  text={t('graph.failed')}
                  busy={graphQuery.fetching}
                  onretry={() => void userAction(graphQuery.refetch)}
                />
              {:else}
                <AreaLoading blocks={1} />
              {/if}
              <Table
                cards
                caption={t('recalls.affected')}
                columns={batchColumns}
                rows={r.batches}
                rowKey={(x) => x.batch.id}
                cell={batchCell}
              />
            </div>
          </CardBody>
        </Card>
      </div>
    {/if}
  </Page>
{/if}
