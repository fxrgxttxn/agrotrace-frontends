import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
import { ComplaintDecisionSchema } from '@agrotrace/validation';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useDialogAlert,
  useFocusAfterWait,
} from '../app/api';
import { useCacheWriter, useScreenToast } from '../app/cache';
import { CodeConfirmDialog } from '../app/CodeConfirm';
import { DateFilter } from '../app/DateFilter';
import { errorOf, FORM_GRID, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { OrgPicker } from '../app/OrgPicker';
import { complaintActions, COMPLAINT_TONE } from '../app/recalls';
import { useSession } from '../app/session';
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
  Empty,
  Field,
  FieldSet,
  ListChanged,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Radio,
  Select,
  Table,
  TablePrimary,
  Textarea,
  type Column,
} from '../ui';

type Complaint = Schemas['Complaint'];
type Item = Schemas['ComplaintListItem'];
type Status = Schemas['ComplaintStatus'];
type Decision = Schemas['ComplaintDecisionType'];

const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const SEVERAL = '__several';
const STATUSES: readonly Status[] = ['NEW', 'IN_REVIEW', 'DECIDED'];
const DECISIONS: readonly Decision[] = ['REJECT', 'LAB_TEST', 'RECALL'];

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

function StatusChip({ status, size }: { status: Status; size?: 'l' }) {
  return (
    <Chip tone={COMPLAINT_TONE[status]} size={size}>
      {enumLabel(t, 'ComplaintStatus', status)}
    </Chip>
  );
}

const SPEC: ListSpec = {
  sort: ['createdAt', 'decidedAt'],
  enums: { status: STATUSES, decision: DECISIONS },
  dates: ['from', 'to'],
  texts: ['q'],
};

export function ComplaintsPage() {
  const { api } = useSession();
  const list = useListParams('/complaints', SPEC);
  const q = list.get('q');
  const status = list.params.getAll('status');
  const decision = list.params.getAll('decision');
  const from = list.get('from');
  const to = list.get('to');
  const sort = list.sort;
  const count = (status.length ? 1 : 0) + (decision.length ? 1 : 0) + [from, to].filter(Boolean).length;

  const query = useQuery({
    queryKey: [
      'complaints',
      { page: list.page, sort: list.params.get('sort'), q, status, decision, from, to },
    ],
    meta: { failed: 'complaints.failed' },
    queryFn: () =>
      call<Schemas['ComplaintPage']>(
        api.GET('/complaints', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(status.length ? { status: status as Status[] } : {}),
              ...(decision.length ? { decision: decision as Decision[] } : {}),
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

  const columns: Column<Item>[] = [
    {
      key: 'batch',
      header: t('complaints.batch'),
      primary: true,
      cell: (x) => (
        <TablePrimary to={`/complaints/${x.id}`} code={x.batch.publicCode} sub={x.batch.product.name} />
      ),
    },
    {
      key: 'status',
      header: t('complaints.status'),
      status: true,
      cell: (x) => <StatusChip status={x.status} />,
    },
    { key: 'text', header: t('complaints.text'), cell: (x) => x.text },
    {
      key: 'decision',
      header: t('complaints.decision'),
      sortField: 'decidedAt',
      cell: (x) =>
        x.decision ? (
          <span className="at-table__primary">
            <span>{enumLabel(t, 'ComplaintDecisionType', x.decision)}</span>
            {x.decidedAt && <span className="at-table__sub">{at(x.decidedAt)}</span>}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'created',
      header: t('complaints.createdAt'),
      sortField: 'createdAt',
      cell: (x) => at(x.createdAt),
    },
  ];

  const multi = (key: 'status' | 'decision', values: string[], all: readonly string[], enumName: string) => (
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
          text={t('complaints.failed')}
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
            <Empty art="empty-complaints" text={t('empty.complaints')} />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={t('page.complaints')}
          columns={columns}
          rows={items}
          rowKey={(x) => x.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'createdAt,desc', label: t('complaints.sort.created') },
            { value: 'decidedAt,desc', label: t('complaints.sort.decided') },
          ]}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page title={t('page.complaints')}>
      <PageToolbar
        search={{
          label: t('complaints.search'),
          placeholder: t('complaints.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          <>
            <Field id="filter-status" label={t('complaints.status')}>
              {multi('status', status, STATUSES, 'ComplaintStatus')}
            </Field>
            <Field id="filter-decision" label={t('complaints.decision')}>
              {multi('decision', decision, DECISIONS, 'ComplaintDecisionType')}
            </Field>
            <DateFilter
              id="filter-from"
              label={t('complaints.from')}
              value={from}
              max={to || undefined}
              onChange={(v) => list.set({ from: v })}
            />
            <DateFilter
              id="filter-to"
              label={t('complaints.to')}
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

export function ComplaintPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const toast = useScreenToast();
  const [reviewing, setReviewing] = useState(false);
  const [reviewWait, startReviewWait] = useCountdown();
  const reviewRef = useFocusAfterWait(reviewWait);
  const refocus = useRef(false);

  const query = useQuery({
    queryKey: ['complaint', id],
    meta: { failed: 'complaints.cardFailed' },
    queryFn: () => call<Complaint>(api.GET('/complaints/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const complaint = query.data;

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
  }, [readAt]);

  const changed = (next: Complaint) => {
    cache.set(['complaint', next.id], next);
    void queryClient.invalidateQueries({ queryKey: ['complaints'] });
  };
  const describe = (e: unknown): string => {
    if (e instanceof ApiProblem && (e.code === 'INVALID_TRANSITION' || e.status === 404)) {
      refocus.current = true;
      void queryClient.invalidateQueries({ queryKey: ['complaint', id] });
      void queryClient.invalidateQueries({ queryKey: ['complaints'] });
      if (e.code === 'INVALID_TRANSITION')
        return t('complaints.stateChanged', {
          status: enumLabel(t, 'ComplaintStatus', String(e.params?.from ?? '')),
        });
    }
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      refocus.current = true;
      void queryClient.invalidateQueries({ queryKey: ['complaint', id] });
      return t('complaints.versionConflict');
    }
    return errorText(e);
  };

  if (!complaint && notFound(query.error))
    return (
      <Page title={t('page.complaint')}>
        <Card>
          <Empty
            art="not-found"
            text={t('complaints.notFound')}
            action={
              <ButtonLink variant="primary" to="/complaints">
                {t('complaints.toList')}
              </ButtonLink>
            }
          />
        </Card>
      </Page>
    );

  const can = complaint ? complaintActions(complaint.status) : [];
  const review = async (c: Complaint) => {
    setReviewing(true);
    try {
      const next = await call<Complaint>(
        api.POST('/complaints/{id}/review', { params: { path: { id: c.id } }, body: {} }),
      );
      changed(next);
      toast.done({ tone: 'ok', text: t('complaints.reviewed') });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) startReviewWait(retryAfterOf(e));
      toast.push({ tone: errorTone(e), text: describe(e) });
    } finally {
      setReviewing(false);
    }
  };

  return (
    <Page
      title={complaint ? t('complaints.title', { code: complaint.batch.publicCode }) : t('page.complaint')}
      actions={
        complaint &&
        can.includes('review') && (
          <Button
            ref={reviewRef}
            variant="primary"
            busy={reviewing}
            disabled={reviewWait > 0}
            onClick={() => void review(complaint)}
          >
            {reviewWait > 0 ? t('auth.retryIn', { seconds: reviewWait }) : t('complaints.review')}
          </Button>
        )
      }
    >
      {!complaint && query.isError ? (
        <LoadFailed
          text={t('complaints.cardFailed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : !complaint ? (
        <AreaLoading />
      ) : (
        <div style={GAP}>
          <ComplaintSummary complaint={complaint} />
          {can.includes('decide') && (
            <DecisionCard key={complaint.id} complaint={complaint} describe={describe} onDone={changed} />
          )}
        </div>
      )}
    </Page>
  );
}

function ComplaintSummary({ complaint }: { complaint: Complaint }) {
  const c = complaint;
  const facts = [
    {
      key: 'batch',
      term: t('complaints.batch'),
      value: (
        <Link className="at-mono" to={`/batches/${c.batch.id}`}>
          {c.batch.publicCode}
        </Link>
      ),
    },
    { key: 'created', term: t('complaints.createdAt'), value: at(c.createdAt) },
    { key: 'contact', term: t('complaints.contact'), value: c.contact ?? t('complaints.noContact') },
    ...(c.inspector
      ? [{ key: 'inspector', term: t('complaints.inspector'), value: c.inspector.fullName }]
      : []),
    ...(c.decision
      ? [
          {
            key: 'decision',
            term: t('complaints.decision'),
            value: enumLabel(t, 'ComplaintDecisionType', c.decision),
          },
        ]
      : []),
    ...(c.decidedAt ? [{ key: 'decided', term: t('complaints.decidedAt'), value: at(c.decidedAt) }] : []),
    ...(c.recallId
      ? [
          {
            key: 'recall',
            term: t('page.recall'),
            value: <Link to={`/recalls/${c.recallId}`}>{t('complaints.recallLink')}</Link>,
          },
        ]
      : []),
    ...(c.labTestId
      ? [
          {
            key: 'lab',
            term: t('recalls.labTest'),
            value: <Link to={`/batches/${c.batch.id}?tab=tests`}>{t('complaints.labLink')}</Link>,
          },
        ]
      : []),
  ];
  return (
    <Card>
      <CardHeader title={c.batch.product.name}>
        <StatusChip status={c.status} size="l" />
      </CardHeader>
      <CardBody>
        <div style={STACK}>
          <dl className="at-card__facts">
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>{t('complaints.text')}</dt>
              <dd style={{ whiteSpace: 'pre-line' }}>{c.text}</dd>
            </div>
            {c.decisionComment && (
              <div style={{ gridColumn: '1 / -1' }}>
                <dt>{t('complaints.comment')}</dt>
                <dd>{c.decisionComment}</dd>
              </div>
            )}
          </dl>
          <CardFacts facts={facts} />
        </div>
      </CardBody>
    </Card>
  );
}

interface DecisionValues {
  decision: Decision | '';
  comment: string;
  labOrgId: string;
  blockUpstream: boolean;
}

function toWire(v: DecisionValues) {
  if (v.decision === 'LAB_TEST') return { decision: v.decision, comment: v.comment, labOrgId: v.labOrgId };
  if (v.decision === 'RECALL')
    return { decision: v.decision, comment: v.comment, blockUpstream: v.blockUpstream };
  return { decision: v.decision, comment: v.comment };
}

const decisionSchema = wireSchema<DecisionValues>(ComplaintDecisionSchema, toWire, (v) => ({
  ...(v.decision === '' ? { decision: 'validation.required' } : {}),
  ...(v.comment.trim() === '' ? { comment: 'validation.required' } : {}),
  ...(v.decision === 'LAB_TEST' && v.labOrgId === '' ? { labOrgId: 'validation.required' } : {}),
}));

function DecisionCard({
  complaint,
  describe,
  onDone,
}: {
  complaint: Complaint;
  describe: (e: unknown) => string;
  onDone: (next: Complaint) => void;
}) {
  const { api } = useSession();
  const toast = useScreenToast();
  const { form, alert, wait, startWait, fail } = useSchemaForm<DecisionValues>(
    decisionSchema,
    { decision: '', comment: '', labOrgId: '', blockUpstream: false },
    ['decision', 'comment', 'labOrgId', 'blockUpstream'],
  );
  const decision = form.watch('decision');
  const labOrgId = form.watch('labOrgId');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<DecisionValues | null>(null);
  const failure = useDialogAlert();
  const code = complaint.batch.publicCode;

  const send = async (v: DecisionValues) => {
    const inDialog = v.decision === 'RECALL';
    setBusy(true);
    failure.clear();
    alert.clear();
    try {
      const next = await call<Complaint>(
        api.POST('/complaints/{id}/decision', {
          params: { path: { id: complaint.id } },
          body: toWire(v) as Schemas['ComplaintDecision'],
        }),
      );
      setConfirming(null);
      onDone(next);
      toast.done({ tone: 'ok', text: t(`complaints.decided.${v.decision}`, { code }) });
    } catch (e) {
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        setConfirming(null);
        fail(e);
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      const text = describe(e);
      if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
        setConfirming(null);
        toast.push({ tone: 'danger', text });
        return;
      }
      if (inDialog) failure.show(text, errorTone(e));
      else alert.show(text, errorTone(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = form.handleSubmit(
    async (v) => {
      if (v.decision === 'RECALL') {
        failure.clear();
        setConfirming(v);
      } else await send(v);
    },
    (errors) => {
      if (errors.decision) document.querySelector<HTMLInputElement>('input[name="decision"]')?.focus();
      else if (errors.comment) form.setFocus('comment');
      else if (errors.labOrgId) document.getElementById('decision-lab')?.focus();
    },
  );

  const decisionError = errorOf(form, 'decision');
  return (
    <Card>
      <CardBody>
        <form noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
          <FieldSet legend={t('complaints.decision')} error={decisionError} errorId="decision-error">
            {DECISIONS.map((d) => (
              <Radio
                key={d}
                value={d}
                aria-invalid={decisionError ? 'true' : undefined}
                aria-describedby={decisionError ? 'decision-error' : undefined}
                {...form.register('decision')}
              >
                {enumLabel(t, 'ComplaintDecisionType', d)}
              </Radio>
            ))}
          </FieldSet>
          <Field id="decision-comment" label={t('complaints.comment')} error={errorOf(form, 'comment')}>
            <Textarea rows={3} {...form.register('comment')} />
          </Field>
          {decision === 'LAB_TEST' && (
            <OrgPicker
              id="decision-lab"
              label={t('complaints.labOrg')}
              types={['LAB']}
              value={labOrgId}
              error={errorOf(form, 'labOrgId')}
              onChange={(org) =>
                form.setValue('labOrgId', org ?? '', { shouldValidate: form.formState.isSubmitted })
              }
            />
          )}
          {decision === 'RECALL' && (
            <Checkbox {...form.register('blockUpstream')}>{t('complaints.blockUpstream')}</Checkbox>
          )}
          <div>
            <Submit busy={busy && !confirming} wait={wait}>
              {decision ? t(`complaints.submit.${decision}`) : t('action.decide')}
            </Submit>
          </div>
        </form>
      </CardBody>
      <CodeConfirmDialog
        open={confirming !== null}
        title={t('complaints.confirmTitle', { code })}
        text={<p style={{ margin: 0 }}>{t('complaints.confirmText')}</p>}
        code={code}
        confirmLabel={t('complaints.submit.RECALL')}
        busy={busy}
        wait={wait}
        message={failure.message}
        onClose={() => {
          failure.handOff();
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming) void send(confirming);
        }}
      />
    </Card>
  );
}
