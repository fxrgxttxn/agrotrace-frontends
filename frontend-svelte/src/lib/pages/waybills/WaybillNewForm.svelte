<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { type Schemas } from '@agrotrace/api-client';
  import { formatDecimal } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { form, SchemaForm } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { Idempotency } from '../../app/idempotency';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import CellField from '../../ui/CellField.svelte';
  import Chip from '../../ui/Chip.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Table from '../../ui/Table.svelte';
  import TablePrimary from '../../ui/TablePrimary.svelte';
  import type { Column } from '../../ui/table';
  import { FORM_GRID } from '../layout';
  import { GAP, massText, waybillNewSchema, type BatchItem, type Waybill, type WaybillNewValues } from './waybills';

  let { batches }: { batches: BatchItem[] } = $props();

  const screen = screenScope();
  const born = cache.generation;
  const me = session.me!;
  const wanted = page.url.searchParams.get('batchId') ?? '';
  const idempotent = new Idempotency();

  const f: SchemaForm<WaybillNewValues, Schemas['WaybillCreate']> = new SchemaForm({
    schema: untrack(() => waybillNewSchema(batches)),
    values: untrack(() => ({
      receiverOrgId: '',
      picked: batches.some((b) => b.id === wanted) ? [wanted] : [],
      mass: Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)])),
    })),
    fields: untrack(() => ['receiverOrgId', 'picked', ...batches.map((b) => `mass.${b.id}`)]),
    alias: (path: string): string => {
      const m = /^items\[(\d+)\]\./.exec(path);
      const id: string | undefined = m ? f.values.picked[Number(m[1])] : undefined;
      if (id) return `mass.${id}`;
      return path === 'items' ? 'picked' : path;
    },
    send: async (body) => {
      const waybill = await idempotent.run(body, (key) =>
        call<Waybill>(session.api.POST('/waybills', { params: { header: { 'Idempotency-Key': key } }, body })),
      );
      cache.set(['waybill', waybill.id], waybill, born);
      void cache.invalidate(['waybills']);
      screen.done({ tone: 'ok', text: t('waybills.created', { number: waybill.number }) });
      screen.navigate(`/waybills/${waybill.id}`);
    },
  });

  const picked = $derived<ReadonlySet<string>>(new Set(f.values.picked));
  const columns: Column<BatchItem>[] = [
    { key: 'code', header: t('waybills.batch'), primary: true },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'current', header: t('waybills.currentMass'), numeric: true },
    { key: 'declared', header: t('waybills.declared') },
  ];
</script>

{#snippet cell(b: BatchItem, c: Column<BatchItem>)}
  {#if c.key === 'code'}
    <TablePrimary href="/batches/{b.id}" code={b.publicCode} sub={b.product.name} />
  {:else if c.key === 'status'}
    <Chip status={b.status} />
  {:else if c.key === 'current'}{formatDecimal(b.massKg, LOCALE)}{:else}
    <CellField id="declared-{b.id}" error={f.error(`mass.${b.id}`)}>
      <InputGroup
        suffix={t('unit.kg')}
        inputmode="decimal"
        autocomplete="off"
        name="mass.{b.id}"
        aria-label={t('waybills.declaredOf', { code: b.publicCode })}
        disabled={!picked.has(b.id)}
        bind:value={f.values.mass[b.id]}
      />
    </CellField>
  {/if}
{/snippet}

<form id="waybill-new" use:form={f} style={GAP}>
  <Card style="max-width: 40rem">
    <CardBody>
      <OrgPicker
        id="waybill-receiver"
        label={t('field.receiverOrgId')}
        value={f.values.receiverOrgId}
        types={['PROCESSOR', 'RETAILER']}
        exclude={me.organization.id}
        error={f.error('receiverOrgId')}
        onchange={(id) => {
          f.values.receiverOrgId = id ?? '';
          f.changed('receiverOrgId');
        }}
      />
    </CardBody>
  </Card>
  <Card>
    <CardHeader title={t('waybills.items')} />
    <CardBody>
      <div style={FORM_GRID}>
        {#if f.error('picked')}
          <p class="at-field__error" id="waybill-items-error" role="alert">{f.error('picked')}</p>
        {/if}
        <Table
          cards
          caption={t('waybills.items')}
          {columns}
          rows={batches}
          rowKey={(b) => b.id}
          selection={{
            selected: picked,
            onchange: (next) => {
              f.values.picked = batches.map((b) => b.id).filter((id) => next.has(id));
              f.changed('picked');
            },
            allLabel: t('waybills.pickAll'),
            rowLabel: (b) => t('waybills.pick', { code: b.publicCode }),
            errorId: f.error('picked') ? 'waybill-items-error' : null,
          }}
          {cell}
        />
      </div>
    </CardBody>
    <CardFooter>
      <Submit form={f} formId="waybill-new">{t('action.createWaybill')}</Submit>
    </CardFooter>
  </Card>
</form>
