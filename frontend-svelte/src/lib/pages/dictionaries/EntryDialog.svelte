<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiProblem, type Schemas } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import type { DictName } from '../../app/admin';
  import { call } from '../../app/api.svelte';
  import { dictionary } from '../../app/dictionaries';
  import { DialogAlert, form, SchemaForm, wireSchema } from '../../app/forms.svelte';
  import { t } from '../../app/i18n';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import AreaLoading from '../../ui/AreaLoading.svelte';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import DialogMessage from '../../ui/DialogMessage.svelte';
  import Field from '../../ui/Field.svelte';
  import Input from '../../ui/Input.svelte';
  import InputGroup from '../../ui/InputGroup.svelte';
  import Select from '../../ui/Select.svelte';
  import Submit from '../../ui/Submit.svelte';
  import { FORM_GRID } from '../layout';
  import { CATEGORIES, entryName, FORMS, refresh, SUBSTANCE_TYPES, type Entry, type Norm, type Values } from './dictionaries';

  let { name, entry, onclose }: { name: DictName; entry?: Entry; onclose: () => void } = $props();

  const screen = screenScope();
  const dict = untrack(() => name);
  const def = FORMS[dict];
  const products = dictionary('products');
  const indicators = dictionary('indicators');
  const failure = new DialogAlert();
  const close = () => {
    failure.handOff();
    onclose();
  };
  const f = new SchemaForm<Values, Schemas['DictionaryInput']>({
    alert: failure,
    schema: wireSchema<Values>(def.schema, def.toWire, def.precheck),
    values: untrack(() => def.defaults(entry)),
    fields: def.fields,
    send: async (body) => {
      const current = entry;
      try {
        const saved = current
          ? await call<Entry>(
              session.api.PUT('/dictionaries/{name}/{id}', { params: { path: { name: dict, id: current.id } }, body }),
            )
          : await call<Entry>(session.api.POST('/dictionaries/{name}', { params: { path: { name: dict } }, body }));
        refresh(dict);
        if (screen.alive()) onclose();
        screen.done({ tone: 'ok', text: t(current ? 'dict.saved' : 'dict.created', { name: entryName(dict, saved) }) });
      } catch (e) {
        if (current && e instanceof ApiProblem && e.status === 404) {
          refresh(dict);
          if (screen.alive()) onclose();
          screen.push({ tone: 'danger', text: t('dict.gone', { name: entryName(dict, current) }) });
        } else throw e;
      }
    },
  });

  type Option = { value: string; label: string };
  const withCurrent = (opts: Option[], id: string | undefined, label: string | undefined): Option[] =>
    id && label && !opts.some((o) => o.value === id) ? [{ value: id, label }, ...opts] : opts;
  const norm = $derived(entry as Norm | undefined);
  const waiting = $derived(dict === 'norms' && (!products.data || !indicators.data));
</script>

{#snippet text(field: string, label: string, mono = false, inputmode: 'decimal' | 'numeric' | undefined = undefined)}
  <Field id="entry-{field}" {label} error={f.error(field)}>
    <Input autocomplete="off" {mono} {inputmode} name={field} bind:value={f.values[field]} />
  </Field>
{/snippet}

{#snippet select(field: string, label: string, options: Option[])}
  <Field id="entry-{field}" {label} error={f.error(field)}>
    <Select name={field} bind:value={f.values[field]}>
      <option value="" disabled>{t('ui.choose')}</option>
      {#each options as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </Select>
  </Field>
{/snippet}

<Dialog
  open
  onclose={close}
  title={entry ? t('dict.editTitle', { name: entryName(dict, entry) }) : t(`dict.addTitle.${dict}`)}
>
  {#snippet actions()}
    <Button variant="ghost" onclick={close}>{t('action.cancel')}</Button>
    <Submit form={f} formId="entry-form">{entry ? t('action.save') : t('dict.add')}</Submit>
  {/snippet}
  {#if waiting}
    <AreaLoading blocks={1} />
  {:else}
    <form id="entry-form" use:form={f} style={FORM_GRID}>
      <DialogMessage text={failure.message} />
      {#if dict === 'products'}
        {@render text('name', t('field.name'))}
        {@render select(
          'category',
          t('field.category'),
          CATEGORIES.map((c) => ({ value: c, label: enumLabel(t, 'ProductCategory', c) })),
        )}
        <Field id="entry-lossNormPercent" label={t('field.lossNormPercent')} error={f.error('lossNormPercent')}>
          <InputGroup
            suffix="%"
            inputmode="decimal"
            autocomplete="off"
            name="lossNormPercent"
            bind:value={f.values.lossNormPercent}
          />
        </Field>
        {@render text('mercuryCode', t('field.mercuryCode'), true)}
      {:else if dict === 'substances'}
        {@render text('name', t('field.name'))}
        {@render select(
          'type',
          t('field.type'),
          SUBSTANCE_TYPES.map((x) => ({ value: x, label: enumLabel(t, 'SubstanceType', x) })),
        )}
        {@render text('waitingPeriodDays', t('field.waitingPeriodDays'), false, 'numeric')}
      {:else if dict === 'indicators'}
        {@render text('name', t('field.name'))}
        {@render text('unit', t('field.unit'))}
      {:else if dict === 'norms'}
        {@render select(
          'productId',
          t('field.productId'),
          withCurrent(
            (products.data ?? []).map((p) => ({ value: p.id, label: p.name })),
            norm?.product.id,
            norm?.product.name,
          ),
        )}
        {@render select(
          'indicatorId',
          t('field.indicatorId'),
          withCurrent(
            (indicators.data ?? []).map((i) => ({ value: i.id, label: `${i.name}, ${i.unit}` })),
            norm?.indicator.id,
            norm ? `${norm.indicator.name}, ${norm.indicator.unit}` : undefined,
          ),
        )}
        {@render text('maxValue', t('field.maxValue'), false, 'decimal')}
      {:else}
        {@render text('code', t('field.code'), true)}
        {@render text('name', t('field.name'))}
      {/if}
    </form>
  {/if}
</Dialog>
