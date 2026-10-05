import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Organization, OrganizationDirectoryPage, OrganizationType } from '@agrotrace/api-client';
import { enumLabel } from '@agrotrace/i18n';
import { call } from './api';
import { t } from './i18n';
import { useSession } from './session';
import { Combobox, Field, type ComboOption } from '../ui';

export function OrgPicker({
  id,
  label,
  value,
  onChange,
  types,
  error,
  exclude,
  onOrg,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (id: string | null) => void;
  types?: OrganizationType[];
  error?: string | null;
  exclude?: string;
  onOrg?: (org: { id: string; name: string; type: OrganizationType } | null) => void;
}) {
  const { api } = useSession();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [picked, setPicked] = useState<ComboOption | null>(null);

  const chosen = useQuery({
    queryKey: ['organization', value],
    enabled: value !== '' && picked?.value !== value,
    staleTime: 5 * 60 * 1000,
    queryFn: () => call<Organization>(api.GET('/organizations/{id}', { params: { path: { id: value } } })),
  });
  useEffect(() => {
    if (value === '') setQuery('');
    else if (chosen.data) setQuery(chosen.data.name);
  }, [value, chosen.data]);
  const reportOrg = useRef(onOrg);
  reportOrg.current = onOrg;
  useEffect(() => {
    if (chosen.data) reportOrg.current?.(chosen.data);
  }, [chosen.data]);

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
  const options: ComboOption[] = (found.data?.items ?? [])
    .filter((o) => o.id !== exclude)
    .map((o) => ({
      value: o.id,
      label: o.name,
      meta: enumLabel(t, 'OrganizationType', o.type),
    }));

  return (
    <Field id={id} label={label} error={error}>
      <Combobox
        listLabel={label}
        query={query}
        onQueryChange={(text) => {
          setQuery(text);
          if (text.trim() === '' && value !== '') {
            onChange(null);
            onOrg?.(null);
          }
        }}
        onSearch={setSearch}
        options={search && search.trim() ? options : []}
        loading={found.isFetching}
        selected={value || null}
        onSelect={(o) => {
          setPicked(o);
          setQuery(o.label);
          onChange(o.value);
          const org = found.data?.items.find((x) => x.id === o.value);
          if (org) onOrg?.(org);
        }}
      />
    </Field>
  );
}
