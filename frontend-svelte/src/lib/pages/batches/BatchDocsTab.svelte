<script lang="ts">
  import { ApiProblem, newIdempotencyKey, type Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatBytes, formatDate, formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, retryAfterOf } from '../../app/api.svelte';
  import { cache, query, type Query } from '../../app/cache.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaFailed from '../../ui/AreaFailed.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Empty from '../../ui/Empty.svelte';
  import { GAP, VSD_TONE, type Batch } from './batches';

  let { batch }: { batch: Batch } = $props();

  const screen = screenScope();
  const born = cache.generation;
  const key = $derived(['batch', batch.id, 'documents'] as const);
  const docsQuery: Query<Schemas['BatchDocuments']> = query(
    () => key,
    ([, id]) =>
      call<Schemas['BatchDocuments']>(
        session.api.GET('/batches/{id}/documents', { params: { path: { id: String(id) } } }),
      ),
    {
      failed: 'documents.failed',
      refetchInterval: () => (docsQuery.data?.vsd?.importStatus === 'PENDING' ? 3000 : false),
    },
  );
  let retrying = $state(false);
  const wait = new Countdown();
  let idempotencyKey: string | null = null;

  const holder = $derived(
    session.me &&
      session.me.organization.id === batch.holder.id &&
      session.me.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR'),
  );

  async function retry() {
    retrying = true;
    idempotencyKey ??= newIdempotencyKey();
    try {
      const vsd = await call<Schemas['BatchVsd']>(
        session.api.POST('/batches/{id}/documents/vsd/retry', {
          params: { path: { id: batch.id }, header: { 'Idempotency-Key': idempotencyKey } },
        }),
      );
      idempotencyKey = null;
      const current = docsQuery.data;
      if (current) docsQuery.set({ ...current, vsd }, born);
      screen.done({ tone: 'ok', text: t('documents.retried') });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
      else if (e instanceof ApiProblem && e.status < 500) {
        idempotencyKey = null;
        if (e.status === 409) void cache.invalidate(key);
      }
      screen.push({ tone: errorTone(e), text: errorText(e) });
    } finally {
      retrying = false;
    }
  }
</script>

{#if !docsQuery.data && docsQuery.failed}
  <AreaFailed text={t('documents.failed')} busy={docsQuery.fetching} onretry={() => void userAction(docsQuery.refetch)} />
{:else if !docsQuery.data}
  <AreaLoading blocks={1} />
{:else}
  {@const { vsd, labProtocols, qr } = docsQuery.data}
  {#if !vsd && labProtocols.length === 0 && !qr}
    <Card><Empty art="empty-batches" text={t('documents.empty')} /></Card>
  {:else}
    <div style="{GAP}; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); align-items: start">
      {#if vsd}
        {@const doc = vsd.document}
        <Card>
          <CardHeader title={t('documents.vsd')}>
            <Chip tone={VSD_TONE[vsd.importStatus]}>{enumLabel(t, 'VsdImportStatus', vsd.importStatus)}</Chip>
          </CardHeader>
          <CardBody>
            <CardFacts
              facts={doc
                ? [
                    { key: 'n', term: t('documents.number'), value: doc.number },
                    { key: 'd', term: t('documents.issueDate'), value: formatDate(doc.issueDate, LOCALE) },
                    { key: 's', term: t('documents.vsdStatus'), value: enumLabel(t, 'VsdStatus', doc.status) },
                    { key: 'p', term: t('documents.product'), value: doc.productName },
                    {
                      key: 'v',
                      term: t('documents.volume'),
                      value: `${formatDecimal(String(doc.volume.value), LOCALE)} ${doc.volume.unit}`,
                    },
                    { key: 'from', term: t('documents.consignor'), value: doc.consignor.name },
                    { key: 'to', term: t('documents.consignee'), value: doc.consignee.name },
                  ]
                : [
                    { key: 'a', term: t('documents.attempts'), value: String(vsd.attempts) },
                    { key: 'u', term: t('batches.updatedAt'), value: formatLocalDateTime(vsd.updatedAt, LOCALE) },
                  ]}
            />
          </CardBody>
          {#if holder && (vsd.importStatus === 'NOT_FOUND' || vsd.importStatus === 'FAILED')}
            <CardFooter>
              <Button variant="primary" busy={retrying} disabled={wait.left > 0} onclick={() => void userAction(retry)}>
                {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('documents.retry')}
              </Button>
            </CardFooter>
          {/if}
        </Card>
      {/if}
      {#if labProtocols.length > 0}
        <Card>
          <CardHeader title={t('documents.protocols')} />
          <CardBody>
            <ul style="display: grid; gap: var(--sp-4); margin: 0; padding: 0; list-style: none">
              {#each labProtocols as p (p.labTestId)}
                <li style="display: grid; gap: var(--sp-2)">
                  <span>{p.lab.name}</span>
                  <span style="display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center">
                    {#if p.conclusion}
                      <Chip tone={p.conclusion === 'PASS' ? 'ok' : 'danger'}>{enumLabel(t, 'LabConclusion', p.conclusion)}</Chip>
                    {/if}
                    {#if p.completedAt}{formatDate(p.completedAt, LOCALE)}{/if}
                  </span>
                  <span>
                    <Button size="s" icon="file-pdf" href={p.file.url} download={p.file.originalName}>
                      {p.file.originalName}, {formatBytes(p.file.sizeBytes, LOCALE)}
                    </Button>
                  </span>
                </li>
              {/each}
            </ul>
          </CardBody>
        </Card>
      {/if}
      {#if qr}
        <Card>
          <CardHeader title={t('documents.qr')} />
          <CardBody>
            <CardFacts
              facts={[
                {
                  key: 'url',
                  term: t('documents.publicPage'),
                  value: qr.publicUrl,
                },
              ]}
            />
          </CardBody>
          <CardFooter>
            <Button icon="download" href={qr.pngUrl} download="{batch.publicCode}.png">{t('documents.png')}</Button>
            <Button icon="file-pdf" href={qr.pdfUrl} download="{batch.publicCode}.pdf">{t('documents.pdf')}</Button>
          </CardFooter>
        </Card>
      {/if}
    </div>
  {/if}
{/if}
