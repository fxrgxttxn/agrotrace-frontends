<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import WaybillNewForm from './WaybillNewForm.svelte';

  const stock = query(
    () => ['batches', 'shippable'],
    () =>
      call<Schemas['BatchPage']>(
        session.api.GET('/batches', {
          params: { query: { holder: 'me', status: ['Approved', 'Accepted'], size: 100, sort: 'publicCode,asc' } },
        }),
      ),
    { failed: 'waybills.formFailed' },
  );
</script>

<Page title={t('page.waybillNew')}>
  {#if !stock.data && stock.failed}
    <AreaFailed text={t('waybills.formFailed')} busy={stock.fetching} onretry={() => void userAction(stock.refetch)} />
  {:else if !stock.data}
    <AreaLoading />
  {:else if stock.data.items.length === 0}
    <Card>
      <Empty art="empty-batches" text={t('waybills.noStock')}>
        {#snippet action()}<Button variant="primary" href="/batches">{t('batches.toList')}</Button>{/snippet}
      </Empty>
    </Card>
  {:else}
    <WaybillNewForm batches={stock.data.items} />
  {/if}
</Page>
