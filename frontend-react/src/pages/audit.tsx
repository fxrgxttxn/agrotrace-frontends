import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import {
  auditActionLabel,
  auditFieldLabel,
  auditValue,
  enumLabel,
  formatLocalDateTime,
} from '@agrotrace/i18n';
import { call } from '../app/api';
import { DateFilter } from '../app/DateFilter';
import { useDictionary } from '../app/dictionaries';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { useSession } from '../app/session';
import {
  AreaLoading,
  Button,
  Card,
  CardFacts,
  Dialog,
  Empty,
  Field,
  Input,
  ListChanged,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Select,
  Table,
  type Column,
} from '../ui';

type Entry = Schemas['AuditEntry'];
type EntityType = Schemas['AuditEntityType'];
type Backend = Entry['backend'];

const SIZE = 20;
const VALUE = { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } as const;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPES: readonly EntityType[] = [
  'organization',
  'user',
  'field',
  'treatment',
  'batch',
  'waybill',
  'labTest',
  'recall',
  'recallTask',
  'complaint',
  'product',
  'substance',
  'indicator',
  'norm',
  'region',
  'file',
  'batchDocument',
];
const BACKENDS: readonly Backend[] = ['express', 'django', 'laravel', 'seed', 'system'];

const SPEC: ListSpec = {
  sort: ['createdAt'],
  enums: { entityType: ENTITY_TYPES, backend: BACKENDS },
  uuids: ['actorId', 'entityId'],
  dates: ['from', 'to'],
  patterns: { action: /^[A-Za-z0-9._-]{1,64}$/ },
};

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);
const short = (id: string) => id.slice(0, 8);

export function AuditPage() {
  const { api } = useSession();
  const list = useListParams('/admin/audit', SPEC);
  const action = list.get('action');
  const entityType = list.get('entityType');
  const entityId = list.get('entityId');
  const actorId = list.get('actorId');
  const backend = list.get('backend');
  const from = list.get('from');
  const to = list.get('to');
  const sort = list.sort;
  const count = [entityType, entityId, actorId, backend, from, to].filter(Boolean).length;
  const [viewing, setViewing] = useState<Entry | null>(null);
  const hrefWith = (patch: Record<string, string>) => {
    const next = new URLSearchParams(list.params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    next.delete('page');
    return `/admin/audit?${next.toString()}`;
  };

  const query = useQuery({
    queryKey: [
      'audit',
      {
        page: list.page,
        sort: list.params.get('sort'),
        action,
        entityType,
        entityId,
        actorId,
        backend,
        from,
        to,
      },
    ],
    meta: { failed: 'audit.failed' },
    queryFn: () =>
      call<Schemas['AuditPage']>(
        api.GET('/audit-log', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(action ? { action } : {}),
              ...(entityType ? { entityType: entityType as EntityType } : {}),
              ...(entityId ? { entityId } : {}),
              ...(actorId ? { actorId } : {}),
              ...(backend ? { backend: backend as Backend } : {}),
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const items = query.data?.items ?? [];
  const gap = query.data ? listGap(query.data, list.page, SIZE) : null;
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && gap === 'pastEnd') clampPage(query.data.total, SIZE);
  }, [query.data, gap, clampPage]);

  const columns: Column<Entry>[] = [
    {
      key: 'time',
      header: t('audit.time'),
      primary: true,
      sortField: 'createdAt',
      cell: (e) => (
        <span className="at-table__primary">
          <span>{at(e.createdAt)}</span>
          <span className="at-table__sub at-mono">{e.action}</span>
        </span>
      ),
    },
    {
      key: 'actor',
      header: t('audit.actor'),
      cell: (e) =>
        e.actor ? (
          <span className="at-table__primary">
            <Link
              to={hrefWith({ actorId: e.actor.id })}
              aria-label={t('audit.byActor', { name: e.actor.fullName })}
            >
              {e.actor.fullName}
            </Link>
            <span className="at-table__sub">{e.actor.organization.name}</span>
          </span>
        ) : (
          t('audit.system')
        ),
    },
    {
      key: 'entity',
      header: t('audit.entity'),
      cell: (e) => (
        <span className="at-table__primary">
          <span>{enumLabel(t, 'AuditEntityType', e.entityType)}</span>
          {e.entityId && (
            <Link
              className="at-mono"
              to={hrefWith({ entityType: e.entityType, entityId: e.entityId })}
              aria-label={t('audit.byEntity', {
                entity: enumLabel(t, 'AuditEntityType', e.entityType),
                id: e.entityId,
              })}
            >
              {short(e.entityId)}
            </Link>
          )}
        </span>
      ),
    },
    {
      key: 'backend',
      header: t('audit.backend'),
      cell: (e) => enumLabel(t, 'AuditEntry.backend', e.backend),
    },
  ];

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('audit.failed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
          onReset={isBadListQuery(query.error) ? list.reset : undefined}
        />
      );
    if (!query.data || gap === 'pastEnd') return <AreaLoading />;
    if (gap === 'changed')
      return <ListChanged busy={query.isFetching} onReload={() => void query.refetch()} />;
    if (items.length === 0)
      return (
        <Card>
          {action || count ? (
            <Empty
              art="empty-search"
              text={t('empty.search')}
              action={
                <Button variant="primary" onClick={list.reset}>
                  {t('filters.reset')}
                </Button>
              }
            />
          ) : (
            <Empty art="empty-search" text={t('audit.empty')} />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={t('page.audit')}
          columns={columns}
          rows={items}
          rowKey={(e) => String(e.id)}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'createdAt,desc', label: t('audit.sort.newest') },
            { value: 'createdAt,asc', label: t('audit.sort.oldest') },
          ]}
          actions={(e) => (
            <Button size="s" aria-label={t('audit.diffOf', { id: e.id })} onClick={() => setViewing(e)}>
              {t('audit.diff')}
            </Button>
          )}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page title={t('page.audit')}>
      <PageToolbar
        search={{
          label: t('audit.action'),
          placeholder: t('audit.actionPlaceholder'),
          value: action,
          onChange: (text) => list.set({ action: text.trim() }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-entity" label={t('audit.entity')}>
              <Select value={entityType} onChange={(e) => list.set({ entityType: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {ENTITY_TYPES.map((x) => (
                  <option key={x} value={x}>
                    {enumLabel(t, 'AuditEntityType', x)}
                  </option>
                ))}
              </Select>
            </Field>
            <IdFilter
              id="filter-entity-id"
              label={t('audit.entityId')}
              value={entityId}
              onChange={(v) => list.set({ entityId: v })}
            />
            <IdFilter
              id="filter-actor"
              label={t('audit.actorId')}
              value={actorId}
              onChange={(v) => list.set({ actorId: v })}
            />
            <Field id="filter-backend" label={t('audit.backend')}>
              <Select value={backend} onChange={(e) => list.set({ backend: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {BACKENDS.map((x) => (
                  <option key={x} value={x}>
                    {enumLabel(t, 'AuditEntry.backend', x)}
                  </option>
                ))}
              </Select>
            </Field>
            <DateFilter
              id="filter-from"
              label={t('audit.from')}
              value={from}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="filter-to"
              label={t('audit.to')}
              value={to}
              min={from || undefined}
              onChange={(v) => list.set({ to: v })}
            />
          </>
        }
      />
      {content()}
      <DiffDialog entry={viewing} onClose={() => setViewing(null)} />
    </Page>
  );
}

function IdFilter({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string | null) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const bad = text.trim() !== '' && !UUID.test(text.trim());
  return (
    <Field id={id} label={label} error={bad ? t('validation.uuid') : null}>
      <Input
        mono
        autoComplete="off"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (v.trim() === '') onChange(null);
          else if (UUID.test(v.trim())) onChange(v.trim().toLowerCase());
        }}
      />
    </Field>
  );
}

function DiffDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const has = (...fields: string[]) => entry !== null && fields.some((f) => f in entry.diff);
  const products = useDictionary('products', has('productId'));
  const indicators = useDictionary('indicators', has('indicatorId'));
  const substances = useDictionary('substances', has('substanceId'));
  const regions = useDictionary('regions', has('regionId', 'regionCode'));
  const resolve = (field: string, value: string): string | undefined => {
    const byId = (list: { id: string; name: string }[] | undefined) =>
      list?.find((x) => x.id === value)?.name;
    if (field === 'productId') return byId(products.data);
    if (field === 'indicatorId') return byId(indicators.data);
    if (field === 'substanceId') return byId(substances.data);
    if (field === 'regionId') return byId(regions.data);
    if (field === 'regionCode') return regions.data?.find((r) => r.code === value)?.name;
    return undefined;
  };
  const shown = (v: unknown, field: string) =>
    auditValue(t, v, LOCALE, entry ? { field, entityType: entry.entityType, resolve } : undefined);
  const rows = entry
    ? Object.entries(entry.diff).map(([field, pair]) => ({ field, before: pair[0], after: pair[1] }))
    : [];
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'field',
      header: t('audit.field'),
      primary: true,
      cell: (r) => (
        <span className="at-table__primary">
          <span>{auditFieldLabel(t, r.field)}</span>
          <span className="at-table__sub at-mono">{r.field}</span>
        </span>
      ),
    },
    {
      key: 'before',
      header: t('audit.before'),
      cell: (r) => <span style={VALUE}>{shown(r.before, r.field)}</span>,
    },
    {
      key: 'after',
      header: t('audit.after'),
      cell: (r) => <span style={VALUE}>{shown(r.after, r.field)}</span>,
    },
  ];
  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      size="l"
      lightDismiss
      title={
        entry
          ? t('audit.diffTitle', {
              entity: enumLabel(t, 'AuditEntityType', entry.entityType),
              action: auditActionLabel(t, entry.action),
            })
          : ''
      }
      actions={
        <Button variant="ghost" onClick={onClose}>
          {t('shell.close')}
        </Button>
      }
    >
      {entry && (
        <div style={STACK}>
          <CardFacts
            facts={[
              { key: 'time', term: t('audit.time'), value: at(entry.createdAt) },
              {
                key: 'actor',
                term: t('audit.actor'),
                value: entry.actor
                  ? `${entry.actor.fullName}, ${entry.actor.organization.name}`
                  : t('audit.system'),
              },
              ...(entry.entityId
                ? [
                    {
                      key: 'id',
                      term: t('audit.entityId'),
                      value: <span className="at-mono">{entry.entityId}</span>,
                    },
                  ]
                : []),
              {
                key: 'backend',
                term: t('audit.backend'),
                value: enumLabel(t, 'AuditEntry.backend', entry.backend),
              },
              ...(entry.ip
                ? [{ key: 'ip', term: t('audit.ip'), value: <span className="at-mono">{entry.ip}</span> }]
                : []),
              ...(entry.requestId
                ? [
                    {
                      key: 'req',
                      term: t('audit.requestId'),
                      value: <span className="at-mono">{entry.requestId}</span>,
                    },
                  ]
                : []),
            ]}
          />
          {rows.length ? (
            <Table cards caption={t('audit.changes')} columns={columns} rows={rows} rowKey={(r) => r.field} />
          ) : (
            <p style={{ margin: 0 }}>{t('audit.noChanges')}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}
