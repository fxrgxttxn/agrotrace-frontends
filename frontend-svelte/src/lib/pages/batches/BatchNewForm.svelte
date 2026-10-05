<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { cache } from '../../app/cache.svelte';
  import { form, SchemaForm } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { momentDefaults } from '../../app/moment';
  import MomentInput from '../../app/MomentInput.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import Field from '../../ui/Field.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Select from '../../ui/Select.svelte';
  import Submit from '../../ui/Submit.svelte';
  import { FORM_GRID } from '../layout';
  import { BATCH_FIELDS, batchSchema, type Batch, type BatchValues } from './batches';

  let { fields, products }: { fields: Schemas['Field'][]; products: Schemas['Product'][] } = $props();

  const screen = screenScope();
  const born = cache.generation;
  const wanted = page.url.searchParams.get('fieldId') ?? '';

  const f = new SchemaForm<BatchValues, Schemas['BatchCreate']>({
    schema: batchSchema,
    values: untrack((): BatchValues => {
      const at = momentDefaults(null);
      return {
        fieldId: fields.some((fl) => fl.id === wanted) ? wanted : '',
        productId: '',
        massKg: '',
        harvestedAt: at.date,
        harvestTime: at.time,
        original: at.original,
      };
    }),
    fields: BATCH_FIELDS,
    send: async (body) => {
      try {
        const batch = await call<Batch>(session.api.POST('/batches', { body }));
        cache.set(['batch', batch.id], batch, born);
        void cache.invalidate(['batches']);
        void cache.invalidate(['fields']);
        screen.done(
          batch.testRequired
            ? {
                tone: 'attention',
                text: t('batches.createdTest', {
                  code: batch.publicCode,
                  reason: enumLabel(t, 'TestReason', batch.testReason),
                }),
              }
            : { tone: 'ok', text: t('batches.createdNoTest', { code: batch.publicCode }) },
        );
        screen.navigate(`/batches/${batch.id}`);
      } catch (e) {
        if (e instanceof ApiProblem && e.code === 'NO_LAB_AVAILABLE') {
          f.alert.show(t('batches.noLab'));
          return;
        }
        throw e;
      }
    },
  });
</script>

<Card style="max-width: 40rem">
  <CardBody>
    <form id="batch-new" use:form={f} style={FORM_GRID}>
      <Field id="batch-field" label={t('field.fieldId')} error={f.error('fieldId')}>
        <Select name="fieldId" bind:value={f.values.fieldId}>
          <option value="" disabled>{t('ui.choose')}</option>
          {#each fields as fl (fl.id)}
            <option value={fl.id}>{fl.name}</option>
          {/each}
        </Select>
      </Field>
      <Field id="batch-product" label={t('field.productId')} error={f.error('productId')}>
        <Select name="productId" bind:value={f.values.productId}>
          <option value="" disabled>{t('ui.choose')}</option>
          {#each products as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </Select>
      </Field>
      <Field id="batch-mass" label={t('batches.massValue')} error={f.error('massKg')}>
        <InputGroup suffix={t('unit.kg')} inputmode="decimal" autocomplete="off" name="massKg" bind:value={f.values.massKg} />
      </Field>
      <MomentInput
        {f}
        id="batch-harvested"
        dateName="harvestedAt"
        timeName="harvestTime"
        dateLabel={t('field.harvestedAt')}
        timeLabel={t('batches.harvestTime')}
      />
      <div><Submit form={f} formId="batch-new">{t('action.createBatch')}</Submit></div>
    </form>
  </CardBody>
</Card>
