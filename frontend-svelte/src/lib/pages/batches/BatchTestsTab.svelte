<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { withBase } from '../../app/paths';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Card from '../../ui/Card.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';
  import { LAB_STATUS_TONE } from './batches';

  let { id, labLinks }: { id: string; labLinks: boolean } = $props();

  type Item = Schemas['LabTestListItem'];

  const tests = query(
    () => ['batch', id, 'tests'],
    ([, batchId]) =>
      call<Schemas['LabTestPage']>(
        session.api.GET('/lab-tests', { params: { query: { batchId: String(batchId), size: 100, sort: 'dueAt,asc' } } }),
      ),
    { failed: 'labTests.failed' },
  );
  const items = $derived(tests.data?.items ?? []);

  const columns: Column<Item>[] = [
    { key: 'lab', header: t('labTests.lab'), primary: true },
    { key: 'status', header: t('labTests.status'), status: true },
    { key: 'conclusion', header: t('labTests.conclusion') },
    { key: 'due', header: t('labTests.dueAt') },
  ];
</script>

{#snippet cell(x: Item, c: Column<Item>)}
  {#if c.key === 'lab'}
    <span class="at-table__primary"
      >{#if labLinks}<a href={withBase(`/lab/tests/${x.id}`)}>{x.lab.name}</a>{:else}<span>{x.lab.name}</span>{/if}<span
        class="at-table__sub">{enumLabel(t, 'LabTestReason', x.reason)}</span
      ></span
    >
  {:else if c.key === 'status'}
    <Chip tone={LAB_STATUS_TONE[x.status]}>{enumLabel(t, 'LabTestStatus', x.status)}</Chip>
  {:else if c.key === 'conclusion'}
    {#if x.conclusion}<Chip tone={x.conclusion === 'PASS' ? 'ok' : 'danger'}>{enumLabel(t, 'LabConclusion', x.conclusion)}</Chip
      >{:else}—{/if}
  {:else}
    {formatLocalDateTime(x.completedAt ?? x.dueAt, LOCALE)}{#if x.overdue}
      <Chip tone="danger">{t('labTests.overdue')}</Chip>{/if}
  {/if}
{/snippet}

{#if !tests.data && tests.failed}
  <AreaFailed text={t('labTests.failed')} busy={tests.fetching} onretry={() => void userAction(tests.refetch)} />
{:else if !tests.data}
  <AreaLoading blocks={1} />
{:else if items.length === 0}
  <Card><Empty art="empty-lab" text={t('labTests.empty')} /></Card>
{:else}
  <Table cards caption={t('batches.tab.tests')} {columns} rows={items} rowKey={(x) => x.id} {cell} />
{/if}
