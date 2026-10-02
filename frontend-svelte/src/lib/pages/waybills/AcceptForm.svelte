<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { WaybillAcceptSchema } from '@agrotrace/validation';
  import { call, Countdown, retryAfterOf } from '../../app/api.svelte';
  import { applyProblem, normalizeDecimal } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { Idempotency } from '../../app/idempotency';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import CardHeader from '../../ui/CardHeader.svelte';
  import Chip from '../../ui/Chip.svelte';
  import Field from '../../ui/Field.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Textarea from '../../ui/Textarea.svelte';
  import { FORM_GRID } from '../layout';
  import { discrepancyOf, discrepancyText, GAP, massText, type Waybill } from './waybills';

  /** The acceptance card (BR-07): per-item actual mass, live discrepancy (domain), the act textarea appears and
   * becomes required only when BR-07 asks for it. Not keyed by `version`: a re-read after a conflict keeps what the
   * person typed (FM13), the next submit sends the new version. */
  let {
    waybill,
    fail,
    clearAlert,
    showAlert,
    ondone,
  }: {
    waybill: Waybill;
    fail: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
    clearAlert: () => void;
    showAlert: (text: string, tone?: 'danger' | 'attention') => void;
    ondone: (next: Waybill) => void;
  } = $props();

  const items = untrack(() => waybill.items);
  let actual = $state<Record<string, string>>(
    Object.fromEntries(items.map((i) => [i.batch.id, massText(i.massDeclaredKg)])),
  );
  let act = $state<Record<string, string>>(Object.fromEntries(items.map((i) => [i.batch.id, ''])));
  let errors = $state<{ actual: Record<string, string>; act: Record<string, string> }>({ actual: {}, act: {} });
  let busy = $state(false);
  const wait = new Countdown();
  const idempotent = new Idempotency();

  function toBody() {
    return {
      items: items.map((i) => {
        const id = i.batch.id;
        const d = discrepancyOf(i.massDeclaredKg, actual[id] ?? '');
        const a = act[id] ?? '';
        return {
          batchId: id,
          massActualKg: normalizeDecimal(actual[id] ?? '', 3),
          // The act is asked for (and sent) only when BR-07 requires it.
          ...(d?.actRequired && a.trim() ? { discrepancyAct: a } : {}),
        };
      }),
    };
  }

  function validate(): boolean {
    const nextActual: Record<string, string> = {};
    const nextAct: Record<string, string> = {};
    for (const i of items) {
      const id = i.batch.id;
      if ((actual[id] ?? '').trim() === '') nextActual[id] = 'validation.required';
      // BR-07: more than 2% — the act is required (the server answers 422 otherwise).
      const d = discrepancyOf(i.massDeclaredKg, actual[id] ?? '');
      if (d?.actRequired && !(act[id] ?? '').trim()) nextAct[id] = 'validation.required';
    }
    const res = WaybillAcceptSchema.safeParse(toBody());
    if (!res.success)
      for (const issue of res.error.issues) {
        const [, index, leaf] = issue.path;
        const id = typeof index === 'number' ? items[index]?.batch.id : undefined;
        if (!id) continue;
        if (leaf === 'massActualKg') nextActual[id] ??= String(issue.message);
        else if (leaf === 'discrepancyAct') nextAct[id] ??= String(issue.message);
      }
    errors = { actual: nextActual, act: nextAct };
    return Object.keys(nextActual).length === 0 && Object.keys(nextAct).length === 0;
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || wait.left > 0) return;
    clearAlert();
    if (!validate()) return;
    busy = true;
    // The version of the card as it is now (a re-read after a conflict brings a new one).
    const version = waybill.version;
    const body = toBody() as Schemas['WaybillAccept'];
    try {
      const next = await idempotent.run({ version, body }, (key) =>
        call<Waybill>(
          session.api.POST('/waybills/{id}/accept', {
            params: { path: { id: waybill.id }, header: { 'If-Match': version, 'Idempotency-Key': key } },
            body,
          }),
        ),
      );
      ondone(next);
    } catch (err) {
      if (err instanceof ApiProblem && err.code === 'VALIDATION') {
        applyProblem(err, {
          alert: showAlert,
          fields: items.flatMap((i) => [`actual.${i.batch.id}`, `act.${i.batch.id}`]),
          mark: (marks) => {
            const nextActual: Record<string, string> = {};
            const nextAct: Record<string, string> = {};
            for (const [k, v] of Object.entries(marks)) {
              if (k.startsWith('actual.')) nextActual[k.slice(7)] = v;
              else if (k.startsWith('act.')) nextAct[k.slice(4)] = v;
            }
            errors = { actual: nextActual, act: nextAct };
          },
          alias: (path) => {
            const m = /^items\[(\d+)\]\.(massActualKg|discrepancyAct)$/.exec(path);
            const item = m ? items[Number(m[1])] : undefined;
            return item && m ? `${m[2] === 'massActualKg' ? 'actual' : 'act'}.${item.batch.id}` : path;
          },
        });
      } else {
        if (err instanceof ApiProblem && err.status === 429) wait.start(retryAfterOf(err));
        // BR-07 by the server's own count: the act of that batch is what is missing.
        if (err instanceof ApiProblem && err.rule === 'BR-07' && typeof err.params?.publicCode === 'string') {
          const code = err.params.publicCode;
          const item = items.find((i) => i.batch.publicCode === code);
          if (item) errors = { ...errors, act: { ...errors.act, [item.batch.id]: 'validation.required' } };
        }
        fail(err);
      }
    } finally {
      busy = false;
    }
  }

  const errText = (key: string | undefined) => (key ? t(key) : null);
</script>

<Card>
  <CardHeader title={t('waybills.acceptance')} />
  <CardBody>
    <form id="waybill-accept" onsubmit={submit} style={GAP}>
      {#each items as i (i.batch.id)}
        {@const id = i.batch.id}
        {@const d = discrepancyOf(i.massDeclaredKg, actual[id] ?? '')}
        <div style={FORM_GRID}>
          <div
            style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: end"
          >
            <Field id="actual-{id}" label={t('waybills.actualOf', { code: i.batch.publicCode })} error={errText(errors.actual[id])}>
              <InputGroup suffix={t('unit.kg')} inputmode="decimal" autocomplete="off" bind:value={actual[id]} />
            </Field>
            <p aria-live="polite" style="margin: 0; min-height: 2.75rem; display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center">
              {#if d}
                <span>{t('waybills.discrepancy')}: {discrepancyText(d)}</span>
                {#if d.actRequired}<Chip tone="attention">{t('waybills.actRequired')}</Chip>{/if}
              {/if}
            </p>
          </div>
          {#if d?.actRequired}
            <Field id="act-{id}" label={t('waybills.actOf', { code: i.batch.publicCode })} error={errText(errors.act[id])}>
              <Textarea rows={3} bind:value={act[id]} />
            </Field>
          {/if}
        </div>
      {/each}
    </form>
  </CardBody>
  <CardFooter>
    <Submit form={{ busy, wait }} formId="waybill-accept">{t('waybillAction.accept')}</Submit>
  </CardFooter>
</Card>
