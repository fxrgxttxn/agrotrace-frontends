<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { type Schemas } from '@agrotrace/api-client';
  import { checkMassBalance, compareDecimalStrings } from '@agrotrace/domain';
  import { formatDecimal, formatMass } from '@agrotrace/i18n';
  import { ProcessingRequestSchema } from '@agrotrace/validation';
  import { call, Countdown } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { applyProblem, FormAlert, normalizeDecimal } from '../../app/forms.svelte';
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
  import { MASS, STEPS, type BatchItem } from './processing';

  let { batches, products }: { batches: BatchItem[]; products: Schemas['Product'][] } = $props();

  const screen = screenScope();
  const born = cache.generation;
  const wide = wideScreen();
  const byId = untrack(() => new Map(batches.map((b) => [b.id, b])));
  const lossOf = untrack(() => {
    const m = new Map(products.map((p) => [p.id, p.lossNormPercent]));
    return (productId: string) => m.get(productId) ?? '0.00';
  });
  const wanted = page.url.searchParams.get('batchId') ?? '';
  const massText = (kg: string) => kg.replace('.', ',');

  let step = $state(0);
  let busy = $state(false);
  const wait = new Countdown();
  const alert = new FormAlert();

  let picked = $state.raw<ReadonlySet<string>>(new Set(byId.has(wanted) ? [wanted] : []));
  let used = $state<Record<string, string>>(
    untrack(() => Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)]))),
  );
  let outputs = $state<{ productId: string; massKg: string }[]>([{ productId: '', massKg: '' }]);
  let errors = $state<{
    picked?: string;
    used: Record<string, string>;
    outputs: Record<string, string>[];
  }>({ used: {}, outputs: [{}] });

  function toBody() {
    return {
      inputs: batches
        .filter((b) => picked.has(b.id))
        .map((b) => ({ batchId: b.id, massUsedKg: normalizeDecimal(used[b.id] ?? '', 3) })),
      outputs: outputs.map((o) => ({ productId: o.productId, massKg: normalizeDecimal(o.massKg, 3) })),
    };
  }

  function validate(): boolean {
    const body = toBody();
    const nextUsed: Record<string, string> = {};
    const nextOutputs: Record<string, string>[] = outputs.map(() => ({}));
    let nextPicked: string | undefined;
    if (body.inputs.length === 0) nextPicked = 'processing.chooseInputs';
    for (const i of body.inputs) if ((used[i.batchId] ?? '').trim() === '') nextUsed[i.batchId] = 'validation.required';
    outputs.forEach((o, n) => {
      if (!o.productId) nextOutputs[n]!.productId = 'validation.required';
      if (o.massKg.trim() === '') nextOutputs[n]!.massKg = 'validation.required';
    });
    const res = ProcessingRequestSchema.safeParse({
      ...body,
      outputs: body.outputs.map((o) => ({ ...o, productId: o.productId || undefined })),
    });
    if (!res.success)
      for (const issue of res.error.issues) {
        const [head, index, leaf] = issue.path;
        if (typeof index !== 'number' || typeof leaf !== 'string') continue;
        if (head === 'inputs') {
          const id = body.inputs[index]?.batchId;
          if (id) nextUsed[id] ??= String(issue.message);
        } else if (head === 'outputs') nextOutputs[index]![leaf] ??= String(issue.message);
      }
    // More than the batch holds: the server would answer the same (validation.mass.exceedsBatch).
    for (const i of body.inputs) {
      const b = byId.get(i.batchId);
      if (!nextUsed[i.batchId] && b && MASS.test(i.massUsedKg) && compareDecimalStrings(i.massUsedKg, b.massKg) > 0)
        nextUsed[i.batchId] = 'validation.mass.exceedsBatch';
    }
    errors = { picked: nextPicked, used: nextUsed, outputs: nextOutputs };
    return !nextPicked && Object.keys(nextUsed).length === 0 && nextOutputs.every((o) => Object.keys(o).length === 0);
  }

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
  async function next() {
    validate();
    const ok = step === 0 ? !errors.picked && Object.keys(errors.used).length === 0 : errors.outputs.every((o) => Object.keys(o).length === 0);
    if (ok) goTo(step + 1);
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || wait.left > 0) return;
    alert.clear();
    if (!validate()) {
      if (!wide.wide) goTo(errors.picked || Object.keys(errors.used).length ? 0 : 1);
      return;
    }
    const body = toBody() as Schemas['ProcessingRequest'];
    const ids = body.inputs.map((i) => i.batchId);
    busy = true;
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
      applyProblem(err, {
        alert: alert.show,
        onRateLimit: (s) => wait.start(s),
        fields: [
          'picked',
          ...ids.map((id) => `used.${id}`),
          ...outputs.flatMap((_, n) => [`outputs.${n}.productId`, `outputs.${n}.massKg`]),
        ],
        mark: (marks) => {
          const nextUsed: Record<string, string> = {};
          const nextOutputs: Record<string, string>[] = outputs.map(() => ({}));
          let nextPicked: string | undefined;
          for (const [k, v] of Object.entries(marks)) {
            if (k === 'picked') nextPicked = v;
            else if (k.startsWith('used.')) nextUsed[k.slice(5)] = v;
            else {
              const m = /^outputs\.(\d+)\.(productId|massKg)$/.exec(k);
              if (m) nextOutputs[Number(m[1])]![m[2]!] = v;
            }
          }
          errors = { picked: nextPicked, used: nextUsed, outputs: nextOutputs };
          if (!wide.wide) goTo(nextPicked || Object.keys(nextUsed).length ? 0 : 1);
        },
        alias: (path) => {
          const input = /^inputs\[(\d+)\]\./.exec(path);
          const id = input ? ids[Number(input[1])] : undefined;
          if (id) return `used.${id}`;
          const output = /^outputs\[(\d+)\]\.(productId|massKg)$/.exec(path);
          if (output) return `outputs.${output[1]}.${output[2]}`;
          return path === 'inputs' ? 'picked' : path;
        },
      });
    } finally {
      busy = false;
    }
  }

  const errText = (key: string | undefined) => (key ? t(key) : null);

  // Live BR-04 (domain), from what already reads as masses; the server makes the final check.
  const balance = $derived.by(() => {
    const ins = batches
      .filter((b) => picked.has(b.id))
      .map((b) => ({ massUsedKg: normalizeDecimal(used[b.id] ?? '', 3), lossNormPercent: lossOf(b.product.id) }))
      .filter((i) => MASS.test(i.massUsedKg));
    const outs = outputs.map((o) => ({ massKg: normalizeDecimal(o.massKg, 3) })).filter((o) => MASS.test(o.massKg));
    const r = checkMassBalance({ inputs: ins, outputs: outs.length ? outs : [{ massKg: '0.000' }] });
    return 'error' in r ? null : r;
  });

  const inputColumns: Column<BatchItem>[] = [
    { key: 'code', header: t('batches.code'), primary: true },
    { key: 'status', header: t('batches.status'), status: true },
    { key: 'available', header: t('processing.available'), numeric: true },
    { key: 'used', header: t('field.massUsedKg') },
  ];
  // On wide screens every step is on the page; the stepper shows how far the filled form has come.
  const done = $derived([
    picked.size > 0,
    outputs.every((o) => o.productId && MASS.test(normalizeDecimal(o.massKg, 3))),
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
    <CellField id="used-{b.id}" error={errText(errors.used[b.id])}>
      <InputGroup
        suffix={t('unit.kg')}
        inputmode="decimal"
        autocomplete="off"
        aria-label={t('processing.usedOf', { code: b.publicCode })}
        disabled={!picked.has(b.id)}
        bind:value={used[b.id]}
      />
    </CellField>
  {/if}
{/snippet}

{#snippet stepCard(n: number)}
  {@const name = STEPS[n]!}
  {@const last = n === STEPS.length - 1}
  <Card>
    <header class="at-card__header">
      <!-- The step title takes the focus on a narrow-screen step change. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <h2 class="at-card__title" bind:this={titleEl} tabindex={!wide.wide ? -1 : undefined}>{t(`processing.step.${name}`)}</h2>
    </header>
    <CardBody>
      {#if name === 'inputs'}
        <div style={FORM_GRID}>
          {#if errors.picked}
            <p class="at-field__error" id="processing-inputs-error" role="alert">{errText(errors.picked)}</p>
          {/if}
          <Table
            cards
            caption={t('processing.step.inputs')}
            columns={inputColumns}
            rows={batches}
            rowKey={(b) => b.id}
            selection={{
              selected: picked,
              onchange: (next) => (picked = next),
              allLabel: t('processing.pickAll'),
              rowLabel: (b) => t('processing.pick', { code: b.publicCode }),
            }}
            cell={inputCell}
          />
        </div>
      {:else if name === 'outputs'}
        <div style="display: grid; gap: var(--sp-5)">
          {#each outputs as o, i (i)}
            <div style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: start">
              <Field id="output-{i}-product" label={t('processing.productOf', { n: i + 1 })} error={errText(errors.outputs[i]?.productId)}>
                <Select bind:value={o.productId}>
                  <option value="" disabled>{t('ui.choose')}</option>
                  {#each products as p (p.id)}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </Select>
              </Field>
              <div style="display: flex; gap: var(--sp-2); align-items: flex-end">
                <div style="flex: 1; min-width: 0">
                  <Field id="output-{i}-mass" label={t('processing.massOf', { n: i + 1 })} error={errText(errors.outputs[i]?.massKg)}>
                    <InputGroup suffix={t('unit.kg')} inputmode="decimal" autocomplete="off" bind:value={o.massKg} />
                  </Field>
                </div>
                {#if outputs.length > 1}
                  <Button
                    variant="ghost"
                    iconOnly
                    icon="close"
                    aria-label={t('processing.removeOutput', { n: i + 1 })}
                    onclick={() => (outputs = outputs.filter((_, idx) => idx !== i))}
                  />
                {/if}
              </div>
            </div>
          {/each}
          {#if outputs.length < 20}
            <div>
              <Button icon="plus" onclick={() => (outputs = [...outputs, { productId: '', massKg: '' }])}>{t('processing.addOutput')}</Button>
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
          <Submit form={{ busy, wait }} formId="processing">{t('processing.submit')}</Submit>
        {:else}
          <Button variant="primary" onclick={() => void next()}>{t('processing.next')}</Button>
        {/if}
      </CardFooter>
    {/if}
  </Card>
{/snippet}

<form id="processing" onsubmit={submit} style="display: grid; gap: var(--sp-5)">
  <Stepper label={t('processing.steps')} steps={STEPS.map((s) => t(`processing.step.${s}`))} current={current} />
  {#if wide.wide}
    {#each STEPS as s, n (s)}
      {@render stepCard(n)}
    {/each}
  {:else}
    {@render stepCard(step)}
  {/if}
</form>
