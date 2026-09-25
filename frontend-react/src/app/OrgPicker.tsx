import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Organization, OrganizationDirectoryPage, OrganizationType } from '@agrotrace/api-client';
import { enumLabel } from '@agrotrace/i18n';
import { call } from './api';
import { t } from './i18n';
import { useSession } from './session';
import { Combobox, Field, type ComboOption } from '../ui';

// Organization filter (INSPECTOR, ADMIN): the organizations directory (listOrganizations, R46) with server search by
// name or INN prefix. The URL keeps only the id; its name is read back with getOrganization (INSPECTOR and ADMIN see
// every organization). Clearing the text clears the filter.

export function OrgPicker({
  id,
  label,
  value,
  onChange,
  types,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string | null) => void;
  types?: OrganizationType[];
}) {
  const { api } = useSession();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<string | null>(null);

  const chosen = useQuery({
    queryKey: ['organization', value],
    enabled: value !== '',
    staleTime: 5 * 60 * 1000,
    queryFn: () => call<Organization>(api.GET('/organizations/{id}', { params: { path: { id: value } } })),
  });
  // The chosen organization's name fills the field (after a reload, or when the filter comes from a link).
  useEffect(() => {
    if (value === '') setQuery('');
    else if (chosen.data) setQuery(chosen.data.name);
  }, [value, chosen.data]);

  const found = useQuery({
    queryKey: ['organizations', 'directory', search, types],
    enabled: search !== null && search.trim() !== '',
    queryFn: () =>
      call<OrganizationDirectoryPage>(
        api.GET('/organizations', {
          params: {
            query: { q: search!.trim(), size: 20, sort: 'name,asc', ...(types ? { type: types } : {}) },
          },
        }),
      ),
  });
  const options: ComboOption[] = (found.data?.items ?? []).map((o) => ({
    value: o.id,
    label: o.name,
    meta: enumLabel(t, 'OrganizationType', o.type),
  }));

  return (
    <Field id={id} label={label}>
      <Combobox
        listLabel={label}
        query={query}
        onQueryChange={(text) => {
          setQuery(text);
          if (text.trim() === '' && value !== '') onChange(null);
        }}
        onSearch={setSearch}
        options={search && search.trim() ? options : []}
        loading={found.isFetching}
        selected={value || null}
        onSelect={(o) => {
          setQuery(o.label);
          onChange(o.value);
        }}
      />
    </Field>
  );
}
