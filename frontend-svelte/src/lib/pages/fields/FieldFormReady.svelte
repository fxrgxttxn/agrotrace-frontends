<script lang="ts">
  import { untrack } from 'svelte';
  import type { Schemas } from '@agrotrace/api-client';
  import { formatBytes } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { DialogAlert, form, SchemaForm } from '../../app/forms.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Field from '../../ui/Field.svelte';
  import FileField, { type FileItem } from '../../ui/FileField.svelte';
  import Input from '../../ui/Input.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Select from '../../ui/Select.svelte';
  import Submit from '../../ui/Submit.svelte';
  import Textarea from '../../ui/Textarea.svelte';
  import { FORM_GRID } from '../layout';
  import {
    FIELD_FIELDS,
    fieldAlias,
    fieldSchema,
    fieldValuesOf,
    GEOJSON_MAX_BYTES,
    parseGeometry,
    prettyGeometry,
    readText,
    type FieldT,
    type FieldValues,
  } from './fields';

  let {
    id,
    field,
    submitLabel,
    onsaved,
    regions,
    dialog,
  }: {
    id: string;
    field?: FieldT;
    submitLabel: string;
    onsaved: (f: FieldT) => void;
    regions: Schemas['RegionEntry'][];
    dialog?: { open: boolean; title: string; onclose: () => void };
  } = $props();

  const failure = untrack(() => (dialog ? new DialogAlert() : undefined));
  $effect(() => {
    if (dialog && !dialog.open) failure?.handOff();
  });
  const f = new SchemaForm<FieldValues, Schemas['FieldInput']>({
    alert: failure,
    schema: fieldSchema,
    values: untrack(() => fieldValuesOf(field)),
    fields: FIELD_FIELDS,
    alias: fieldAlias,
    send: async (body) => {
      const saved = field
        ? await call<FieldT>(session.api.PUT('/fields/{id}', { params: { path: { id: field.id } }, body }))
        : await call<FieldT>(session.api.POST('/fields', { body }));
      onsaved(saved);
    },
  });

  let file = $state<FileItem[]>([]);
  let fileError = $state<string | null>(null);

  async function importFile(files: File[]) {
    const picked = files[0];
    if (!picked) return;
    fileError = null;
    const text = picked.size <= GEOJSON_MAX_BYTES ? await readText(picked) : null;
    if (text === null) {
      file = [];
      fileError = t('fields.geometryUnreadable');
      return;
    }
    const parsed = parseGeometry(text);
    f.values.geometry = parsed.ok && parsed.value ? prettyGeometry(parsed.value) : text;
    f.changed('geometry');
    file = [{ key: picked.name, name: picked.name, sizeText: formatBytes(picked.size, LOCALE) }];
    if (!parsed.ok) f.mark('geometry', 'fields.geometryInvalid');
  }
</script>

{#snippet body()}
  <form {id} use:form={f} style={FORM_GRID}>
    {#if failure}<DialogMessage text={failure.message} />{/if}
    <Field id="{id}-name" label={t('field.name')} error={f.error('name')}>
      <Input autocomplete="off" name="name" bind:value={f.values.name} />
    </Field>
    <Field id="{id}-area" label={t('field.areaHa')} error={f.error('areaHa')}>
      <InputGroup suffix={t('unit.ha')} inputmode="decimal" autocomplete="off" name="areaHa" bind:value={f.values.areaHa} />
    </Field>
    <Field id="{id}-region" label={t('field.regionCode')} error={f.error('regionCode')}>
      <Select name="regionCode" bind:value={f.values.regionCode}>
        <option value="" disabled>{t('ui.choose')}</option>
        {#each regions as r (r.id)}
          <option value={r.code}>{r.name}</option>
        {/each}
      </Select>
    </Field>
    <Field id="{id}-geometry" label={t('fields.geometry')} error={f.error('geometry')}>
      <Textarea
        class="at-textarea at-mono"
        rows={6}
        spellcheck={false}
        aria-describedby="{id}-geometry-file-hint"
        placeholder={'{\n  "type": "Polygon",\n  "coordinates": [[[39.01, 45.04], …, [39.01, 45.04]]]\n}'}
        name="geometry"
        bind:value={f.values.geometry}
      />
    </Field>
    <FileField
      id="{id}-geometry-file"
      label={t('fields.geometryFile')}
      accept=".geojson,.json,application/geo+json,application/json"
      hint={t('fields.geometryFileHint')}
      files={file}
      onfiles={(files) => void importFile(files)}
      onremove={() => (file = [])}
      error={fileError}
    />
  </form>
{/snippet}

{#if dialog}
  <Dialog open={dialog.open} onclose={dialog.onclose} title={dialog.title}>
    {#snippet actions()}
      <Button variant="ghost" onclick={dialog.onclose}>{t('action.cancel')}</Button>
      <Submit form={f} formId={id}>{submitLabel}</Submit>
    {/snippet}
    {@render body()}
  </Dialog>
{:else}
  {@render body()}
  <div style="margin-top: var(--sp-5)"><Submit form={f} formId={id}>{submitLabel}</Submit></div>
{/if}
