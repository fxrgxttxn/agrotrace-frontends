import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatBytes, formatDecimal, formatLocalDate, formatLocalDateTime } from '@agrotrace/i18n';
import { FieldInputSchema, TreatmentInputSchema } from '@agrotrace/validation';
import { call, errorText, errorTone, useDialogAlert } from '../app/api';
import { addDays } from '../app/dates';
import { useDictionary } from '../app/dictionaries';
import { errorOf, FORM_GRID, normalizeDecimal, Submit, useSchemaForm, wireSchema } from '../app/forms';
import { useCacheWriter, useScreenNavigate, useScreenToast } from '../app/cache';
import { LOCALE, t } from '../app/i18n';
import { isBadListQuery, listGap, useListParams, type ListSpec } from '../app/listState';
import { momentCheck, momentDefaults, MomentInput, momentWire } from '../app/MomentInput';
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
  Textarea,
  type Column,
  type FileItem,
} from '../ui';

// Fields (FR-PROD-01) and their treatment journal (FR-PROD-02). FARMER manages the fields of the farm; INSPECTOR and
// ADMIN read the fields of every farm (organization filter). List state (search, region, organization, sort, page)
// lives in the URL (sanitized, F11). The map (Yandex Maps) is drawn only when the build has a key; the table is always
// there. Moments (treatment time) are entered in local time and shown in local time (F7, F11).

type FieldT = Schemas['Field'];
type Treatment = Schemas['Treatment'];
const SIZE = 20;
const GAP = { display: 'grid', gap: 'var(--sp-5)' } as const;

const FIELDS_SPEC: ListSpec = {
  sort: ['name', 'areaHa', 'lastTreatmentAt', 'createdAt'],
  patterns: { regionCode: /^[0-9A-Z-]{1,8}$/ },
  uuids: ['organizationId'],
  texts: ['q'],
};
const TREATMENTS_SPEC: ListSpec = { sort: ['appliedAt', 'createdAt'] };

/** How a form is laid out: on a page (submit under the fields) or in a dialog (submit in the action row). */
type Wrap = (form: ReactNode, submit: ReactNode) => ReactNode;
const onPage: Wrap = (form, submit) => (
  <>
    {form}
    {submit && <div style={{ marginTop: 'var(--sp-5)' }}>{submit}</div>}
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

const dateOrDash = (iso: string | null) => (iso ? formatLocalDate(iso, LOCALE) : '—');
const sortParam = (s: { field: string; dir: string } | null) => (s ? { sort: `${s.field},${s.dir}` } : {});
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
/** Client errors are answers, not outages: no automatic retries. */
const retryTransient = (n: number, e: unknown) => !(e instanceof ApiProblem && e.status < 500) && n < 2;

// ── /fields ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function FieldsPage() {
  const { api } = useSession();
  const { farmer, overseer } = useViewer();
  const list = useListParams('/fields', FIELDS_SPEC);
  const q = list.get('q');
  const regionCode = list.get('regionCode');
  const organizationId = overseer ? list.get('organizationId') : '';
  const regions = useDictionary('regions');
  const sort = list.sort;

  const query = useQuery({
    queryKey: ['fields', { page: list.page, sort: list.params.get('sort'), q, regionCode, organizationId }],
    meta: { failed: 'fields.failed' },
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
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && query.data.items.length === 0 && query.data.total > 0)
      clampPage(query.data.total, SIZE);
  }, [query.data, clampPage]);

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
        <LoadFailed
          text={t('fields.failed')}
          busy={query.isFetching}
          onRetry={() => void query.refetch()}
          onReset={isBadListQuery(query.error) ? list.reset : undefined}
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
          {filtered ? (
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
                  <option key={r.id} value={r.code}>
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
/** Largest outline file read into the form (1000 positions × 10 rings of GeoJSON fit well below it). */
const GEOJSON_MAX_BYTES = 1024 * 1024;

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

/** Text of a chosen file (FileReader: every browser, and jsdom). */
function readText(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

/** A polygon as the outline field shows it: pretty-printed, one position per line. */
export function prettyGeometry(geometry: unknown): string {
  return JSON.stringify(geometry, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]');
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
    geometry: f?.geometry ? prettyGeometry(f.geometry) : '',
  };
}

interface FieldFormProps {
  id: string;
  field?: FieldT;
  submitLabel: string;
  onSaved: (f: FieldT) => void;
  wrap?: Wrap;
  /** Set when the form is the body of a dialog: its open state (README «Диалог»: a failure is said in the dialog,
   * and handed to the page if the dialog closes while it still applies). */
  dialogOpen?: boolean;
}

/** The form is built once the regions are there: a select rendered before its options would show one value while
 * the form holds another. */
function FieldForm(props: FieldFormProps) {
  const regions = useDictionary('regions');
  const wrap = props.wrap ?? onPage;
  if (!regions.data)
    return wrap(
      regions.isError ? (
        <LoadFailed
          text={t('fields.failed')}
          busy={regions.isFetching}
          onRetry={() => void regions.refetch()}
        />
      ) : (
        <AreaLoading blocks={1} />
      ),
      null,
    );
  return <FieldFormReady {...props} wrap={wrap} regions={regions.data} />;
}

function FieldFormReady({
  id,
  field,
  submitLabel,
  onSaved,
  wrap,
  regions,
  dialogOpen,
}: FieldFormProps & { wrap: Wrap; regions: Schemas['RegionEntry'][] }) {
  const { api } = useSession();
  const inDialog = dialogOpen !== undefined;
  const { form, alert, wait, fail, message, handOff } = useSchemaForm<FieldValues>(
    fieldSchema,
    valuesOf(field),
    FIELD_FIELDS,
    fieldAlias,
    { dialog: inDialog },
  );
  useEffect(() => {
    if (dialogOpen === false) handOff();
  }, [dialogOpen, handOff]);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<FileItem[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
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
  // A `.geojson` file is read into the outline field (pretty-printed when it holds a polygon), where it can be checked.
  const importFile = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setFileError(null);
    const text = f.size <= GEOJSON_MAX_BYTES ? await readText(f) : null;
    if (text === null) {
      setFile([]);
      setFileError(t('fields.geometryUnreadable'));
      return;
    }
    const parsed = parseGeometry(text);
    form.setValue('geometry', parsed.ok && parsed.value ? prettyGeometry(parsed.value) : text, {
      shouldDirty: true,
    });
    setFile([{ key: f.name, name: f.name, sizeText: formatBytes(f.size, LOCALE) }]);
    if (parsed.ok) form.clearErrors('geometry');
    else form.setError('geometry', { type: 'file', message: 'fields.geometryInvalid' });
  };
  return wrap(
    <form id={id} noValidate onSubmit={(e) => void submit(e)} style={FORM_GRID}>
      {inDialog && <DialogMessage text={message} />}
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
          {regions.map((r) => (
            <option key={r.id} value={r.code}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={`${id}-geometry`} label={t('fields.geometry')} error={errorOf(form, 'geometry')}>
        <Textarea
          className="at-textarea at-mono"
          rows={6}
          spellCheck={false}
          // The format stays described when the placeholder is gone: the file field's hint (ruling F12).
          aria-describedby={`${id}-geometry-file-hint`}
          placeholder={'{\n  "type": "Polygon",\n  "coordinates": [[[39.01, 45.04], …, [39.01, 45.04]]]\n}'}
          {...form.register('geometry')}
        />
      </Field>
      <FileField
        id={`${id}-geometry-file`}
        label={t('fields.geometryFile')}
        accept=".geojson,.json,application/geo+json,application/json"
        hint={t('fields.geometryFileHint')}
        files={file}
        onFiles={(files) => void importFile(files)}
        onRemove={() => setFile([])}
        error={fileError}
      />
    </form>,
    <Submit busy={busy} wait={wait} form={id}>
      {submitLabel}
    </Submit>,
  );
}

// ── /fields/new ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function FieldNewPage() {
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
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
              toast.done({ tone: 'ok', text: t('fields.created', { name: f.name }) });
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
  // Loaded with the page: the edit dialog is mounted once, with its choices.
  const regions = useDictionary('regions');
  const { api } = useSession();
  const { farmer, overseer } = useViewer();
  const navigate = useScreenNavigate();
  const toast = useScreenToast();
  const queryClient = useQueryClient();
  const cache = useCacheWriter();
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  // Each opening of the edit dialog starts from the field as it is now.
  const [editKey, setEditKey] = useState(0);
  const [deleting, setDeleting] = useState(false);
  // The delete failure is said in its dialog; closed with it still standing, the page says it (README «Диалог»).
  const failure = useDialogAlert();
  const { handOff } = failure;
  useEffect(() => {
    if (dialog !== 'delete') handOff();
  }, [dialog, handOff]);

  const query = useQuery({
    queryKey: ['field', id],
    meta: { failed: 'fields.failed' },
    queryFn: () => call<FieldT>(api.GET('/fields/{id}', { params: { path: { id } } })),
    retry: retryTransient,
  });
  const field = query.data;

  const remove = async () => {
    if (!field) return;
    setDeleting(true);
    failure.clear();
    try {
      await call(api.DELETE('/fields/{id}', { params: { path: { id } } }));
      setDialog(null);
      queryClient.removeQueries({ queryKey: ['field', id] });
      void queryClient.invalidateQueries({ queryKey: ['fields'] });
      toast.done({ tone: 'ok', text: t('fields.deleted', { name: field.name }) });
      navigate('/fields');
    } catch (e) {
      failure.show(errorText(e), errorTone(e));
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
                if (!regions.data && regions.isError) {
                  toast.push({ tone: 'danger', text: t('fields.regionsFailed') });
                  void regions.refetch();
                  return;
                }
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
      {field && regions.data && (
        <FieldForm
          key={editKey}
          id="field-edit"
          field={field}
          dialogOpen={dialog === 'edit'}
          submitLabel={t('action.save')}
          onSaved={(f) => {
            setDialog(null);
            cache.set(['field', id], f);
            void queryClient.invalidateQueries({ queryKey: ['fields'] });
            toast.done({ tone: 'ok', text: t('fields.saved', { name: f.name }) });
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
        <div style={FORM_GRID}>
          <DialogMessage text={failure.message} />
          <p style={{ margin: 0 }}>{t('fields.deleteText', { name: field?.name ?? '' })}</p>
        </div>
      </Dialog>
    </Page>
  );
}

// ── Treatments of a field ────────────────────────────────────────────────────────────────────────────────────────────

function Treatments({ field, farmer }: { field: FieldT; farmer: boolean }) {
  const { api } = useSession();
  // Loaded before a dialog opens: the dialog is mounted once, with its choices (its opener gets the focus back).
  const substances = useDictionary('substances');
  const list = useListParams(`/fields/${field.id}`, TREATMENTS_SPEC);
  const now = useNow();
  const queryClient = useQueryClient();
  const toast = useScreenToast();
  // The dialog stays mounted while it closes (the native close returns the focus to the button that opened it).
  const [editing, setEditingState] = useState<{ tr?: Treatment; key: number; open: boolean } | null>(null);
  const setEditing = (target: Treatment | 'new' | null) => {
    if (target !== null && !substances.data && substances.isError) {
      toast.push({ tone: 'danger', text: t('treatments.substancesFailed') });
      void substances.refetch();
      return;
    }
    setEditingState((cur) =>
      target === null
        ? cur && { ...cur, open: false }
        : { tr: target === 'new' ? undefined : target, key: (cur?.key ?? 0) + 1, open: true },
    );
  };
  const sort = list.sort;

  const query = useQuery({
    queryKey: ['treatments', field.id, { page: list.page, sort: list.params.get('sort') }],
    meta: { failed: 'treatments.failed' },
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
  const { clampPage } = list;
  useEffect(() => {
    if (query.data && query.data.items.length === 0 && query.data.total > 0)
      clampPage(query.data.total, SIZE);
  }, [query.data, clampPage]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['treatments', field.id] });
    void queryClient.invalidateQueries({ queryKey: ['field', field.id] });
    void queryClient.invalidateQueries({ queryKey: ['fields'] });
  };

  // A focused «Изменить» that disappears (its 24 h window closed) would drop the focus to the page: it goes to
  // «Записать обработку» (or the card title) instead.
  const card = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<Element | null>(null);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const on = (e: FocusEvent) => (lastFocus.current = e.target as Element);
    el.addEventListener('focus', on, true);
    return () => el.removeEventListener('focus', on, true);
  }, []);
  useEffect(() => {
    const last = lastFocus.current;
    if (!last || last.isConnected) return;
    // (Browsers move the focus to the body; jsdom keeps the removed element as active.)
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    lastFocus.current = null;
    const title = card.current?.querySelector<HTMLElement>('.at-card__title');
    (addButton.current ?? title)?.focus();
  });

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
      cell: (tr) => formatLocalDateTime(tr.appliedAt, LOCALE),
    },
    {
      key: 'wait',
      header: t('treatments.waitUntil'),
      cell: (tr) => formatLocalDateTime(addDays(tr.appliedAt, tr.substance.waitingPeriodDays), LOCALE),
    },
  ];

  const body = () => {
    if (!query.data && query.isError)
      return isBadListQuery(query.error) ? (
        <Empty
          art="empty-search"
          text={t('filters.invalid')}
          action={
            <Button variant="primary" onClick={list.reset}>
              {t('filters.reset')}
            </Button>
          }
        />
      ) : (
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
    const gap = listGap(query.data, list.page, SIZE);
    if (gap === 'pastEnd') return <AreaLoading blocks={1} />;
    if (gap === 'changed')
      return <ListChanged busy={query.isFetching} onReload={() => void query.refetch()} />;
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
                        date: formatLocalDate(tr.appliedAt, LOCALE),
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
    <div ref={card}>
      <Card>
        <CardHeader title={t('treatments.title')}>
          {farmer && items.length > 0 && (
            <Button ref={addButton} icon="plus" onClick={() => setEditing('new')}>
              {t('treatments.add')}
            </Button>
          )}
        </CardHeader>
        <CardBody>{body()}</CardBody>
        {editing !== null && substances.data && (
          <TreatmentFormReady
            substances={substances.data}
            key={editing.key}
            open={editing.open}
            fieldId={field.id}
            treatment={editing.tr}
            onClose={() => setEditing(null)}
            onSaved={(created) => {
              setEditing(null);
              refresh();
              toast.done({ tone: 'ok', text: t(created ? 'treatments.created' : 'treatments.saved') });
            }}
            onClosedWindow={(until) => {
              setEditing(null);
              refresh();
              toast.push({
                tone: 'danger',
                text: t('treatments.editClosed', { time: formatLocalDateTime(until, LOCALE) }),
              });
            }}
          />
        )}
      </Card>
    </div>
  );
}

interface TreatmentValues {
  substanceId: string;
  dose: string;
  doseUnit: string;
  appliedAt: string | null;
  appliedTime: string;
  /** The recorded instant: kept as it is while its date and time are not changed. */
  original: string | null;
}
const TREATMENT_FIELDS = ['substanceId', 'dose', 'doseUnit', 'appliedAt', 'appliedTime'] as const;
const DOSE_UNITS = ['л/га', 'мл/га', 'кг/га', 'г/га'] as const;

const moment = (v: TreatmentValues) => ({ date: v.appliedAt, time: v.appliedTime, original: v.original });
const treatmentSchema = wireSchema<TreatmentValues>(
  TreatmentInputSchema,
  (v) => ({
    substanceId: v.substanceId,
    dose: normalizeDecimal(v.dose, 3),
    doseUnit: v.doseUnit,
    appliedAt: momentWire(moment(v)),
  }),
  (v) => momentCheck(moment(v), 'appliedAt', 'appliedTime'),
);

interface TreatmentFormProps {
  open: boolean;
  fieldId: string;
  treatment?: Treatment;
  onClose: () => void;
  onSaved: (created: boolean) => void;
  /** 403 EDIT_WINDOW_CLOSED: until when it could be edited (the server's `params.editableUntil`). */
  onClosedWindow: (editableUntil: string) => void;
}

function TreatmentFormReady({
  open,
  fieldId,
  treatment,
  onClose,
  onSaved,
  onClosedWindow,
  substances,
}: TreatmentFormProps & { substances: Schemas['Substance'][] }) {
  const { api } = useSession();
  const at = momentDefaults(treatment?.appliedAt);
  const { form, alert, wait, fail, message, handOff } = useSchemaForm<TreatmentValues>(
    treatmentSchema,
    {
      substanceId: treatment?.substance.id ?? '',
      dose: treatment ? treatment.dose.replace('.', ',') : '',
      doseUnit: treatment?.doseUnit ?? 'л/га',
      appliedAt: at.date,
      appliedTime: at.time,
      original: at.original,
    },
    TREATMENT_FIELDS,
    undefined,
    { dialog: true },
  );
  useEffect(() => {
    if (!open) handOff();
  }, [open, handOff]);
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
      ) {
        const until = e.params.editableUntil;
        onClosedWindow(typeof until === 'string' ? until : treatment.editableUntil);
      } else fail(e);
    } finally {
      setBusy(false);
    }
  });
  const label = treatment ? t('action.save') : t('treatments.add');
  // A substance that left the dictionary still names the edited record.
  const options =
    treatment && !substances.some((s) => s.id === treatment.substance.id)
      ? [treatment.substance, ...substances]
      : substances;
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
        <DialogMessage text={message} />
        <Field id="treatment-substance" label={t('field.substanceId')} error={errorOf(form, 'substanceId')}>
          <Select {...form.register('substanceId')}>
            <option value="" disabled>
              {t('ui.choose')}
            </option>
            {options.map((s) => (
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
        <MomentInput
          form={form}
          id="treatment"
          dateName="appliedAt"
          timeName="appliedTime"
          dateLabel={t('field.appliedAt')}
          timeLabel={t('treatments.time')}
        />
      </form>
    </Dialog>
  );
}
