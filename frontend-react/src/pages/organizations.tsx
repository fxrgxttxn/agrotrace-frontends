import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatLocalDate } from '@agrotrace/i18n';
import { OrganizationAdminPatchSchema } from '@agrotrace/validation';
import { APPLICATION, ORG_TONE, orgActions, orgTarget, type OrgAction } from '../app/admin';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useDialogAlert,
  useFocusAfterWait,
} from '../app/api';
import { useScreenToast } from '../app/cache';
import { useDictionary } from '../app/dictionaries';
import { errorOf, FORM_GRID, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { useSession } from '../app/session';
import {
  AreaLoading,
  Button,
  Card,
  Chip,
  Dialog,
  DialogMessage,
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
  Textarea,
  type Column,
} from '../ui';

type Org = Schemas['OrganizationAdmin'];
type Status = Schemas['OrganizationStatus'];
type OrgType = Schemas['OrganizationType'];

const SIZE = 20;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const STATUSES: readonly Status[] = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'];
const TYPES: readonly OrgType[] = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'];
const APPLICATIONS = '__applications';
const SEVERAL = '__several';

const SPEC: ListSpec = {
  sort: ['createdAt', 'name'],
  enums: { status: STATUSES, type: TYPES },
  patterns: { regionCode: /^[0-9A-Z-]{1,8}$/ },
  texts: ['q'],
};

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;

const CONFIRMED: readonly OrgAction[] = ['reject', 'suspend'];

export function OrganizationsPage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const toast = useScreenToast();
  const regions = useDictionary('regions');
  const list = useListParams('/admin/organizations', SPEC);
  const q = list.get('q');
  const status = list.params.getAll('status');
  const type = list.params.getAll('type');
  const regionCode = list.get('regionCode');
  const sort = list.sort;
  const count = (status.length ? 1 : 0) + (type.length ? 1 : 0) + (regionCode ? 1 : 0);

  const query = useQuery({
    queryKey: [
      'adminOrganizations',
      { page: list.page, sort: list.params.get('sort'), q, status, type, regionCode },
    ],
    meta: { failed: 'orgs.failed' },
    queryFn: () =>
      call<Schemas['OrganizationAdminPage']>(
        api.GET('/admin/organizations', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(status.length ? { status: status as Status[] } : {}),
              ...(type.length ? { type: type as OrgType[] } : {}),
              ...(regionCode ? { regionCode } : {}),
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

  const [busyId, setBusyId] = useState<string | null>(null);
  const [wait, startWait] = useCountdown();
  const [confirming, setConfirming] = useState<{ org: Org; action: OrgAction } | null>(null);
  const failure = useDialogAlert();
  const [editing, setEditing] = useState<Org | null>(null);
  const confirmRef = useFocusAfterWait(wait);

  const reread = () => void queryClient.invalidateQueries({ queryKey: ['adminOrganizations'] });

  const describe = (e: unknown, org: Org): string => {
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      reread();
      return t('orgs.stateChanged', {
        name: org.name,
        status: enumLabel(t, 'OrganizationStatus', String(e.params?.from ?? '')),
      });
    }
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      reread();
      return t('orgs.busy', { name: org.name });
    }
    if (e instanceof ApiProblem && e.status === 404) {
      reread();
      return t('orgs.gone', { name: org.name });
    }
    if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
    return errorText(e);
  };

  const act = async (org: Org, action: OrgAction) => {
    setBusyId(org.id);
    failure.clear();
    try {
      const next =
        action === 'approve'
          ? await call<Org>(
              api.POST('/admin/organizations/{id}/approve', { params: { path: { id: org.id } } }),
            )
          : await call<Org>(
              api.PATCH('/admin/organizations/{id}', {
                params: { path: { id: org.id } },
                body: { status: orgTarget(action) as 'ACTIVE' | 'REJECTED' | 'SUSPENDED' },
              }),
            );
      setConfirming(null);
      reread();
      toast.done({ tone: 'ok', text: t(`orgs.done.${action}`, { name: next.name }) });
    } catch (e) {
      const text = describe(e, org);
      const stale = e instanceof ApiProblem && (e.code === 'INVALID_TRANSITION' || e.status === 404);
      if (stale) setConfirming(null);
      if (CONFIRMED.includes(action) && !stale) failure.show(text, errorTone(e));
      else toast.push({ tone: errorTone(e), text });
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<Org>[] = [
    {
      key: 'name',
      header: t('orgs.name'),
      primary: true,
      sortField: 'name',
      cell: (o) => (
        <span className="at-table__primary">
          <span>{o.name}</span>
          <span className="at-table__sub">{t('orgs.inn', { inn: o.inn })}</span>
          <span className="at-table__sub">
            {t('orgs.typeRegionOf', {
              type: enumLabel(t, 'OrganizationType', o.type),
              region: o.region.name,
            })}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('orgs.status'),
      status: true,
      cell: (o) => <Chip tone={ORG_TONE[o.status]}>{enumLabel(t, 'OrganizationStatus', o.status)}</Chip>,
    },
    {
      key: 'head',
      header: t('orgs.head'),
      cell: (o) =>
        o.head ? (
          <span className="at-table__primary">
            <span>{o.head.fullName}</span>
            <span className="at-table__sub" style={{ overflowWrap: 'anywhere' }}>
              {o.head.email}
            </span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'created',
      header: t('orgs.createdAt'),
      sortField: 'createdAt',
      cell: (o) => formatLocalDate(o.createdAt, LOCALE),
    },
  ];

  const actions = (o: Org) => {
    const can = orgActions(o.status, o.type);
    const busy = busyId === o.id;
    return (
      <>
        {can.map((action) => (
          <Button
            key={action}
            size="s"
            variant={action === 'approve' ? 'primary' : CONFIRMED.includes(action) ? 'danger' : 'secondary'}
            busy={busy && !confirming}
            disabled={wait > 0 || (busyId !== null && !busy)}
            aria-label={t(`orgs.actionOf.${action}`, { name: o.name })}
            onClick={() => {
              if (CONFIRMED.includes(action)) {
                failure.clear();
                setConfirming({ org: o, action });
              } else void act(o, action);
            }}
          >
            {t(`orgs.action.${action}`)}
          </Button>
        ))}
        <Button
          size="s"
          variant="ghost"
          aria-label={t('orgs.editOf', { name: o.name })}
          onClick={() => setEditing(o)}
        >
          {t('orgs.edit')}
        </Button>
      </>
    );
  };

  const statusValue =
    status.length === 2 && APPLICATION.every((s) => status.includes(s))
      ? APPLICATIONS
      : status.length === 1
        ? status[0]
        : status.length > 1
          ? SEVERAL
          : '';
  const typeValue = type.length === 1 ? type[0] : type.length > 1 ? SEVERAL : '';

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('orgs.failed')}
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
          <Empty
            art="empty-search"
            text={
              statusValue === APPLICATIONS && !q && count === 1 ? t('orgs.noApplications') : t('empty.search')
            }
            action={
              <Button variant="primary" onClick={list.reset}>
                {t('filters.reset')}
              </Button>
            }
          />
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={t('page.organizations')}
          columns={columns}
          rows={items}
          rowKey={(o) => o.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'createdAt,desc', label: t('orgs.sort.created') },
            { value: 'name,asc', label: t('orgs.sort.name') },
          ]}
          actions={actions}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  const c = confirming;
  const closeConfirm = () => {
    failure.handOff();
    setConfirming(null);
  };
  return (
    <Page title={t('page.organizations')}>
      <PageToolbar
        search={{
          label: t('orgs.search'),
          placeholder: t('orgs.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-status" label={t('orgs.status')}>
              <Select
                value={statusValue}
                onChange={(e) =>
                  list.set({ status: e.target.value === APPLICATIONS ? [...APPLICATION] : e.target.value })
                }
              >
                <option value="">{t('filters.any')}</option>
                <option value={APPLICATIONS}>{t('orgs.applications')}</option>
                {statusValue === SEVERAL && (
                  <option value={SEVERAL} disabled>
                    {t('filters.several', { count: status.length })}
                  </option>
                )}
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {enumLabel(t, 'OrganizationStatus', s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="filter-type" label={t('orgs.type')}>
              <Select value={typeValue} onChange={(e) => list.set({ type: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {typeValue === SEVERAL && (
                  <option value={SEVERAL} disabled>
                    {t('filters.several', { count: type.length })}
                  </option>
                )}
                {TYPES.map((x) => (
                  <option key={x} value={x}>
                    {enumLabel(t, 'OrganizationType', x)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="filter-region" label={t('orgs.region')}>
              <Select value={regionCode} onChange={(e) => list.set({ regionCode: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {regionCode && !regions.data?.some((r) => r.code === regionCode) && (
                  <option value={regionCode}>{regionCode}</option>
                )}
                {(regions.data ?? []).map((r) => (
                  <option key={r.id} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        }
      />
      {content()}
      <Dialog
        open={c !== null}
        onClose={closeConfirm}
        title={c ? t(`orgs.confirm.${c.action}.title`, { name: c.org.name }) : ''}
        actions={
          <>
            <Button variant="ghost" onClick={closeConfirm}>
              {t('action.cancel')}
            </Button>
            <Button
              ref={confirmRef}
              variant="danger"
              busy={busyId !== null}
              disabled={wait > 0}
              onClick={() => c && void act(c.org, c.action)}
            >
              {wait > 0
                ? t('auth.retryIn', { seconds: wait })
                : c
                  ? t(`orgs.confirm.${c.action}.button`)
                  : ''}
            </Button>
          </>
        }
      >
        <div style={STACK}>
          <DialogMessage text={failure.message} />
          <p style={{ margin: 0 }}>{c ? t(`orgs.confirm.${c.action}.text`) : ''}</p>
        </div>
      </Dialog>
      {editing && (
        <EditDialog
          org={editing}
          regions={regions.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setEditing(null);
            reread();
            toast.done({ tone: 'ok', text: t('orgs.saved', { name: next.name }) });
          }}
          onGone={(e) => {
            setEditing(null);
            toast.push({ tone: 'danger', text: describe(e, editing) });
          }}
        />
      )}
    </Page>
  );
}

interface EditValues {
  name: string;
  address: string;
  regionCode: string;
}

function EditDialog({
  org,
  regions,
  onClose,
  onSaved,
  onGone,
}: {
  org: Org;
  regions: Schemas['RegionEntry'][];
  onClose: () => void;
  onSaved: (next: Org) => void;
  onGone: (e: unknown) => void;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const full = (v: EditValues) => ({
    name: v.name.trim(),
    address: v.address.trim() === '' ? null : v.address.trim(),
    regionCode: v.regionCode,
  });
  const toWire = (v: EditValues) => {
    const f = full(v);
    return {
      ...(f.name !== org.name ? { name: f.name } : {}),
      ...(f.address !== org.address ? { address: f.address } : {}),
      ...(f.regionCode !== org.region.code ? { regionCode: f.regionCode } : {}),
    };
  };
  const schema = wireSchema<EditValues>(OrganizationAdminPatchSchema, full, (v): Record<string, string> =>
    v.name.trim() === '' ? { name: 'validation.required' } : {},
  );
  const { form, alert, wait, fail, message, handOff } = useSchemaForm<EditValues>(
    schema,
    { name: org.name, address: org.address ?? '', regionCode: org.region.code },
    ['name', 'address', 'regionCode'],
    undefined,
    { dialog: true },
  );
  const close = () => {
    handOff();
    onClose();
  };
  const submit = form.handleSubmit(async () => {
    const body = toWire(form.getValues());
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    alert.clear();
    setBusy(true);
    try {
      const next = await call<Org>(
        api.PATCH('/admin/organizations/{id}', { params: { path: { id: org.id } }, body }),
      );
      onSaved(next);
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 404) onGone(e);
      else fail(e);
    } finally {
      setBusy(false);
    }
  });
  return (
    <Dialog
      open
      onClose={close}
      title={t('orgs.editTitle', { name: org.name })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Submit busy={busy} wait={wait} form="org-form">
            {t('action.save')}
          </Submit>
        </>
      }
    >
      <form id="org-form" noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
        <DialogMessage text={message} />
        <Field id="org-name" label={t('field.name')} error={errorOf(form, 'name')}>
          <Input autoComplete="off" {...form.register('name')} />
        </Field>
        <Field id="org-address" label={t('field.address')} error={errorOf(form, 'address')}>
          <Textarea rows={2} {...form.register('address')} />
        </Field>
        <Field id="org-region" label={t('field.regionCode')} error={errorOf(form, 'regionCode')}>
          <Select {...form.register('regionCode')}>
            {!regions.some((r) => r.code === org.region.code) && (
              <option value={org.region.code}>{org.region.name}</option>
            )}
            {regions.map((r) => (
              <option key={r.id} value={r.code}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
