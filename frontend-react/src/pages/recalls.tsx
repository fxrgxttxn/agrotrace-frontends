import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatLocalDateTime, formatMass } from '@agrotrace/i18n';
import { RecallCreateSchema } from '@agrotrace/validation';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useDialogAlert,
  useFormAlert,
} from '../app/api';
import { useCacheWriter, useScreenNavigate, useScreenToast } from '../app/cache';
import { CodeConfirmDialog } from '../app/CodeConfirm';
import { DateFilter } from '../app/DateFilter';
import { errorOf, focusFirstInvalid, FORM_GRID, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { useIdempotency } from '../app/idempotency';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { deadline, RECALL_TONE, TASK_TONE, taskConfirmable } from '../app/recalls';
import { useSession } from '../app/session';
import { useNow } from '../app/useNow';
import { BatchGraphView } from '../graph/BatchGraph';
import {
  AreaLoading,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFacts,
  CardHeader,
  Checkbox,
  Chip,
  Combobox,
  Empty,
  Field,
  ListChanged,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Progress,
  Select,
  Table,
  TablePrimary,
  Textarea,
  type ComboOption,
  type Column,
} from '../ui';

type Recall = Schemas['Recall'];
type RecallItem = Schemas['RecallListItem'];
type Task = Schemas['RecallTask'];
type TaskStatus = Schemas['RecallTaskStatus'];
type RecallBatch = Schemas['RecallBatch'];
type Batch = Schemas['Batch'];

const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const ALL = 'all';
const SEVERAL = '__several';
const TASK_STATUSES: readonly TaskStatus[] = ['OPEN', 'OVERDUE', 'CONFIRMED'];
const ACTIVE: readonly TaskStatus[] = ['OPEN', 'OVERDUE'];
const TRIGGERS: readonly Schemas['RecallTrigger'][] = ['LAB', 'INSPECTOR', 'COMPLAINT'];
const TICK_MS = 30_000;

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

function liveStatus(task: Pick<Task, 'status' | 'dueAt'>, now: number): TaskStatus {
  return deadline(task, now)?.overdue ? 'OVERDUE' : task.status;
}

function TaskChip({ task, now }: { task: Pick<Task, 'status' | 'dueAt'>; now: number }) {
  const status = liveStatus(task, now);
  return <Chip tone={TASK_TONE[status]}>{enumLabel(t, 'RecallTaskStatus', status)}</Chip>;
}

function Due({ task, now }: { task: Task; now: number }) {
  const left = deadline(task, now);
  return (
    <span className="at-table__primary">
      <span>{at(task.dueAt)}</span>
      {left && (
        <span className={left.overdue ? 'at-table__sub at-field__warning' : 'at-table__sub'}>
          {left.text}
        </span>
      )}
    </span>
  );
}

function Confirmed({ task }: { task: Task }) {
  if (!task.confirmedAt) return <>—</>;
  return (
    <span className="at-table__primary">
      <span>{at(task.confirmedAt)}</span>
      {task.confirmedBy && <span className="at-table__sub">{task.confirmedBy.fullName}</span>}
    </span>
  );
}

function MultiSelect({
  values,
  all,
  enumName,
  first,
  onChange,
}: {
  values: string[];
  all: readonly string[];
  enumName: string;
  first: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={values.length === 1 ? values[0] : values.length > 1 ? SEVERAL : ''}
      onChange={(e) => onChange(e.target.value)}
    >
      {first.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {values.length > 1 && (
        <option value={SEVERAL} disabled>
          {t('filters.several', { count: values.length })}
        </option>
      )}
      {all.map((v) => (
        <option key={v} value={v}>
          {enumLabel(t, enumName, v)}
        </option>
      ))}
    </Select>
  );
}

const TASKS_SPEC: ListSpec = {
  sort: ['dueAt', 'createdAt', 'confirmedAt'],
  enums: { status: [...TASK_STATUSES, ALL], overdue: ['true', 'false'] },
  texts: ['q'],
};

export function RecallTasksPage() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const toast = useScreenToast();
  const alert = useFormAlert();
  const idempotent = useIdempotency();
  const now = useNow(TICK_MS);
  const list = useListParams('/recall-tasks', TASKS_SPEC);
  const q = list.get('q');
  const statusParam = list.params.getAll('status');
  const status: string[] = statusParam.includes(ALL) ? [ALL] : statusParam;
  const sentStatus: readonly TaskStatus[] =
    status[0] === ALL ? [] : status.length ? (status as TaskStatus[]) : ACTIVE;
  const overdue = list.get('overdue');
  const sort = list.sort;
  const count = (status.length ? 1 : 0) + (overdue ? 1 : 0);
  const allOnly = status[0] === ALL && !q && count === 1;
  const [, setSearch] = useSearchParams();
  const mixed = statusParam.includes(ALL) && statusParam.length > 1;
  useEffect(() => {
    if (!mixed) return;
    setSearch(
      (cur) => {
        const next = new URLSearchParams(cur);
        next.delete('status');
        next.append('status', ALL);
        return next;
      },
      { replace: true },
    );
  }, [mixed, setSearch]);

  const query = useQuery({
    queryKey: ['recallTasks', { page: list.page, sort: list.params.get('sort'), q, status, overdue }],
    meta: { failed: 'recallTasks.failed' },
    queryFn: () =>
      call<Schemas['RecallTaskPage']>(
        api.GET('/recall-tasks', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(sentStatus.length ? { status: [...sentStatus] } : {}),
              ...(overdue ? { overdue: overdue === 'true' } : {}),
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

  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const failure = useDialogAlert();
  const { clear: clearFailure } = failure;
  const shown = items.find((x) => x.id === target) ?? null;
  const stale = target !== null && query.data !== undefined && (!shown || !taskConfirmable(shown.status));
  useEffect(() => {
    if (!stale) return;
    setTarget(null);
    clearFailure();
  }, [stale, clearFailure]);
  const close = () => {
    failure.handOff();
    setTarget(null);
  };

  const reread = () => void queryClient.invalidateQueries({ queryKey: ['recallTasks'] });
  const confirm = async (task: Task) => {
    setBusy(true);
    failure.clear();
    alert.clear();
    try {
      await idempotent(
        { id: task.id, version: task.version },
        (key) =>
          call<Task>(
            api.POST('/recall-tasks/{id}/confirm', {
              params: { path: { id: task.id }, header: { 'If-Match': task.version, 'Idempotency-Key': key } },
              body: {},
            }),
          ),
        task.id,
      );
      close();
      reread();
      for (const key of ['batches', 'batch', 'dashboard', 'notifications'])
        void queryClient.invalidateQueries({ queryKey: [key] });
      toast.done({ tone: 'ok', text: t('recallTasks.confirmed', { code: task.batch.publicCode }) });
    } catch (e) {
      const code = task.batch.publicCode;
      let text: string;
      let closing = false;
      if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
        reread();
        text = t('recallTasks.versionConflict');
      } else if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
        reread();
        closing = true;
        text = t('recallTasks.alreadyConfirmed', { code });
      } else if (e instanceof ApiProblem && e.status === 404) {
        reread();
        closing = true;
        text = t('recallTasks.gone');
      } else {
        if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
        text = errorText(e);
      }
      if (closing) {
        setTarget(null);
        alert.show(text, errorTone(e));
      } else failure.show(text, errorTone(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<Task>[] = [
    {
      key: 'batch',
      header: t('recallTasks.batch'),
      primary: true,
      cell: (x) => (
        <TablePrimary to={`/batches/${x.batch.id}`} code={x.batch.publicCode} sub={x.batch.product.name} />
      ),
    },
    {
      key: 'status',
      header: t('recallTasks.status'),
      status: true,
      cell: (x) => <TaskChip task={x} now={now} />,
    },
    { key: 'reason', header: t('recallTasks.reason'), cell: (x) => x.recallReason },
    {
      key: 'due',
      header: t('recallTasks.dueAt'),
      sortField: 'dueAt',
      cell: (x) => <Due task={x} now={now} />,
    },
    {
      key: 'confirmed',
      header: t('recallTasks.confirmedAt'),
      sortField: 'confirmedAt',
      cell: (x) => <Confirmed task={x} />,
    },
  ];

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('recallTasks.failed')}
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
          {allOnly ? (
            <Empty art="empty-recalls" text={t('recallTasks.empty')} />
          ) : q || count ? (
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
              art="empty-recalls"
              text={t('recallTasks.empty')}
              action={
                <Button variant="primary" onClick={() => list.set({ status: ALL })}>
                  {t('recallTasks.showAll')}
                </Button>
              }
            />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={t('page.recallTasks')}
          columns={columns}
          rows={items}
          rowKey={(x) => x.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'dueAt,asc', label: t('recallTasks.sort.due') },
            { value: 'createdAt,desc', label: t('recallTasks.sort.created') },
            { value: 'confirmedAt,desc', label: t('recallTasks.sort.confirmed') },
          ]}
          actions={(x) =>
            taskConfirmable(x.status) ? (
              <Button
                variant="danger"
                icon="check"
                aria-label={t('recallTasks.confirmFor', { code: x.batch.publicCode })}
                onClick={() => {
                  failure.clear();
                  setTarget(x.id);
                }}
              >
                {t('action.confirmSeizure')}
              </Button>
            ) : null
          }
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page title={t('page.recallTasks')}>
      <PageToolbar
        search={{
          label: t('recallTasks.search'),
          placeholder: t('recallTasks.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-status" label={t('recallTasks.status')}>
              <MultiSelect
                values={status}
                all={TASK_STATUSES}
                enumName="RecallTaskStatus"
                first={[
                  { value: '', label: t('recallTasks.active') },
                  { value: ALL, label: t('filters.any') },
                ]}
                onChange={(v) => list.set({ status: v })}
              />
            </Field>
            <Field id="filter-overdue" label={t('recallTasks.overdueFilter')}>
              <Select value={overdue} onChange={(e) => list.set({ overdue: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                <option value="true">{t('recallTasks.overdueOnly')}</option>
                <option value="false">{t('recallTasks.overdueNone')}</option>
              </Select>
            </Field>
          </>
        }
      />
      {content()}
      <CodeConfirmDialog
        open={shown !== null}
        title={shown ? t('recallTasks.confirmTitle', { code: shown.batch.publicCode }) : ''}
        text={
          shown && (
            <p style={{ margin: 0 }}>
              {t('recallTasks.confirmText', {
                product: shown.batch.product.name,
                mass: formatMass(shown.batch.massKg, LOCALE),
              })}
            </p>
          )
        }
        code={shown?.batch.publicCode ?? ''}
        confirmLabel={enumLabel(t, 'BatchActionName', 'writeOff')}
        busy={busy}
        wait={wait}
        message={failure.message}
        onClose={close}
        onConfirm={() => {
          if (shown) void confirm(shown);
        }}
      />
    </Page>
  );
}

const RECALLS_SPEC: ListSpec = {
  sort: ['openedAt', 'closedAt'],
  enums: { status: ['OPEN', 'CLOSED'], trigger: TRIGGERS },
  dates: ['from', 'to'],
  texts: ['q'],
};

function RecallChip({ status, size }: { status: Schemas['RecallStatus']; size?: 'l' }) {
  return (
    <Chip tone={RECALL_TONE[status]} size={size}>
      {enumLabel(t, 'RecallStatus', status)}
    </Chip>
  );
}

function RecallProgress({
  id,
  progress,
  inTable,
}: {
  id: string;
  progress: Schemas['RecallProgress'];
  inTable?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-1)' }}>
      <Progress
        id={id}
        label={t('recalls.progress')}
        value={progress.confirmed}
        max={progress.total}
        tone={progress.overdue > 0 ? 'danger' : undefined}
        labelHidden={inTable}
      />
      {progress.overdue > 0 && (
        <span className="at-table__sub at-field__warning">
          {t('recalls.overdueCount', { count: progress.overdue })}
        </span>
      )}
    </div>
  );
}

export function RecallsPage() {
  const { api } = useSession();
  const list = useListParams('/recalls', RECALLS_SPEC);
  const q = list.get('q');
  const status = list.get('status');
  const trigger = list.params.getAll('trigger');
  const from = list.get('from');
  const to = list.get('to');
  const sort = list.sort;
  const count = (trigger.length ? 1 : 0) + [status, from, to].filter(Boolean).length;

  const query = useQuery({
    queryKey: ['recalls', { page: list.page, sort: list.params.get('sort'), q, status, trigger, from, to }],
    meta: { failed: 'recalls.failed' },
    queryFn: () =>
      call<Schemas['RecallPage']>(
        api.GET('/recalls', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(status ? { status: status as Schemas['RecallStatus'] } : {}),
              ...(trigger.length ? { trigger: trigger as Schemas['RecallTrigger'][] } : {}),
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

  const columns: Column<RecallItem>[] = [
    {
      key: 'source',
      header: t('recalls.source'),
      primary: true,
      cell: (x) => (
        <TablePrimary
          to={`/recalls/${x.id}`}
          code={x.sourceBatch.publicCode}
          sub={x.sourceBatch.product.name}
        />
      ),
    },
    {
      key: 'status',
      header: t('recalls.status'),
      status: true,
      cell: (x) => <RecallChip status={x.status} />,
    },
    {
      key: 'trigger',
      header: t('recalls.trigger'),
      cell: (x) => (
        <span className="at-table__primary">
          <span>{enumLabel(t, 'RecallTrigger', x.trigger)}</span>
          <span className="at-table__sub">{x.reason}</span>
        </span>
      ),
    },
    {
      key: 'progress',
      header: t('recalls.progress'),
      cell: (x) => <RecallProgress id={`progress-${x.id}`} progress={x.progress} inTable />,
    },
    { key: 'batches', header: t('recalls.batchesCount'), numeric: true, cell: (x) => x.batchesCount },
    { key: 'opened', header: t('recalls.openedAt'), sortField: 'openedAt', cell: (x) => at(x.openedAt) },
    {
      key: 'closed',
      header: t('recalls.closedAt'),
      sortField: 'closedAt',
      cell: (x) => (x.closedAt ? at(x.closedAt) : '—'),
    },
  ];

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('recalls.failed')}
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
            <Empty art="empty-recalls" text={t('empty.recalls')} />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={t('page.recalls')}
          columns={columns}
          rows={items}
          rowKey={(x) => x.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'openedAt,desc', label: t('recalls.sort.opened') },
            { value: 'closedAt,desc', label: t('recalls.sort.closed') },
          ]}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page
      title={t('page.recalls')}
      actions={
        <ButtonLink variant="danger" to="/recalls/new">
          {t('action.startRecall')}
        </ButtonLink>
      }
    >
      <PageToolbar
        search={{
          label: t('recalls.search'),
          placeholder: t('recalls.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-status" label={t('recalls.status')}>
              <Select value={status} onChange={(e) => list.set({ status: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                <option value="OPEN">{enumLabel(t, 'RecallStatus', 'OPEN')}</option>
                <option value="CLOSED">{enumLabel(t, 'RecallStatus', 'CLOSED')}</option>
              </Select>
            </Field>
            <Field id="filter-trigger" label={t('recalls.trigger')}>
              <MultiSelect
                values={trigger}
                all={TRIGGERS}
                enumName="RecallTrigger"
                first={[{ value: '', label: t('filters.any') }]}
                onChange={(v) => list.set({ trigger: v })}
              />
            </Field>
            <DateFilter
              id="filter-from"
              label={t('recalls.from')}
              value={from}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="filter-to"
              label={t('recalls.to')}
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

export function RecallPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const now = useNow(TICK_MS);
  const query = useQuery({
    queryKey: ['recall', id],
    meta: { failed: 'recalls.cardFailed' },
    queryFn: () => call<Recall>(api.GET('/recalls/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const recall = query.data;

  if (!recall && notFound(query.error))
    return (
      <Page title={t('page.recall')}>
        <Card>
          <Empty
            art="not-found"
            text={t('recalls.notFound')}
            action={
              <ButtonLink variant="primary" to="/recalls">
                {t('recalls.toList')}
              </ButtonLink>
            }
          />
        </Card>
      </Page>
    );

  return (
    <Page title={recall ? t('recalls.title', { code: recall.sourceBatch.publicCode }) : t('page.recall')}>
      {!recall && query.isError ? (
        <LoadFailed
          text={t('recalls.cardFailed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : !recall ? (
        <AreaLoading />
      ) : (
        <div style={GAP}>
          <RecallSummary recall={recall} />
          <TasksCard recall={recall} now={now} />
          <AffectedCard recall={recall} />
        </div>
      )}
    </Page>
  );
}

function RecallSummary({ recall }: { recall: Recall }) {
  const source = recall.sourceBatch;
  const facts = [
    {
      key: 'source',
      term: t('recalls.source'),
      value: (
        <Link className="at-mono" to={`/batches/${source.id}`}>
          {source.publicCode}
        </Link>
      ),
    },
    { key: 'trigger', term: t('recalls.trigger'), value: enumLabel(t, 'RecallTrigger', recall.trigger) },
    { key: 'opened', term: t('recalls.openedAt'), value: at(recall.openedAt) },
    ...(recall.openedBy ? [{ key: 'by', term: t('recalls.openedBy'), value: recall.openedBy.fullName }] : []),
    ...(recall.closedAt ? [{ key: 'closed', term: t('recalls.closedAt'), value: at(recall.closedAt) }] : []),
    {
      key: 'upstream',
      term: t('recalls.blockUpstream'),
      value: recall.blockUpstream ? t('recalls.upstreamBlocked') : t('recalls.upstreamKept'),
    },
    ...(recall.complaintId
      ? [
          {
            key: 'complaint',
            term: t('recalls.complaint'),
            value: <Link to={`/complaints/${recall.complaintId}`}>{t('recalls.complaintOpen')}</Link>,
          },
        ]
      : []),
    ...(recall.labTestId
      ? [
          {
            key: 'lab',
            term: t('recalls.labTest'),
            value: <Link to={`/batches/${source.id}?tab=tests`}>{t('recalls.labTestOpen')}</Link>,
          },
        ]
      : []),
  ];
  return (
    <Card>
      <CardHeader title={source.product.name}>
        <RecallChip status={recall.status} size="l" />
      </CardHeader>
      <CardBody>
        <div style={STACK}>
          <dl className="at-card__facts">
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>{t('recalls.reason')}</dt>
              <dd>{recall.reason}</dd>
            </div>
          </dl>
          <CardFacts facts={facts} />
          <RecallProgress id="recall-progress" progress={recall.progress} />
        </div>
      </CardBody>
    </Card>
  );
}

function TasksCard({ recall, now }: { recall: Recall; now: number }) {
  const columns: Column<Task>[] = [
    {
      key: 'batch',
      header: t('recallTasks.batch'),
      primary: true,
      cell: (x) => (
        <TablePrimary to={`/batches/${x.batch.id}`} code={x.batch.publicCode} sub={x.batch.product.name} />
      ),
    },
    {
      key: 'status',
      header: t('recallTasks.status'),
      status: true,
      cell: (x) => <TaskChip task={x} now={now} />,
    },
    { key: 'holder', header: t('recallTasks.holder'), cell: (x) => x.holder.name },
    { key: 'due', header: t('recallTasks.dueAt'), cell: (x) => <Due task={x} now={now} /> },
    { key: 'confirmed', header: t('recallTasks.confirmedAt'), cell: (x) => <Confirmed task={x} /> },
  ];
  return (
    <Card>
      <CardHeader title={t('recalls.tasks')} />
      <CardBody>
        {recall.tasks.length === 0 ? (
          <p style={{ margin: 0 }}>{t('recalls.noTasks')}</p>
        ) : (
          <Table
            cards
            caption={t('recalls.tasks')}
            columns={columns}
            rows={recall.tasks}
            rowKey={(x) => x.id}
          />
        )}
      </CardBody>
    </Card>
  );
}

const relation = (b: Pick<RecallBatch, 'direction' | 'depth'>) =>
  b.direction === 'SOURCE'
    ? enumLabel(t, 'RecallDirection', 'SOURCE')
    : b.direction === 'UP'
      ? t('graph.up', { level: b.depth })
      : t('graph.down', { level: b.depth });

function asBatchGraph(recall: Recall, graph: Schemas['RecallGraph']): Schemas['BatchGraph'] {
  return {
    rootId: recall.sourceBatch.id,
    depth: Math.min(5, Math.max(1, ...graph.nodes.map((n) => n.depth))),
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      publicCode: n.publicCode,
      product: n.product,
      status: n.status,
      holder: n.holder,
      depth: n.direction === 'UP' ? -n.depth : n.depth,
      accessible: true,
    })),
    edges: graph.edges,
  };
}

function AffectedCard({ recall }: { recall: Recall }) {
  const { api } = useSession();
  const graph = useQuery({
    queryKey: ['recall', recall.id, 'graph'],
    meta: { failed: 'graph.failed' },
    queryFn: () =>
      call<Schemas['RecallGraph']>(api.GET('/recalls/{id}/graph', { params: { path: { id: recall.id } } })),
    retry: retryTransient,
  });
  const columns: Column<RecallBatch>[] = [
    {
      key: 'batch',
      header: t('recallTasks.batch'),
      primary: true,
      cell: (x) => (
        <TablePrimary to={`/batches/${x.batch.id}`} code={x.batch.publicCode} sub={x.batch.product.name} />
      ),
    },
    {
      key: 'now',
      header: t('recalls.statusNow'),
      status: true,
      cell: (x) => <Chip status={x.batch.status} />,
    },
    { key: 'link', header: t('recalls.direction'), cell: relation },
    { key: 'before', header: t('recalls.statusBefore'), cell: (x) => <Chip status={x.statusBefore} /> },
    { key: 'holder', header: t('recalls.holder'), cell: (x) => x.batch.holder.name },
  ];
  return (
    <Card>
      <CardHeader title={t('recalls.affected')} />
      <CardBody>
        <div style={STACK}>
          {graph.data ? (
            <BatchGraphView
              graph={asBatchGraph(recall, graph.data)}
              code={recall.sourceBatch.publicCode}
              labelKey="recalls.graphLabel"
            />
          ) : graph.isError ? (
            <LoadFailed
              text={t('graph.failed')}
              busy={graph.isFetching}
              onRetry={() => void graph.refetch()}
            />
          ) : (
            <AreaLoading blocks={1} />
          )}
          <Table
            cards
            caption={t('recalls.affected')}
            columns={columns}
            rows={recall.batches}
            rowKey={(x) => x.batch.id}
          />
        </div>
      </CardBody>
    </Card>
  );
}

interface NewRecall {
  sourceBatchId: string;
  reason: string;
  blockUpstream: boolean;
}

const newRecallSchema = wireSchema<NewRecall>(RecallCreateSchema, (v) => v);

function BatchPicker({
  value,
  error,
  onChange,
  onPending,
}: {
  value: string;
  error?: string;
  onChange: (batch: { id: string; code: string } | null) => void;
  onPending: (pending: boolean) => void;
}) {
  const { api } = useSession();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [picked, setPicked] = useState<ComboOption | null>(null);
  const linked = useQuery({
    queryKey: ['batch', value],
    enabled: value !== '' && picked?.value !== value,
    queryFn: () => call<Batch>(api.GET('/batches/{id}', { params: { path: { id: value } } })),
    retry: retryTransient,
  });
  const report = linked.data;
  const pending = linked.isPending && linked.fetchStatus !== 'idle';
  useEffect(() => onPending(pending), [pending, onPending]);
  const linkError =
    value !== '' && picked?.value !== value && linked.isError
      ? notFound(linked.error)
        ? t('validation.notFound')
        : t('recalls.new.batchFailed')
      : undefined;
  useEffect(() => {
    if (report && report.id === value) {
      setQuery(report.publicCode);
      onChange({ id: report.id, code: report.publicCode });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, value]);
  const found = useQuery({
    queryKey: ['batches', 'search', search],
    enabled: search !== null && search.trim() !== '',
    queryFn: () =>
      call<Schemas['BatchPage']>(
        api.GET('/batches', { params: { query: { q: search!.trim(), size: 20, sort: 'publicCode,asc' } } }),
      ),
  });
  const options: ComboOption[] = (found.data?.items ?? []).map((b) => ({
    value: b.id,
    label: b.publicCode,
    meta: b.product.name,
  }));
  return (
    <Field id="recall-batch" label={t('recalls.new.batch')} error={error ?? linkError}>
      <Combobox
        listLabel={t('recalls.new.batch')}
        query={query}
        onQueryChange={(text) => {
          setQuery(text);
          if (value !== '') {
            setPicked(null);
            onChange(null);
          }
        }}
        onSearch={setSearch}
        options={search && search.trim() ? options : []}
        loading={found.isFetching}
        selected={value || null}
        onSelect={(o) => {
          setPicked(o);
          setQuery(o.label);
          onChange({ id: o.value, code: o.label });
        }}
      />
    </Field>
  );
}

export function RecallNewPage() {
  const { api } = useSession();
  const [params] = useSearchParams();
  const toast = useScreenToast();
  const navigate = useScreenNavigate();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const linked = params.get('batchId') ?? '';
  const { form, alert, wait, startWait, fail } = useSchemaForm<NewRecall>(
    newRecallSchema,
    { sourceBatchId: /^[0-9a-f-]{36}$/i.test(linked) ? linked : '', reason: '', blockUpstream: false },
    ['sourceBatchId', 'reason', 'blockUpstream'],
    undefined,
    { shouldFocusError: false },
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [code, setCode] = useState('');
  const [linkPending, setLinkPending] = useState(false);
  const [confirming, setConfirming] = useState<NewRecall | null>(null);
  const [busy, setBusy] = useState(false);
  const failure = useDialogAlert();
  const sourceBatchId = form.watch('sourceBatchId');

  const start = async (v: NewRecall) => {
    setBusy(true);
    failure.clear();
    alert.clear();
    try {
      const res = await api.POST('/recalls', { body: v });
      const recall = await call<Recall>(Promise.resolve(res));
      cache.set(['recall', recall.id], recall);
      for (const key of ['recalls', 'batches', 'batch', 'dashboard'])
        void queryClient.invalidateQueries({ queryKey: [key] });
      setConfirming(null);
      const shown = recall.sourceBatch.publicCode;
      if (res.response.status === 200)
        toast.push({ tone: 'attention', text: t('recalls.new.existing', { code: shown }) });
      else toast.done({ tone: 'ok', text: t('recalls.new.started', { code: shown }) });
      navigate(`/recalls/${recall.id}`);
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        setConfirming(null);
        fail(e);
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      failure.show(errorText(e), errorTone(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = form.handleSubmit(
    (v) => {
      if (!code) {
        if (!linkPending) document.getElementById('recall-batch')?.focus();
        return;
      }
      failure.clear();
      setConfirming(v);
    },
    () => focusFirstInvalid(formRef.current),
  );

  return (
    <Page title={t('page.recallNew')}>
      <Card>
        <CardBody>
          <form ref={formRef} noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
            <BatchPicker
              value={sourceBatchId}
              error={errorOf(form, 'sourceBatchId')}
              onPending={setLinkPending}
              onChange={(b) => {
                setCode(b?.code ?? '');
                form.setValue('sourceBatchId', b?.id ?? '', { shouldValidate: form.formState.isSubmitted });
              }}
            />
            <Field id="recall-reason" label={t('recalls.new.reason')} error={errorOf(form, 'reason')}>
              <Textarea rows={4} {...form.register('reason')} />
            </Field>
            <Checkbox {...form.register('blockUpstream')}>{t('recalls.new.blockUpstream')}</Checkbox>
            <div>
              <Submit busy={(busy && !confirming) || linkPending} wait={wait}>
                {t('recalls.new.submit')}
              </Submit>
            </div>
          </form>
        </CardBody>
      </Card>
      <CodeConfirmDialog
        open={confirming !== null && code !== ''}
        title={t('recalls.new.confirmTitle', { code })}
        text={
          <>
            <p style={{ margin: 0 }}>{t('recalls.new.confirmText')}</p>
            {confirming?.blockUpstream && <p style={{ margin: 0 }}>{t('recalls.new.confirmUpstream')}</p>}
          </>
        }
        code={code}
        confirmLabel={t('recalls.new.submit')}
        busy={busy}
        wait={wait}
        message={failure.message}
        onClose={() => {
          failure.handOff();
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming) void start(confirming);
        }}
      />
    </Page>
  );
}
