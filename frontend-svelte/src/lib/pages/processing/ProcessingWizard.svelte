<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { checkMassBalance } from '@agrotrace/domain';
  import { formatDecimal, formatMass } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { form, normalizeDecimal, SchemaForm } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import { wideScreen } from '../../ui/wide.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CellField from '../../ui/CellField.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Field from '../../ui/Field.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Select from '../../ui/Select.svelte';
  import Stepper from '../../ui/Stepper.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Table from '../../ui/Table.svelte';
  import TablePrimary from '../../ui/TablePrimary.svelte';
  import type { Column } from '../../ui/table';
  import { FORM_GRID } from '../layout';
  import { MASS, processingFields, processingSchema, STEPS, type BatchItem, type ProcessingValues } from './processing';

  let { batches, products }: { batches: BatchItem[]; products: Schemas['Product'][] } = $props();

  const screen = screenScope();
  const born = cache.generation;
  const wide = wideScreen();
  const lossOf = untrack(() => {
    const m = new Map(products.map((p) => [p.id, p.lossNormPercent]));
    return (productId: string) => m.get(productId) ?? '0.00';
  });
  const wanted = page.url.searchParams.get('batchId') ?? '';
  const massText = (kg: string) => kg.replace('.', ',');

  let step = $state(0);

  const f: SchemaForm<ProcessingValues, Schemas['ProcessingRequest']> = new SchemaForm({
    schema: untrack(() => processingSchema(batches)),
    values: untrack(() => ({
      picked: batches.some((b) => b.id === wanted) ? [wanted] : [],
      used: Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)])),
      outputs: [{ productId: '', massKg: '' }],
    })),
    fields: untrack(() => processingFields(batches)),
    alias: (path: string): string => {
      const input = /^inputs\[(\d+)\]\./.exec(path);
      const id: string | undefined = input ? f.values.picked[Number(input[1])] : undefined;
      if (id) return `used.${id}`;
      const output = /^outputs\[(\d+)\]\.(productId|massKg)$/.exec(path);
      if (output) return `outputs.${output[1]}.${output[2]}`;
      return path === 'inputs' ? 'picked' : path;
    },
    send: async (body) => {
      try {
        const result = await call<Schemas['ProcessingResult']>(session.api.POST('/processing', { body }));
        for (const b of result.outputs) cache.set(['batch', b.id], b, born);
        void cache.invalidate(['batches']);
        void cache.invalidate(['batch']);
        screen.done({
          tone: 'ok',
          text: t('processing.done', { count: result.outputs.length, codes: result.outputs.map((b) => b.publicCode).join(', ') }),
        });
        screen.navigate(`/batches/${result.outputs[0]!.id}`);
      } catch (err) {
        if (err instanceof ApiProblem && err.code === 'VALIDATION' && err.errors && !wide.wide)
          goTo(Object.keys(err.errors).some((k) => k === 'inputs' || k.startsWith('inputs[')) ? 0 : 1);
        throw err;
      }
    },
  });

  const picked = $derived<ReadonlySet<string>>(new Set(f.values.picked));

  let titleEl: HTMLHeadingElement | null = $state(null);
  let moved = false;
  $effect(() => {
    void step;
    if (moved) titleEl?.focus({ preventScroll: false });
    moved = false;
  });
  function goTo(n: number) {
    moved = true;
    step = n;
  }
  function next() {
    const paths =
      step === 0 ? ['picked', ...batches.map((b) => `used.${b.id}`)] : f.values.outputs.flatMap((_, n) => [`outputs.${n}.productId`, `outputs.${n}.massKg`]);
    if (f.checkFields(paths)) goTo(step + 1);
  }

  const balance = $derived.by(() => {
    const ins = batches
      .filter((b) => picked.has(b.id))
      .map((b) => ({ massUsedKg: normalizeDecimal(f.values.used[b.id] ?? '', 3), lossNormPercent: lossOf(b.product.id) }))
      .filter((i) => MASS.test(i.massUsedKg));
    const outs = f.values.outputs.map((o) => ({ massKg: normalizeDecimal(o.massKg, 3) })).filter((o) => MASS.test(o.massKg));
    const r = checkMassBalance({ inputs: ins, outputs: outs.length ? outs : [{ massKg: '0.000' }] });
    return 'error' in r ? null : r;
  });

  const inputColumns: Column<BatchItem>[] = [
    { key: 'code', header: t('batches.code'), primary: true },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'available', header: t('processing.available'), numeric: true },
    { key: 'used', header: t('field.massUsedKg') },
  ];
  const done = $derived([
    picked.size > 0,
    f.values.outputs.every((o) => o.productId && MASS.test(normalizeDecimal(o.massKg, 3))),
  ]);
  const current = $derived(wide.wide ? (done[0] ? (done[1] ? 2 : 1) : 0) : step);
</script>

{#snippet inputCell(b: BatchItem, c: Column<BatchItem>)}
  {#if c.key === 'code'}
    <TablePrimary href="/batches/{b.id}" code={b.publicCode} sub={b.product.name} />
  {:else if c.key === 'status'}
    <Chip status={b.status} />
  {:else if c.key === 'available'}
    {formatDecimal(b.massKg, LOCALE)}
  {:else}
    <CellField id="used-{b.id}" error={f.error(`used.${b.id}`)}>
      <InputGroup
        suffix={t('unit.kg')}
        inputmode="decimal"
        autocomplete="off"
        name="used.{b.id}"
        aria-label={t('processing.usedOf', { code: b.publicCode })}
        disabled={!picked.has(b.id)}
        bind:value={f.values.used[b.id]}
      />
    </CellField>
  {/if}
{/snippet}

{#snippet stepCard(n: number)}
  {@const name = STEPS[n]!}
  {@const last = n === STEPS.length - 1}
  <Card>
    <header class="at-card__header">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <h2 class="at-card__title" bind:this={titleEl} tabindex={!wide.wide ? -1 : undefined}>{t(`processing.step.${name}`)}</h2>
    </header>
    <CardBody>
      {#if name === 'inputs'}
        <div style={FORM_GRID}>
          {#if f.error('picked')}
            <p class="at-field__error" id="processing-inputs-error" role="alert">{f.error('picked')}</p>
          {/if}
          <Table
            cards
            caption={t('processing.step.inputs')}
            columns={inputColumns}
            rows={batches}
            rowKey={(b) => b.id}
            selection={{
              selected: picked,
              onchange: (next) => {
                f.values.picked = batches.map((b) => b.id).filter((id) => next.has(id));
                f.changed('picked');
              },
              allLabel: t('processing.pickAll'),
              rowLabel: (b) => t('processing.pick', { code: b.publicCode }),
              errorId: f.error('picked') ? 'processing-inputs-error' : null,
            }}
            cell={inputCell}
          />
        </div>
      {:else if name === 'outputs'}
        <div style="display: grid; gap: var(--sp-5)">
          {#each f.values.outputs as o, i (i)}
            <div style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: start">
              <Field id="output-{i}-product" label={t('processing.productOf', { n: i + 1 })} error={f.error(`outputs.${i}.productId`)}>
                <Select name="outputs.{i}.productId" bind:value={o.productId}>
                  <option value="" disabled>{t('ui.choose')}</option>
                  {#each products as p (p.id)}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </Select>
              </Field>
              <div style="display: flex; gap: var(--sp-2); align-items: flex-end">
                <div style="flex: 1; min-width: 0">
                  <Field id="output-{i}-mass" label={t('processing.massOf', { n: i + 1 })} error={f.error(`outputs.${i}.massKg`)}>
                    <InputGroup suffix={t('unit.kg')} inputmode="decimal" autocomplete="off" name="outputs.{i}.massKg" bind:value={o.massKg} />
                  </Field>
                </div>
                {#if f.values.outputs.length > 1}
                  <Button
                    variant="ghost"
                    iconOnly
                    icon="close"
                    aria-label={t('processing.removeOutput', { n: i + 1 })}
                    onclick={() => (f.values.outputs = f.values.outputs.filter((_, idx) => idx !== i))}
                  />
                {/if}
              </div>
            </div>
          {/each}
          {#if f.values.outputs.length < 20}
            <div>
              <Button icon="plus" onclick={() => (f.values.outputs = [...f.values.outputs, { productId: '', massKg: '' }])}>{t('processing.addOutput')}</Button>
            </div>
          {/if}
        </div>
      {:else}
        {#if !balance}
          <p style="margin: 0">{t('processing.chooseInputs')}</p>
        {:else}
          <div style={FORM_GRID}>
            <CardFacts
              facts={[
                { key: 'in', term: t('processing.input'), value: formatMass(balance.inputKg, LOCALE) },
                { key: 'allowed', term: t('processing.allowed'), value: formatMass(balance.allowedKg, LOCALE) },
                { key: 'out', term: t('processing.outputTotal'), value: formatMass(balance.outputKg, LOCALE) },
              ]}
            />
            <div aria-live="polite">
              {#if balance.ok}
                <p style="margin: 0">{t('processing.balanceOk', { allowedKg: formatMass(balance.allowedKg, LOCALE) })}</p>
              {:else}
                <p class="at-field__warning">
                  {t('rules.BR-04', { outputKg: formatMass(balance.outputKg, LOCALE), allowedKg: formatMass(balance.allowedKg, LOCALE), inputKg: formatMass(balance.inputKg, LOCALE) })}
                </p>
              {/if}
            </div>
          </div>
        {/if}
      {/if}
    </CardBody>
    {#if !wide.wide || last}
      <CardFooter>
        {#if !wide.wide && n > 0}
          <Button variant="ghost" onclick={() => goTo(n - 1)}>{t('processing.back')}</Button>
        {/if}
        {#if last}
          <Submit form={f} formId="processing">{t('processing.submit')}</Submit>
        {:else}
          <Button variant="primary" onclick={next}>{t('processing.next')}</Button>
        {/if}
      </CardFooter>
    {/if}
  </Card>
{/snippet}

<form id="processing" use:form={f} style="display: grid; gap: var(--sp-5)">
  <Stepper label={t('processing.steps')} steps={STEPS.map((s) => t(`processing.step.${s}`))} current={current} />
  {#if wide.wide}
    {#each STEPS as s, n (s)}
      {@render stepCard(n)}
    {/each}
  {:else}
    {@render stepCard(step)}
  {/if}
</form>
