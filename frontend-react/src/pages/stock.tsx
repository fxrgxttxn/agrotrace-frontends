import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFieldArray, useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { availableActions, canUseAsInput, checkMassBalance, compareDecimalStrings } from '@agrotrace/domain';
import { enumLabel, formatDecimal, formatLocalDate, formatLocalDateTime, formatMass } from '@agrotrace/i18n';
import { ProcessingRequestSchema } from '@agrotrace/validation';
import {
  applyProblem,
  call,
  errorText,
  errorTone,
  useCountdown,
  useDialogAlert,
  useFormAlert,
} from '../app/api';
import { useDictionary } from '../app/dictionaries';
import { errorOf, focusFirstInvalid, FORM_GRID, normalizeDecimal, Submit } from '../app/forms';
import { useCacheWriter, useScreenNavigate, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { useMe, useSession } from '../app/session';
import {
  AreaLoading,
  Button,
  ButtonAnchor,
  ButtonLink,
  Card,
  CardBody,
  CardFacts,
  CardFooter,
  CellField,
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
  Qr,
  Select,
  Stepper,
  Table,
  TablePrimary,
  useWide,
  type Column,
} from '../ui';

type BatchItem = Schemas['BatchListItem'];
type Batch = Schemas['Batch'];
type BatchStatus = Schemas['BatchStatus'];
const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;
const MASS = /^\d{1,9}\.\d{3}$/;
const SEVERAL = '__several';

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const massText = (kg: string) => (LOCALE === 'ru' ? kg.replace('.', ',') : kg);

function useRoles() {
  const me = useMe();
  const has = (r: string) => me.roles.some((x) => x === r);
  return { me, processor: has('PROCESSOR'), retailer: has('RETAILER') };
}

function stockStatuses(processor: boolean, retailer: boolean): BatchStatus[] {
  const out = new Set<BatchStatus>();
  if (processor) ['Approved', 'Accepted'].forEach((s) => out.add(s as BatchStatus));
  if (retailer) ['Accepted', 'OnSale'].forEach((s) => out.add(s as BatchStatus));
  return [...out];
}

type Transition = 'putOnSale' | 'sell';

function useBatchTransition() {
  const { api } = useSession();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const [busy, setBusy] = useState<string | null>(null);
  const reread = () => {
    void queryClient.invalidateQueries({ queryKey: ['batches'] });
    void queryClient.invalidateQueries({ queryKey: ['batch'] });
  };
  const run = async (row: BatchItem, action: Transition) => {
    setBusy(row.id);
    const code = row.publicCode;
    try {
      const batch = await call<Batch>(api.GET('/batches/{id}', { params: { path: { id: row.id } } }));
      if (!batch.actions.some((a) => a.action === action)) {
        reread();
        toast.push({ tone: 'danger', text: t('stock.unavailable', { code }) });
        return;
      }
      const params = { path: { id: row.id }, header: { 'If-Match': batch.version } };
      const next = await call<Batch>(
        action === 'putOnSale'
          ? api.POST('/batches/{id}/on-sale', { params })
          : api.POST('/batches/{id}/sold', { params }),
      );
      cache.set(['batch', next.id], next);
      reread();
      toast.done({
        tone: 'ok',
        text: t(action === 'putOnSale' ? 'stock.putOnSale' : 'stock.sold', { code }),
      });
    } catch (e) {
      if (e instanceof ApiProblem && (e.code === 'VERSION_CONFLICT' || e.code === 'INVALID_TRANSITION')) {
        reread();
        toast.push({ tone: 'danger', text: t('stock.changed', { code }) });
      } else {
        if (e instanceof ApiProblem && (e.status === 404 || e.status === 403)) reread();
        toast.push({ tone: errorTone(e), text: errorText(e) });
      }
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

const STOCK_SPEC: ListSpec = {
  sort: ['publicCode', 'massKg', 'updatedAt'],
  enums: { status: ['Approved', 'Accepted', 'OnSale'] },
  uuids: ['productId'],
  texts: ['q'],
};

function useOwnBatches(key: string, statuses: BatchStatus[], spec: ListSpec, path: string) {
  const { api } = useSession();
  const list = useListParams(path, spec);
  const q = list.get('q');
  const chosen = list.params.getAll('status').filter((s) => statuses.includes(s as BatchStatus));
  const productId = list.get('productId');
  const sort = list.sort;
  const query = useQuery({
    queryKey: [
      'batches',
      key,
      { page: list.page, sort: list.params.get('sort'), q, chosen, productId, statuses },
    ],
    meta: { failed: 'stock.failed' },
    queryFn: () =>
      call<Schemas['BatchPage']>(
        api.GET('/batches', {
          params: {
            query: {
              holder: 'me',
              status: (chosen.length ? chosen : statuses) as BatchStatus[],
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(productId ? { productId } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const gap = query.data ? listGap(query.data, list.page, SIZE) : null;
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && gap === 'pastEnd') clampPage(query.data.total, SIZE);
  }, [query.data, gap, clampPage]);
  return { list, query, q, chosen, productId, gap, count: (chosen.length ? 1 : 0) + (productId ? 1 : 0) };
}

function listState(
  own: ReturnType<typeof useOwnBatches>,
  failed: string,
  empty: { text: string; action: ReactNode },
) {
  const { query, list, gap } = own;
  if (!query.data && query.isError)
    return (
      <LoadFailed
        text={failed}
        busy={query.isFetching}
        onRetry={() => void query.refetch()}
        onReset={isBadListQuery(query.error) ? list.reset : undefined}
      />
    );
  if (!query.data || gap === 'pastEnd') return <AreaLoading />;
  if (gap === 'changed') return <ListChanged busy={query.isFetching} onReload={() => void query.refetch()} />;
  if (query.data.items.length === 0)
    return (
      <Card>
        {own.q || own.count ? (
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
          <Empty art="empty-batches" text={empty.text} action={empty.action} />
        )}
      </Card>
    );
  return null;
}

function StatusFilter({ statuses, own }: { statuses: BatchStatus[]; own: ReturnType<typeof useOwnBatches> }) {
  return (
    <Field id="filter-status" label={t('batches.status')}>
      <Select
        value={own.chosen.length === 1 ? own.chosen[0] : own.chosen.length > 1 ? SEVERAL : ''}
        onChange={(e) => own.list.set({ status: e.target.value })}
      >
        <option value="">{t('filters.any')}</option>
        {own.chosen.length > 1 && (
          <option value={SEVERAL} disabled>
            {t('filters.several', { count: own.chosen.length })}
          </option>
        )}
        {statuses.map((s) => (
          <option key={s} value={s}>
            {enumLabel(t, 'BatchStatus', s)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function StockPage() {
  const { processor, retailer } = useRoles();
  const statuses = stockStatuses(processor, retailer);
  const own = useOwnBatches('stock', statuses, STOCK_SPEC, '/stock');
  const products = useDictionary('products');
  const transition = useBatchTransition();
  const { list, query } = own;

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
    { key: 'origin', header: t('batches.origin'), cell: (b) => b.origin.name },
    {
      key: 'updated',
      header: t('batches.updatedAt'),
      sortField: 'updatedAt',
      cell: (b) => formatLocalDateTime(b.updatedAt, LOCALE),
    },
  ];

  const rowActions = (b: BatchItem) => {
    const allowed = new Set(availableActions(b.status).map((a) => a.action));
    const label = (a: string) => enumLabel(t, 'BatchActionName', a);
    return (
      <>
        {processor && allowed.has('process') && (
          <ButtonLink size="s" variant="primary" to={`/processing/new?batchId=${b.id}`}>
            {label('process')}
          </ButtonLink>
        )}
        {processor && allowed.has('ship') && (
          <ButtonLink size="s" to={`/waybills/new?batchId=${b.id}`}>
            {label('ship')}
          </ButtonLink>
        )}
        {retailer &&
          (['putOnSale', 'sell'] as const)
            .filter((a) => allowed.has(a))
            .map((a) => (
              <Button
                key={a}
                size="s"
                variant={a === 'putOnSale' ? 'primary' : 'secondary'}
                busy={transition.busy === b.id}
                onClick={() => void transition.run(b, a)}
              >
                {label(a)}
              </Button>
            ))}
      </>
    );
  };

  const state = listState(own, t('stock.failed'), {
    text: t('stock.empty'),
    action: (
      <ButtonLink variant="primary" to="/waybills?direction=incoming">
        {t('waybillDirection.incoming')}
      </ButtonLink>
    ),
  });

  return (
    <Page
      title={t('page.stock')}
      actions={
        processor && (
          <ButtonLink variant="primary" icon="factory" to="/processing/new">
            {t('processing.submit')}
          </ButtonLink>
        )
      }
    >
      <PageToolbar
        search={{
          label: t('stock.search'),
          placeholder: t('stock.searchPlaceholder'),
          value: own.q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={own.count}
        filters={
          <>
            <StatusFilter statuses={statuses} own={own} />
            <Field id="filter-product" label={t('batches.product')}>
              <Select value={own.productId} onChange={(e) => list.set({ productId: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {(products.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        }
      />
      {state ??
        (query.data && (
          <div
            aria-busy={query.isFetching ? 'true' : undefined}
            style={{ display: 'grid', gap: 'var(--sp-4)' }}
          >
            <Table
              cards
              caption={t('page.stock')}
              columns={columns}
              rows={query.data.items}
              rowKey={(b) => b.id}
              sort={list.sort}
              onSort={list.setSort}
              sortOptions={[
                { value: 'updatedAt,desc', label: t('batches.sort.updated') },
                { value: 'publicCode,asc', label: t('batches.sort.code') },
                { value: 'massKg,desc', label: t('batches.sort.massDesc') },
                { value: 'massKg,asc', label: t('batches.sort.massAsc') },
              ]}
              actions={rowActions}
            />
            <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
          </div>
        ))}
    </Page>
  );
}

const STEPS = ['inputs', 'outputs', 'balance'] as const;

interface ProcValues {
  picked: string[];
  used: Record<string, string>;
  outputs: { productId: string; massKg: string }[];
}

type FieldError = { type: string; message: string };
const fieldError = (message: string): FieldError => ({ type: 'validate', message });
type Issue = { path: (string | number)[]; message: string };

export function ProcessingPage() {
  const { api } = useSession();
  const products = useDictionary('products');
  const inputs = useQuery({
    queryKey: ['batches', 'processable'],
    meta: { failed: 'processing.formFailed' },
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
  const eligible = (inputs.data?.items ?? []).filter((b) => canUseAsInput({ status: b.status }).allowed);
  const failed = (!inputs.data && inputs.isError) || (!products.data && products.isError);
  return (
    <Page title={t('page.processing')}>
      {failed ? (
        <LoadFailed
          text={t('processing.formFailed')}
          busy={inputs.isFetching || products.isFetching}
          onRetry={() => {
            void inputs.refetch();
            void products.refetch();
          }}
        />
      ) : !inputs.data || !products.data ? (
        <AreaLoading />
      ) : eligible.length === 0 ? (
        <Card>
          <Empty
            art="empty-batches"
            text={t('processing.noInputs')}
            action={
              <ButtonLink variant="primary" to="/waybills?direction=incoming">
                {t('waybillDirection.incoming')}
              </ButtonLink>
            }
          />
        </Card>
      ) : (
        <ProcessingWizard batches={eligible} products={products.data} />
      )}
    </Page>
  );
}

function ProcessingWizard({ batches, products }: { batches: BatchItem[]; products: Schemas['Product'][] }) {
  const { api } = useSession();
  const [params] = useSearchParams();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const alert = useFormAlert();
  const [wait, startWait] = useCountdown();
  const wide = useWide();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches]);
  const lossOf = useMemo(() => {
    const m = new Map(products.map((p) => [p.id, p.lossNormPercent]));
    return (productId: string) => m.get(productId) ?? '0.00';
  }, [products]);
  const wanted = params.get('batchId') ?? '';

  const toBody = (v: ProcValues) => ({
    inputs: batches
      .filter((b) => v.picked.includes(b.id))
      .map((b) => ({ batchId: b.id, massUsedKg: normalizeDecimal(v.used[b.id] ?? '', 3) })),
    outputs: v.outputs.map((o) => ({ productId: o.productId, massKg: normalizeDecimal(o.massKg, 3) })),
  });

  const resolver: Resolver<ProcValues> = async (values) => {
    const body = toBody(values);
    const used: Record<string, FieldError> = {};
    const outputs: Record<string, FieldError>[] = values.outputs.map(() => ({}));
    const errors: FieldErrors<ProcValues> = {};
    if (body.inputs.length === 0) errors.picked = fieldError('processing.chooseInputs');
    for (const i of body.inputs)
      if ((values.used[i.batchId] ?? '').trim() === '') used[i.batchId] = fieldError('validation.required');
    values.outputs.forEach((o, n) => {
      if (!o.productId) outputs[n]!.productId = fieldError('validation.required');
      if (o.massKg.trim() === '') outputs[n]!.massKg = fieldError('validation.required');
    });
    const res = ProcessingRequestSchema.safeParse({
      ...body,
      outputs: body.outputs.map((o) => ({ ...o, productId: o.productId || undefined })),
    });
    for (const issue of (res.success ? [] : res.error.issues) as Issue[]) {
      const [head, index, leaf] = issue.path;
      if (typeof index !== 'number' || typeof leaf !== 'string') continue;
      if (head === 'inputs') used[body.inputs[index]!.batchId] ??= fieldError(issue.message);
      else if (head === 'outputs') outputs[index]![leaf] ??= fieldError(issue.message);
    }
    for (const i of body.inputs) {
      const b = byId.get(i.batchId);
      if (
        !used[i.batchId] &&
        b &&
        MASS.test(i.massUsedKg) &&
        compareDecimalStrings(i.massUsedKg, b.massKg) > 0
      )
        used[i.batchId] = fieldError('validation.mass.exceedsBatch');
    }
    if (Object.keys(used).length) errors.used = used as never;
    if (outputs.some((o) => Object.keys(o).length)) errors.outputs = outputs as never;
    return Object.keys(errors).length ? { values: {}, errors } : { values, errors: {} };
  };

  const form = useForm<ProcValues>({
    resolver,
    defaultValues: {
      picked: byId.has(wanted) ? [wanted] : [],
      used: Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)])),
      outputs: [{ productId: '', massKg: '' }],
    },
  });
  const outputRows = useFieldArray({ control: form.control, name: 'outputs' });
  const values = form.watch();
  const pickedSet = new Set(values.picked);

  const balance = (() => {
    const ins = batches
      .filter((b) => values.picked.includes(b.id))
      .map((b) => ({
        massUsedKg: normalizeDecimal(values.used[b.id] ?? '', 3),
        lossNormPercent: lossOf(b.product.id),
      }))
      .filter((i) => MASS.test(i.massUsedKg));
    const outs = values.outputs
      .map((o) => ({ massKg: normalizeDecimal(o.massKg, 3) }))
      .filter((o) => MASS.test(o.massKg));
    const r = checkMassBalance({ inputs: ins, outputs: outs.length ? outs : [{ massKg: '0.000' }] });
    return 'error' in r ? null : r;
  })();

  const title = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current) title.current?.focus({ preventScroll: false });
    moved.current = false;
  }, [step]);
  const goTo = (n: number) => {
    moved.current = true;
    setStep(n);
  };
  const formRef = useRef<HTMLFormElement>(null);
  const checkedSteps = useRef(new Set<number>());
  const stepNames = useCallback(
    (n: number) => (n === 0 ? ['picked', ...batches.map((b) => `used.${b.id}`)] : ['outputs']) as never,
    [batches],
  );
  const next = async () => {
    if (await form.trigger(stepNames(step))) goTo(step + 1);
    else {
      checkedSteps.current.add(step);
      focusFirstInvalid(formRef.current);
    }
  };
  useEffect(() => {
    const sub = form.watch(() => {
      if (form.formState.isSubmitted) return;
      for (const n of checkedSteps.current) void form.trigger(stepNames(n));
    });
    return () => sub.unsubscribe();
  }, [form, stepNames]);

  const sent = useRef<{ inputs: string[] }>({ inputs: [] });
  const submit = form.handleSubmit(
    async (v) => {
      const body = toBody(v) as Schemas['ProcessingRequest'];
      sent.current = { inputs: body.inputs.map((i) => i.batchId) };
      alert.clear();
      setBusy(true);
      try {
        const result = await call<Schemas['ProcessingResult']>(api.POST('/processing', { body }));
        for (const b of result.outputs) cache.set(['batch', b.id], b);
        void queryClient.invalidateQueries({ queryKey: ['batches'] });
        void queryClient.invalidateQueries({ queryKey: ['batch'] });
        toast.done({
          tone: 'ok',
          text: t('processing.done', {
            count: result.outputs.length,
            codes: result.outputs.map((b) => b.publicCode).join(', '),
          }),
        });
        navigate(`/batches/${result.outputs[0]!.id}`);
      } catch (e) {
        const ids = sent.current.inputs;
        applyProblem(e, {
          form,
          fields: [
            'picked',
            ...ids.map((id) => `used.${id}` as const),
            ...v.outputs.flatMap((_, n) => [`outputs.${n}.productId`, `outputs.${n}.massKg`] as const),
          ],
          alert: alert.show,
          onRateLimit: startWait,
          alias: (path) => {
            const input = /^inputs\[(\d+)\]\./.exec(path);
            const id = input ? ids[Number(input[1])] : undefined;
            if (id) return `used.${id}`;
            const output = /^outputs\[(\d+)\]\.(productId|massKg)$/.exec(path);
            if (output) return `outputs.${output[1]}.${output[2]}`;
            return path === 'inputs' ? 'picked' : path;
          },
        });
        const errs = form.formState.errors;
        if (!wide && (errs.picked || errs.used)) goTo(0);
        else if (!wide && errs.outputs) goTo(1);
      } finally {
        setBusy(false);
      }
    },
    (errs) => {
      if (!wide) goTo(errs.picked || errs.used ? 0 : 1);
    },
  );

  const inputColumns: Column<BatchItem>[] = [
    {
      key: 'code',
      header: t('batches.code'),
      primary: true,
      cell: (b) => <TablePrimary to={`/batches/${b.id}`} code={b.publicCode} sub={b.product.name} />,
    },
    { key: 'status', header: t('batches.status'), status: true, cell: (b) => <Chip status={b.status} /> },
    {
      key: 'available',
      header: t('processing.available'),
      numeric: true,
      cell: (b) => formatDecimal(b.massKg, LOCALE),
    },
    {
      key: 'used',
      header: t('field.massUsedKg'),
      cell: (b) => (
        <CellField id={`used-${b.id}`} error={errorOf(form, `used.${b.id}`)}>
          <InputGroup
            suffix={t('unit.kg')}
            inputMode="decimal"
            autoComplete="off"
            aria-label={t('processing.usedOf', { code: b.publicCode })}
            disabled={!pickedSet.has(b.id)}
            {...form.register(`used.${b.id}`)}
          />
        </CellField>
      ),
    },
  ];
  const pickedError = errorOf(form, 'picked');

  const stepCard = (n: number) => {
    const name = STEPS[n]!;
    const last = n === STEPS.length - 1;
    return (
      <Card key={name}>
        <header className="at-card__header">
          <h2 className="at-card__title" ref={!wide ? title : undefined} tabIndex={-1}>
            {t(`processing.step.${name}`)}
          </h2>
        </header>
        <CardBody>
          {name === 'inputs' && (
            <div style={FORM_GRID}>
              {pickedError && (
                <p className="at-field__error" id="processing-inputs-error" role="alert">
                  {pickedError}
                </p>
              )}
              <Table
                cards
                caption={t('processing.step.inputs')}
                columns={inputColumns}
                rows={batches}
                rowKey={(b) => b.id}
                selection={{
                  selected: pickedSet,
                  errorId: pickedError ? 'processing-inputs-error' : null,
                  onChange: (next) =>
                    form.setValue(
                      'picked',
                      batches.map((b) => b.id).filter((id) => next.has(id)),
                      { shouldValidate: form.formState.isSubmitted },
                    ),
                  allLabel: t('processing.pickAll'),
                  rowLabel: (b) => t('processing.pick', { code: b.publicCode }),
                }}
              />
            </div>
          )}
          {name === 'outputs' && (
            <div style={GAP}>
              {outputRows.fields.map((row, i) => (
                <div
                  key={row.id}
                  style={{
                    display: 'grid',
                    gap: 'var(--sp-4)',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))',
                    alignItems: 'start',
                  }}
                >
                  <Field
                    id={`output-${i}-product`}
                    label={t('processing.productOf', { n: i + 1 })}
                    error={errorOf(form, `outputs.${i}.productId`)}
                  >
                    <Select {...form.register(`outputs.${i}.productId`)}>
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
                  <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Field
                        id={`output-${i}-mass`}
                        label={t('processing.massOf', { n: i + 1 })}
                        error={errorOf(form, `outputs.${i}.massKg`)}
                      >
                        <InputGroup
                          suffix={t('unit.kg')}
                          inputMode="decimal"
                          autoComplete="off"
                          {...form.register(`outputs.${i}.massKg`)}
                        />
                      </Field>
                    </div>
                    {outputRows.fields.length > 1 && (
                      <Button
                        variant="ghost"
                        iconOnly
                        icon="close"
                        aria-label={t('processing.removeOutput', { n: i + 1 })}
                        onClick={() => outputRows.remove(i)}
                      />
                    )}
                  </div>
                </div>
              ))}
              {outputRows.fields.length < 20 && (
                <div>
                  <Button icon="plus" onClick={() => outputRows.append({ productId: '', massKg: '' })}>
                    {t('processing.addOutput')}
                  </Button>
                </div>
              )}
            </div>
          )}
          {name === 'balance' && <BalanceView balance={balance} />}
        </CardBody>
        {(!wide || last) && (
          <CardFooter>
            {!wide && n > 0 && (
              <Button variant="ghost" onClick={() => goTo(n - 1)}>
                {t('processing.back')}
              </Button>
            )}
            {last ? (
              <Submit busy={busy} wait={wait} form="processing">
                {t('processing.submit')}
              </Submit>
            ) : (
              <Button variant="primary" onClick={() => void next()}>
                {t('processing.next')}
              </Button>
            )}
          </CardFooter>
        )}
      </Card>
    );
  };

  const done = [
    values.picked.length > 0,
    values.outputs.every((o) => o.productId && MASS.test(normalizeDecimal(o.massKg, 3))),
  ];
  const current = wide ? (done[0] ? (done[1] ? 2 : 1) : 0) : step;

  return (
    <form id="processing" ref={formRef} noValidate onSubmit={(e) => void submit(e)} style={GAP}>
      <Stepper
        label={t('processing.steps')}
        steps={STEPS.map((s) => t(`processing.step.${s}`))}
        current={current}
      />
      {wide ? STEPS.map((_, n) => stepCard(n)) : stepCard(step)}
    </form>
  );
}

function BalanceView({ balance }: { balance: ReturnType<typeof checkMassBalance> | null }) {
  if (!balance || 'error' in balance) return <p style={{ margin: 0 }}>{t('processing.chooseInputs')}</p>;
  const mass = (kg: string) => formatMass(kg, LOCALE);
  return (
    <div style={FORM_GRID}>
      <CardFacts
        facts={[
          { key: 'in', term: t('processing.input'), value: mass(balance.inputKg) },
          { key: 'allowed', term: t('processing.allowed'), value: mass(balance.allowedKg) },
          { key: 'out', term: t('processing.outputTotal'), value: mass(balance.outputKg) },
        ]}
      />
      <div aria-live="polite">
        {balance.ok ? (
          <p style={{ margin: 0 }}>{t('processing.balanceOk', { allowedKg: mass(balance.allowedKg) })}</p>
        ) : (
          <p className="at-field__warning">
            {t('rules.BR-04', {
              outputKg: mass(balance.outputKg),
              allowedKg: mass(balance.allowedKg),
              inputKg: mass(balance.inputKg),
            })}
          </p>
        )}
      </div>
    </div>
  );
}

const QR_SPEC: ListSpec = {
  sort: ['publicCode', 'updatedAt'],
  enums: { status: ['Approved', 'Accepted', 'OnSale'] },
  texts: ['q'],
};

type QrLinks = Schemas['QrLinks'];

function qrStatuses(processor: boolean): BatchStatus[] {
  return (processor ? ['Accepted', 'OnSale', 'Approved'] : ['Accepted', 'OnSale']) as BatchStatus[];
}

export function QrPage() {
  const { api } = useSession();
  const { processor } = useRoles();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const statuses = qrStatuses(processor);
  const own = useOwnBatches('qr', statuses, QR_SPEC, '/qr');
  const { list, query } = own;
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<{ batch: BatchItem; links: QrLinks | null } | null>(null);
  const failure = useDialogAlert();
  const close = () => {
    failure.handOff();
    setShown(null);
  };

  const generate = async (b: BatchItem, inDialog = false) => {
    setBusy(b.id);
    failure.clear();
    try {
      const links = await call<QrLinks>(
        api.POST('/batches/{id}/qr', { params: { path: { id: b.id } }, body: {} }),
      );
      void queryClient.invalidateQueries({ queryKey: ['batches'] });
      void queryClient.invalidateQueries({ queryKey: ['batch', b.id, 'documents'] });
      toast.done({ tone: 'ok', text: t('qr.done', { code: b.publicCode }) });
      setShown({ batch: b, links });
    } catch (e) {
      if (e instanceof ApiProblem && (e.status === 403 || e.status === 404))
        void queryClient.invalidateQueries({ queryKey: ['batches'] });
      if (inDialog) failure.show(errorText(e), errorTone(e));
      else toast.push({ tone: errorTone(e), text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

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
      key: 'qr',
      header: t('qr.state'),
      cell: (b) =>
        b.qrGeneratedAt
          ? t('qr.generatedAt', { date: formatLocalDate(b.qrGeneratedAt, LOCALE) })
          : t('qr.notGenerated'),
    },
    {
      key: 'updated',
      header: t('batches.updatedAt'),
      sortField: 'updatedAt',
      cell: (b) => formatLocalDateTime(b.updatedAt, LOCALE),
    },
  ];

  const state = listState(own, t('qr.failed'), {
    text: t('qr.empty'),
    action: (
      <ButtonLink variant="primary" to="/stock">
        {t('nav.stock')}
      </ButtonLink>
    ),
  });

  return (
    <Page title={t('page.qr')}>
      <PageToolbar
        search={{
          label: t('qr.search'),
          placeholder: t('qr.searchPlaceholder'),
          value: own.q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={own.count}
        filters={<StatusFilter statuses={statuses} own={own} />}
      />
      {state ??
        (query.data && (
          <div
            aria-busy={query.isFetching ? 'true' : undefined}
            style={{ display: 'grid', gap: 'var(--sp-4)' }}
          >
            <Table
              cards
              caption={t('page.qr')}
              columns={columns}
              rows={query.data.items}
              rowKey={(b) => b.id}
              sort={list.sort}
              onSort={list.setSort}
              sortOptions={[
                { value: 'updatedAt,desc', label: t('batches.sort.updated') },
                { value: 'publicCode,asc', label: t('batches.sort.code') },
              ]}
              actions={(b) =>
                b.qrGeneratedAt ? (
                  <Button
                    size="s"
                    icon="download"
                    aria-label={t('qr.downloadOf', { code: b.publicCode })}
                    onClick={() => setShown({ batch: b, links: null })}
                  >
                    {t('qr.download')}
                  </Button>
                ) : (
                  <Button
                    size="s"
                    variant="primary"
                    icon="qr"
                    busy={busy === b.id}
                    aria-label={t('qr.generateOf', { code: b.publicCode })}
                    onClick={() => void generate(b)}
                  >
                    {t('action.generateQr')}
                  </Button>
                )
              }
            />
            <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
          </div>
        ))}
      <Dialog
        open={shown !== null}
        onClose={close}
        lightDismiss
        title={shown ? t('qr.title', { code: shown.batch.publicCode }) : ''}
        actions={
          shown &&
          !shown.links && (
            <Button busy={busy === shown.batch.id} onClick={() => void generate(shown.batch, true)}>
              {t('qr.regenerate')}
            </Button>
          )
        }
      >
        {shown && (
          <>
            <DialogMessage text={failure.message} />
            <QrView batch={shown.batch} links={shown.links} />
          </>
        )}
      </Dialog>
    </Page>
  );
}

function QrView({ batch, links }: { batch: BatchItem; links: QrLinks | null }) {
  const { api } = useSession();
  const docs = useQuery({
    queryKey: ['batch', batch.id, 'documents'],
    meta: { failed: 'qr.linksFailed' },
    enabled: links === null,
    queryFn: () =>
      call<Schemas['BatchDocuments']>(
        api.GET('/batches/{id}/documents', { params: { path: { id: batch.id } } }),
      ),
    retry: retryTransient,
  });
  const qr = links ?? docs.data?.qr ?? null;
  if (!qr && links === null && docs.isPending) return <AreaLoading blocks={1} />;
  if (!qr) return <p style={{ margin: 0 }}>{t('qr.linksFailed')}</p>;
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-4)', justifyItems: 'start' }}>
      <Qr value={qr.publicUrl} label={t('qr.image', { code: batch.publicCode, url: qr.publicUrl })} />
      <a href={qr.publicUrl} style={{ overflowWrap: 'anywhere' }}>
        {qr.publicUrl}
      </a>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-3)' }}>
        <ButtonAnchor icon="download" href={qr.pngUrl} download={`${batch.publicCode}.png`}>
          {t('qr.png')}
        </ButtonAnchor>
        <ButtonAnchor icon="file-pdf" href={qr.pdfUrl} download={`${batch.publicCode}.pdf`}>
          {t('qr.pdf')}
        </ButtonAnchor>
      </div>
    </div>
  );
}
