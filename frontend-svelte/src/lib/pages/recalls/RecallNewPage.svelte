<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { RecallCreateSchema } from '@agrotrace/validation';
  import { call, errorText, errorTone, retryAfterOf } from '../../app/api.svelte';
  import { cache, query } from '../../app/cache.svelte';
  import CodeConfirmDialog from '../../app/CodeConfirmDialog.svelte';
  import { DialogAlert, form, SchemaForm, wireSchema } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import Checkbox from '../../ui/Checkbox.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import type { ComboOption } from '../../ui/combobox';
  import Field from '../../ui/Field.svelte';
  import Page from '../../ui/Page.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Textarea from '../../ui/Textarea.svelte';
  import { FORM_GRID } from '../layout';
  import type { Recall } from './recalls';

  interface NewRecall extends Record<string, unknown> {
    sourceBatchId: string;
    reason: string;
    blockUpstream: boolean;
  }
  const schema = wireSchema<NewRecall>(RecallCreateSchema, (v) => v);

  const screen = screenScope();
  const born = cache.generation;
  const linked = untrack(() => page.url.searchParams.get('batchId') ?? '');
  let code = $state('');
  let confirming = $state<NewRecall | null>(null);
  let busy = $state(false);
  const failure = new DialogAlert();

  const f = new SchemaForm<NewRecall>({
    schema,
    values: { sourceBatchId: /^[0-9a-f-]{36}$/i.test(linked) ? linked : '', reason: '', blockUpstream: false },
    fields: ['sourceBatchId', 'reason', 'blockUpstream'],
    send: async (v) => {
      if (!code) {
        if (!linkPending) document.getElementById('recall-batch')?.focus();
        return;
      }
      failure.clear();
      confirming = v;
    },
  });
  const submitState = {
    get busy() {
      return (busy && confirming === null) || linkPending;
    },
    wait: f.wait,
  };

  let text = $state('');
  let search = $state<string | null>(null);
  let picked = $state<ComboOption | null>(null);
  const value = $derived(f.values.sourceBatchId);
  const linkedQuery = query(
    () => (value !== '' && picked?.value !== value ? ['batch', value] : null),
    ([, bid]) => call<Schemas['Batch']>(session.api.GET('/batches/{id}', { params: { path: { id: String(bid) } } })),
  );
  const linkPending = $derived(value !== '' && picked?.value !== value && !linkedQuery.data && !linkedQuery.failed);
  const linkError = $derived(
    value !== '' && picked?.value !== value && !linkedQuery.data && linkedQuery.failed
      ? linkedQuery.error instanceof ApiProblem && linkedQuery.error.status === 404
        ? t('validation.notFound')
        : t('recalls.new.batchFailed')
      : null,
  );
  $effect(() => {
    const report = linkedQuery.data;
    if (report && report.id === value) {
      untrack(() => {
        text = report.publicCode;
        code = report.publicCode;
      });
    }
  });
  const found = query(
    () => (search !== null && search.trim() !== '' ? ['batches', 'search', search] : null),
    ([, , q]) =>
      call<Schemas['BatchPage']>(
        session.api.GET('/batches', { params: { query: { q: String(q).trim(), size: 20, sort: 'publicCode,asc' } } }),
      ),
  );
  const options: ComboOption[] = $derived(
    (found.data?.items ?? []).map((b) => ({ value: b.id, label: b.publicCode, meta: b.product.name })),
  );
  function choose(batch: { id: string; code: string } | null) {
    code = batch?.code ?? '';
    f.values.sourceBatchId = batch?.id ?? '';
    f.changed('sourceBatchId');
  }

  async function start(v: NewRecall) {
    busy = true;
    failure.clear();
    f.alert.clear();
    try {
      const res = await session.api.POST('/recalls', { body: v as Schemas['RecallCreate'] });
      const recall = await call<Recall>(Promise.resolve(res));
      cache.set(['recall', recall.id], recall, born);
      for (const key of ['recalls', 'batches', 'batch', 'dashboard']) void cache.invalidate([key]);
      if (!screen.alive()) {
        screen.done({ tone: 'ok', text: t('recalls.new.started', { code: recall.sourceBatch.publicCode }) });
        return;
      }
      confirming = null;
      const shown = recall.sourceBatch.publicCode;
      if (res.response.status === 200) screen.push({ tone: 'attention', text: t('recalls.new.existing', { code: shown }) });
      else screen.done({ tone: 'ok', text: t('recalls.new.started', { code: shown }) });
      screen.navigate(`/recalls/${recall.id}`);
    } catch (e) {
      if (!screen.alive()) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        confirming = null;
        f.fail(e);
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) f.wait.start(retryAfterOf(e));
      failure.show(errorText(e), errorTone(e));
    } finally {
      busy = false;
    }
  }
</script>

{#snippet confirmText()}
  <p style="margin: 0">{t('recalls.new.confirmText')}</p>
  {#if confirming?.blockUpstream}<p style="margin: 0">{t('recalls.new.confirmUpstream')}</p>{/if}
{/snippet}

<Page title={t('page.recallNew')}>
  <Card>
    <CardBody>
      <form id="recall-new" use:form={f} style={FORM_GRID}>
        <Field id="recall-batch" label={t('recalls.new.batch')} error={f.error('sourceBatchId') ?? linkError}>
          <Combobox
            listLabel={t('recalls.new.batch')}
            bind:query={text}
            onquery={() => {
              if (value !== '') {
                picked = null;
                choose(null);
              }
            }}
            onsearch={(next) => (search = next)}
            options={search && search.trim() ? options : []}
            loading={found.fetching}
            selected={value || null}
            onselect={(o) => {
              picked = o;
              text = o.label;
              choose({ id: o.value, code: o.label });
            }}
          />
        </Field>
        <Field id="recall-reason" label={t('recalls.new.reason')} error={f.error('reason')}>
          <Textarea rows={4} name="reason" bind:value={f.values.reason} />
        </Field>
        <Checkbox name="blockUpstream" bind:checked={f.values.blockUpstream}>{t('recalls.new.blockUpstream')}</Checkbox>
        <div><Submit form={submitState} formId="recall-new">{t('recalls.new.submit')}</Submit></div>
      </form>
    </CardBody>
  </Card>
  <CodeConfirmDialog
    open={confirming !== null && code !== ''}
    title={t('recalls.new.confirmTitle', { code })}
    text={confirmText}
    {code}
    confirmLabel={t('recalls.new.submit')}
    {busy}
    wait={f.wait.left}
    message={failure.message}
    onclose={() => {
      failure.handOff();
      confirming = null;
    }}
    onconfirm={() => {
      const v = confirming;
      if (v) void userAction(() => start(v));
    }}
  />
</Page>
