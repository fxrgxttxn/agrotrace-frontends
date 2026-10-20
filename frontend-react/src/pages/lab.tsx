import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { concludeLabTest } from '@agrotrace/domain';
import { enumLabel, formatBytes, formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
import { LabResultsInputSchema } from '@agrotrace/validation';
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
import { Submit } from '../app/forms';
import { useCacheWriter, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { CONCLUSION_TONE, LAB_STATUS_TONE } from '../app/labTests';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { useSession } from '../app/session';
import {
  AreaLoading,
  Button,
  ButtonAnchor,
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
  FileField,
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
  type Column,
  type FileItem,
} from '../ui';

// Laboratory (БП-2, FR-QA-02…05, BR-02). The queue (`/lab/tests`) is the laboratory's tests with filters and sort in
// the URL; the card (`/lab/tests/:id`) registers the sample, takes a value for every norm of the batch's product with
// the live comparison against the norm (the domain's `concludeLabTest`, exact decimals — never floats), sends them in
// one request, and uploads the PDF report. What may be done comes from `LabTest.actions`; every transition carries
// the test's `version` in If-Match, and a VERSION_CONFLICT or a state that moved on re-reads the card and says so,
// keeping what was typed (FM13). A FAIL starts a recall (FR-QA-05), so it is confirmed in a dialog with the batch code
// repeated (spec §9.3). The server's conclusion is final.

type LabTest = Schemas['LabTest'];
type ListItem = Schemas['LabTestListItem'];
type Status = Schemas['LabTestStatus'];
type Reason = Schemas['LabTestReason'];
type Conclusion = Schemas['LabConclusion'];
type Norm = Schemas['LabNorm'];
type Result = Schemas['LabResult'];

const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const STATUSES: readonly Status[] = ['QUEUED', 'SAMPLED', 'ESCALATED', 'DONE', 'CANCELLED'];
const REASONS: readonly Reason[] = ['RISK', 'PLANNED', 'COMPLAINT', 'INSPECTOR'];
const SEVERAL = '__several';
/** The queue opens on the tests still to do (ruling FM20); every status is the explicit `status=all`. */
const ACTIVE: readonly Status[] = ['QUEUED', 'SAMPLED', 'ESCALATED'];
const ALL = 'all';
/** Contract limit of the report (uploadLabProtocol): ≤ 10 485 760 bytes inclusive, PDF by content. */
const PROTOCOL_MAX_BYTES = 10485760;

const SPEC: ListSpec = {
  sort: ['dueAt', 'createdAt', 'completedAt'],
  enums: {
    status: [...STATUSES, ALL],
    reason: REASONS,
    conclusion: ['PASS', 'FAIL'],
    overdue: ['true', 'false'],
  },
  dates: ['from', 'to'],
  texts: ['q'],
};

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

/** An `IndicatorValue` (`612.000000`) as people read it: trailing zeros dropped, the locale's separators. */
export function indicatorText(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return formatDecimal(trimmed, LOCALE);
}

/** A typed value as a wire decimal (`0,15` → `0.15`); `null` when it is not a plain number (no sign, no exponent). */
export function decimalOf(text: string): string | null {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1]!;
}
/** The contract's `Decimal`: up to 8 integer digits and 6 decimals. */
const DECIMAL = /^\d{1,8}(\.\d{1,6})?$/;
const validDecimal = (text: string) => {
  const d = decimalOf(text);
  return d !== null && DECIMAL.test(d) ? d : null;
};

/** Live BR-02 of one value against its norm (the domain's comparison); `null` while it is not a number yet. */
export function exceeds(norm: Norm, text: string): boolean | null {
  const value = validDecimal(text);
  if (value === null) return null;
  const r = concludeLabTest({ results: [{ indicatorId: norm.indicatorId, value, maxValue: norm.maxValue }] });
  return 'error' in r ? null : r.conclusion === 'FAIL';
}

/** The conclusion the values would get (BR-02): FAIL as soon as one value is over its norm, PASS once every value is
 * a number within its norm, otherwise not known yet. */
export function previewConclusion(norms: readonly Norm[], values: Record<string, string>): Conclusion | null {
  const typed = norms.flatMap((n) => {
    const value = validDecimal(values[n.indicatorId] ?? '');
    return value === null ? [] : [{ indicatorId: n.indicatorId, value, maxValue: n.maxValue }];
  });
  const r = concludeLabTest({ results: typed });
  if ('error' in r) return null;
  if (r.conclusion === 'FAIL') return 'FAIL';
  return typed.length === norms.length ? 'PASS' : null;
}

function StatusChip({ status, size }: { status: Status; size?: 'l' }) {
  return (
    <Chip tone={LAB_STATUS_TONE[status]} size={size}>
      {enumLabel(t, 'LabTestStatus', status)}
    </Chip>
  );
}

function ConclusionChip({ conclusion }: { conclusion: Conclusion }) {
  return <Chip tone={CONCLUSION_TONE[conclusion]}>{enumLabel(t, 'LabConclusion', conclusion)}</Chip>;
}

function Due({ test }: { test: Pick<ListItem, 'dueAt' | 'overdue'> }) {
  return (
    <>
      {at(test.dueAt)}
      {test.overdue && (
        <>
          {' '}
          <Chip tone="danger">{t('labTests.overdue')}</Chip>
        </>
      )}
    </>
  );
}

// ── /lab/tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function LabTestsPage() {
  const { api } = useSession();
  const list = useListParams('/lab/tests', SPEC);
  const q = list.get('q');
  const statusParam = list.params.getAll('status');
  // No `status` in the URL — the active tests; `all` — every status; otherwise the chosen ones.
  const status: string[] = statusParam.includes(ALL) ? [ALL] : statusParam;
  const sentStatus: readonly Status[] =
    status[0] === ALL ? [] : status.length ? (status as Status[]) : ACTIVE;
  const reason = list.params.getAll('reason');
  const conclusion = list.get('conclusion');
  const overdue = list.get('overdue');
  const from = list.get('from');
  const to = list.get('to');
  const sort = list.sort;
  const count =
    (status.length ? 1 : 0) +
    (reason.length ? 1 : 0) +
    [conclusion, overdue, from, to].filter(Boolean).length;
  // Only «Все» chosen (nothing else narrows the list): an empty answer is simply an empty queue.
  const allOnly = status[0] === ALL && !q && count === 1;
  // `all` with other statuses (a hand-made link) is just `all`: the URL says what is shown.
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
    queryKey: [
      'labTests',
      { page: list.page, sort: list.params.get('sort'), q, status, reason, conclusion, overdue, from, to },
    ],
    meta: { failed: 'lab.failed' },
    queryFn: () =>
      call<Schemas['LabTestPage']>(
        api.GET('/lab-tests', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(sentStatus.length ? { status: [...sentStatus] } : {}),
              ...(reason.length ? { reason: reason as Reason[] } : {}),
              ...(conclusion ? { conclusion: conclusion as Conclusion } : {}),
              ...(overdue ? { overdue: overdue === 'true' } : {}),
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

  const columns: Column<ListItem>[] = [
    {
      key: 'batch',
      header: t('lab.batch'),
      primary: true,
      cell: (x) => (
        <TablePrimary to={`/lab/tests/${x.id}`} code={x.batch.publicCode} sub={x.batch.product.name} />
      ),
    },
    {
      key: 'status',
      header: t('labTests.status'),
      status: true,
      cell: (x) => <StatusChip status={x.status} />,
    },
    { key: 'reason', header: t('labTests.reason'), cell: (x) => enumLabel(t, 'LabTestReason', x.reason) },
    { key: 'due', header: t('labTests.dueAt'), sortField: 'dueAt', cell: (x) => <Due test={x} /> },
    { key: 'created', header: t('lab.createdAt'), sortField: 'createdAt', cell: (x) => at(x.createdAt) },
    {
      // The conclusion with its moment (sorted by the completion time, x-sort).
      key: 'conclusion',
      header: t('labTests.conclusion'),
      sortField: 'completedAt',
      cell: (x) =>
        x.conclusion ? (
          <span className="at-table__primary">
            <ConclusionChip conclusion={x.conclusion} />
            {x.completedAt && <span className="at-table__sub">{at(x.completedAt)}</span>}
          </span>
        ) : (
          '—'
        ),
    },
  ];

  /** A single select over a repeatable filter; several values from a link show as «Несколько (N)». */
  const multi = (key: 'reason', values: string[], all: readonly string[], enumName: string) => (
    <Select
      value={values.length === 1 ? values[0] : values.length > 1 ? SEVERAL : ''}
      onChange={(e) => list.set({ [key]: e.target.value })}
    >
      <option value="">{t('filters.any')}</option>
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

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('lab.failed')}
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
            <Empty art="empty-lab" text={t('lab.empty')} />
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
              art="empty-lab"
              text={t('lab.empty')}
              action={
                <Button variant="primary" onClick={() => list.set({ status: ALL })}>
                  {t('lab.showAll')}
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
          caption={t('page.labTests')}
          columns={columns}
          rows={items}
          rowKey={(x) => x.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'dueAt,asc', label: t('lab.sort.due') },
            { value: 'createdAt,desc', label: t('lab.sort.created') },
            { value: 'completedAt,desc', label: t('lab.sort.completed') },
          ]}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page title={t('page.labTests')}>
      <PageToolbar
        search={{
          label: t('lab.search'),
          placeholder: t('lab.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-status" label={t('labTests.status')}>
              <Select
                value={status.length === 1 ? status[0] : status.length > 1 ? SEVERAL : ''}
                onChange={(e) => list.set({ status: e.target.value })}
              >
                <option value="">{t('lab.active')}</option>
                <option value={ALL}>{t('filters.any')}</option>
                {status.length > 1 && (
                  <option value={SEVERAL} disabled>
                    {t('filters.several', { count: status.length })}
                  </option>
                )}
                {STATUSES.map((v) => (
                  <option key={v} value={v}>
                    {enumLabel(t, 'LabTestStatus', v)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="filter-reason" label={t('labTests.reason')}>
              {multi('reason', reason, REASONS, 'LabTestReason')}
            </Field>
            <Field id="filter-conclusion" label={t('labTests.conclusion')}>
              <Select value={conclusion} onChange={(e) => list.set({ conclusion: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                <option value="PASS">{enumLabel(t, 'LabConclusion', 'PASS')}</option>
                <option value="FAIL">{enumLabel(t, 'LabConclusion', 'FAIL')}</option>
              </Select>
            </Field>
            <Field id="filter-overdue" label={t('lab.overdueFilter')}>
              <Select value={overdue} onChange={(e) => list.set({ overdue: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                <option value="true">{t('lab.overdueOnly')}</option>
                <option value="false">{t('lab.overdueNone')}</option>
              </Select>
            </Field>
            <DateFilter
              id="filter-from"
              label={t('lab.from')}
              value={from}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="filter-to"
              label={t('lab.to')}
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

// ── /lab/tests/:id ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Failures of the card's actions (FM13): the text, a re-read when the card is stale (VERSION_CONFLICT,
 * INVALID_TRANSITION, gone), one page-level message at a time, and — after the re-read — the focus on the page title
 * when the focused control went away. */
function useLabProblems(id: string) {
  const queryClient = useQueryClient();
  const alert = useFormAlert();
  const refocus = useRef(false);
  const reread = () => {
    refocus.current = true;
    void queryClient.invalidateQueries({ queryKey: ['labTest', id] });
    void queryClient.invalidateQueries({ queryKey: ['labTests'] });
  };
  const describe = (e: unknown): { text: string; tone: 'danger' | 'attention' } => {
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      reread();
      return { text: t('lab.versionConflict'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      reread();
      const from = String(e.params?.from ?? '');
      return { text: t('lab.stateChanged', { status: enumLabel(t, 'LabTestStatus', from) }), tone: 'danger' };
    }
    // The indicator set no longer matches the norms (a norm was added or removed meanwhile): the card is read again
    // like a version conflict (ruling FM20); the values of the norms that stayed are kept.
    if (isNormsMismatch(e)) {
      reread();
      return { text: t('lab.normsChanged'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.status === 404) reread();
    return { text: errorText(e), tone: errorTone(e) };
  };
  return {
    alert,
    refocus,
    /** Describes the failure (re-reading when stale) without showing it — a dialog says it (README «Диалог»). */
    describe,
    /** Describes the failure (re-reading when stale) and shows it as the page message. */
    fail: (e: unknown) => {
      const p = describe(e);
      alert.show(p.text, p.tone);
      return p;
    },
  };
}
type Problems = ReturnType<typeof useLabProblems>;

const isNormsMismatch = (e: unknown) =>
  e instanceof ApiProblem &&
  e.code === 'VALIDATION' &&
  Boolean(e.errors?.results?.includes('validation.results.mismatch'));

export function LabTestPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const problems = useLabProblems(id);
  const [sampling, setSampling] = useState(false);
  const [sampleWait, startSampleWait] = useCountdown();
  const sampleRef = useFocusAfterWait(sampleWait);

  const query = useQuery({
    queryKey: ['labTest', id],
    meta: { failed: 'lab.testFailed' },
    queryFn: () => call<LabTest>(api.GET('/lab-tests/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const test = query.data;
  const can = (a: Schemas['LabTestActionName']) => Boolean(test?.actions.includes(a));

  // After a re-read the focused control may be gone: the focus goes to the page title (FM13). The flag is spent by
  // each finished read (the fetch time, not the data: an identical answer keeps the same object).
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

  const changed = (next: LabTest) => {
    cache.set(['labTest', next.id], next);
    void queryClient.invalidateQueries({ queryKey: ['labTests'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['batch'] });
  };

  if (!test && notFound(query.error))
    return (
      <Page title={t('page.labTest')}>
        <Card>
          <Empty
            art="not-found"
            text={t('lab.notFound')}
            action={
              <ButtonLink variant="primary" to="/lab/tests">
                {t('lab.toList')}
              </ButtonLink>
            }
          />
        </Card>
      </Page>
    );

  const sample = async (x: LabTest) => {
    problems.alert.clear();
    setSampling(true);
    try {
      const next = await call<LabTest>(
        api.POST('/lab-tests/{id}/sample', {
          params: { path: { id: x.id }, header: { 'If-Match': x.version } },
          body: {},
        }),
      );
      changed(next);
      toast.done({ tone: 'ok', text: t('lab.sampled', { code: x.batch.publicCode }) });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) startSampleWait(retryAfterOf(e));
      problems.fail(e);
    } finally {
      setSampling(false);
    }
  };

  const results = () => {
    if (!test) return null;
    if (!can('submitResults')) return <ResultsTable test={test} />;
    if (test.norms.length === 0)
      return (
        <Card>
          <CardHeader title={t('lab.results')} />
          <CardBody>
            <p style={{ margin: 0 }}>{t('lab.noNorms')}</p>
          </CardBody>
        </Card>
      );
    // Keyed by the test only: a re-read after a conflict or a changed set of norms keeps what was typed for the norms
    // that stayed (FM13, FM20); another test (same route, new id) starts empty.
    return <ResultsForm key={test.id} test={test} problems={problems} onDone={changed} />;
  };

  return (
    <Page
      title={test ? t('lab.title', { code: test.batch.publicCode }) : t('page.labTest')}
      actions={
        test &&
        can('sample') && (
          <Button
            ref={sampleRef}
            variant="primary"
            icon="flask"
            busy={sampling}
            disabled={sampleWait > 0}
            onClick={() => void sample(test)}
          >
            {sampleWait > 0 ? t('auth.retryIn', { seconds: sampleWait }) : t('lab.sample')}
          </Button>
        )
      }
    >
      {!test && query.isError ? (
        <LoadFailed text={t('lab.testFailed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
      ) : !test ? (
        <AreaLoading />
      ) : (
        <div style={GAP}>
          <LabSummary test={test} />
          {results()}
          <ProtocolCard test={test} canUpload={can('uploadProtocol')} />
        </div>
      )}
    </Page>
  );
}

function LabSummary({ test }: { test: LabTest }) {
  const facts = [
    {
      key: 'batch',
      term: t('lab.batch'),
      value: (
        <Link className="at-mono" to={`/batches/${test.batch.id}`}>
          {test.batch.publicCode}
        </Link>
      ),
    },
    { key: 'lab', term: t('labTests.lab'), value: test.lab.name },
    { key: 'reason', term: t('labTests.reason'), value: enumLabel(t, 'LabTestReason', test.reason) },
    { key: 'created', term: t('lab.createdAt'), value: at(test.createdAt) },
    { key: 'due', term: t('labTests.dueAt'), value: <Due test={test} /> },
    ...(test.sampledAt ? [{ key: 'sampled', term: t('lab.sampledAt'), value: at(test.sampledAt) }] : []),
    ...(test.escalatedAt
      ? [{ key: 'escalated', term: t('lab.escalatedAt'), value: at(test.escalatedAt) }]
      : []),
    ...(test.completedAt
      ? [{ key: 'completed', term: t('lab.completedAt'), value: at(test.completedAt) }]
      : []),
    ...(test.conclusion
      ? [
          {
            key: 'conclusion',
            term: t('labTests.conclusion'),
            value: <ConclusionChip conclusion={test.conclusion} />,
          },
        ]
      : []),
  ];
  return (
    <Card>
      <CardHeader title={test.batch.product.name}>
        <StatusChip status={test.status} size="l" />
      </CardHeader>
      <CardBody>
        <CardFacts facts={facts} />
      </CardBody>
    </Card>
  );
}

const normText = (maxValue: string, unit: string) =>
  t('lab.normValue', { value: indicatorText(maxValue), unit });

function Assessment({ exceeded }: { exceeded: boolean }) {
  return exceeded ? <Chip tone="danger">{t('lab.exceeded')}</Chip> : <Chip tone="ok">{t('lab.within')}</Chip>;
}

/** The results the server stored (DONE: values, the norm at that time, its own assessment); before that — the norms. */
function ResultsTable({ test }: { test: LabTest }) {
  if (test.results.length === 0 && test.norms.length === 0) return null;
  const table =
    test.results.length === 0 ? (
      <Table
        cards
        caption={t('lab.results')}
        columns={
          [
            { key: 'name', header: t('lab.indicator'), primary: true, cell: (n) => n.name },
            { key: 'norm', header: t('lab.norm'), cell: (n) => normText(n.maxValue, n.unit) },
          ] satisfies Column<Norm>[]
        }
        rows={test.norms}
        rowKey={(n) => n.indicatorId}
      />
    ) : (
      <Table
        cards
        caption={t('lab.results')}
        columns={
          [
            { key: 'name', header: t('lab.indicator'), primary: true, cell: (r) => r.name },
            {
              key: 'assessment',
              header: t('lab.assessment'),
              status: true,
              cell: (r) => <Assessment exceeded={r.isExceeded} />,
            },
            {
              key: 'value',
              header: t('lab.value'),
              numeric: true,
              cell: (r) => `${indicatorText(r.value)} ${r.unit}`,
            },
            { key: 'norm', header: t('lab.norm'), cell: (r) => normText(r.normValue, r.unit) },
          ] satisfies Column<Result>[]
        }
        rows={test.results}
        rowKey={(r) => r.indicatorId}
      />
    );
  return (
    <Card>
      <CardHeader title={t('lab.results')} />
      <CardBody>{table}</CardBody>
    </Card>
  );
}

interface ResultValues {
  values: Record<string, string>;
}
type FieldError = { type: string; message: string };
const fieldError = (message: string): FieldError => ({ type: 'validate', message });

function ResultsForm({
  test,
  problems,
  onDone,
}: {
  test: LabTest;
  problems: Problems;
  onDone: (next: LabTest) => void;
}) {
  const { api } = useSession();
  const toast = useScreenToast();
  const norms = test.norms;
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const submitRef = useFocusAfterWait(wait);
  const [confirming, setConfirming] = useState<ResultValues | null>(null);
  // The norms of the card as it is now (a re-read may change them; the form, not keyed, keeps its values).
  const current = useRef(norms);
  current.current = norms;

  // The request lists the norms in their order: server paths `results[i]` point back to them.
  const toBody = (v: ResultValues) => ({
    results: current.current.map((n) => ({
      indicatorId: n.indicatorId,
      value: decimalOf(v.values[n.indicatorId] ?? '') ?? v.values[n.indicatorId] ?? '',
    })),
  });

  const resolver: Resolver<ResultValues> = async (values) => {
    const errs: Record<string, FieldError> = {};
    for (const n of current.current)
      if ((values.values[n.indicatorId] ?? '').trim() === '')
        errs[n.indicatorId] = fieldError('validation.required');
    const res = LabResultsInputSchema.safeParse(toBody(values));
    for (const issue of res.success ? [] : res.error.issues) {
      const [head, index] = issue.path;
      const norm = head === 'results' && typeof index === 'number' ? current.current[index] : undefined;
      if (norm) errs[norm.indicatorId] ??= fieldError(issue.message);
    }
    if (Object.keys(errs).length === 0) return { values, errors: {} };
    return { values: {}, errors: { values: errs } as unknown as FieldErrors<ResultValues> };
  };

  const form = useForm<ResultValues>({
    resolver,
    defaultValues: { values: Object.fromEntries(norms.map((n) => [n.indicatorId, ''])) },
  });
  // RHF's watch() hands back the same (mutated) object: the live check reads a copy each render.
  const snapshot = { ...form.watch('values') };
  const preview = previewConclusion(norms, snapshot);
  // The FAIL confirmation holds the values it was opened with: it stays only while they still cover every current norm
  // with a number and still conclude FAIL. A re-read that changed the norms (a conflict, FM20 mismatch) closes it —
  // confirming then would send an empty value for a new norm.
  const covered =
    confirming !== null &&
    norms.every((n) => validDecimal(confirming.values[n.indicatorId] ?? '') !== null) &&
    previewConclusion(norms, confirming.values) === 'FAIL';
  // The failure of a confirmation is said in its dialog only (README «Диалог»); closed with it still standing —
  // by the person or by such a re-read — the page says it.
  const failure = useDialogAlert();
  const { handOff } = failure;
  useEffect(() => {
    if (!confirming || covered) return;
    handOff();
    setConfirming(null);
  }, [confirming, covered, handOff]);
  // A changed set of norms: the first norm still without a value gets the focus (after a closing dialog returned
  // its own; ruling FM24 — the newly revealed field).
  const normSet = norms.map((n) => n.indicatorId).join();
  const seenSet = useRef(normSet);
  useEffect(() => {
    if (seenSet.current === normSet) return;
    seenSet.current = normSet;
    const empty = current.current.find((n) => !(form.getValues(`values.${n.indicatorId}`) ?? '').trim());
    if (!empty) return;
    // FM25: only if the focus is idle — on the body, gone, or on the button that sent the values.
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (
        !active ||
        active === document.body ||
        !active.isConnected ||
        active === submitRef.current ||
        active.matches('h1.at-page__title')
      )
        form.setFocus(`values.${empty.indicatorId}`);
    }, 0);
    return () => clearTimeout(timer);
  }, [normSet, form, submitRef]);

  /** Sends the values; from the confirmation dialog (`inDialog`) a failure is said in it (it stays open). */
  const send = async (v: ResultValues, inDialog = false): Promise<void> => {
    problems.alert.clear();
    failure.clear();
    setBusy(true);
    const body = toBody(v) as Schemas['LabResultsInput'];
    try {
      // The version of the card as it is now (a re-read after a conflict brings a new one).
      const next = await call<LabTest>(
        api.POST('/lab-tests/{id}/results', {
          params: { path: { id: test.id }, header: { 'If-Match': test.version } },
          body,
        }),
      );
      setConfirming(null);
      onDone(next);
      toast.done({
        tone: 'ok',
        text:
          next.conclusion === 'FAIL'
            ? t('lab.submittedRecall', { code: next.batch.publicCode })
            : t('lab.submitted', { conclusion: enumLabel(t, 'LabConclusion', next.conclusion ?? 'PASS') }),
      });
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'VALIDATION' && !isNormsMismatch(e)) {
        setConfirming(null);
        applyProblem(e, {
          form,
          fields: norms.map((n) => `values.${n.indicatorId}` as const),
          alert: problems.alert.show,
          alias: (path) => {
            const m = /^results\[(\d+)\]\.value$/.exec(path);
            const norm = m ? norms[Number(m[1])] : undefined;
            return norm ? `values.${norm.indicatorId}` : path;
          },
        });
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      if (!inDialog) {
        problems.fail(e);
        return;
      }
      const p = problems.describe(e);
      failure.show(p.text, p.tone);
    } finally {
      setBusy(false);
    }
  };

  const submit = form.handleSubmit(async (v) => {
    // A FAIL starts a recall of the batch and its derived batches: confirmed with the batch code (spec §9.3).
    if (previewConclusion(norms, v.values) === 'FAIL') setConfirming({ values: { ...v.values } });
    else await send(v);
  });

  const columns: Column<Norm>[] = [
    { key: 'name', header: t('lab.indicator'), primary: true, cell: (n) => n.name },
    {
      key: 'assessment',
      header: t('lab.assessment'),
      status: true,
      cell: (n) => {
        const over = exceeds(n, snapshot[n.indicatorId] ?? '');
        return over === null ? null : <Assessment exceeded={over} />;
      },
    },
    { key: 'norm', header: t('lab.norm'), cell: (n) => normText(n.maxValue, n.unit) },
    {
      key: 'value',
      header: t('lab.value'),
      cell: (n) => {
        const message = form.formState.errors.values?.[n.indicatorId]?.message;
        return (
          <CellField id={`value-${n.indicatorId}`} error={message ? t(message) : null}>
            <InputGroup
              suffix={n.unit}
              inputMode="decimal"
              autoComplete="off"
              aria-label={t('lab.valueOf', { name: n.name })}
              {...form.register(`values.${n.indicatorId}`)}
            />
          </CellField>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader title={t('lab.results')} />
      <CardBody>
        <form id="lab-results" noValidate onSubmit={(e) => void submit(e)} style={STACK}>
          <Table
            cards
            caption={t('lab.results')}
            columns={columns}
            rows={norms}
            rowKey={(n) => n.indicatorId}
          />
          {/* The conclusion the values would get (BR-02, the domain's rule), read out politely. */}
          <div aria-live="polite">
            {preview && (
              <p className={preview === 'FAIL' ? 'at-field__warning' : undefined} style={{ margin: 0 }}>
                {t('lab.preview', { conclusion: enumLabel(t, 'LabConclusion', preview) })}
              </p>
            )}
          </div>
        </form>
      </CardBody>
      <CardFooter>
        <Submit ref={submitRef} busy={busy && !confirming} wait={wait} form="lab-results">
          {t('action.submitResults')}
        </Submit>
      </CardFooter>
      <FailDialog
        open={confirming !== null}
        test={test}
        busy={busy}
        wait={wait}
        message={failure.message}
        onClose={() => {
          failure.handOff();
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming && covered) void send(confirming, true);
        }}
      />
    </Card>
  );
}

/** A FAIL is a recall (FR-QA-05): its own dialog with the batch code repeated (spec §9.3, README «Диалог»). A failure
 * stays in the dialog (the page's toast region is behind it); any close clears what was typed. */
function FailDialog({
  open,
  test,
  busy,
  wait,
  message,
  onClose,
  onConfirm,
}: {
  open: boolean;
  test: LabTest;
  busy: boolean;
  wait: number;
  /** The failure of the last attempt, said in the dialog. */
  message: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [code, setCode] = useState('');
  const confirmRef = useFocusAfterWait(wait);
  const matches = test.batch.publicCode !== '' && code.trim().toUpperCase() === test.batch.publicCode;
  useEffect(() => {
    if (!open) setCode('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('lab.failTitle', { code: test.batch.publicCode })}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="danger"
            busy={busy}
            disabled={!matches || wait > 0}
            onClick={onConfirm}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('lab.failSubmit')}
          </Button>
        </>
      }
    >
      <div style={STACK}>
        <DialogMessage text={message} />
        <p style={{ margin: 0 }}>{t('lab.failText')}</p>
        <Field id="fail-code" label={t('lab.failConfirm')}>
          <Input mono autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ── Protocol (FR-QA-04) ──────────────────────────────────────────────────────────────────────────────────────────────

const isPdf = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });
const unsupportedText = () => t('files.unsupported', { allowed: 'PDF' });

function ProtocolCard({ test, canUpload }: { test: LabTest; canUpload: boolean }) {
  const { api } = useSession();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const alert = useFormAlert();
  const [picked, setPicked] = useState<{ file: File; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const uploadRef = useFocusAfterWait(wait);
  const protocol = test.protocol;

  // The server checks the PDF signature and the size again (415 / 413); the client says it before sending.
  const pick = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!isPdf(file)) error = unsupportedText();
    else if (file.size > PROTOCOL_MAX_BYTES) error = tooLargeText(PROTOCOL_MAX_BYTES);
    setPicked({ file, error });
  };

  const upload = async () => {
    if (!picked || picked.error) return;
    alert.clear();
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', picked.file);
      await call(
        api.PUT('/lab-tests/{id}/protocol', { params: { path: { id: test.id } }, body: body as never }),
      );
      setPicked(null);
      await queryClient.invalidateQueries({ queryKey: ['labTest', test.id] });
      void queryClient.invalidateQueries({ queryKey: ['labTests'] });
      toast.done({ tone: 'ok', text: t('lab.protocolSaved') });
    } catch (e) {
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.maxBytes) || PROTOCOL_MAX_BYTES);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE') error = unsupportedText();
      else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.file?.[0])
        error = t(e.errors.file[0]);
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      // The file says what is wrong with it; the page says it too (the toast region reads it out).
      if (error) setPicked((p) => (p ? { ...p, error } : p));
      alert.show(error ?? errorText(e), error ? 'danger' : errorTone(e));
    } finally {
      setBusy(false);
    }
  };

  if (!protocol && !canUpload) return null;
  const items: FileItem[] = picked
    ? [
        {
          key: 'protocol',
          name: picked.file.name,
          sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
          error: Boolean(picked.error),
          kind: 'PDF',
          ...(busy ? { progress: null } : {}),
        },
      ]
    : [];
  return (
    <Card>
      <CardHeader title={t('lab.protocol')} />
      <CardBody>
        <div style={STACK}>
          {protocol ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)', alignItems: 'center' }}>
              <ButtonAnchor variant="secondary" icon="download" href={protocol.url}>
                {t('lab.protocolDownload')}
              </ButtonAnchor>
              <span className="at-table__sub">
                {protocol.originalName}, {formatBytes(protocol.sizeBytes, LOCALE)}
              </span>
            </div>
          ) : (
            <p style={{ margin: 0 }}>{t('lab.protocolNone')}</p>
          )}
          {canUpload && (
            <FileField
              id="protocol-file"
              label={t('field.file')}
              accept="application/pdf,.pdf"
              hint={t('lab.protocolHint')}
              files={items}
              onFiles={pick}
              onRemove={() => setPicked(null)}
              error={picked?.error}
              disabled={busy}
            />
          )}
        </div>
      </CardBody>
      {canUpload && picked && !picked.error && (
        <CardFooter>
          <Button
            ref={uploadRef}
            variant="primary"
            icon="upload"
            busy={busy}
            disabled={wait > 0}
            onClick={() => void upload()}
          >
            {wait > 0
              ? t('auth.retryIn', { seconds: wait })
              : protocol
                ? t('lab.protocolReplace')
                : t('action.upload')}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
