import { useEffect, useRef, useState } from 'react';
import { Link, matchPath, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, newIdempotencyKey, withVariant, type Schemas } from '@agrotrace/api-client';
import { BATCH_STATUSES } from '@agrotrace/domain';
import {
  enumLabel,
  formatBytes,
  formatDate,
  formatDecimal,
  formatLocalDate,
  formatLocalDateTime,
  formatMass,
} from '@agrotrace/i18n';
import { BatchCreateSchema } from '@agrotrace/validation';
import { canAccess } from '../app/access';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useFocusAfterWait,
  useDialogAlert,
} from '../app/api';
import { useDictionary } from '../app/dictionaries';
import { errorOf, FORM_GRID, normalizeDecimal, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { useCacheWriter, useScreenNavigate, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { momentCheck, momentDefaults, MomentInput, momentWire } from '../app/MomentInput';
import { DateFilter } from '../app/DateFilter';
import { LAB_STATUS_TONE } from '../app/labTests';
import { OrgPicker } from '../app/OrgPicker';
import { CABINET_ROUTES } from '../app/routes';
import { useMe, useSession } from '../app/session';
import { BatchGraphView } from '../graph/BatchGraph';
import {
  AreaLoading,
  Avatar,
  Button,
  ButtonAnchor,
  ButtonLink,
  Card,
  CardBody,
  CardFacts,
  CardFooter,
  CardHeader,
  Chip,
  Dialog,
  DialogMessage,
  Empty,
  Field,
  InputGroup,
  ListChanged,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Select,
  Table,
  TablePrimary,
  Tabs,
  Timeline,
  type Column,
  type Tone,
} from '../ui';

type Batch = Schemas['Batch'];
type BatchItem = Schemas['BatchListItem'];
type BatchStatus = Schemas['BatchStatus'];
const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const producedOf = (b: BatchItem) => b.harvestedAt ?? b.producedAt;

const BATCHES_SPEC: ListSpec = {
  sort: ['publicCode', 'massKg', 'updatedAt', 'harvestedAt', 'producedAt'],
  enums: { status: BATCH_STATUSES, kind: ['RAW', 'DERIVED'], holder: ['me'], origin: ['me'] },
  uuids: ['productId', 'orgId'],
  dates: ['from', 'to'],
  texts: ['q'],
};
const SEVERAL = '__several';

export const STATUS_TONE: Record<BatchStatus, Tone> = {
  Created: 'neutral',
  OnTest: 'attention',
  Approved: 'ok',
  InTransit: 'move',
  Accepted: 'ok',
  OnSale: 'ok',
  Processed: 'neutral',
  Sold: 'neutral',
  Blocked: 'danger',
  Recalled: 'danger-solid',
  WrittenOff: 'neutral',
};

function useViewer() {
  const me = useMe();
  const has = (r: string) => me.roles.some((x) => x === r);
  return {
    me,
    farmer: has('FARMER'),
    overseer: has('INSPECTOR') || has('ADMIN'),
    inspector: has('INSPECTOR'),
    participant: has('FARMER') || has('PROCESSOR') || has('RETAILER'),
    may: (href: string) => {
      const path = href.split('?')[0]!;
      const route = CABINET_ROUTES.find((r) => matchPath(r.path, path));
      return Boolean(route && canAccess(me, route.access));
    },
  };
}

function Org({ org }: { org: Schemas['OrganizationRef'] }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
      <Avatar
        name={org.name}
        src={org.logoUrl ? withVariant(org.logoUrl, 96) : null}
        size="s"
        shape="square"
        decorative
      />
      {org.name}
    </span>
  );
}

export function BatchesPage() {
  const { api } = useSession();
  const { farmer, overseer, participant } = useViewer();
  const list = useListParams('/batches', BATCHES_SPEC);
  const products = useDictionary('products');
  const q = list.get('q');
  const status = list.params.getAll('status');
  const productId = list.get('productId');
  const kind = list.get('kind');
  const holder = participant ? list.get('holder') : '';
  const origin = participant ? list.get('origin') : '';
  const orgId = overseer ? list.get('orgId') : '';
  const from = list.get('from');
  const to = list.get('to');
  const sort = list.sort;
  const filters = { status, productId, kind, holder, origin, orgId, from, to };
  const count =
    (status.length ? 1 : 0) + [productId, kind, holder, origin, orgId, from, to].filter(Boolean).length;

  const query = useQuery({
    queryKey: ['batches', { page: list.page, sort: list.params.get('sort'), q, ...filters }],
    meta: { failed: 'batches.failed' },
    queryFn: () =>
      call<Schemas['BatchPage']>(
        api.GET('/batches', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(status.length ? { status: status as BatchStatus[] } : {}),
              ...(productId ? { productId } : {}),
              ...(kind ? { kind: kind as Schemas['BatchKind'] } : {}),
              ...(holder ? { holder: holder as 'me' | 'all' } : {}),
              ...(origin ? { origin: origin as 'me' | 'all' } : {}),
              ...(orgId ? { orgId } : {}),
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
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && query.data.items.length === 0 && query.data.total > 0)
      clampPage(query.data.total, SIZE);
  }, [query.data, clampPage]);
  const producedSort = kind === 'DERIVED' ? 'producedAt' : kind === 'RAW' ? 'harvestedAt' : undefined;

  const columns: Column<BatchItem>[] = [
    {
      key: 'code',
      header: t('batches.code'),
      primary: true,
      sortField: 'publicCode',
      cell: (b) => <TablePrimary to={`/batches/${b.id}`} code={b.publicCode} sub={b.product.name} />,
    },
    { key: 'status', header: t('batches.status'), status: true, cell: (b) => <Chip status={b.status} /> },
    {
      key: 'mass',
      header: t('batches.mass'),
      numeric: true,
      sortField: 'massKg',
      cell: (b) => formatDecimal(b.massKg, LOCALE),
    },
    { key: 'holder', header: t('batches.holder'), cell: (b) => b.holder.name },
    {
      key: 'produced',
      header: t('batches.producedOn'),
      sortField: producedSort,
      cell: (b) => {
        const at = producedOf(b);
        return at ? formatLocalDate(at, LOCALE) : '—';
      },
    },
    {
      key: 'updated',
      header: t('batches.updatedAt'),
      sortField: 'updatedAt',
      cell: (b) => formatLocalDateTime(b.updatedAt, LOCALE),
    },
  ];

  const reset = list.reset;

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('batches.failed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
          onReset={isBadListQuery(query.error) ? reset : undefined}
        />
      );
    if (!query.data) return <AreaLoading />;
    const gap = listGap(query.data, list.page, SIZE);
    if (gap === 'pastEnd') return <AreaLoading />;
    if (gap === 'changed')
      return <ListChanged busy={query.isFetching} onReload={() => void query.refetch()} />;
    if (items.length === 0)
      return (
        <Card>
          {q || count ? (
            <Empty
              art="empty-search"
              text={t('empty.search')}
              action={
                <Button variant="primary" onClick={reset}>
                  {t('filters.reset')}
                </Button>
              }
            />
          ) : (
            <Empty
              art="empty-batches"
              text={t('empty.batches')}
              action={
                <ButtonLink variant="primary" to={farmer ? '/batches/new' : '/'}>
                  {farmer ? t('action.createBatch') : t('action.home')}
                </ButtonLink>
              }
            />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <Table
          cards
          caption={t('page.batches')}
          columns={columns}
          rows={items}
          rowKey={(b) => b.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'updatedAt,desc', label: t('batches.sort.updated') },
            { value: 'publicCode,asc', label: t('batches.sort.code') },
            { value: 'massKg,desc', label: t('batches.sort.massDesc') },
            { value: 'massKg,asc', label: t('batches.sort.massAsc') },
            ...(producedSort
              ? [{ value: `${producedSort},desc`, label: t('batches.sort.producedDesc') }]
              : []),
          ]}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page
      title={t('page.batches')}
      actions={
        farmer && (
          <ButtonLink variant="primary" icon="plus" to="/batches/new">
            {t('action.createBatch')}
          </ButtonLink>
        )
      }
    >
      <PageToolbar
        search={{
          label: t('batches.search'),
          placeholder: t('batches.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-status" label={t('batches.status')}>
              <Select
                value={status.length === 1 ? status[0] : status.length > 1 ? SEVERAL : ''}
                onChange={(e) => list.set({ status: e.target.value })}
              >
                <option value="">{t('filters.any')}</option>
                {status.length > 1 && (
                  <option value={SEVERAL} disabled>
                    {t('filters.several', { count: status.length })}
                  </option>
                )}
                {BATCH_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {enumLabel(t, 'BatchStatus', s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="filter-product" label={t('batches.product')}>
              <Select value={productId} onChange={(e) => list.set({ productId: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {(products.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="filter-kind" label={t('batches.kind')}>
              <Select value={kind} onChange={(e) => list.set({ kind: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {(['RAW', 'DERIVED'] as const).map((k) => (
                  <option key={k} value={k}>
                    {enumLabel(t, 'BatchKind', k)}
                  </option>
                ))}
              </Select>
            </Field>
            {participant && (
              <>
                <Field id="filter-holder" label={t('batches.holder')}>
                  <Select value={holder} onChange={(e) => list.set({ holder: e.target.value })}>
                    <option value="">{enumLabel(t, 'param:holder', 'all')}</option>
                    <option value="me">{enumLabel(t, 'param:holder', 'me')}</option>
                  </Select>
                </Field>
                <Field id="filter-origin" label={t('batches.origin')}>
                  <Select value={origin} onChange={(e) => list.set({ origin: e.target.value })}>
                    <option value="">{enumLabel(t, 'param:origin', 'all')}</option>
                    <option value="me">{enumLabel(t, 'param:origin', 'me')}</option>
                  </Select>
                </Field>
              </>
            )}
            {overseer && (
              <OrgPicker
                id="filter-org"
                label={t('batches.organization')}
                value={orgId}
                onChange={(id) => list.set({ orgId: id })}
              />
            )}
            <DateFilter
              id="filter-from"
              label={t('batches.from')}
              value={from}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="filter-to"
              label={t('batches.to')}
              value={to}
              min={from || undefined}
              onChange={(v) => list.set({ to: v })}
            />
          </>
        }
      />
      {content()}
    </Page>
  );
}

interface BatchValues {
  fieldId: string;
  productId: string;
  massKg: string;
  harvestedAt: string | null;
  harvestTime: string;
  original: string | null;
}
const BATCH_FIELDS = ['fieldId', 'productId', 'massKg', 'harvestedAt', 'harvestTime'] as const;

const harvest = (v: BatchValues) => ({ date: v.harvestedAt, time: v.harvestTime, original: v.original });
const batchSchema = wireSchema<BatchValues>(
  BatchCreateSchema,
  (v) => ({
    fieldId: v.fieldId,
    productId: v.productId,
    massKg: normalizeDecimal(v.massKg, 3),
    harvestedAt: momentWire(harvest(v)),
  }),
  (v) => momentCheck(harvest(v), 'harvestedAt', 'harvestTime'),
);

export function BatchNewPage() {
  const { api } = useSession();
  const products = useDictionary('products');
  const fields = useQuery({
    queryKey: ['fields', 'all'],
    meta: { failed: 'batches.formFailed' },
    queryFn: () =>
      call<Schemas['FieldPage']>(api.GET('/fields', { params: { query: { size: 100, sort: 'name,asc' } } })),
    retry: retryTransient,
  });
  const failed = (!fields.data && fields.isError) || (!products.data && products.isError);
  return (
    <Page title={t('page.batchNew')}>
      {fields.data && fields.data.items.length === 0 ? (
        <Card>
          <Empty
            art="empty-fields"
            text={t('empty.fields')}
            action={
              <ButtonLink variant="primary" to="/fields/new">
                {t('fields.add')}
              </ButtonLink>
            }
          />
        </Card>
      ) : failed ? (
        <LoadFailed
          text={t('batches.formFailed')}
          busy={fields.isFetching || products.isFetching}
          onRetry={() => {
            void fields.refetch();
            void products.refetch();
          }}
        />
      ) : fields.data && products.data ? (
        <BatchNewForm
          fields={fields.data.items}
          products={products.data.filter((p) => p.category !== 'PROCESSED')}
        />
      ) : (
        <AreaLoading />
      )}
    </Page>
  );
}

function BatchNewForm({ fields, products }: { fields: Schemas['Field'][]; products: Schemas['Product'][] }) {
  const { api } = useSession();
  const [params] = useSearchParams();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const wanted = params.get('fieldId') ?? '';
  const at = momentDefaults(null);
  const { form, alert, wait, fail } = useSchemaForm<BatchValues>(
    batchSchema,
    {
      fieldId: fields.some((f) => f.id === wanted) ? wanted : '',
      productId: '',
      massKg: '',
      harvestedAt: at.date,
      harvestTime: at.time,
      original: null,
    },
    BATCH_FIELDS,
  );
  const [busy, setBusy] = useState(false);
  const submit = form.handleSubmit(async (values) => {
    const body = values as unknown as Schemas['BatchCreate'];
    alert.clear();
    setBusy(true);
    try {
      const batch = await call<Batch>(api.POST('/batches', { body }));
      cache.set(['batch', batch.id], batch);
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['fields'] });
      toast.done(
        batch.testRequired
          ? {
              tone: 'attention',
              text: t('batches.createdTest', {
                code: batch.publicCode,
                reason: enumLabel(t, 'TestReason', batch.testReason),
              }),
            }
          : { tone: 'ok', text: t('batches.createdNoTest', { code: batch.publicCode }) },
      );
      navigate(`/batches/${batch.id}`);
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'NO_LAB_AVAILABLE') alert.show(t('batches.noLab'));
      else fail(e);
    } finally {
      setBusy(false);
    }
  });

  return (
    <Card style={{ maxWidth: '40rem' }}>
      <CardBody>
        <form id="batch-new" noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
          <Field id="batch-field" label={t('field.fieldId')} error={errorOf(form, 'fieldId')}>
            <Select {...form.register('fieldId')}>
              <option value="" disabled>
                {t('ui.choose')}
              </option>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="batch-product" label={t('field.productId')} error={errorOf(form, 'productId')}>
            <Select {...form.register('productId')}>
              <option value="" disabled>
                {t('ui.choose')}
              </option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="batch-mass" label={t('batches.massValue')} error={errorOf(form, 'massKg')}>
            <InputGroup
              suffix={t('unit.kg')}
              inputMode="decimal"
              autoComplete="off"
              {...form.register('massKg')}
            />
          </Field>
          <MomentInput
            form={form}
            id="batch-harvested"
            dateName="harvestedAt"
            timeName="harvestTime"
            dateLabel={t('field.harvestedAt')}
            timeLabel={t('batches.harvestTime')}
          />
          <div>
            <Submit busy={busy} wait={wait}>
              {t('action.createBatch')}
            </Submit>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

const TABS = ['history', 'path', 'graph', 'tests', 'docs'] as const;
type Tab = (typeof TABS)[number];

const ACTION_TARGET: Record<string, (b: Batch) => string> = {
  ship: (b) => `/waybills/new?batchId=${b.id}`,
  accept: () => '/waybills?direction=incoming',
  reject: () => '/waybills?direction=incoming',
  process: (b) => `/processing/new?batchId=${b.id}`,
  putOnSale: () => '/stock',
  sell: () => '/stock',
  recall: (b) => `/recalls/new?batchId=${b.id}`,
  writeOff: () => '/recall-tasks',
};

export function BatchPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const viewer = useViewer();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'history';
  const [assigning, setAssigning] = useState(false);
  const showTab = (next: Tab) =>
    setParams(
      (cur) => {
        const n = new URLSearchParams(cur);
        if (next === 'history') n.delete('tab');
        else n.set('tab', next);
        return n;
      },
      { replace: true },
    );

  const query = useQuery({
    queryKey: ['batch', id],
    meta: { failed: 'batches.failed' },
    queryFn: () => call<Batch>(api.GET('/batches/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const batch = query.data;

  if (!batch && notFound(query.error))
    return (
      <Page title={t('page.batch')}>
        <Card>
          <Empty
            art="not-found"
            text={t('batches.notFound')}
            action={
              viewer.may('/batches') ? (
                <ButtonLink variant="primary" to="/batches">
                  {t('batches.toList')}
                </ButtonLink>
              ) : (
                <ButtonLink variant="primary" to="/">
                  {t('action.home')}
                </ButtonLink>
              )
            }
          />
        </Card>
      </Page>
    );

  const actions = (batch?.actions ?? [])
    .map((a) => ({ a, href: ACTION_TARGET[a.action]?.(batch!) }))
    .filter((x): x is { a: Schemas['BatchAction']; href: string } => Boolean(x.href && viewer.may(x.href)));

  return (
    <Page
      title={batch?.publicCode ?? t('page.batch')}
      actions={
        batch &&
        (actions.length > 0 || viewer.inspector) && (
          <>
            {actions.map(({ a, href }, i) => (
              <ButtonLink key={a.action} variant={i === 0 ? 'primary' : 'secondary'} to={href}>
                {enumLabel(t, 'BatchActionName', a.action)}
              </ButtonLink>
            ))}
            {viewer.inspector && (
              <Button variant="secondary" icon="flask" onClick={() => setAssigning(true)}>
                {t('lab.assign')}
              </Button>
            )}
          </>
        )
      }
    >
      {!batch && query.isError ? (
        <LoadFailed text={t('batches.failed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
      ) : !batch ? (
        <AreaLoading />
      ) : (
        <div style={GAP}>
          <BatchSummary batch={batch} fieldLink={viewer.may('/fields/x')} />
          <Tabs
            label={t('batches.tabs', { code: batch.publicCode })}
            tabs={TABS.map((id) => ({ id, label: t(`batches.tab.${id}`) }))}
            selected={tab}
            onSelect={(next) => showTab(next as Tab)}
            panel={(which) => {
              switch (which as Tab) {
                case 'history':
                  return <HistoryTab id={batch.id} />;
                case 'path':
                  return <PathTab id={batch.id} />;
                case 'graph':
                  return <GraphTab batch={batch} />;
                case 'tests':
                  return <TestsTab id={batch.id} labLinks={viewer.may('/lab/tests/x')} />;
                case 'docs':
                  return <DocsTab batch={batch} />;
              }
            }}
          />
        </div>
      )}
      {batch && viewer.inspector && (
        <AssignLabDialog
          open={assigning}
          batch={batch}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            showTab('tests');
          }}
        />
      )}
    </Page>
  );
}

function AssignLabDialog({
  open,
  batch,
  onClose,
  onDone,
}: {
  open: boolean;
  batch: Batch;
  onClose: () => void;
  onDone: () => void;
}) {
  const { api } = useSession();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const [labOrgId, setLabOrgId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const failure = useDialogAlert();
  const { clear: clearFailure } = failure;
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const confirmRef = useFocusAfterWait(wait);
  useEffect(() => {
    if (open) return;
    setLabOrgId('');
    setError(null);
    clearFailure();
  }, [open, clearFailure]);
  const assign = async () => {
    if (!labOrgId) return setError(t('validation.required'));
    setBusy(true);
    failure.clear();
    try {
      const test = await call<Schemas['LabTest']>(
        api.POST('/lab-tests', { body: { batchId: batch.id, labOrgId } }),
      );
      void queryClient.invalidateQueries({ queryKey: ['batch', batch.id, 'tests'] });
      toast.done({ tone: 'ok', text: t('lab.assigned', { code: batch.publicCode, lab: test.lab.name }) });
      onDone();
    } catch (e) {
      const key = e instanceof ApiProblem && e.code === 'VALIDATION' ? e.errors?.labOrgId?.[0] : undefined;
      if (key) setError(t(key));
      else {
        if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
        failure.show(errorText(e), errorTone(e));
      }
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    failure.handOff();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('lab.assignTitle', { code: batch.publicCode })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="primary"
            busy={busy}
            disabled={wait > 0}
            onClick={() => void assign()}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('lab.assign')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <DialogMessage text={failure.message} />
        <OrgPicker
          id="assign-lab"
          label={t('field.labOrgId')}
          types={['LAB']}
          value={labOrgId}
          error={error}
          onChange={(id) => {
            setLabOrgId(id ?? '');
            setError(null);
          }}
        />
      </div>
    </Dialog>
  );
}

function BatchSummary({ batch, fieldLink }: { batch: Batch; fieldLink: boolean }) {
  const facts = [
    { key: 'product', term: t('batches.product'), value: batch.product.name },
    { key: 'mass', term: t('batches.massValue'), value: formatMass(batch.massKg, LOCALE) },
    { key: 'holder', term: t('batches.holder'), value: <Org org={batch.holder} /> },
    ...(batch.origin.id !== batch.holder.id
      ? [{ key: 'origin', term: t('batches.origin'), value: <Org org={batch.origin} /> }]
      : []),
    ...(batch.field
      ? [
          {
            key: 'field',
            term: t('batches.field'),
            value: fieldLink ? (
              <Link to={`/fields/${batch.field.id}`}>{batch.field.name}</Link>
            ) : (
              batch.field.name
            ),
          },
        ]
      : []),
    batch.harvestedAt
      ? { key: 'date', term: t('batches.harvestedAt'), value: formatLocalDateTime(batch.harvestedAt, LOCALE) }
      : {
          key: 'date',
          term: t('batches.producedAt'),
          value: batch.producedAt ? formatLocalDateTime(batch.producedAt, LOCALE) : '—',
        },
    { key: 'kind', term: t('batches.kind'), value: enumLabel(t, 'BatchKind', batch.kind) },
    ...(batch.kind === 'RAW'
      ? [{ key: 'test', term: t('batches.test'), value: enumLabel(t, 'TestReason', batch.testReason) }]
      : []),
  ];
  return (
    <Card>
      <CardHeader title={batch.product.name}>
        <Chip status={batch.status} size="l" />
      </CardHeader>
      <CardBody>
        <div style={{ display: 'flex', gap: 'var(--sp-5)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {batch.product.imageUrl && (
            <Avatar
              name={batch.product.name}
              src={withVariant(batch.product.imageUrl, 96)}
              size="l"
              shape="square"
              decorative
            />
          )}
          <div style={{ flex: '1 1 16rem', minWidth: 0 }}>
            <CardFacts facts={facts} />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function TabFailed({ text, busy, onRetry }: { text: string; busy: boolean; onRetry: () => void }) {
  return <LoadFailed text={text} busy={busy} onRetry={onRetry} />;
}

function HistoryTab({ id }: { id: string }) {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['batch', id, 'history'],
    meta: { failed: 'batches.historyFailed' },
    queryFn: () =>
      call<Schemas['StatusHistoryItem'][]>(api.GET('/batches/{id}/history', { params: { path: { id } } })),
    retry: retryTransient,
  });
  if (!query.data && query.isError)
    return (
      <TabFailed
        text={t('batches.historyFailed')}
        busy={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return <AreaLoading blocks={1} />;
  return (
    <Card>
      <CardBody>
        <Timeline
          items={query.data.map((h, i) => ({
            key: `${i}`,
            at: h.changedAt,
            atText: formatLocalDateTime(h.changedAt, LOCALE),
            title: enumLabel(t, 'BatchStatus', h.to),
            tone: STATUS_TONE[h.to],
            meta: (
              <>
                {h.changedBy && (
                  <Avatar
                    name={h.changedBy.fullName}
                    src={h.changedBy.avatarUrl ? withVariant(h.changedBy.avatarUrl, 96) : null}
                    size="s"
                    decorative
                  />
                )}
                {enumLabel(t, 'BatchStatusReason', h.reason)}, {h.changedBy?.fullName ?? t('batches.system')}
              </>
            ),
          }))}
        />
      </CardBody>
    </Card>
  );
}

function PathTab({ id }: { id: string }) {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['batch', id, 'path'],
    meta: { failed: 'batches.pathFailed' },
    queryFn: () => call<Schemas['PathStep'][]>(api.GET('/batches/{id}/path', { params: { path: { id } } })),
    retry: retryTransient,
  });
  if (!query.data && query.isError)
    return (
      <TabFailed
        text={t('batches.pathFailed')}
        busy={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return <AreaLoading blocks={1} />;
  return (
    <Card>
      <CardBody>
        <Timeline
          items={query.data.map((s, i) => ({
            key: `${i}`,
            at: s.from,
            atText: s.to
              ? t('batches.period', {
                  from: formatLocalDate(s.from, LOCALE),
                  to: formatLocalDate(s.to, LOCALE),
                })
              : t('batches.since', { date: formatLocalDate(s.from, LOCALE) }),
            title: s.org.name,
            meta: (
              <>
                <Avatar
                  name={s.org.name}
                  src={s.org.logoUrl ? withVariant(s.org.logoUrl, 96) : null}
                  size="s"
                  shape="square"
                  decorative
                />
                {enumLabel(t, 'OrganizationType', s.org.type)}
                {s.waybillNumber && (
                  <>
                    {', '}
                    {t('batches.byWaybill', { number: s.waybillNumber })}
                  </>
                )}
              </>
            ),
          }))}
        />
      </CardBody>
    </Card>
  );
}

type GraphNode = Schemas['BatchGraph']['nodes'][number];

function GraphTab({ batch }: { batch: Batch }) {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['batch', batch.id, 'graph'],
    meta: { failed: 'graph.failed' },
    queryFn: () =>
      call<Schemas['BatchGraph']>(
        api.GET('/batches/{id}/graph', { params: { path: { id: batch.id }, query: { depth: 2 } } }),
      ),
    retry: retryTransient,
  });
  if (!query.data && query.isError)
    return (
      <TabFailed text={t('graph.failed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
    );
  if (!query.data) return <AreaLoading blocks={1} />;
  const graph = query.data;
  const relation = (n: GraphNode) =>
    n.depth === 0
      ? t('graph.root')
      : n.depth < 0
        ? t('graph.up', { level: -n.depth })
        : t('graph.down', { level: n.depth });
  const columns: Column<GraphNode>[] = [
    {
      key: 'code',
      header: t('batches.code'),
      primary: true,
      cell: (n) =>
        n.accessible && n.id !== batch.id ? (
          <TablePrimary to={`/batches/${n.id}?tab=graph`} code={n.publicCode} sub={n.product.name} />
        ) : n.accessible ? (
          <span className="at-table__primary">
            <span className="at-mono">{n.publicCode}</span>
            <span className="at-table__sub">{n.product.name}</span>
          </span>
        ) : (
          <span className="at-table__primary">
            <a className="at-mono" href={`/p/${n.publicCode}`}>
              {n.publicCode}
            </a>
            <span className="at-table__sub">
              {n.product.name}, {t('graph.noAccess').toLocaleLowerCase('ru')}
            </span>
          </span>
        ),
    },
    { key: 'status', header: t('batches.status'), status: true, cell: (n) => <Chip status={n.status} /> },
    { key: 'holder', header: t('batches.holder'), cell: (n) => n.holder.name },
    { key: 'link', header: t('graph.link'), cell: relation },
    {
      key: 'used',
      header: t('graph.used'),
      numeric: true,
      cell: (n) => {
        const edge = graph.edges.find((e) => (n.depth < 0 ? e.parent === n.id : e.child === n.id));
        return n.depth !== 0 && edge ? formatDecimal(edge.massUsedKg, LOCALE) : '—';
      },
    },
  ];
  return (
    <div style={GAP}>
      <BatchGraphView graph={query.data} code={batch.publicCode} />
      <Table
        cards
        caption={t('graph.related')}
        columns={columns}
        rows={query.data.nodes}
        rowKey={(n) => n.id}
      />
    </div>
  );
}

function TestsTab({ id, labLinks }: { id: string; labLinks: boolean }) {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['batch', id, 'tests'],
    meta: { failed: 'labTests.failed' },
    queryFn: () =>
      call<Schemas['LabTestPage']>(
        api.GET('/lab-tests', { params: { query: { batchId: id, size: 100, sort: 'dueAt,asc' } } }),
      ),
    retry: retryTransient,
  });
  if (!query.data && query.isError)
    return (
      <TabFailed text={t('labTests.failed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
    );
  if (!query.data) return <AreaLoading blocks={1} />;
  if (query.data.items.length === 0)
    return (
      <Card>
        <Empty art="empty-lab" text={t('labTests.empty')} />
      </Card>
    );
  type Item = Schemas['LabTestListItem'];
  const columns: Column<Item>[] = [
    {
      key: 'lab',
      header: t('labTests.lab'),
      primary: true,
      cell: (x) => (
        <span className="at-table__primary">
          {labLinks ? <Link to={`/lab/tests/${x.id}`}>{x.lab.name}</Link> : <span>{x.lab.name}</span>}
          <span className="at-table__sub">{enumLabel(t, 'LabTestReason', x.reason)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('labTests.status'),
      status: true,
      cell: (x) => <Chip tone={LAB_STATUS_TONE[x.status]}>{enumLabel(t, 'LabTestStatus', x.status)}</Chip>,
    },
    {
      key: 'conclusion',
      header: t('labTests.conclusion'),
      cell: (x) =>
        x.conclusion ? (
          <Chip tone={x.conclusion === 'PASS' ? 'ok' : 'danger'}>
            {enumLabel(t, 'LabConclusion', x.conclusion)}
          </Chip>
        ) : (
          '—'
        ),
    },
    {
      key: 'due',
      header: t('labTests.dueAt'),
      cell: (x) => (
        <>
          {formatLocalDateTime(x.completedAt ?? x.dueAt, LOCALE)}
          {x.overdue && (
            <>
              {' '}
              <Chip tone="danger">{t('labTests.overdue')}</Chip>
            </>
          )}
        </>
      ),
    },
  ];
  return (
    <Table
      cards
      caption={t('batches.tab.tests')}
      columns={columns}
      rows={query.data.items}
      rowKey={(x) => x.id}
    />
  );
}

const VSD_TONE: Record<Schemas['VsdImportStatus'], Tone> = {
  PENDING: 'move',
  IMPORTED: 'ok',
  NOT_FOUND: 'attention',
  FAILED: 'danger',
};

function DocsTab({ batch }: { batch: Batch }) {
  const { api } = useSession();
  const me = useMe();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const key = ['batch', batch.id, 'documents'];
  const query = useQuery({
    queryKey: key,
    meta: { failed: 'documents.failed' },
    queryFn: () =>
      call<Schemas['BatchDocuments']>(
        api.GET('/batches/{id}/documents', { params: { path: { id: batch.id } } }),
      ),
    retry: retryTransient,
    refetchInterval: (q) => (q.state.data?.vsd?.importStatus === 'PENDING' ? 3000 : false),
  });
  const [retrying, setRetrying] = useState(false);
  const [wait, startWait] = useCountdown();
  const idempotency = useRef<string | null>(null);

  const holder =
    me.organization.id === batch.holder.id && me.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR');

  const retry = async () => {
    setRetrying(true);
    idempotency.current ??= newIdempotencyKey();
    try {
      const vsd = await call<Schemas['BatchVsd']>(
        api.POST('/batches/{id}/documents/vsd/retry', {
          params: { path: { id: batch.id }, header: { 'Idempotency-Key': idempotency.current } },
        }),
      );
      idempotency.current = null;
      cache.set<Schemas['BatchDocuments']>(key, (d) => (d ? { ...d, vsd } : d));
      toast.done({ tone: 'ok', text: t('documents.retried') });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      else if (e instanceof ApiProblem && e.status < 500) {
        idempotency.current = null;
        if (e.status === 409) void queryClient.invalidateQueries({ queryKey: key });
      }
      toast.push({ tone: errorTone(e), text: errorText(e) });
    } finally {
      setRetrying(false);
    }
  };

  if (!query.data && query.isError)
    return (
      <TabFailed text={t('documents.failed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
    );
  if (!query.data) return <AreaLoading blocks={1} />;
  const { vsd, labProtocols, qr } = query.data;
  if (!vsd && labProtocols.length === 0 && !qr)
    return (
      <Card>
        <Empty art="empty-batches" text={t('documents.empty')} />
      </Card>
    );

  const doc = vsd?.document;
  return (
    <div
      style={{
        ...GAP,
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
        alignItems: 'start',
      }}
    >
      {vsd && (
        <Card>
          <CardHeader title={t('documents.vsd')}>
            <Chip tone={VSD_TONE[vsd.importStatus]}>{enumLabel(t, 'VsdImportStatus', vsd.importStatus)}</Chip>
          </CardHeader>
          <CardBody>
            <CardFacts
              facts={
                doc
                  ? [
                      {
                        key: 'n',
                        term: t('documents.number'),
                        value: <span className="at-mono">{doc.number}</span>,
                      },
                      { key: 'd', term: t('documents.issueDate'), value: formatDate(doc.issueDate, LOCALE) },
                      {
                        key: 's',
                        term: t('documents.vsdStatus'),
                        value: enumLabel(t, 'VsdStatus', doc.status),
                      },
                      { key: 'p', term: t('documents.product'), value: doc.productName },
                      {
                        key: 'v',
                        term: t('documents.volume'),
                        value: `${formatDecimal(String(doc.volume.value), LOCALE)} ${doc.volume.unit}`,
                      },
                      { key: 'from', term: t('documents.consignor'), value: doc.consignor.name },
                      { key: 'to', term: t('documents.consignee'), value: doc.consignee.name },
                    ]
                  : [
                      { key: 'a', term: t('documents.attempts'), value: String(vsd.attempts) },
                      {
                        key: 'u',
                        term: t('batches.updatedAt'),
                        value: formatLocalDateTime(vsd.updatedAt, LOCALE),
                      },
                    ]
              }
            />
          </CardBody>
          {holder && (vsd.importStatus === 'NOT_FOUND' || vsd.importStatus === 'FAILED') && (
            <CardFooter>
              <Button variant="primary" busy={retrying} disabled={wait > 0} onClick={() => void retry()}>
                {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('documents.retry')}
              </Button>
            </CardFooter>
          )}
        </Card>
      )}
      {labProtocols.length > 0 && (
        <Card>
          <CardHeader title={t('documents.protocols')} />
          <CardBody>
            <ul style={{ display: 'grid', gap: 'var(--sp-4)', margin: 0, padding: 0, listStyle: 'none' }}>
              {labProtocols.map((p) => (
                <li key={p.labTestId} style={{ display: 'grid', gap: 'var(--sp-2)' }}>
                  <span>{p.lab.name}</span>
                  <span
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', alignItems: 'center' }}
                  >
                    {p.conclusion && (
                      <Chip tone={p.conclusion === 'PASS' ? 'ok' : 'danger'}>
                        {enumLabel(t, 'LabConclusion', p.conclusion)}
                      </Chip>
                    )}
                    {p.completedAt && formatLocalDate(p.completedAt, LOCALE)}
                  </span>
                  <span>
                    <ButtonAnchor size="s" icon="file-pdf" href={p.file.url} download={p.file.originalName}>
                      {p.file.originalName}, {formatBytes(p.file.sizeBytes, LOCALE)}
                    </ButtonAnchor>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
      {qr && (
        <Card>
          <CardHeader title={t('documents.qr')} />
          <CardBody>
            <CardFacts
              facts={[
                {
                  key: 'url',
                  term: t('documents.publicPage'),
                  value: (
                    <a href={qr.publicUrl} style={{ overflowWrap: 'anywhere' }}>
                      {qr.publicUrl}
                    </a>
                  ),
                },
              ]}
            />
          </CardBody>
          <CardFooter>
            <ButtonAnchor icon="download" href={qr.pngUrl} download={`${batch.publicCode}.png`}>
              {t('documents.png')}
            </ButtonAnchor>
            <ButtonAnchor icon="file-pdf" href={qr.pdfUrl} download={`${batch.publicCode}.pdf`}>
              {t('documents.pdf')}
            </ButtonAnchor>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
