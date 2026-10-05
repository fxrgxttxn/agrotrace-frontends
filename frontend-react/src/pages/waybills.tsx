import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { checkDiscrepancy, compareDecimalStrings, gramsToKg, kgToGrams } from '@agrotrace/domain';
import { enumLabel, formatDecimal, formatLocalDateTime, formatPercent } from '@agrotrace/i18n';
import { WaybillAcceptSchema, WaybillCreateSchema, WaybillRejectSchema } from '@agrotrace/validation';
import {
  applyProblem,
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useFocusAfterWait,
  useDialogAlert,
  useFormAlert,
} from '../app/api';
import { DateFilter } from '../app/DateFilter';
import { errorOf, focusFirstInvalid, FORM_GRID, normalizeDecimal, Submit } from '../app/forms';
import { useCacheWriter, useScreenNavigate, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { useIdempotency } from '../app/idempotency';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { OrgPicker } from '../app/OrgPicker';
import { useMe, useSession } from '../app/session';
import {
  AreaLoading,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFacts,
  CardFooter,
  CardHeader,
  CellField,
  Chip,
  Dialog,
  DialogMessage,
  Empty,
  Field,
  Input,
  InputGroup,
  ListChanged,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Select,
  Table,
  TablePrimary,
  Textarea,
  type Column,
  type Tone,
} from '../ui';

type Waybill = Schemas['Waybill'];
type WaybillStatus = Schemas['WaybillStatus'];
type BatchItem = Schemas['BatchListItem'];
const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;
const WAYBILL_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
const SEVERAL = '__several';

export const WAYBILL_TONE: Record<WaybillStatus, Tone> = {
  DRAFT: 'neutral',
  SENT: 'move',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
};

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;

const PARTICIPANT_SPEC: ListSpec = {
  sort: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  enums: { status: WAYBILL_STATUSES, direction: ['incoming', 'outgoing'] },
  dates: ['from', 'to'],
  texts: ['q'],
};
const OVERSEER_SPEC: ListSpec = {
  sort: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  enums: { status: WAYBILL_STATUSES },
  uuids: ['counterpartyOrgId'],
  dates: ['from', 'to'],
  texts: ['q'],
};

function useRoles() {
  const me = useMe();
  const has = (r: string) => me.roles.some((x) => x === r);
  return {
    me,
    sender: has('FARMER') || has('PROCESSOR'),
    overseer: !(has('FARMER') || has('PROCESSOR') || has('RETAILER')),
  };
}

function totalKg(masses: string[]): string {
  return gramsToKg(masses.reduce((s, m) => s + kgToGrams(m), 0n));
}

const massText = (kg: string) => (LOCALE === 'ru' ? kg.replace('.', ',') : kg);

function StatusChip({ status, size }: { status: WaybillStatus; size?: 'l' }) {
  return (
    <Chip tone={WAYBILL_TONE[status]} size={size}>
      {enumLabel(t, 'WaybillStatus', status)}
    </Chip>
  );
}

export function WaybillsPage() {
  const { api } = useSession();
  const { sender, overseer } = useRoles();
  const list = useListParams('/waybills', overseer ? OVERSEER_SPEC : PARTICIPANT_SPEC);
  const q = list.get('q');
  const status = list.params.getAll('status');
  const direction = overseer ? '' : list.get('direction');
  const counterpartyOrgId = overseer ? list.get('counterpartyOrgId') : '';
  const from = list.get('from');
  const to = list.get('to');
  const sort = list.sort;
  const count = (status.length ? 1 : 0) + [direction, counterpartyOrgId, from, to].filter(Boolean).length;

  const query = useQuery({
    queryKey: [
      'waybills',
      { page: list.page, sort: list.params.get('sort'), q, status, direction, counterpartyOrgId, from, to },
    ],
    meta: { failed: 'waybills.failed' },
    queryFn: () =>
      call<Schemas['WaybillPage']>(
        api.GET('/waybills', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(status.length ? { status: status as WaybillStatus[] } : {}),
              ...(direction ? { direction: direction as 'incoming' | 'outgoing' } : {}),
              ...(counterpartyOrgId ? { counterpartyOrgId } : {}),
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

  const columns: Column<Waybill>[] = [
    {
      key: 'number',
      header: t('waybills.number'),
      primary: true,
      sortField: 'number',
      cell: (w) => (
        <TablePrimary
          to={`/waybills/${w.id}`}
          code={w.number}
          sub={t('count.batches', { count: w.items.length })}
        />
      ),
    },
    {
      key: 'status',
      header: t('waybills.status'),
      status: true,
      cell: (w) => <StatusChip status={w.status} />,
    },
    { key: 'sender', header: t('waybills.sender'), cell: (w) => w.sender.name },
    { key: 'receiver', header: t('waybills.receiver'), cell: (w) => w.receiver.name },
    {
      key: 'mass',
      header: t('waybills.mass'),
      numeric: true,
      cell: (w) => formatDecimal(totalKg(w.items.map((i) => i.massDeclaredKg)), LOCALE),
    },
    {
      key: 'created',
      header: t('waybills.createdAt'),
      sortField: 'createdAt',
      cell: (w) => formatLocalDateTime(w.createdAt, LOCALE),
    },
    {
      key: 'sent',
      header: t('waybills.sentAt'),
      sortField: 'sentAt',
      cell: (w) => (w.sentAt ? formatLocalDateTime(w.sentAt, LOCALE) : '—'),
    },
  ];

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('waybills.failed')}
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
          {q || count ? (
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
            <Empty
              art="empty-waybills"
              text={t('empty.waybills')}
              action={
                <ButtonLink variant="primary" to={sender ? '/waybills/new' : '/'}>
                  {sender ? t('action.createWaybill') : t('action.home')}
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
          caption={t('page.waybills')}
          columns={columns}
          rows={items}
          rowKey={(w) => w.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'createdAt,desc', label: t('waybills.sort.created') },
            { value: 'number,asc', label: t('waybills.sort.number') },
            { value: 'sentAt,desc', label: t('waybills.sort.sent') },
            { value: 'acceptedAt,desc', label: t('waybills.sort.accepted') },
          ]}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page
      title={t('page.waybills')}
      actions={
        sender && (
          <ButtonLink variant="primary" icon="plus" to="/waybills/new">
            {t('action.createWaybill')}
          </ButtonLink>
        )
      }
    >
      <PageToolbar
        search={{
          label: t('waybills.search'),
          placeholder: t('waybills.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            {!overseer && (
              <Field id="filter-direction" label={t('waybills.direction')}>
                <Select value={direction} onChange={(e) => list.set({ direction: e.target.value })}>
                  <option value="">{t('filters.any')}</option>
                  <option value="incoming">{t('waybillDirection.incoming')}</option>
                  <option value="outgoing">{t('waybillDirection.outgoing')}</option>
                </Select>
              </Field>
            )}
            <Field id="filter-status" label={t('waybills.status')}>
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
                {WAYBILL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {enumLabel(t, 'WaybillStatus', s)}
                  </option>
                ))}
              </Select>
            </Field>
            {overseer && (
              <OrgPicker
                id="filter-counterparty"
                label={t('waybills.counterparty')}
                value={counterpartyOrgId}
                onChange={(id) => list.set({ counterpartyOrgId: id })}
              />
            )}
            <DateFilter
              id="filter-from"
              label={t('waybills.from')}
              value={from}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="filter-to"
              label={t('waybills.to')}
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

function useShippable() {
  const { api } = useSession();
  return useQuery({
    queryKey: ['batches', 'shippable'],
    meta: { failed: 'waybills.formFailed' },
    queryFn: () =>
      call<Schemas['BatchPage']>(
        api.GET('/batches', {
          params: {
            query: { holder: 'me', status: ['Approved', 'Accepted'], size: 100, sort: 'publicCode,asc' },
          },
        }),
      ),
    retry: retryTransient,
  });
}

export function WaybillNewPage() {
  const stock = useShippable();
  return (
    <Page title={t('page.waybillNew')}>
      {!stock.data && stock.isError ? (
        <LoadFailed
          text={t('waybills.formFailed')}
          busy={stock.isFetching}
          onRetry={() => void stock.refetch()}
        />
      ) : !stock.data ? (
        <AreaLoading />
      ) : stock.data.items.length === 0 ? (
        <Card>
          <Empty
            art="empty-batches"
            text={t('waybills.noStock')}
            action={
              <ButtonLink variant="primary" to="/batches">
                {t('batches.toList')}
              </ButtonLink>
            }
          />
        </Card>
      ) : (
        <WaybillNewForm batches={stock.data.items} />
      )}
    </Page>
  );
}

interface NewValues {
  receiverOrgId: string;
  picked: string[];
  mass: Record<string, string>;
}

type Issue = { path: (string | number)[]; message: string };
type FieldError = { type: string; message: string };
const fieldError = (message: string): FieldError => ({ type: 'validate', message });

function WaybillNewForm({ batches }: { batches: BatchItem[] }) {
  const { api } = useSession();
  const { me } = useRoles();
  const [params] = useSearchParams();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const alert = useFormAlert();
  const idempotent = useIdempotency();
  const wanted = params.get('batchId') ?? '';
  const byId = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);
  const toBody = (v: NewValues) => ({
    receiverOrgId: v.receiverOrgId,
    items: batches
      .filter((b) => v.picked.includes(b.id))
      .map((b) => ({ batchId: b.id, massDeclaredKg: normalizeDecimal(v.mass[b.id] ?? '', 3) })),
  });

  const resolver: Resolver<NewValues> = async (values) => {
    const errors: FieldErrors<NewValues> = {};
    const mass: Record<string, FieldError> = {};
    const body = toBody(values);
    if (!values.receiverOrgId) errors.receiverOrgId = fieldError('validation.required');
    if (body.items.length === 0) errors.picked = fieldError('waybills.chooseItems');
    for (const item of body.items)
      if ((values.mass[item.batchId] ?? '').trim() === '')
        mass[item.batchId] = fieldError('validation.required');
    const res = WaybillCreateSchema.safeParse({ ...body, receiverOrgId: body.receiverOrgId || undefined });
    for (const issue of (res.success ? [] : res.error.issues) as Issue[]) {
      const [head, index, leaf] = issue.path;
      if (head === 'items' && typeof index === 'number' && leaf)
        mass[body.items[index]!.batchId] ??= fieldError(issue.message);
      else if (head === 'receiverOrgId') errors.receiverOrgId ??= fieldError(issue.message);
    }
    for (const item of body.items) {
      const batch = byId.get(item.batchId);
      if (!mass[item.batchId] && batch && compareDecimalStrings(item.massDeclaredKg, batch.massKg) > 0)
        mass[item.batchId] = fieldError('validation.mass.exceedsBatch');
    }
    if (Object.keys(mass).length) errors.mass = mass as never;
    return Object.keys(errors).length ? { values: {}, errors } : { values, errors: {} };
  };

  const form = useForm<NewValues>({
    resolver,
    defaultValues: {
      receiverOrgId: '',
      picked: byId.has(wanted) ? [wanted] : [],
      mass: Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)])),
    },
    shouldFocusError: false,
  });
  const picked = form.watch('picked');
  const receiverOrgId = form.watch('receiverOrgId');
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const sentIds = useRef<string[]>([]);

  const formRef = useRef<HTMLFormElement>(null);
  const submit = form.handleSubmit(
    async (values) => {
      const body = toBody(values) as Schemas['WaybillCreate'];
      sentIds.current = body.items.map((i) => i.batchId);
      alert.clear();
      setBusy(true);
      try {
        const waybill = await idempotent(body, (key) =>
          call<Waybill>(api.POST('/waybills', { params: { header: { 'Idempotency-Key': key } }, body })),
        );
        cache.set(['waybill', waybill.id], waybill);
        void queryClient.invalidateQueries({ queryKey: ['waybills'] });
        toast.done({ tone: 'ok', text: t('waybills.created', { number: waybill.number }) });
        navigate(`/waybills/${waybill.id}`);
      } catch (e) {
        const ids = sentIds.current;
        applyProblem(e, {
          form,
          fields: ['receiverOrgId', 'picked', ...ids.map((id) => `mass.${id}` as const)],
          alert: alert.show,
          onRateLimit: startWait,
          alias: (path) => {
            const m = /^items\[(\d+)\]\./.exec(path);
            const id = m ? ids[Number(m[1])] : undefined;
            if (id) return `mass.${id}`;
            return path === 'items' ? 'picked' : path;
          },
        });
      } finally {
        setBusy(false);
      }
    },
    () => focusFirstInvalid(formRef.current),
  );

  const pickedSet = new Set(picked);
  const columns: Column<BatchItem>[] = [
    {
      key: 'code',
      header: t('waybills.batch'),
      primary: true,
      cell: (b) => <TablePrimary to={`/batches/${b.id}`} code={b.publicCode} sub={b.product.name} />,
    },
    { key: 'status', header: t('batches.status'), status: true, cell: (b) => <Chip status={b.status} /> },
    {
      key: 'current',
      header: t('waybills.currentMass'),
      numeric: true,
      cell: (b) => formatDecimal(b.massKg, LOCALE),
    },
    {
      key: 'declared',
      header: t('waybills.declared'),
      cell: (b) => (
        <CellField id={`declared-${b.id}`} error={errorOf(form, `mass.${b.id}`)}>
          <InputGroup
            suffix={t('unit.kg')}
            inputMode="decimal"
            autoComplete="off"
            aria-label={t('waybills.declaredOf', { code: b.publicCode })}
            disabled={!pickedSet.has(b.id)}
            {...form.register(`mass.${b.id}`)}
          />
        </CellField>
      ),
    },
  ];
  const pickedError = errorOf(form, 'picked');

  return (
    <form id="waybill-new" ref={formRef} noValidate onSubmit={(e) => void submit(e)} style={GAP}>
      <Card style={{ maxWidth: '40rem' }}>
        <CardBody>
          <OrgPicker
            id="waybill-receiver"
            label={t('field.receiverOrgId')}
            value={receiverOrgId}
            types={['PROCESSOR', 'RETAILER']}
            exclude={me.organization.id}
            error={errorOf(form, 'receiverOrgId')}
            onChange={(id) =>
              form.setValue('receiverOrgId', id ?? '', { shouldValidate: form.formState.isSubmitted })
            }
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('waybills.items')} />
        <CardBody>
          <div style={FORM_GRID}>
            {pickedError && (
              <p className="at-field__error" id="waybill-items-error" role="alert">
                {pickedError}
              </p>
            )}
            <Table
              cards
              caption={t('waybills.items')}
              columns={columns}
              rows={batches}
              rowKey={(b) => b.id}
              selection={{
                selected: pickedSet,
                errorId: pickedError ? 'waybill-items-error' : null,
                onChange: (next) =>
                  form.setValue(
                    'picked',
                    batches.map((b) => b.id).filter((id) => next.has(id)),
                    { shouldValidate: form.formState.isSubmitted },
                  ),
                allLabel: t('waybills.pickAll'),
                rowLabel: (b) => t('waybills.pick', { code: b.publicCode }),
              }}
            />
          </div>
        </CardBody>
        <CardFooter>
          <Submit busy={busy} wait={wait}>
            {t('action.createWaybill')}
          </Submit>
        </CardFooter>
      </Card>
    </form>
  );
}

interface Problem {
  text: string;
  tone: 'danger' | 'attention';
}

function useWaybillProblems(id: string) {
  const queryClient = useQueryClient();
  const alert = useFormAlert();
  const refocus = useRef(false);
  const describe = (e: unknown): Problem => {
    const reread = () => {
      refocus.current = true;
      void queryClient.invalidateQueries({ queryKey: ['waybill', id] });
      void queryClient.invalidateQueries({ queryKey: ['waybills'] });
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
    };
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      reread();
      return { text: t('waybills.versionConflict'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      reread();
      const from = String(e.params?.from ?? '');
      return typeof e.params?.publicCode === 'string'
        ? {
            text: t('waybills.batchState', {
              publicCode: e.params.publicCode,
              status: enumLabel(t, 'BatchStatus', from),
            }),
            tone: 'danger',
          }
        : {
            text: t('waybills.stateChanged', { status: enumLabel(t, 'WaybillStatus', from) }),
            tone: 'danger',
          };
    }
    if (e instanceof ApiProblem && (e.rule === 'BR-06' || e.status === 404)) reread();
    return { text: errorText(e), tone: errorTone(e) };
  };
  return {
    alert,
    fail: (e: unknown): Problem => {
      const p = describe(e);
      alert.show(p.text, p.tone);
      return p;
    },
    describe,
    refocus,
  };
}

export function WaybillPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const problems = useWaybillProblems(id);
  const idempotentSend = useIdempotency();
  const [sending, setSending] = useState(false);
  const [sendWait, startSendWait] = useCountdown();
  const sendRef = useFocusAfterWait(sendWait);
  const [dialog, setDialog] = useState<'delete' | 'reject' | null>(null);

  const [deleted, setDeleted] = useState(false);
  useEffect(
    () => () => {
      if (deleted) queryClient.removeQueries({ queryKey: ['waybill', id] });
    },
    [deleted, id, queryClient],
  );
  const query = useQuery({
    queryKey: ['waybill', id],
    enabled: !deleted,
    meta: { failed: 'waybills.failed' },
    queryFn: () => call<Waybill>(api.GET('/waybills/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const waybill = query.data;
  const can = (a: Schemas['WaybillActionName']) => Boolean(waybill?.actions.includes(a));

  const rejectAllowed = can('reject');
  const deleteAllowed = can('delete');
  useEffect(() => {
    if ((dialog === 'reject' && !rejectAllowed) || (dialog === 'delete' && !deleteAllowed)) setDialog(null);
  }, [dialog, rejectAllowed, deleteAllowed]);
  const refocus = problems.refocus;
  const readAt = Math.max(query.dataUpdatedAt, query.errorUpdatedAt);
  useEffect(() => {
    if (!refocus.current || !readAt) return;
    refocus.current = false;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        document.querySelector<HTMLElement>('h1.at-page__title')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [readAt, refocus]);

  const changed = (next: Waybill) => {
    cache.set(['waybill', next.id], next);
    void queryClient.invalidateQueries({ queryKey: ['waybills'] });
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    void queryClient.invalidateQueries({ queryKey: ['batch'] });
  };

  if (!waybill && notFound(query.error))
    return (
      <Page title={t('page.waybill')}>
        <Card>
          <Empty
            art="not-found"
            text={t('waybills.notFound')}
            action={
              <ButtonLink variant="primary" to="/waybills">
                {t('waybills.toList')}
              </ButtonLink>
            }
          />
        </Card>
      </Page>
    );

  const send = async (w: Waybill) => {
    problems.alert.clear();
    setSending(true);
    try {
      const next = await idempotentSend({ id: w.id, version: w.version }, (key) =>
        call<Waybill>(
          api.POST('/waybills/{id}/send', {
            params: { path: { id: w.id }, header: { 'If-Match': w.version, 'Idempotency-Key': key } },
          }),
        ),
      );
      changed(next);
      toast.done({ tone: 'ok', text: t('waybills.sent', { number: next.number }) });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) startSendWait(retryAfterOf(e));
      problems.fail(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <Page
      title={waybill?.number ?? t('page.waybill')}
      actions={
        waybill &&
        (can('send') || can('delete') || can('reject')) && (
          <>
            {can('send') && (
              <Button
                ref={sendRef}
                variant="primary"
                icon="truck"
                busy={sending}
                disabled={sendWait > 0}
                onClick={() => void send(waybill)}
              >
                {sendWait > 0
                  ? t('auth.retryIn', { seconds: sendWait })
                  : enumLabel(t, 'WaybillActionName', 'send')}
              </Button>
            )}
            {can('delete') && (
              <Button variant="secondary" onClick={() => setDialog('delete')}>
                {enumLabel(t, 'WaybillActionName', 'delete')}
              </Button>
            )}
            {can('reject') && (
              <Button variant="secondary" onClick={() => setDialog('reject')}>
                {enumLabel(t, 'WaybillActionName', 'reject')}
              </Button>
            )}
          </>
        )
      }
    >
      {!waybill && query.isError ? (
        <LoadFailed
          text={t('waybills.failed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : !waybill ? (
        <AreaLoading />
      ) : (
        <div style={GAP}>
          <WaybillSummary waybill={waybill} />
          <WaybillItems waybill={waybill} />
          {can('accept') && (
            <AcceptForm
              waybill={waybill}
              onDone={(next) => {
                changed(next);
                toast.done({ tone: 'ok', text: t('waybills.accepted', { number: next.number }) });
              }}
              problems={problems}
            />
          )}
        </div>
      )}
      {waybill && (
        <>
          <DeleteDialog
            open={dialog === 'delete'}
            waybill={waybill}
            problems={problems}
            onClose={() => setDialog(null)}
            onDone={() => {
              setDialog(null);
              setDeleted(true);
              void queryClient.cancelQueries({ queryKey: ['waybill', waybill.id] });
              void queryClient.invalidateQueries({ queryKey: ['waybills'] });
              toast.done({ tone: 'ok', text: t('waybills.deleted', { number: waybill.number }) });
              navigate('/waybills');
            }}
          />
          <RejectDialog
            open={dialog === 'reject'}
            waybill={waybill}
            problems={problems}
            onClose={() => setDialog(null)}
            onDone={(next) => {
              setDialog(null);
              changed(next);
              toast.done({ tone: 'ok', text: t('waybills.rejected', { number: next.number }) });
            }}
          />
        </>
      )}
    </Page>
  );
}

function WaybillSummary({ waybill: w }: { waybill: Waybill }) {
  const at = (iso: string) => formatLocalDateTime(iso, LOCALE);
  const facts = [
    { key: 'sender', term: t('waybills.sender'), value: w.sender.name },
    { key: 'receiver', term: t('waybills.receiver'), value: w.receiver.name },
    {
      key: 'mass',
      term: t('waybills.mass'),
      value: formatDecimal(totalKg(w.items.map((i) => i.massDeclaredKg)), LOCALE),
    },
    { key: 'created', term: t('waybills.createdAt'), value: at(w.createdAt) },
    ...(w.sentAt ? [{ key: 'sent', term: t('waybills.sentAt'), value: at(w.sentAt) }] : []),
    ...(w.acceptedAt ? [{ key: 'accepted', term: t('waybills.acceptedAt'), value: at(w.acceptedAt) }] : []),
    ...(w.rejectReason ? [{ key: 'reason', term: t('waybills.rejectReason'), value: w.rejectReason }] : []),
  ];
  return (
    <Card>
      <CardHeader title={t('count.batches', { count: w.items.length })}>
        <StatusChip status={w.status} size="l" />
      </CardHeader>
      <CardBody>
        <CardFacts facts={facts} />
      </CardBody>
    </Card>
  );
}

type Item = Schemas['WaybillItem'];

function WaybillItems({ waybill }: { waybill: Waybill }) {
  const accepted = waybill.items.some((i) => i.massActualKg !== null);
  const columns: Column<Item>[] = [
    {
      key: 'code',
      header: t('waybills.batch'),
      primary: true,
      cell: (i) => (
        <TablePrimary to={`/batches/${i.batch.id}`} code={i.batch.publicCode} sub={i.batch.product.name} />
      ),
    },
    {
      key: 'status',
      header: t('batches.status'),
      status: true,
      cell: (i) => <Chip status={i.batch.status} />,
    },
    {
      key: 'declared',
      header: t('waybills.declared'),
      numeric: true,
      cell: (i) => formatDecimal(i.massDeclaredKg, LOCALE),
    },
  ];
  if (accepted)
    columns.push(
      {
        key: 'actual',
        header: t('waybills.actual'),
        numeric: true,
        cell: (i) => (i.massActualKg ? formatDecimal(i.massActualKg, LOCALE) : '—'),
      },
      {
        key: 'discrepancy',
        header: t('waybills.discrepancy'),
        numeric: true,
        cell: (i) => (i.discrepancyPercent ? formatPercent(i.discrepancyPercent, LOCALE) : '—'),
      },
      { key: 'act', header: t('waybills.act'), cell: (i) => i.discrepancyAct ?? '—' },
    );
  return (
    <Table
      cards
      caption={t('waybills.items')}
      columns={columns}
      rows={waybill.items}
      rowKey={(i) => i.batch.id}
    />
  );
}

interface AcceptValues {
  actual: Record<string, string>;
  act: Record<string, string>;
}

export function discrepancyOf(declaredKg: string, actualText: string) {
  const actualKg = normalizeDecimal(actualText, 3);
  if (!/^\d{1,9}\.\d{3}$/.test(actualKg)) return null;
  const r = checkDiscrepancy({ declaredKg, actualKg });
  return 'error' in r ? null : r;
}

export function discrepancyText(d: { percent: string; actRequired: boolean }): string {
  return d.actRequired && compareDecimalStrings(d.percent, '2.00') <= 0
    ? t('waybills.overLimit')
    : formatPercent(d.percent, LOCALE);
}

type Problems = ReturnType<typeof useWaybillProblems>;

function AcceptForm({
  waybill,
  onDone,
  problems,
}: {
  waybill: Waybill;
  onDone: (next: Waybill) => void;
  problems: Problems;
}) {
  const { api } = useSession();
  const idempotent = useIdempotency();
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const submitRef = useFocusAfterWait(wait);
  const items = waybill.items;

  const toBody = (v: AcceptValues) => ({
    items: items.map((i) => {
      const id = i.batch.id;
      const d = discrepancyOf(i.massDeclaredKg, v.actual[id] ?? '');
      const act = v.act[id] ?? '';
      return {
        batchId: id,
        massActualKg: normalizeDecimal(v.actual[id] ?? '', 3),
        ...(d?.actRequired && act.trim() ? { discrepancyAct: act } : {}),
      };
    }),
  });

  const resolver: Resolver<AcceptValues> = async (values) => {
    const actual: Record<string, FieldError> = {};
    const act: Record<string, FieldError> = {};
    for (const i of items) {
      const id = i.batch.id;
      if ((values.actual[id] ?? '').trim() === '') actual[id] = fieldError('validation.required');
      const d = discrepancyOf(i.massDeclaredKg, values.actual[id] ?? '');
      if (d?.actRequired && !(values.act[id] ?? '').trim()) act[id] = fieldError('validation.required');
    }
    const res = WaybillAcceptSchema.safeParse(toBody(values));
    for (const issue of (res.success ? [] : res.error.issues) as Issue[]) {
      const [, index, leaf] = issue.path;
      const id = typeof index === 'number' ? items[index]?.batch.id : undefined;
      if (!id) continue;
      if (leaf === 'massActualKg') actual[id] ??= fieldError(issue.message);
      else if (leaf === 'discrepancyAct') act[id] ??= fieldError(issue.message);
    }
    const errors: FieldErrors<AcceptValues> = {};
    if (Object.keys(actual).length) errors.actual = actual as never;
    if (Object.keys(act).length) errors.act = act as never;
    return Object.keys(errors).length ? { values: {}, errors } : { values, errors: {} };
  };

  const form = useForm<AcceptValues>({
    resolver,
    defaultValues: {
      actual: Object.fromEntries(items.map((i) => [i.batch.id, massText(i.massDeclaredKg)])),
      act: Object.fromEntries(items.map((i) => [i.batch.id, ''])),
    },
  });
  const actual = form.watch('actual');

  const submit = form.handleSubmit(async (values) => {
    problems.alert.clear();
    setBusy(true);
    const version = waybill.version;
    const body = toBody(values) as Schemas['WaybillAccept'];
    try {
      const next = await idempotent({ version, body }, (key) =>
        call<Waybill>(
          api.POST('/waybills/{id}/accept', {
            params: { path: { id: waybill.id }, header: { 'If-Match': version, 'Idempotency-Key': key } },
            body,
          }),
        ),
      );
      onDone(next);
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        applyProblem(e, {
          form,
          fields: items.flatMap((i) => [`actual.${i.batch.id}`, `act.${i.batch.id}`] as const),
          alert: problems.alert.show,
          alias: (path) => {
            const m = /^items\[(\d+)\]\.(massActualKg|discrepancyAct)$/.exec(path);
            const item = m ? items[Number(m[1])] : undefined;
            return item && m ? `${m[2] === 'massActualKg' ? 'actual' : 'act'}.${item.batch.id}` : path;
          },
        });
      } else {
        if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
        if (e instanceof ApiProblem && e.rule === 'BR-07' && typeof e.params?.publicCode === 'string') {
          const code = e.params.publicCode;
          const item = items.find((i) => i.batch.publicCode === code);
          if (item) form.setError(`act.${item.batch.id}`, { type: 'server', message: 'validation.required' });
        }
        problems.fail(e);
      }
    } finally {
      setBusy(false);
    }
  });

  return (
    <Card>
      <CardHeader title={t('waybills.acceptance')} />
      <CardBody>
        <form id="waybill-accept" noValidate onSubmit={(e) => void submit(e)} style={GAP}>
          {items.map((i) => {
            const id = i.batch.id;
            const d = discrepancyOf(i.massDeclaredKg, actual[id] ?? '');
            return (
              <div key={id} style={FORM_GRID}>
                <div
                  style={{
                    display: 'grid',
                    gap: 'var(--sp-4)',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
                    alignItems: 'end',
                  }}
                >
                  <Field
                    id={`actual-${id}`}
                    label={t('waybills.actualOf', { code: i.batch.publicCode })}
                    error={errorOf(form, `actual.${id}`)}
                  >
                    <InputGroup
                      suffix={t('unit.kg')}
                      inputMode="decimal"
                      autoComplete="off"
                      {...form.register(`actual.${id}`)}
                    />
                  </Field>
                  <p
                    aria-live="polite"
                    style={{
                      margin: 0,
                      minHeight: '2.75rem',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 'var(--sp-2)',
                      alignItems: 'center',
                    }}
                  >
                    {d && (
                      <>
                        <span>
                          {t('waybills.discrepancy')}: {discrepancyText(d)}
                        </span>
                        {d.actRequired && <Chip tone="attention">{t('waybills.actRequired')}</Chip>}
                      </>
                    )}
                  </p>
                </div>
                {d?.actRequired && (
                  <Field
                    id={`act-${id}`}
                    label={t('waybills.actOf', { code: i.batch.publicCode })}
                    error={errorOf(form, `act.${id}`)}
                  >
                    <Textarea rows={3} {...form.register(`act.${id}`)} />
                  </Field>
                )}
              </div>
            );
          })}
        </form>
      </CardBody>
      <CardFooter>
        <Submit ref={submitRef} busy={busy} wait={wait} form="waybill-accept">
          {enumLabel(t, 'WaybillActionName', 'accept')}
        </Submit>
      </CardFooter>
    </Card>
  );
}

function DeleteDialog({
  open,
  waybill,
  problems,
  onClose,
  onDone,
}: {
  open: boolean;
  waybill: Waybill;
  problems: Problems;
  onClose: () => void;
  onDone: () => void;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const failure = useDialogAlert();
  const { handOff } = failure;
  const confirmRef = useFocusAfterWait(wait);
  useEffect(() => {
    if (!open) handOff();
  }, [open, handOff]);
  const close = () => onClose();
  const remove = async () => {
    setBusy(true);
    failure.clear();
    try {
      await call(
        api.DELETE('/waybills/{id}', {
          params: { path: { id: waybill.id }, header: { 'If-Match': waybill.version } },
        }),
      );
      onDone();
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      const p = problems.describe(e);
      failure.show(p.text, p.tone);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('waybills.deleteTitle', { number: waybill.number })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="danger"
            busy={busy}
            disabled={wait > 0}
            onClick={() => void remove()}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : enumLabel(t, 'WaybillActionName', 'delete')}
          </Button>
        </>
      }
    >
      {failure.message && <DialogMessage text={failure.message} />}
    </Dialog>
  );
}

function RejectDialog({
  open,
  waybill,
  problems,
  onClose,
  onDone,
}: {
  open: boolean;
  waybill: Waybill;
  problems: Problems;
  onClose: () => void;
  onDone: (next: Waybill) => void;
}) {
  const { api } = useSession();
  const [reason, setReason] = useState('');
  const [number, setNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const failure = useDialogAlert();
  const { handOff } = failure;
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const matches = waybill.number !== '' && number.trim().toUpperCase() === waybill.number;
  const confirmRef = useFocusAfterWait(wait);
  useEffect(() => {
    if (open) return;
    setReason('');
    setNumber('');
    setError(null);
    handOff();
  }, [open, handOff]);
  const close = () => onClose();
  const reject = async () => {
    const check = WaybillRejectSchema.safeParse({ reason });
    if (!check.success)
      return setError(t(reason.trim() ? check.error.issues[0]!.message : 'validation.required'));
    setBusy(true);
    failure.clear();
    try {
      const next = await call<Waybill>(
        api.POST('/waybills/{id}/reject', {
          params: { path: { id: waybill.id }, header: { 'If-Match': waybill.version } },
          body: { reason },
        }),
      );
      setReason('');
      setNumber('');
      onDone(next);
    } catch (e) {
      const key = e instanceof ApiProblem && e.code === 'VALIDATION' ? e.errors?.reason?.[0] : undefined;
      if (key) setError(t(key));
      else {
        if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
        const p = problems.describe(e);
        failure.show(p.text, p.tone);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('waybills.rejectTitle', { number: waybill.number })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="danger"
            busy={busy}
            disabled={!matches || wait > 0}
            onClick={() => void reject()}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : enumLabel(t, 'WaybillActionName', 'reject')}
          </Button>
        </>
      }
    >
      <div style={FORM_GRID}>
        <DialogMessage text={failure.message} />
        <Field id="reject-reason" label={t('waybills.rejectReason')} error={error}>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field id="reject-number" label={t('waybills.repeatNumber')}>
          <Input mono autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
