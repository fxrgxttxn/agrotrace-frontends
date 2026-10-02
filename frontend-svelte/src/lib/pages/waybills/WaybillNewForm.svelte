<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { type Schemas } from '@agrotrace/api-client';
  import { compareDecimalStrings } from '@agrotrace/domain';
  import { formatDecimal } from '@agrotrace/i18n';
  import { WaybillCreateSchema } from '@agrotrace/validation';
  import { call, Countdown } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { applyProblem, FormAlert, normalizeDecimal } from '../../app/forms.svelte';
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
  import { GAP, massText, type BatchItem, type Waybill } from './waybills';

  /** `/waybills/new` (FR-PROD-05): receiver (the directory, not own org), the own stock (own Approved/Accepted) in a
   * selectable table with a declared-mass cell input (disabled until picked, default = the batch's own mass); server
   * `items[i].*` errors land on that row, `items` on the choice itself; one Idempotency-Key per intent. */
  let { batches }: { batches: BatchItem[] } = $props();

  const screen = screenScope();
  const born = cache.generation;
  const me = session.me!;
  // Only a batch of this stock is preselected; another id in the URL leaves the choice to the person.
  const wanted = page.url.searchParams.get('batchId') ?? '';
  const byId = untrack(() => new Map(batches.map((b) => [b.id, b])));

  let receiverOrgId = $state('');
  let picked = $state.raw<ReadonlySet<string>>(new Set(byId.has(wanted) ? [wanted] : []));
  let mass = $state<Record<string, string>>(
    untrack(() => Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)]))),
  );
  let errors = $state<{ receiverOrgId?: string; picked?: string; mass: Record<string, string> }>({ mass: {} });
  let busy = $state(false);
  const wait = new Countdown();
  const alert = new FormAlert();
  const idempotent = new Idempotency();

  function toBody() {
    return {
      receiverOrgId,
      items: batches
        .filter((b) => picked.has(b.id))
        .map((b) => ({ batchId: b.id, massDeclaredKg: normalizeDecimal(mass[b.id] ?? '', 3) })),
    };
  }

  /** Client checks before a request (React Hook Form's resolver, as plain functions here): required fields, the
   * shared schema, and the mass-exceeds-batch check the server would also make. */
  function validate(): boolean {
    const body = toBody();
    const next: typeof errors = { mass: {} };
    if (!receiverOrgId) next.receiverOrgId = 'validation.required';
    if (body.items.length === 0) next.picked = 'waybills.chooseItems';
    for (const item of body.items)
      if ((mass[item.batchId] ?? '').trim() === '') next.mass[item.batchId] = 'validation.required';
    const res = WaybillCreateSchema.safeParse({ ...body, receiverOrgId: body.receiverOrgId || undefined });
    if (!res.success)
      for (const issue of res.error.issues) {
        const [head, index, leaf] = issue.path;
        if (head === 'items' && typeof index === 'number' && leaf) {
          const id = body.items[index]?.batchId;
          if (id) next.mass[id] ??= String(issue.message);
        } else if (head === 'receiverOrgId') next.receiverOrgId ??= String(issue.message);
      }
    for (const item of body.items) {
      const batch = byId.get(item.batchId);
      if (!next.mass[item.batchId] && batch && compareDecimalStrings(item.massDeclaredKg, batch.massKg) > 0)
        next.mass[item.batchId] = 'validation.mass.exceedsBatch';
    }
    errors = next;
    return !next.receiverOrgId && !next.picked && Object.keys(next.mass).length === 0;
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || wait.left > 0) return;
    if (!validate()) return;
    const body = toBody() as Schemas['WaybillCreate'];
    const ids = body.items.map((i) => i.batchId);
    alert.clear();
    busy = true;
    try {
      const waybill = await idempotent.run(body, (key) =>
        call<Waybill>(session.api.POST('/waybills', { params: { header: { 'Idempotency-Key': key } }, body })),
      );
      cache.set(['waybill', waybill.id], waybill, born);
      void cache.invalidate(['waybills']);
      screen.done({ tone: 'ok', text: t('waybills.created', { number: waybill.number }) });
      screen.navigate(`/waybills/${waybill.id}`);
    } catch (err) {
      applyProblem(err, {
        alert: alert.show,
        onRateLimit: (s) => wait.start(s),
        fields: ['receiverOrgId', 'picked', ...ids.map((id) => `mass.${id}`)],
        mark: (marks) => {
          const next: typeof errors = { receiverOrgId: marks.receiverOrgId, picked: marks.picked, mass: {} };
          for (const [k, v] of Object.entries(marks)) if (k.startsWith('mass.')) next.mass[k.slice(5)] = v;
          errors = next;
        },
        alias: (path) => {
          const m = /^items\[(\d+)\]\./.exec(path);
          const id = m ? ids[Number(m[1])] : undefined;
          if (id) return `mass.${id}`;
          return path === 'items' ? 'picked' : path;
        },
      });
    } finally {
      busy = false;
    }
  }

  const errText = (key: string | undefined) => (key ? t(key) : null);
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
    <CellField id="declared-{b.id}" error={errText(errors.mass[b.id])}>
      <InputGroup
        suffix={t('unit.kg')}
        inputmode="decimal"
        autocomplete="off"
        aria-label={t('waybills.declaredOf', { code: b.publicCode })}
        disabled={!picked.has(b.id)}
        bind:value={mass[b.id]}
      />
    </CellField>
  {/if}
{/snippet}

<form id="waybill-new" onsubmit={submit} style={GAP}>
  <Card style="max-width: 40rem">
    <CardBody>
      <OrgPicker
        id="waybill-receiver"
        label={t('field.receiverOrgId')}
        value={receiverOrgId}
        types={['PROCESSOR', 'RETAILER']}
        exclude={me.organization.id}
        error={errText(errors.receiverOrgId)}
        onchange={(id) => (receiverOrgId = id ?? '')}
      />
    </CardBody>
  </Card>
  <Card>
    <CardHeader title={t('waybills.items')} />
    <CardBody>
      <div style={FORM_GRID}>
        {#if errors.picked}
          <p class="at-field__error" id="waybill-items-error" role="alert">{t(errors.picked)}</p>
        {/if}
        <Table
          cards
          caption={t('waybills.items')}
          {columns}
          rows={batches}
          rowKey={(b) => b.id}
          selection={{
            selected: picked,
            onchange: (next) => (picked = next),
            allLabel: t('waybills.pickAll'),
            rowLabel: (b) => t('waybills.pick', { code: b.publicCode }),
          }}
          {cell}
        />
      </div>
    </CardBody>
    <CardFooter>
      <Submit form={{ busy, wait }} formId="waybill-new">{t('action.createWaybill')}</Submit>
    </CardFooter>
  </Card>
</form>
