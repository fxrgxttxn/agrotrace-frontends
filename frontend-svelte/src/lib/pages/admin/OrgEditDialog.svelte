<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { OrganizationAdminPatchSchema } from '@agrotrace/validation';
  import { call } from '../../app/api.svelte';
  import { DialogAlert, form, SchemaForm, wireSchema } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import Select from '../../ui/Select.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Textarea from '../../ui/Textarea.svelte';
  import { FORM_GRID } from '../layout';

  type Org = Schemas['OrganizationAdmin'];
  interface EditValues extends Record<string, unknown> {
    name: string;
    address: string;
    regionCode: string;
  }

  let {
    org,
    regions,
    onclose,
    onsaved,
    ongone,
  }: {
    org: Org;
    regions: Schemas['RegionEntry'][];
    onclose: () => void;
    onsaved: (next: Org) => void;
    ongone: (e: unknown) => void;
  } = $props();

  const full = (v: EditValues) => ({
    name: v.name.trim(),
    address: v.address.trim() === '' ? null : v.address.trim(),
    regionCode: v.regionCode,
  });
  const schema = wireSchema<EditValues>(OrganizationAdminPatchSchema, full, (v): Record<string, string> =>
    v.name.trim() === '' ? { name: 'validation.required' } : {},
  );
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };
  const f = new SchemaForm<EditValues>({
    alert: failure,
    schema,
    values: untrack(() => ({ name: org.name, address: org.address ?? '', regionCode: org.region.code })),
    fields: ['name', 'address', 'regionCode'],
    send: async () => {
      const v = full($state.snapshot(f.values) as EditValues);
      const body = {
        ...(v.name !== org.name ? { name: v.name } : {}),
        ...(v.address !== org.address ? { address: v.address } : {}),
        ...(v.regionCode !== org.region.code ? { regionCode: v.regionCode } : {}),
      };
      if (Object.keys(body).length === 0) {
        onclose();
        return;
      }
      try {
        onsaved(
          await call<Org>(session.api.PATCH('/admin/organizations/{id}', { params: { path: { id: org.id } }, body })),
        );
      } catch (e) {
        if (e instanceof ApiProblem && e.status === 404) ongone(e);
        else throw e;
      }
    },
  });
</script>

<Dialog open onclose={close} title={t('orgs.editTitle', { name: org.name })}>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Submit form={f} formId="org-form">{t('action.save')}</Submit>
  {/snippet}
  <form id="org-form" use:form={f} style={FORM_GRID}>
    <DialogMessage text={failure.message} />
    <Field id="org-name" label={t('field.name')} error={f.error('name')}>
      <Input autocomplete="off" name="name" bind:value={f.values.name} />
    </Field>
    <Field id="org-address" label={t('field.address')} error={f.error('address')}>
      <Textarea rows={2} name="address" bind:value={f.values.address} />
    </Field>
    <Field id="org-region" label={t('field.regionCode')} error={f.error('regionCode')}>
      <Select name="regionCode" bind:value={f.values.regionCode}>
        {#if !regions.some((r) => r.code === org.region.code)}
          <option value={org.region.code}>{org.region.name}</option>
        {/if}
        {#each regions as r (r.id)}
          <option value={r.code}>{r.name}</option>
        {/each}
      </Select>
    </Field>
  </form>
</Dialog>
