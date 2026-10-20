<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { withVariant } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDate } from '@agrotrace/i18n';
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

  let { id }: { id: string } = $props();

  type Step = Schemas['PathStep'];
  type Item = TimelineEntry & { org: Step['org']; waybillNumber: Step['waybillNumber'] };

  const path = query(
    () => ['batch', id, 'path'],
    ([, batchId]) =>
      call<Step[]>(session.api.GET('/batches/{id}/path', { params: { path: { id: String(batchId) } } })),
    { failed: 'batches.pathFailed' },
  );
  const items = $derived<Item[]>(
    (path.data ?? []).map((s, i) => ({
      key: String(i),
      at: s.from,
      atText: s.to
        ? t('batches.period', { from: formatLocalDate(s.from, LOCALE), to: formatLocalDate(s.to, LOCALE) })
        : t('batches.since', { date: formatLocalDate(s.from, LOCALE) }),
      title: s.org.name,
      org: s.org,
      waybillNumber: s.waybillNumber,
    })),
  );
</script>

{#if !path.data && path.failed}
  <AreaFailed text={t('batches.pathFailed')} busy={path.fetching} onretry={() => void userAction(path.refetch)} />
{:else if !path.data}
  <AreaLoading blocks={1} />
{:else}
  <Card>
    <CardBody>
      <Timeline {items}>
        {#snippet meta(it: Item)}
          <Avatar
            name={it.org.name}
            src={it.org.logoUrl ? withVariant(it.org.logoUrl, 96) : null}
            size="s"
            shape="square"
            decorative
          />
          {enumLabel(t, 'OrganizationType', it.org.type)}{#if it.waybillNumber}, {t('batches.byWaybill', {
              number: it.waybillNumber,
            })}{/if}
        {/snippet}
      </Timeline>
    </CardBody>
  </Card>
{/if}
