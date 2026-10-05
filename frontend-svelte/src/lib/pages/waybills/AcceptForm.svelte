<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { call, retryAfterOf } from '../../app/api.svelte';
  import { form, SchemaForm, type FormAlert } from '../../app/forms.svelte';
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
  import {
    discrepancyOf,
    discrepancyText,
    GAP,
    massText,
    waybillAcceptSchema,
    type AcceptValues,
    type Waybill,
  } from './waybills';

  let {
    waybill,
    alert,
    fail,
    ondone,
  }: {
    waybill: Waybill;
    alert: FormAlert;
    fail: (e: unknown) => { text: string; tone: 'danger' | 'attention' };
    ondone: (next: Waybill) => void;
  } = $props();

  const items = $derived(waybill.items);
  const idempotent = new Idempotency();

  const f = new SchemaForm<AcceptValues, Schemas['WaybillAccept']>({
    schema: untrack(() => waybillAcceptSchema(waybill.items)),
    values: untrack(() => ({
      actual: Object.fromEntries(waybill.items.map((i) => [i.batch.id, massText(i.massDeclaredKg)])),
      act: Object.fromEntries(waybill.items.map((i) => [i.batch.id, ''])),
    })),
    fields: untrack(() => waybill.items.flatMap((i) => [`actual.${i.batch.id}`, `act.${i.batch.id}`])),
    alert: untrack(() => alert),
    alias: (path) => {
      const m = /^items\[(\d+)\]\.(massActualKg|discrepancyAct)$/.exec(path);
      const item = m ? items[Number(m[1])] : undefined;
      return item && m ? `${m[2] === 'massActualKg' ? 'actual' : 'act'}.${item.batch.id}` : path;
    },
    send: async (body) => {
      const version = waybill.version;
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
        if (
          err instanceof ApiProblem &&
          (err.code === 'VERSION_CONFLICT' || err.code === 'INVALID_TRANSITION' || err.rule === 'BR-06' || err.status === 404)
        ) {
          fail(err);
          return;
        }
        if (err instanceof ApiProblem && err.rule === 'BR-07' && typeof err.params?.publicCode === 'string') {
          const code = err.params.publicCode;
          const item = items.find((i) => i.batch.publicCode === code);
          if (item) f.mark(`act.${item.batch.id}`, 'validation.required');
        }
        if (err instanceof ApiProblem && err.status === 429) f.wait.start(retryAfterOf(err));
        throw err;
      }
    },
  });
</script>

<Card>
  <CardHeader title={t('waybills.acceptance')} />
  <CardBody>
    <form id="waybill-accept" use:form={f} style={GAP}>
      {#each items as i (i.batch.id)}
        {@const id = i.batch.id}
        {@const d = discrepancyOf(i.massDeclaredKg, f.values.actual[id] ?? '')}
        <div style={FORM_GRID}>
          <div
            style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: end"
          >
            <Field id="actual-{id}" label={t('waybills.actualOf', { code: i.batch.publicCode })} error={f.error(`actual.${id}`)}>
              <InputGroup
                suffix={t('unit.kg')}
                inputmode="decimal"
                autocomplete="off"
                name="actual.{id}"
                bind:value={f.values.actual[id]}
              />
            </Field>
            <p aria-live="polite" style="margin: 0; min-height: 2.75rem; display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center">
              {#if d}
                <span>{t('waybills.discrepancy')}: {discrepancyText(d)}</span>
                {#if d.actRequired}<Chip tone="attention">{t('waybills.actRequired')}</Chip>{/if}
              {/if}
            </p>
          </div>
          {#if d?.actRequired}
            <Field id="act-{id}" label={t('waybills.actOf', { code: i.batch.publicCode })} error={f.error(`act.${id}`)}>
              <Textarea rows={3} name="act.{id}" bind:value={f.values.act[id]} />
            </Field>
          {/if}
        </div>
      {/each}
    </form>
  </CardBody>
  <CardFooter>
    <Submit form={f} formId="waybill-accept">{t('waybillAction.accept')}</Submit>
  </CardFooter>
</Card>
