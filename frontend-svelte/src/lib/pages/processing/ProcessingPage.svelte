<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { canUseAsInput } from '@agrotrace/domain';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import Empty from '../../ui/Empty.svelte';
  import Page from '../../ui/Page.svelte';
  import ProcessingWizard from './ProcessingWizard.svelte';

  const inputs = query(
    () => ['batches', 'processable'],
    () =>
      call<Schemas['BatchPage']>(
        session.api.GET('/batches', {
          params: { query: { holder: 'me', status: ['Approved', 'Accepted'], size: 100, sort: 'publicCode,asc' } },
        }),
      ),
    { failed: 'processing.formFailed' },
  );
  const products = dictionary('products');
  const eligible = $derived((inputs.data?.items ?? []).filter((b) => canUseAsInput({ status: b.status }).allowed));
  const failed = $derived((!inputs.data && inputs.failed) || (!products.data && products.failed));
</script>

<Page title={t('page.processing')}>
  {#if failed}
    <AreaFailed
      text={t('processing.formFailed')}
      busy={inputs.fetching || products.fetching}
      onretry={() =>
        void userAction(async () => {
          await Promise.all([inputs.refetch(), products.refetch()]);
        })}
    />
  {:else if !inputs.data || !products.data}
    <AreaLoading />
  {:else if eligible.length === 0}
    <Card>
      <Empty art="empty-batches" text={t('processing.noInputs')}>
        {#snippet action()}<Button variant="primary" href="/waybills?direction=incoming">{t('waybillDirection.incoming')}</Button>{/snippet}
      </Empty>
    </Card>
  {:else}
    <ProcessingWizard batches={eligible} products={products.data} />
  {/if}
</Page>
