<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { DialogAlert, form, SchemaForm } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { momentDefaults } from '../../app/moment';
  import MomentInput from '../../app/MomentInput.svelte';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import Select from '../../ui/Select.svelte';
  import Submit from '../../ui/Submit.svelte';
  import { FORM_GRID } from '../layout';
  import { DOSE_UNITS, TREATMENT_FIELDS, treatmentSchema, type Treatment, type TreatmentValues } from './fields';

  let {
    open,
    fieldId,
    treatment,
    onclose,
    onsaved,
    onclosedwindow,
    substances,
  }: {
    open: boolean;
    fieldId: string;
    treatment?: Treatment;
    onclose: () => void;
    onsaved: (created: boolean) => void;
    onclosedwindow: (editableUntil: string) => void;
    substances: Schemas['Substance'][];
  } = $props();

  const initial = untrack((): TreatmentValues => {
    const at = momentDefaults(treatment?.appliedAt);
    return {
      substanceId: treatment?.substance.id ?? '',
      dose: treatment ? treatment.dose.replace('.', ',') : '',
      doseUnit: treatment?.doseUnit ?? 'л/га',
      appliedAt: at.date,
      appliedTime: at.time,
      original: at.original,
    };
  });

  const failure = new DialogAlert();
  $effect(() => {
    if (!open) failure.handOff();
  });
  const f = new SchemaForm<TreatmentValues, Schemas['TreatmentInput']>({
    alert: failure,
    schema: treatmentSchema,
    values: initial,
    fields: TREATMENT_FIELDS,
    send: async (body) => {
      try {
        if (treatment)
          await call<Treatment>(
            session.api.PUT('/treatments/{id}', { params: { path: { id: treatment.id } }, body }),
          );
        else
          await call<Treatment>(
            session.api.POST('/fields/{id}/treatments', { params: { path: { id: fieldId } }, body }),
          );
      } catch (e) {
        if (treatment && e instanceof ApiProblem && e.status === 403 && e.params?.reason === 'EDIT_WINDOW_CLOSED') {
          const until = e.params.editableUntil;
          onclosedwindow(typeof until === 'string' ? until : treatment.editableUntil);
          return;
        }
        throw e;
      }
      onsaved(!treatment);
    },
  });

  const label = $derived(treatment ? t('action.save') : t('treatments.add'));
  const options = $derived(
    treatment && !substances.some((s) => s.id === treatment.substance.id)
      ? [treatment.substance, ...substances]
      : substances,
  );
</script>

<Dialog {open} {onclose} title={treatment ? t('treatments.editTitle') : t('treatments.add')}>
  {#snippet actions()}
    <Button variant="ghost" onclick={onclose}>{t('action.cancel')}</Button>
    <Submit form={f} formId="treatment-form">{label}</Submit>
  {/snippet}
  <form id="treatment-form" use:form={f} style={FORM_GRID}>
    <DialogMessage text={failure.message} />
    <Field id="treatment-substance" label={t('field.substanceId')} error={f.error('substanceId')}>
      <Select name="substanceId" bind:value={f.values.substanceId}>
        <option value="" disabled>{t('ui.choose')}</option>
        {#each options as s (s.id)}
          <option value={s.id}>{s.name}</option>
        {/each}
      </Select>
    </Field>
    <Field id="treatment-dose" label={t('field.dose')} error={f.error('dose')}>
      <Input inputmode="decimal" autocomplete="off" name="dose" bind:value={f.values.dose} />
    </Field>
    <Field id="treatment-unit" label={t('field.doseUnit')} error={f.error('doseUnit')}>
      <Select name="doseUnit" bind:value={f.values.doseUnit}>
        {#each DOSE_UNITS as u (u)}
          <option value={u}>{enumLabel(t, 'DoseUnit', u)}</option>
        {/each}
      </Select>
    </Field>
    <MomentInput
      {f}
      id="treatment"
      dateName="appliedAt"
      timeName="appliedTime"
      dateLabel={t('field.appliedAt')}
      timeLabel={t('treatments.time')}
    />
  </form>
</Dialog>
