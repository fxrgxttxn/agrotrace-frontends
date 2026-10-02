<script lang="ts">
  import { untrack } from 'svelte';
  import type { Organization, OrganizationDirectoryPage, OrganizationType } from '@agrotrace/api-client';
  import { enumLabel } from '@agrotrace/i18n';
  import { call } from './api.svelte';
  import { query } from './cache.svelte';
  import { t } from './i18n';
  import { session } from './session.svelte';
  import Combobox from '../ui/Combobox.svelte';
  import type { ComboOption } from '../ui/combobox';
  import Field from '../ui/Field.svelte';

  /** Organization filter (INSPECTOR, ADMIN): the organizations directory (listOrganizations, R46) with server search by
   * name or INN prefix. The URL keeps only the id; its name is read back with getOrganization. Clearing the text clears
   * the filter. The option just picked carries its name and is not read again. As the React app's OrgPicker. */
  let {
    id,
    label,
    value,
    onchange,
    types,
    error = null,
    exclude,
    onorg,
  }: {
    id: string;
    label: string;
    value: string;
    onchange: (id: string | null) => void;
    types?: OrganizationType[];
    /** Error text of the field (a form field). */
    error?: string | null;
    /** An organization never offered (the user's own: a waybill receiver). */
    exclude?: string;
    /** The picked (or, for a value from a link, read back) organization itself: its type decides the role of an
     * invited user. */
    onorg?: (org: { id: string; name: string; type: OrganizationType } | null) => void;
  } = $props();

  let text = $state('');
  let search = $state<string | null>(null);
  let picked = $state<ComboOption | null>(null);

  const chosen = query(
    () => (value !== '' && picked?.value !== value ? ['organization', value] : null),
    ([, orgId]) =>
      call<Organization>(session.api.GET('/organizations/{id}', { params: { path: { id: String(orgId) } } })),
    { freshMs: 5 * 60 * 1000 },
  );
  // The chosen organization's name fills the field (after a reload, or when the filter comes from a link).
  $effect.pre(() => {
    if (value === '') text = '';
    else if (chosen.data && chosen.data.id === value) text = chosen.data.name;
  });
  $effect(() => {
    const org = chosen.data;
    if (org) untrack(() => onorg?.(org));
  });

  const found = query(
    () => (search !== null && search.trim() !== '' ? ['organizations', 'directory', search, (types ?? []).join(',')] : null),
    ([, , q, kinds]) =>
      call<OrganizationDirectoryPage>(
        session.api.GET('/organizations', {
          params: {
            query: {
              q: String(q).trim(),
              size: 20,
              sort: 'name,asc',
              ...(kinds ? { type: String(kinds).split(',') as OrganizationType[] } : {}),
            },
          },
        }),
      ),
  );
  const options: ComboOption[] = $derived(
    (found.data?.items ?? [])
      .filter((o) => o.id !== exclude)
      .map((o) => ({ value: o.id, label: o.name, meta: enumLabel(t, 'OrganizationType', o.type) })),
  );
</script>

<Field {id} {label} {error}>
  <Combobox
    listLabel={label}
    bind:query={text}
    onquery={(next) => {
      if (next.trim() === '' && value !== '') {
        onchange(null);
        onorg?.(null);
      }
    }}
    onsearch={(next) => (search = next)}
    options={search && search.trim() ? options : []}
    loading={found.fetching}
    selected={value || null}
    onselect={(o) => {
      picked = o;
      text = o.label;
      onchange(o.value);
      const org = found.data?.items.find((x) => x.id === o.value);
      if (org) onorg?.(org);
    }}
  />
</Field>
