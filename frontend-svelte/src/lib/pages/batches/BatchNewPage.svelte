<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
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
  import BatchNewForm from './BatchNewForm.svelte';

  const products = dictionary('products');
  const fields = query(
    () => ['fields', 'all'],
    () =>
      call<Schemas['FieldPage']>(
        session.api.GET('/fields', { params: { query: { size: 100, sort: 'name,asc' } } }),
      ),
    { failed: 'batches.formFailed' },
  );
  const failed = $derived((!fields.data && fields.failed) || (!products.data && products.failed));
</script>

<Page title={t('page.batchNew')}>
  {#if fields.data && fields.data.items.length === 0}
    <Card>
      <Empty art="empty-fields" text={t('empty.fields')}>
        {#snippet action()}<Button variant="primary" href="/fields/new">{t('fields.add')}</Button>{/snippet}
      </Empty>
    </Card>
  {:else if failed}
    <AreaFailed
      text={t('batches.formFailed')}
      busy={fields.fetching || products.fetching}
      onretry={() =>
        void userAction(async () => {
          await Promise.all([fields.refetch(), products.refetch()]);
        })}
    />
  {:else if fields.data && products.data}
    <BatchNewForm fields={fields.data.items} products={products.data.filter((p) => p.category !== 'PROCESSED')} />
  {:else}
    <AreaLoading />
  {/if}
</Page>
