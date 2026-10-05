import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, withVariant, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatBytes, formatDecimal } from '@agrotrace/i18n';
import {
  IndicatorInputSchema,
  NormInputSchema,
  ProductInputSchema,
  RegionInputSchema,
  SubstanceInputSchema,
} from '@agrotrace/validation';
import type { ZodTypeAny } from 'zod';
import {
  DICTIONARIES,
  IMAGE_TYPES,
  IMPORT_ACCEPT,
  IMPORT_HEADER,
  IMPORT_TYPES,
  importFileProblem,
  isImportFile,
  tooLargeText,
  typesText,
  UPLOAD_MAX_BYTES,
  type DictName,
} from '../app/admin';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useFocusAfterWait,
  useDialogAlert,
} from '../app/api';
import { useScreenToast } from '../app/cache';
import { useDictionary } from '../app/dictionaries';
import { errorOf, FORM_GRID, normalizeDecimal, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { ImageUpload } from '../app/ImageUpload';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { useSkipRouteFocus } from '../app/routeFocus';
import { useSession } from '../app/session';
import {
  AreaLoading,
  Avatar,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
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
  Metric,
  Page,
  PageToolbar,
  Pagination,
  Select,
  Table,
  Tabs,
  type Column,
  type FileItem,
} from '../ui';

type Product = Schemas['Product'];
type Substance = Schemas['Substance'];
type Indicator = Schemas['Indicator'];
type Norm = Schemas['Norm'];
type Region = Schemas['RegionEntry'];
type Entry = Product | Substance | Indicator | Norm | Region;
type Report = Schemas['ImportReport'];

const SIZE = 20;
const STACK = { display: 'grid', gap: 'var(--sp-4)' } as const;
const CATEGORIES: readonly Schemas['ProductCategory'][] = [
  'GRAIN',
  'VEGETABLE',
  'FRUIT',
  'DAIRY',
  'MEAT',
  'OILSEED',
  'PROCESSED',
];
const SUBSTANCE_TYPES: readonly Schemas['SubstanceType'][] = ['PESTICIDE', 'FERTILIZER'];
const SOFT: readonly DictName[] = ['products', 'substances', 'indicators'];
const REPORT_ROWS = 200;
const METRICS = {
  display: 'grid',
  gap: 'var(--sp-3)',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))',
} as const;

const SPECS: Record<DictName, ListSpec> = {
  products: {
    sort: ['name'],
    enums: { category: CATEGORIES },
    patterns: { includeDeleted: /^true$/ },
    texts: ['q'],
  },
  substances: {
    sort: ['name'],
    enums: { type: SUBSTANCE_TYPES },
    patterns: { includeDeleted: /^true$/ },
    texts: ['q'],
  },
  indicators: { sort: ['name'], patterns: { includeDeleted: /^true$/ }, texts: ['q'] },
  norms: { sort: ['name'], texts: ['q'] },
  regions: { sort: ['name'], texts: ['q'] },
};

const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;
const isDict = (s: string | undefined): s is DictName => DICTIONARIES.includes(s as DictName);

function entryName(name: DictName, e: Entry): string {
  if (name === 'norms') {
    const n = e as Norm;
    return `${n.product.name} — ${n.indicator.name}`;
  }
  return (e as { name: string }).name;
}

export function DictionaryPage() {
  const { name } = useParams();
  const navigate = useNavigate();
  const skipFocus = useSkipRouteFocus();
  const [dialog, setDialog] = useState<'add' | 'import' | null>(null);
  const [report, setReport] = useState<{ name: DictName; report: Report } | null>(null);

  if (!isDict(name))
    return (
      <Page title={t('page.dictionaries')}>
        <Card>
          <Empty
            art="not-found"
            text={t('dict.notFound')}
            action={
              <ButtonLink variant="primary" to="/admin/dictionaries/products">
                {t('dict.toProducts')}
              </ButtonLink>
            }
          />
        </Card>
      </Page>
    );

  return (
    <Page
      title={t('page.dictionaries')}
      actions={
        <>
          <Button icon="upload" onClick={() => setDialog('import')}>
            {t('dict.import.open')}
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setDialog('add')}>
            {t('dict.add')}
          </Button>
        </>
      }
    >
      <Tabs
        label={t('page.dictionaries')}
        tabs={DICTIONARIES.map((d) => ({ id: d, label: enumLabel(t, 'DictionaryName', d) }))}
        selected={name}
        onSelect={(id) => {
          if (id === name) return;
          const to = `/admin/dictionaries/${id}`;
          skipFocus(to);
          navigate(to);
        }}
        panel={(id) => (
          <div style={{ ...STACK, paddingTop: 'var(--sp-4)' }}>
            {report && report.name === id && (
              <ImportReportCard
                name={id as DictName}
                report={report.report}
                onClose={() => setReport(null)}
              />
            )}
            <DictionaryList key={id} name={id as DictName} />
          </div>
        )}
      />
      {dialog === 'add' && <EntryDialog name={name} onClose={() => setDialog(null)} />}
      {dialog === 'import' && (
        <ImportDialog
          name={name}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            setReport({ name, report: r });
          }}
        />
      )}
    </Page>
  );
}

function DictionaryList({ name }: { name: DictName }) {
  const { api } = useSession();
  const list = useListParams(`/admin/dictionaries/${name}`, SPECS[name]);
  const q = list.get('q');
  const category = list.get('category');
  const type = list.get('type');
  const deleted = list.get('includeDeleted') === 'true';
  const sort = list.sort;
  const count = [category, type, deleted ? 'yes' : ''].filter(Boolean).length;
  const [editing, setEditing] = useState<Entry | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [photo, setPhoto] = useState<Product | null>(null);

  const query = useQuery({
    queryKey: [
      'dictionaryAdmin',
      name,
      { page: list.page, sort: list.params.get('sort'), q, category, type, deleted },
    ],
    meta: { failed: 'dict.failed' },
    queryFn: () =>
      call<Schemas['DictionaryPage']>(
        api.GET('/dictionaries/{name}', {
          params: {
            path: { name },
            query: {
              page: list.page,
              size: SIZE,
              ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
              ...(q ? { q } : {}),
              ...(category ? { category: category as Schemas['ProductCategory'] } : {}),
              ...(type ? { type: type as Schemas['SubstanceType'] } : {}),
              ...(deleted ? { includeDeleted: true } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const items = (query.data?.items ?? []) as Entry[];
  const gap = query.data ? listGap(query.data, list.page, SIZE) : null;
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && gap === 'pastEnd') clampPage(query.data.total, SIZE);
  }, [query.data, gap, clampPage]);

  const isDeleted = (e: Entry) => 'deletedAt' in e && e.deletedAt !== null;
  const columns = columnsOf(name, deleted);
  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed
          text={t('dict.failed')}
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
            <Empty art="empty-search" text={t('dict.empty')} />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={STACK}>
        <Table
          cards
          caption={enumLabel(t, 'DictionaryName', name)}
          columns={columns}
          rows={items}
          rowKey={(e) => e.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'name,asc', label: t('dict.sort.nameAsc') },
            { value: 'name,desc', label: t('dict.sort.nameDesc') },
          ]}
          actions={(e) =>
            isDeleted(e) ? null : (
              <>
                <Button
                  size="s"
                  aria-label={t('dict.editOf', { name: entryName(name, e) })}
                  onClick={() => setEditing(e)}
                >
                  {t('dict.edit')}
                </Button>
                {name === 'products' && (
                  <Button
                    size="s"
                    icon="image"
                    iconOnly
                    aria-label={t('dict.photoOf', { name: entryName(name, e) })}
                    onClick={() => setPhoto(e as Product)}
                  />
                )}
                <Button
                  size="s"
                  variant="ghost"
                  icon="trash"
                  iconOnly
                  aria-label={t('dict.deleteOf', { name: entryName(name, e) })}
                  onClick={() => setRemoving(e)}
                />
              </>
            )
          }
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <div style={STACK}>
      <PageToolbar
        search={{
          label: t('dict.search', { name: enumLabel(t, 'DictionaryName', name) }),
          placeholder: t(`dict.searchPlaceholder.${name}`),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={count}
        filters={
          name === 'products' || name === 'substances' || SOFT.includes(name) ? (
            <>
              {name === 'products' && (
                <Field id="filter-category" label={t('field.category')}>
                  <Select value={category} onChange={(e) => list.set({ category: e.target.value })}>
                    <option value="">{t('filters.any')}</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {enumLabel(t, 'ProductCategory', c)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {name === 'substances' && (
                <Field id="filter-type" label={t('field.type')}>
                  <Select value={type} onChange={(e) => list.set({ type: e.target.value })}>
                    <option value="">{t('filters.any')}</option>
                    {SUBSTANCE_TYPES.map((x) => (
                      <option key={x} value={x}>
                        {enumLabel(t, 'SubstanceType', x)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {SOFT.includes(name) && (
                <Checkbox
                  checked={deleted}
                  onChange={(e) => list.set({ includeDeleted: e.target.checked ? 'true' : null })}
                >
                  {t('dict.showDeleted')}
                </Checkbox>
              )}
            </>
          ) : undefined
        }
      />
      {content()}
      {editing && <EntryDialog name={name} entry={editing} onClose={() => setEditing(null)} />}
      {removing && <DeleteDialog name={name} entry={removing} onClose={() => setRemoving(null)} />}
      {photo && <PhotoDialog product={photo} onClose={() => setPhoto(null)} />}
    </div>
  );
}

function columnsOf(name: DictName, deleted: boolean): Column<Entry>[] {
  const nameCol = (sub?: (e: Entry) => ReactNode): Column<Entry> => ({
    key: 'name',
    header: t('field.name'),
    primary: true,
    sortField: 'name',
    cell: (e) => (
      <span className="at-table__primary">
        <span>{(e as { name: string }).name}</span>
        {sub && <span className="at-table__sub">{sub(e)}</span>}
      </span>
    ),
  });
  const status: Column<Entry>[] =
    deleted && SOFT.includes(name)
      ? [
          {
            key: 'deleted',
            header: t('dict.state'),
            status: true,
            cell: (e) =>
              (e as { deletedAt: string | null }).deletedAt ? (
                <Chip tone="neutral">{t('dict.deleted')}</Chip>
              ) : (
                <Chip tone="ok">{t('dict.inUse')}</Chip>
              ),
          },
        ]
      : [];
  switch (name) {
    case 'products':
      return [
        {
          key: 'photo',
          header: t('dict.photo'),
          cell: (e) => {
            const p = e as Product;
            return (
              <Avatar
                name={p.name}
                src={p.imageUrl ? withVariant(p.imageUrl, 96) : null}
                size="s"
                shape="square"
                decorative
              />
            );
          },
        },
        nameCol(),
        ...status,
        {
          key: 'category',
          header: t('field.category'),
          cell: (e) => enumLabel(t, 'ProductCategory', (e as Product).category),
        },
        {
          key: 'loss',
          header: t('field.lossNormPercent'),
          numeric: true,
          cell: (e) => formatDecimal((e as Product).lossNormPercent, LOCALE),
        },
        {
          key: 'mercury',
          header: t('field.mercuryCode'),
          cell: (e) => <span className="at-mono">{(e as Product).mercuryCode ?? '—'}</span>,
        },
      ];
    case 'substances':
      return [
        nameCol(),
        ...status,
        {
          key: 'type',
          header: t('field.type'),
          cell: (e) => enumLabel(t, 'SubstanceType', (e as Substance).type),
        },
        {
          key: 'days',
          header: t('field.waitingPeriodDays'),
          numeric: true,
          cell: (e) => (e as Substance).waitingPeriodDays,
        },
      ];
    case 'indicators':
      return [
        nameCol(),
        ...status,
        { key: 'unit', header: t('field.unit'), cell: (e) => (e as Indicator).unit },
      ];
    case 'norms':
      return [
        {
          key: 'product',
          header: t('field.productId'),
          primary: true,
          sortField: 'name',
          cell: (e) => (
            <span className="at-table__primary">
              <span>{(e as Norm).product.name}</span>
              <span className="at-table__sub">{(e as Norm).indicator.name}</span>
            </span>
          ),
        },
        { key: 'indicator', header: t('field.indicatorId'), cell: (e) => (e as Norm).indicator.name },
        {
          key: 'max',
          header: t('field.maxValue'),
          numeric: true,
          cell: (e) => `${formatDecimal((e as Norm).maxValue, LOCALE)} ${(e as Norm).indicator.unit}`,
        },
      ];
    case 'regions':
      return [
        {
          key: 'code',
          header: t('field.code'),
          cell: (e) => <span className="at-mono">{(e as Region).code}</span>,
        },
        nameCol(),
      ];
  }
}

function useRefresh(name: DictName) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['dictionaryAdmin', name] });
    void queryClient.invalidateQueries({ queryKey: ['dictionary', name] });
    if (name === 'products' || name === 'indicators')
      void queryClient.invalidateQueries({ queryKey: ['dictionaryAdmin', 'norms'] });
  };
}

type Values = Record<string, string>;

interface FormDef {
  fields: string[];
  defaults: (e?: Entry) => Values;
  schema: ZodTypeAny;
  toWire: (v: Values) => Record<string, unknown>;
  precheck?: (v: Values) => Record<string, string>;
}

const FORMS: Record<DictName, FormDef> = {
  products: {
    fields: ['name', 'category', 'lossNormPercent', 'mercuryCode'],
    defaults: (e) => {
      const p = e as Product | undefined;
      return {
        name: p?.name ?? '',
        category: p?.category ?? '',
        lossNormPercent: p ? p.lossNormPercent.replace('.', ',') : '',
        mercuryCode: p?.mercuryCode ?? '',
      };
    },
    schema: ProductInputSchema,
    toWire: (v) => ({
      name: v.name,
      category: v.category,
      lossNormPercent: normalizeDecimal(v.lossNormPercent!, 2),
      mercuryCode: v.mercuryCode!.trim() === '' ? null : v.mercuryCode!.trim(),
    }),
  },
  substances: {
    fields: ['name', 'type', 'waitingPeriodDays'],
    defaults: (e) => {
      const s = e as Substance | undefined;
      return {
        name: s?.name ?? '',
        type: s?.type ?? '',
        waitingPeriodDays: s ? String(s.waitingPeriodDays) : '',
      };
    },
    schema: SubstanceInputSchema,
    toWire: (v) => ({
      name: v.name,
      type: v.type,
      waitingPeriodDays: /^\d{1,4}$/.test(v.waitingPeriodDays!.trim()) ? Number(v.waitingPeriodDays) : '',
    }),
    precheck: (v): Record<string, string> =>
      v.waitingPeriodDays!.trim() !== '' && !/^\d{1,4}$/.test(v.waitingPeriodDays!.trim())
        ? { waitingPeriodDays: 'validation.pattern' }
        : {},
  },
  indicators: {
    fields: ['name', 'unit'],
    defaults: (e) => ({
      name: (e as Indicator | undefined)?.name ?? '',
      unit: (e as Indicator | undefined)?.unit ?? '',
    }),
    schema: IndicatorInputSchema,
    toWire: (v) => ({ name: v.name, unit: v.unit }),
  },
  norms: {
    fields: ['productId', 'indicatorId', 'maxValue'],
    defaults: (e) => {
      const n = e as Norm | undefined;
      return {
        productId: n?.product.id ?? '',
        indicatorId: n?.indicator.id ?? '',
        maxValue: n ? n.maxValue.replace(/\.?0+$/, '').replace('.', ',') : '',
      };
    },
    schema: NormInputSchema,
    toWire: (v) => ({
      productId: v.productId,
      indicatorId: v.indicatorId,
      maxValue: v.maxValue!.trim().replace(',', '.'),
    }),
  },
  regions: {
    fields: ['code', 'name'],
    defaults: (e) => ({
      code: (e as Region | undefined)?.code ?? '',
      name: (e as Region | undefined)?.name ?? '',
    }),
    schema: RegionInputSchema,
    toWire: (v) => ({ code: v.code!.trim().toUpperCase(), name: v.name }),
  },
};

function EntryDialog({ name, entry, onClose }: { name: DictName; entry?: Entry; onClose: () => void }) {
  const { api } = useSession();
  const toast = useScreenToast();
  const refresh = useRefresh(name);
  const def = FORMS[name];
  const products = useDictionary('products');
  const indicators = useDictionary('indicators');
  const schema = wireSchema<Values>(def.schema, def.toWire, def.precheck);
  const { form, alert, wait, fail, message, handOff } = useSchemaForm<Values>(
    schema,
    def.defaults(entry),
    def.fields,
    undefined,
    { dialog: true },
  );
  const close = () => {
    handOff();
    onClose();
  };
  const [busy, setBusy] = useState(false);

  const submit = form.handleSubmit(async (body) => {
    alert.clear();
    setBusy(true);
    try {
      const saved = entry
        ? await call<Entry>(
            api.PUT('/dictionaries/{name}/{id}', {
              params: { path: { name, id: entry.id } },
              body: body as unknown as Schemas['DictionaryInput'],
            }),
          )
        : await call<Entry>(
            api.POST('/dictionaries/{name}', {
              params: { path: { name } },
              body: body as unknown as Schemas['DictionaryInput'],
            }),
          );
      refresh();
      onClose();
      toast.done({
        tone: 'ok',
        text: t(entry ? 'dict.saved' : 'dict.created', { name: entryName(name, saved) }),
      });
    } catch (e) {
      if (entry && e instanceof ApiProblem && e.status === 404) {
        refresh();
        onClose();
        toast.push({ tone: 'danger', text: t('dict.gone', { name: entryName(name, entry) }) });
      } else fail(e);
    } finally {
      setBusy(false);
    }
  });

  const text = (field: string, label: string, extra: Record<string, unknown> = {}) => (
    <Field id={`entry-${field}`} label={label} error={errorOf(form, field)}>
      <Input autoComplete="off" {...extra} {...form.register(field)} />
    </Field>
  );
  const select = (field: string, label: string, options: { value: string; label: string }[]) => (
    <Field id={`entry-${field}`} label={label} error={errorOf(form, field)}>
      <Select {...form.register(field)}>
        <option value="" disabled>
          {t('ui.choose')}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );

  const withCurrent = (
    opts: { value: string; label: string }[],
    id: string | undefined,
    label: string | undefined,
  ) => (id && label && !opts.some((o) => o.value === id) ? [{ value: id, label }, ...opts] : opts);

  const fields = () => {
    switch (name) {
      case 'products':
        return (
          <>
            {text('name', t('field.name'))}
            {select(
              'category',
              t('field.category'),
              CATEGORIES.map((c) => ({ value: c, label: enumLabel(t, 'ProductCategory', c) })),
            )}
            <Field
              id="entry-lossNormPercent"
              label={t('field.lossNormPercent')}
              error={errorOf(form, 'lossNormPercent')}
            >
              <InputGroup
                suffix="%"
                inputMode="decimal"
                autoComplete="off"
                {...form.register('lossNormPercent')}
              />
            </Field>
            {text('mercuryCode', t('field.mercuryCode'), { mono: true })}
          </>
        );
      case 'substances':
        return (
          <>
            {text('name', t('field.name'))}
            {select(
              'type',
              t('field.type'),
              SUBSTANCE_TYPES.map((x) => ({ value: x, label: enumLabel(t, 'SubstanceType', x) })),
            )}
            {text('waitingPeriodDays', t('field.waitingPeriodDays'), { inputMode: 'numeric' })}
          </>
        );
      case 'indicators':
        return (
          <>
            {text('name', t('field.name'))}
            {text('unit', t('field.unit'))}
          </>
        );
      case 'norms': {
        const n = entry as Norm | undefined;
        return (
          <>
            {select(
              'productId',
              t('field.productId'),
              withCurrent(
                (products.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                n?.product.id,
                n?.product.name,
              ),
            )}
            {select(
              'indicatorId',
              t('field.indicatorId'),
              withCurrent(
                (indicators.data ?? []).map((i) => ({ value: i.id, label: `${i.name}, ${i.unit}` })),
                n?.indicator.id,
                n ? `${n.indicator.name}, ${n.indicator.unit}` : undefined,
              ),
            )}
            {text('maxValue', t('field.maxValue'), { inputMode: 'decimal' })}
          </>
        );
      }
      case 'regions':
        return (
          <>
            {text('code', t('field.code'), { mono: true })}
            {text('name', t('field.name'))}
          </>
        );
    }
  };

  const waiting = name === 'norms' && (!products.data || !indicators.data);
  return (
    <Dialog
      open
      onClose={close}
      title={entry ? t('dict.editTitle', { name: entryName(name, entry) }) : t(`dict.addTitle.${name}`)}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Submit busy={busy} wait={wait} form="entry-form">
            {entry ? t('action.save') : t('dict.add')}
          </Submit>
        </>
      }
    >
      {waiting ? (
        <AreaLoading blocks={1} />
      ) : (
        <form id="entry-form" noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
          <DialogMessage text={message} />
          {fields()}
        </form>
      )}
    </Dialog>
  );
}

function DeleteDialog({ name, entry, onClose }: { name: DictName; entry: Entry; onClose: () => void }) {
  const { api } = useSession();
  const toast = useScreenToast();
  const refresh = useRefresh(name);
  const [busy, setBusy] = useState(false);
  const failure = useDialogAlert();
  const [wait, startWait] = useCountdown();
  const button = useFocusAfterWait(wait);
  const label = entryName(name, entry);
  const remove = async () => {
    setBusy(true);
    failure.clear();
    try {
      await call(api.DELETE('/dictionaries/{name}/{id}', { params: { path: { name, id: entry.id } } }));
      refresh();
      onClose();
      toast.done({ tone: 'ok', text: t('dict.removed', { name: label }) });
    } catch (e) {
      let text = errorText(e);
      if (e instanceof ApiProblem && e.code === 'REFERENCE_IN_USE') {
        const used = Array.isArray(e.params?.usedBy) ? (e.params.usedBy as string[]) : [];
        text = t('dict.inUseBy', { name: label, by: used.map((u) => t(`dict.usedBy.${u}`)).join(', ') });
      } else if (e instanceof ApiProblem && e.status === 404) {
        refresh();
        onClose();
        toast.push({ tone: 'danger', text: t('dict.gone', { name: label }) });
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      failure.show(text, errorTone(e));
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
      open
      onClose={close}
      title={t('dict.deleteTitle', { name: label })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button ref={button} variant="danger" busy={busy} disabled={wait > 0} onClick={() => void remove()}>
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('action.delete')}
          </Button>
        </>
      }
    >
      <div style={STACK}>
        <DialogMessage text={failure.message} />
        <p style={{ margin: 0 }}>{SOFT.includes(name) ? t('dict.deleteSoft') : t('dict.deleteHard')}</p>
      </div>
    </Dialog>
  );
}

function PhotoDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const { api } = useSession();
  const toast = useScreenToast();
  const refresh = useRefresh('products');
  const failure = useDialogAlert();
  const close = () => {
    failure.handOff();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t('dict.photoTitle', { name: product.name })}
      actions={
        <Button variant="ghost" onClick={close}>
          {t('action.cancel')}
        </Button>
      }
    >
      <div style={STACK}>
        <DialogMessage text={failure.message} />
        {product.imageUrl && (
          <img
            src={withVariant(product.imageUrl, 480)}
            alt={t('dict.photoAlt', { name: product.name })}
            style={{ maxWidth: '100%', maxHeight: '12rem', borderRadius: 'var(--r-m)', justifySelf: 'start' }}
          />
        )}
        <ImageUpload
          id="photo-file"
          dialogAlert={failure}
          label={t('field.file')}
          hint={t('dict.photoHint')}
          types={IMAGE_TYPES}
          maxBytes={UPLOAD_MAX_BYTES}
          upload={async (file) => {
            const body = new FormData();
            body.append('file', file);
            await call(
              api.PUT('/dictionaries/products/{id}/image', {
                params: { path: { id: product.id } },
                body: body as never,
              }),
            );
          }}
          onDone={() => {
            refresh();
            onClose();
            toast.done({ tone: 'ok', text: t('dict.photoSaved', { name: product.name }) });
          }}
        />
      </div>
    </Dialog>
  );
}

function ImportDialog({
  name,
  onClose,
  onDone,
}: {
  name: DictName;
  onClose: () => void;
  onDone: (report: Report) => void;
}) {
  const { api } = useSession();
  const toast = useScreenToast();
  const refresh = useRefresh(name);
  const [picked, setPicked] = useState<{ file: File; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const failure = useDialogAlert();
  const [wait, startWait] = useCountdown();
  const button = useFocusAfterWait(wait);

  const pick = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    failure.clear();
    let error: string | undefined;
    if (!isImportFile(file)) error = t('files.unsupported', { allowed: typesText(IMPORT_TYPES) });
    else if (file.size > UPLOAD_MAX_BYTES) error = tooLargeText(UPLOAD_MAX_BYTES);
    setPicked({ file, error });
  };

  const send = async () => {
    if (!picked || picked.error) return;
    failure.clear();
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', picked.file);
      const report = await call<Report>(
        api.POST('/dictionaries/{name}/import', { params: { path: { name } }, body: body as never }),
      );
      refresh();
      onDone(report);
      toast.done({
        tone: report.errors.length ? 'attention' : 'ok',
        text: t('dict.import.done', {
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          rejected: new Set(report.errors.map((x) => x.row)).size,
        }),
      });
    } catch (e) {
      const problem = importFileProblem(e, name);
      if (problem) setPicked((p) => (p ? { ...p, error: problem } : p));
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      if (!problem) failure.show(errorText(e), errorTone(e));
    } finally {
      setBusy(false);
    }
  };

  const items: FileItem[] = picked
    ? [
        {
          key: 'import',
          name: picked.file.name,
          sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
          error: Boolean(picked.error),
          kind: picked.file.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV',
          ...(busy ? { progress: null } : {}),
        },
      ]
    : [];

  const close = () => {
    failure.handOff();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t('dict.import.title', { name: enumLabel(t, 'DictionaryName', name) })}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t('action.cancel')}
          </Button>
          <Button
            ref={button}
            variant="primary"
            icon="upload"
            busy={busy}
            disabled={!picked || Boolean(picked.error) || wait > 0}
            onClick={() => void send()}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('dict.import.send')}
          </Button>
        </>
      }
    >
      <div style={STACK}>
        <DialogMessage text={failure.message} />
        <FileField
          id="import-file"
          label={t('field.file')}
          accept={IMPORT_ACCEPT}
          hint={t('dict.import.hint', { header: IMPORT_HEADER[name] })}
          files={items}
          onFiles={pick}
          onRemove={() => setPicked(null)}
          error={picked?.error}
          disabled={busy}
        />
      </div>
    </Dialog>
  );
}

const COLUMN_LABEL: Record<string, string> = {
  name: 'field.name',
  category: 'field.category',
  lossNormPercent: 'field.lossNormPercent',
  type: 'field.type',
  waitingPeriodDays: 'field.waitingPeriodDays',
  unit: 'field.unit',
  product: 'field.productId',
  indicator: 'field.indicatorId',
  maxValue: 'field.maxValue',
  code: 'field.code',
};

type ReportError = Report['errors'][number];

function ImportReportCard({
  name,
  report,
  onClose,
}: {
  name: DictName;
  report: Report;
  onClose: () => void;
}) {
  const rejected = new Set(report.errors.map((x) => x.row)).size;
  const [page, setPage] = useState(1);
  const [seen, setSeen] = useState(report);
  if (seen !== report) {
    setSeen(report);
    setPage(1);
  }
  const shown = report.errors.slice((page - 1) * REPORT_ROWS, page * REPORT_ROWS);
  const columns: Column<ReportError & { key: string }>[] = [
    { key: 'row', header: t('dict.report.row'), numeric: true, cell: (x) => x.row },
    {
      key: 'column',
      header: t('dict.report.column'),
      cell: (x) =>
        x.column ? (
          <span className="at-table__primary">
            <span>{COLUMN_LABEL[x.column] ? t(COLUMN_LABEL[x.column]!) : x.column}</span>
            <span className="at-table__sub at-mono">{x.column}</span>
          </span>
        ) : (
          t('dict.report.wholeRow')
        ),
    },
    { key: 'message', header: t('dict.report.message'), cell: (x) => t(x.message) },
  ];
  return (
    <Card>
      <CardHeader title={t('dict.report.title', { name: enumLabel(t, 'DictionaryName', name) })}>
        <Button variant="ghost" iconOnly icon="close" aria-label={t('dict.report.close')} onClick={onClose} />
      </CardHeader>
      <CardBody>
        <div style={STACK}>
          <div style={METRICS}>
            <Metric label={t('dict.report.created')} value={report.created} />
            <Metric label={t('dict.report.updated')} value={report.updated} />
            <Metric label={t('dict.report.unchanged')} value={report.unchanged} />
            <Metric
              label={t('dict.report.rejected')}
              value={rejected}
              tone={rejected ? 'danger' : undefined}
            />
          </div>
          {shown.length > 0 && (
            <Table
              cards
              caption={t('dict.report.errors')}
              columns={columns}
              rows={shown.map((x, i) => ({
                ...x,
                key: `${x.row}-${x.column ?? ''}-${(page - 1) * REPORT_ROWS + i}`,
              }))}
              rowKey={(x) => x.key}
            />
          )}
          {report.errors.length > REPORT_ROWS && (
            <Pagination
              page={page}
              size={REPORT_ROWS}
              total={report.errors.length}
              label={t('dict.report.pages')}
              onPage={setPage}
            />
          )}
        </div>
      </CardBody>
    </Card>
  );
}
