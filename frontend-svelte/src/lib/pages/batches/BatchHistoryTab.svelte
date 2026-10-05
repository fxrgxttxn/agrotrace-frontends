<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { withVariant } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Avatar from '../../ui/Avatar.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import Timeline, { type TimelineEntry } from '../../ui/Timeline.svelte';
  import { STATUS_TONE } from './batches';

  let { id }: { id: string } = $props();

  type Item = TimelineEntry & { changedBy: Schemas['StatusHistoryItem']['changedBy']; reason: Schemas['StatusHistoryItem']['reason'] };

  const history = query(
    () => ['batch', id, 'history'],
    ([, batchId]) =>
      call<Schemas['StatusHistoryItem'][]>(
        session.api.GET('/batches/{id}/history', { params: { path: { id: String(batchId) } } }),
      ),
    { failed: 'batches.historyFailed' },
  );
  const items = $derived<Item[]>(
    (history.data ?? []).map((h, i) => ({
      key: String(i),
      at: h.changedAt,
      atText: formatLocalDateTime(h.changedAt, LOCALE),
      title: enumLabel(t, 'BatchStatus', h.to),
      tone: STATUS_TONE[h.to],
      changedBy: h.changedBy,
      reason: h.reason,
    })),
  );
</script>

{#if !history.data && history.failed}
  <AreaFailed text={t('batches.historyFailed')} busy={history.fetching} onretry={() => void userAction(history.refetch)} />
{:else if !history.data}
  <AreaLoading blocks={1} />
{:else}
  <Card>
    <CardBody>
      <Timeline {items}>
        {#snippet meta(it: Item)}
          {#if it.changedBy}
            <Avatar
              name={it.changedBy.fullName}
              src={it.changedBy.avatarUrl ? withVariant(it.changedBy.avatarUrl, 96) : null}
              size="s"
              decorative
            />
          {/if}
          {enumLabel(t, 'BatchStatusReason', it.reason)}, {it.changedBy?.fullName ?? t('batches.system')}
        {/snippet}
      </Timeline>
    </CardBody>
  </Card>
{/if}
