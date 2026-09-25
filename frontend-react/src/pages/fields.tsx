import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatDate, formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
import { FieldInputSchema, TreatmentInputSchema } from '@agrotrace/validation';
import { call, errorText, errorTone, useFormAlert } from '../app/api';
import { addDays, dateToInstant, todayUtc } from '../app/dates';
import { useDictionary } from '../app/dictionaries';
import { errorOf, FORM_GRID, normalizeDecimal, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { useListParams } from '../app/listState';
import { OrgPicker } from '../app/OrgPicker';
import { useMe, useSession } from '../app/session';
import { useNow } from '../app/useNow';
import { FieldMap } from '../maps/FieldMap';
import {
  AreaLoading,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardFacts,
  CardHeader,
  DateInput,
  Dialog,
  Empty,
  Field,
  Input,
  InputGroup,
  LoadFailed,
  Page,
  PageToolbar,
  Pagination,
  Select,
  Table,
  Textarea,
  useToast,
  type Column,
} from '../ui';

// Fields (FR-PROD-01) and their treatment journal (FR-PROD-02). FARMER manages the fields of the farm; INSPECTOR and
// ADMIN read the fields of every farm (organization filter). List state (search, region, organization, sort, page)
// lives in the URL. The map (Yandex Maps) is drawn only when the build has a key; the table is always there.

type FieldT = Schemas['Field'];
type Treatment = Schemas['Treatment'];
const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;

/** How a form is laid out: on a page (submit under the fields) or in a dialog (submit in the action row). */
type Wrap = (form: ReactNode, submit: ReactNode) => ReactNode;
const onPage: Wrap = (form, submit) => (
  <>
    {form}
    <div style={{ marginTop: 'var(--sp-5)' }}>{submit}</div>
  </>
);

function useViewer() {
  const me = useMe();
  return {
    me,
    farmer: me.roles.includes('FARMER'),
    overseer: me.roles.includes('INSPECTOR') || me.roles.includes('ADMIN'),
  };
}

const dateOrDash = (iso: string | null) => (iso ? formatDate(iso, LOCALE) : '—');
const sortParam = (s: { field: string; dir: string } | null) => (s ? { sort: `${s.field},${s.dir}` } : {});
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
/** Client errors are answers, not outages: no automatic retries. */
const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;

// ── /fields ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function FieldsPage() {
  const { api } = useSession();
  const { farmer, overseer } = useViewer();
  const list = useListParams('/fields');
  const q = list.get('q');
  const regionCode = list.get('regionCode');
  const organizationId = overseer ? list.get('organizationId') : '';
  const regions = useDictionary('regions');
  const sort = list.sort;

  const query = useQuery({
    queryKey: ['fields', { page: list.page, sort: list.params.get('sort'), q, regionCode, organizationId }],
    queryFn: () =>
      call<Schemas['FieldPage']>(
        api.GET('/fields', {
          params: {
            query: {
              page: list.page,
              size: SIZE,
              ...sortParam(sort),
              ...(q ? { q } : {}),
              ...(regionCode ? { regionCode } : {}),
              ...(organizationId ? { organizationId } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const items = query.data?.items ?? [];
  const filtered = Boolean(q || regionCode || organizationId);

  const columns: Column<FieldT>[] = [
    {
      key: 'name',
      header: t('field.name'),
      primary: true,
      sortField: 'name',
      cell: (f) => (
        <span className="at-table__primary">
          <Link to={`/fields/${f.id}`}>{f.name}</Link>
          <span className="at-table__sub">{f.region.name}</span>
        </span>
      ),
    },
    ...(overseer
      ? [{ key: 'farm', header: t('fields.farm'), cell: (f: FieldT) => f.organization.name }]
      : []),
    {
      key: 'area',
      header: t('fields.area'),
      numeric: true,
      sortField: 'areaHa',
      cell: (f) => formatDecimal(f.areaHa, LOCALE),
    },
    {
      key: 'last',
      header: t('fields.lastTreatment'),
      sortField: 'lastTreatmentAt',
      cell: (f) => dateOrDash(f.lastTreatmentAt),
    },
    { key: 'count', header: t('fields.treatments'), numeric: true, cell: (f) => String(f.treatmentsCount) },
  ];

  const content = () => {
    if (!query.data && query.isError)
      return (
        <LoadFailed text={t('fields.failed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
      );
    if (!query.data) return <AreaLoading />;
    if (items.length === 0)
      return (
        <Card>
          {filtered ? (
            <Empty
              art="empty-search"
              text={t('empty.search')}
              action={
                <Button
                  variant="primary"
                  onClick={() => list.set({ q: null, regionCode: null, organizationId: null })}
                >
                  {t('filters.reset')}
                </Button>
              }
            />
          ) : (
            <Empty
              art="empty-fields"
              text={t('empty.fields')}
              action={
                farmer ? (
                  <ButtonLink variant="primary" to="/fields/new">
                    {t('fields.add')}
                  </ButtonLink>
                ) : (
                  <ButtonLink variant="primary" to="/">
                    {t('action.home')}
                  </ButtonLink>
                )
              }
            />
          )}
        </Card>
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={GAP}>
        <FieldMap fields={items} />
        <Table
          cards
          caption={t('page.fields')}
          columns={columns}
          rows={items}
          rowKey={(f) => f.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'name,asc', label: t('fields.sort.name') },
            { value: 'areaHa,desc', label: t('fields.sort.areaDesc') },
            { value: 'areaHa,asc', label: t('fields.sort.areaAsc') },
            { value: 'lastTreatmentAt,desc', label: t('fields.sort.lastTreatment') },
          ]}
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Page
      title={t('page.fields')}
      actions={
        farmer && (
          <ButtonLink variant="primary" icon="plus" to="/fields/new">
            {t('fields.add')}
          </ButtonLink>
        )
      }
    >
      <PageToolbar
        search={{
          label: t('fields.search'),
          placeholder: t('fields.searchPlaceholder'),
          value: q,
          onChange: (text) => list.set({ q: text }),
        }}
        count={[regionCode, organizationId].filter(Boolean).length}
        filters={
          <>
            <Field id="filter-region" label={t('fields.region')}>
              <Select value={regionCode} onChange={(e) => list.set({ regionCode: e.target.value })}>
                <option value="">{t('filters.any')}</option>
                {(regions.data ?? []).map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            {overseer && (
              <OrgPicker
                id="filter-org"
                label={t('fields.farm')}
                types={['FARM']}
                value={organizationId}
                onChange={(id) => list.set({ organizationId: id })}
              />
            )}
          </>
        }
      />
      {content()}
    </Page>
  );
}

// ── Field form (create page, edit dialog) ────────────────────────────────────────────────────────────────────────────

interface FieldValues {
  name: string;
  areaHa: string;
  regionCode: string;
  geometry: string;
}
const FIELD_FIELDS = ['name', 'areaHa', 'regionCode', 'geometry'] as const;

/** GeoJSON text → a Polygon geometry (a bare geometry, a Feature, or a collection of one Feature); `''` → null. */
export function parseGeometry(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    let v = JSON.parse(text) as Record<string, unknown> | null;
    if (v?.type === 'FeatureCollection' && Array.isArray(v.features) && v.features.length === 1)
      v = v.features[0] as Record<string, unknown>;
    if (v?.type === 'Feature') v = v.geometry as Record<string, unknown>;
    return v?.type === 'Polygon' ? { ok: true, value: v } : { ok: false };
  } catch {
    return { ok: false };
  }
}

const fieldSchema = wireSchema<FieldValues>(
  FieldInputSchema,
  (v) => {
    const geometry = parseGeometry(v.geometry);
    return {
      name: v.name,
      areaHa: normalizeDecimal(v.areaHa, 2),
      regionCode: v.regionCode,
      geometry: geometry.ok ? geometry.value : null,
    };
  },
  (v): Record<string, string> => (parseGeometry(v.geometry).ok ? {} : { geometry: 'fields.geometryInvalid' }),
);

/** Server errors inside the outline (`geometry.coordinates[0]`) belong to the outline field. */
const fieldAlias = (path: string) => (path.startsWith('geometry') ? 'geometry' : path);

function valuesOf(f?: FieldT): FieldValues {
  return {
    name: f?.name ?? '',
    areaHa: f ? f.areaHa.replace('.', ',') : '',
    regionCode: f?.region.code ?? '',
    geometry: f?.geometry ? JSON.stringify(f.geometry) : '',
  };
}

function FieldForm({
  id,
  field,
  submitLabel,
  onSaved,
  wrap = onPage,
}: {
  id: string;
  field?: FieldT;
  submitLabel: string;
  onSaved: (f: FieldT) => void;
  wrap?: Wrap;
}) {
  const { api } = useSession();
  const regions = useDictionary('regions');
  const { form, alert, wait, fail } = useSchemaForm<FieldValues>(
    fieldSchema,
    valuesOf(field),
    FIELD_FIELDS,
    fieldAlias,
  );
  const [busy, setBusy] = useState(false);
  const submit = form.handleSubmit(async (values) => {
    const body = values as unknown as Schemas['FieldInput'];
    alert.clear();
    setBusy(true);
    try {
      const saved = field
        ? await call<FieldT>(api.PUT('/fields/{id}', { params: { path: { id: field.id } }, body }))
        : await call<FieldT>(api.POST('/fields', { body }));
      onSaved(saved);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  });
  return wrap(
    <form id={id} noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
      <Field id={`${id}-name`} label={t('field.name')} error={errorOf(form, 'name')}>
        <Input autoComplete="off" {...form.register('name')} />
      </Field>
      <Field id={`${id}-area`} label={t('field.areaHa')} error={errorOf(form, 'areaHa')}>
        <InputGroup
          suffix={t('unit.ha')}
          inputMode="decimal"
          autoComplete="off"
          {...form.register('areaHa')}
        />
      </Field>
      <Field id={`${id}-region`} label={t('field.regionCode')} error={errorOf(form, 'regionCode')}>
        <Select {...form.register('regionCode')}>
          <option value="" disabled>
            {t('ui.choose')}
          </option>
          {(regions.data ?? (field ? [field.region] : [])).map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`${id}-geometry`} label={t('fields.geometry')} error={errorOf(form, 'geometry')}>
        <Textarea rows={4} spellCheck={false} {...form.register('geometry')} />
      </Field>
    </form>,
    <Submit busy={busy} wait={wait} form={id}>
      {submitLabel}
    </Submit>,
  );
}

// ── /fields/new ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function FieldNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  return (
    <Page title={t('page.fieldNew')}>
      <Card style={{ maxWidth: '40rem' }}>
        <CardBody>
          <FieldForm
            id="field-new"
            submitLabel={t('fields.add')}
            onSaved={(f) => {
              void queryClient.invalidateQueries({ queryKey: ['fields'] });
              toast.push({ tone: 'ok', text: t('fields.created', { name: f.name }) });
              navigate(`/fields/${f.id}`);
            }}
          />
        </CardBody>
      </Card>
    </Page>
  );
}

// ── /fields/:id ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function FieldPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const { farmer, overseer } = useViewer();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  // Each opening of the edit dialog starts from the field as it is now.
  const [editKey, setEditKey] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const alert = useFormAlert();

  const query = useQuery({
    queryKey: ['field', id],
    queryFn: () => call<FieldT>(api.GET('/fields/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const field = query.data;

  const remove = async () => {
    if (!field) return;
    setDeleting(true);
    alert.clear();
    try {
      await call(api.DELETE('/fields/{id}', { params: { path: { id } } }));
      setDialog(null);
      queryClient.removeQueries({ queryKey: ['field', id] });
      void queryClient.invalidateQueries({ queryKey: ['fields'] });
      toast.push({ tone: 'ok', text: t('fields.deleted', { name: field.name }) });
      navigate('/fields');
    } catch (e) {
      alert.show(errorText(e), errorTone(e));
    } finally {
      setDeleting(false);
    }
  };

  if (!field && notFound(query.error))
    return (
      <Page title={t('page.field')}>
        <Card>
          <Empty
            art="not-found"
            text={t('fields.notFound')}
            action={
              <ButtonLink variant="primary" to="/fields">
                {t('fields.toList')}
              </ButtonLink>
            }
          />
        </Card>
      </Page>
    );

  return (
    <Page
      title={field?.name ?? t('page.field')}
      actions={
        farmer &&
        field && (
          <>
            <ButtonLink variant="primary" to={`/batches/new?fieldId=${field.id}`}>
              {t('fields.batch')}
            </ButtonLink>
            <Button
              onClick={() => {
                setEditKey((k) => k + 1);
                setDialog('edit');
              }}
            >
              {t('fields.edit')}
            </Button>
            <Button variant="ghost" icon="trash" onClick={() => setDialog('delete')}>
              {t('fields.delete')}
            </Button>
          </>
        )
      }
    >
      {!field && query.isError ? (
        <LoadFailed text={t('fields.failed')} busy={query.isFetching} onRetry={() => void query.refetch()} />
      ) : !field ? (
        <AreaLoading />
      ) : (
        <div style={GAP}>
          <Card>
            <CardBody>
              <CardFacts
                facts={[
                  ...(overseer
                    ? [{ key: 'farm', term: t('fields.farm'), value: field.organization.name }]
                    : []),
                  { key: 'region', term: t('fields.region'), value: field.region.name },
                  { key: 'area', term: t('fields.area'), value: formatDecimal(field.areaHa, LOCALE) },
                  { key: 'count', term: t('fields.treatments'), value: String(field.treatmentsCount) },
                  { key: 'last', term: t('fields.lastTreatment'), value: dateOrDash(field.lastTreatmentAt) },
                  ...(field.geometry
                    ? []
                    : [{ key: 'geo', term: t('field.geometry'), value: t('fields.noGeometry') }]),
                ]}
              />
            </CardBody>
          </Card>
          <FieldMap fields={[field]} />
          <Treatments field={field} farmer={farmer} />
        </div>
      )}
      {field && (
        <FieldForm
          key={editKey}
          id="field-edit"
          field={field}
          submitLabel={t('action.save')}
          onSaved={(f) => {
            setDialog(null);
            queryClient.setQueryData(['field', id], f);
            void queryClient.invalidateQueries({ queryKey: ['fields'] });
            toast.push({ tone: 'ok', text: t('fields.saved', { name: f.name }) });
          }}
          wrap={(form, submit) => (
            <Dialog
              open={dialog === 'edit'}
              onClose={() => setDialog(null)}
              title={t('fields.editTitle')}
              actions={
                <>
                  <Button variant="ghost" onClick={() => setDialog(null)}>
                    {t('action.cancel')}
                  </Button>
                  {submit}
                </>
              }
            >
              {form}
            </Dialog>
          )}
        />
      )}
      <Dialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title={t('fields.deleteTitle')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('action.cancel')}
            </Button>
            <Button variant="danger" busy={deleting} onClick={() => void remove()}>
              {t('fields.delete')}
            </Button>
          </>
        }
      >
        <p>{t('fields.deleteText', { name: field?.name ?? '' })}</p>
      </Dialog>
    </Page>
  );
}

// ── Treatments of a field ────────────────────────────────────────────────────────────────────────────────────────────

function Treatments({ field, farmer }: { field: FieldT; farmer: boolean }) {
  const { api } = useSession();
  const list = useListParams(`/fields/${field.id}`);
  const now = useNow();
  const queryClient = useQueryClient();
  const toast = useToast();
  // The dialog stays mounted while it closes (the native close returns the focus to the button that opened it).
  const [editing, setEditingState] = useState<{ tr?: Treatment; key: number; open: boolean } | null>(null);
  const setEditing = (target: Treatment | 'new' | null) =>
    setEditingState((cur) =>
      target === null
        ? cur && { ...cur, open: false }
        : { tr: target === 'new' ? undefined : target, key: (cur?.key ?? 0) + 1, open: true },
    );
  const sort = list.sort;

  const query = useQuery({
    queryKey: ['treatments', field.id, { page: list.page, sort: list.params.get('sort') }],
    queryFn: () =>
      call<Schemas['TreatmentPage']>(
        api.GET('/fields/{id}/treatments', {
          params: { path: { id: field.id }, query: { page: list.page, size: SIZE, ...sortParam(sort) } },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
  const items = query.data?.items ?? [];
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['treatments', field.id] });
    void queryClient.invalidateQueries({ queryKey: ['field', field.id] });
    void queryClient.invalidateQueries({ queryKey: ['fields'] });
  };

  // The edit window (FR-PROD-02) is the contract's `editableUntil`, inclusive; the button goes when it passes.
  const editable = (tr: Treatment) => farmer && now <= Date.parse(tr.editableUntil);
  const columns: Column<Treatment>[] = [
    {
      key: 'substance',
      header: t('field.substanceId'),
      primary: true,
      cell: (tr) => (
        <span className="at-table__primary">
          <span>{tr.substance.name}</span>
          <span className="at-table__sub">{enumLabel(t, 'SubstanceType', tr.substance.type)}</span>
        </span>
      ),
    },
    {
      key: 'dose',
      header: t('treatments.dose'),
      numeric: true,
      cell: (tr) => `${formatDecimal(tr.dose, LOCALE)} ${tr.doseUnit}`,
    },
    {
      key: 'applied',
      header: t('field.appliedAt'),
      sortField: 'appliedAt',
      cell: (tr) => formatDate(tr.appliedAt, LOCALE),
    },
    {
      key: 'wait',
      header: t('treatments.waitUntil'),
      cell: (tr) => formatDate(addDays(tr.appliedAt, tr.substance.waitingPeriodDays), LOCALE),
    },
  ];

  const body = () => {
    if (!query.data && query.isError)
      return (
        <Empty
          art="empty-search"
          text={t('treatments.failed')}
          action={
            <Button variant="primary" busy={query.isFetching} onClick={() => void query.refetch()}>
              {t('action.retry')}
            </Button>
          }
        />
      );
    if (!query.data) return <AreaLoading blocks={1} />;
    if (items.length === 0)
      return (
        <Empty
          art="empty-fields"
          text={t('treatments.empty')}
          action={
            farmer ? (
              <Button variant="primary" onClick={() => setEditing('new')}>
                {t('treatments.add')}
              </Button>
            ) : undefined
          }
        />
      );
    return (
      <div aria-busy={query.isFetching ? 'true' : undefined} style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <Table
          cards
          caption={t('treatments.title')}
          columns={columns}
          rows={items}
          rowKey={(tr) => tr.id}
          sort={sort}
          onSort={list.setSort}
          sortOptions={[
            { value: 'appliedAt,desc', label: t('treatments.sort.newest') },
            { value: 'appliedAt,asc', label: t('treatments.sort.oldest') },
          ]}
          actions={
            farmer
              ? (tr) =>
                  editable(tr) ? (
                    <Button
                      size="s"
                      aria-label={t('treatments.editOf', {
                        substance: tr.substance.name,
                        date: formatDate(tr.appliedAt, LOCALE),
                      })}
                      title={t('treatments.editableUntil', {
                        time: formatLocalDateTime(tr.editableUntil, LOCALE),
                      })}
                      onClick={() => setEditing(tr)}
                    >
                      {t('treatments.edit')}
                    </Button>
                  ) : null
              : undefined
          }
        />
        <Pagination page={list.page} size={SIZE} total={query.data.total} hrefFor={list.hrefFor} />
      </div>
    );
  };

  return (
    <Card>
      <CardHeader title={t('treatments.title')}>
        {farmer && items.length > 0 && (
          <Button icon="plus" onClick={() => setEditing('new')}>
            {t('treatments.add')}
          </Button>
        )}
      </CardHeader>
      <CardBody>{body()}</CardBody>
      {editing !== null && (
        <TreatmentForm
          key={editing.key}
          open={editing.open}
          fieldId={field.id}
          treatment={editing.tr}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null);
            refresh();
            toast.push({ tone: 'ok', text: t(created ? 'treatments.created' : 'treatments.saved') });
          }}
          onClosedWindow={(tr) => {
            setEditing(null);
            refresh();
            toast.push({
              tone: 'danger',
              text: t('treatments.editClosed', { time: formatLocalDateTime(tr.editableUntil, LOCALE) }),
            });
          }}
        />
      )}
    </Card>
  );
}

interface TreatmentValues {
  substanceId: string;
  dose: string;
  doseUnit: string;
  appliedAt: string | null;
  /** The recorded instant: kept as it is while its date is not changed (an edit keeps the time of day). */
  original: string | null;
}
const TREATMENT_FIELDS = ['substanceId', 'dose', 'doseUnit', 'appliedAt'] as const;
const DOSE_UNITS = ['л/га', 'мл/га', 'кг/га', 'г/га'] as const;

const treatmentSchema = wireSchema<TreatmentValues>(TreatmentInputSchema, (v) => ({
  substanceId: v.substanceId,
  dose: normalizeDecimal(v.dose, 3),
  doseUnit: v.doseUnit,
  appliedAt:
    v.appliedAt === null
      ? undefined
      : v.original && v.original.slice(0, 10) === v.appliedAt
        ? v.original
        : dateToInstant(v.appliedAt),
}));

function TreatmentForm({
  open,
  fieldId,
  treatment,
  onClose,
  onSaved,
  onClosedWindow,
}: {
  open: boolean;
  fieldId: string;
  treatment?: Treatment;
  onClose: () => void;
  onSaved: (created: boolean) => void;
  onClosedWindow: (tr: Treatment) => void;
}) {
  const { api } = useSession();
  const substances = useDictionary('substances');
  const { form, alert, wait, fail } = useSchemaForm<TreatmentValues>(
    treatmentSchema,
    {
      substanceId: treatment?.substance.id ?? '',
      dose: treatment ? treatment.dose.replace('.', ',') : '',
      doseUnit: treatment?.doseUnit ?? 'л/га',
      appliedAt: treatment ? treatment.appliedAt.slice(0, 10) : null,
      original: treatment?.appliedAt ?? null,
    },
    TREATMENT_FIELDS,
  );
  const [busy, setBusy] = useState(false);
  const submit = form.handleSubmit(async (values) => {
    const body = values as unknown as Schemas['TreatmentInput'];
    alert.clear();
    setBusy(true);
    try {
      if (treatment)
        await call<Treatment>(api.PUT('/treatments/{id}', { params: { path: { id: treatment.id } }, body }));
      else
        await call<Treatment>(
          api.POST('/fields/{id}/treatments', { params: { path: { id: fieldId } }, body }),
        );
      onSaved(!treatment);
    } catch (e) {
      if (
        treatment &&
        e instanceof ApiProblem &&
        e.status === 403 &&
        e.params?.reason === 'EDIT_WINDOW_CLOSED'
      )
        onClosedWindow(treatment);
      else fail(e);
    } finally {
      setBusy(false);
    }
  });
  const appliedAt = form.watch('appliedAt');
  const label = treatment ? t('action.save') : t('treatments.add');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={treatment ? t('treatments.editTitle') : t('treatments.add')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Submit busy={busy} wait={wait} form="treatment-form">
            {label}
          </Submit>
        </>
      }
    >
      <form id="treatment-form" noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
        <Field id="treatment-substance" label={t('field.substanceId')} error={errorOf(form, 'substanceId')}>
          <Select {...form.register('substanceId')}>
            <option value="" disabled>
              {t('ui.choose')}
            </option>
            {(substances.data ?? (treatment ? [treatment.substance] : [])).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="treatment-dose" label={t('field.dose')} error={errorOf(form, 'dose')}>
          <Input inputMode="decimal" autoComplete="off" {...form.register('dose')} />
        </Field>
        <Field id="treatment-unit" label={t('field.doseUnit')} error={errorOf(form, 'doseUnit')}>
          <Select {...form.register('doseUnit')}>
            {DOSE_UNITS.map((u) => (
              <option key={u} value={u}>
                {enumLabel(t, 'DoseUnit', u)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="treatment-date" label={t('field.appliedAt')} error={errorOf(form, 'appliedAt')}>
          <DateInput
            value={appliedAt}
            max={todayUtc()}
            onChange={(iso) => form.setValue('appliedAt', iso, { shouldDirty: true })}
            onValidate={(err) =>
              err ? form.setError('appliedAt', { type: 'date', message: err }) : form.clearErrors('appliedAt')
            }
          />
        </Field>
      </form>
    </Dialog>
  );
}
