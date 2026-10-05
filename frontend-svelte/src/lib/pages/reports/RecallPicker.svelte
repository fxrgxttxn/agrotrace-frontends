<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { enumLabel, formatLocalDate } from '@agrotrace/i18n';
  import { call } from '../../app/api.svelte';
  import { query } from '../../app/cache.svelte';
  import { LOCALE, t } from '../../app/i18n';
  import { session } from '../../app/session.svelte';
  import Combobox from '../../ui/Combobox.svelte';
  import type { ComboOption } from '../../ui/combobox';
  import Field from '../../ui/Field.svelte';

  let {
    value,
    error = null,
    onchange,
  }: { value: string; error?: string | null; onchange: (id: string | null) => void } = $props();

  let text = $state('');
  let search = $state<string | null>(null);
  let picked = $state<string | null>(null);
  const chosen = query(
    () => (value !== '' && picked !== value ? ['recall', value] : null),
    ([, id]) => call<Schemas['Recall']>(session.api.GET('/recalls/{id}', { params: { path: { id: String(id) } } })),
  );
  $effect.pre(() => {
    if (value === '') text = '';
    else if (chosen.data) text = chosen.data.sourceBatch.publicCode;
  });
  const found = query(
    () => (search !== null && search.trim() !== '' ? ['recalls', 'picker', search] : null),
    ([, , q]) =>
      call<Schemas['RecallPage']>(
        session.api.GET('/recalls', { params: { query: { q: String(q).trim(), size: 20, sort: 'openedAt,desc' } } }),
      ),
  );
  const options: ComboOption[] = $derived(
    (found.data?.items ?? []).map((r) => ({
      value: r.id,
      label: r.sourceBatch.publicCode,
      meta: t('reports.recallMeta', {
        date: formatLocalDate(r.openedAt, LOCALE),
        status: enumLabel(t, 'RecallStatus', r.status),
      }),
    })),
  );
</script>

<Field id="report-id" label={t('reports.recall')} {error}>
  <Combobox
    listLabel={t('reports.recall')}
    bind:query={text}
    onquery={(next) => {
      if (next.trim() === '' && value !== '') onchange(null);
    }}
    onsearch={(next) => (search = next)}
    options={search && search.trim() ? options : []}
    loading={found.fetching}
    selected={value || null}
    onselect={(o) => {
      picked = o.value;
      text = o.label;
      onchange(o.value);
    }}
  />
</Field>
