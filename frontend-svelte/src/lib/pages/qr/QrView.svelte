<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Qr from '../../ui/Qr.svelte';
  import type { BatchItem } from '../stock/stock.svelte';

  let { batch, links }: { batch: BatchItem; links: Schemas['QrLinks'] | null } = $props();

  const docs = query(
    () => (links === null ? ['batch', batch.id, 'documents'] : null),
    ([, id]) =>
      call<Schemas['BatchDocuments']>(
        session.api.GET('/batches/{id}/documents', { params: { path: { id: String(id) } } }),
      ),
    { failed: 'qr.linksFailed' },
  );
  const qr = $derived(links ?? docs.data?.qr ?? null);
</script>

{#if !qr && links === null && !docs.data && !docs.failed}
  <AreaLoading blocks={1} />
{:else if !qr}
  <p style="margin: 0">{t('qr.linksFailed')}</p>
{:else}
  <div style="display: grid; gap: var(--sp-4); justify-items: start">
    <Qr value={qr.publicUrl} label={t('qr.image', { code: batch.publicCode, url: qr.publicUrl })} />
    <a href={qr.publicUrl} style="overflow-wrap: anywhere">{qr.publicUrl}</a>
    <div style="display: flex; flex-wrap: wrap; gap: var(--sp-3)">
      <Button icon="download" href={qr.pngUrl} download="{batch.publicCode}.png">{t('qr.png')}</Button>
      <Button icon="file-pdf" href={qr.pdfUrl} download="{batch.publicCode}.pdf">{t('qr.pdf')}</Button>
    </div>
  </div>
{/if}
