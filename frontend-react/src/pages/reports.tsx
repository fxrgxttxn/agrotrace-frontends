import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatBytes, formatLocalDate } from '@agrotrace/i18n';
import {
  call,
  errorText,
  errorTone,
  retryAfterOf,
  useCountdown,
  useFocusAfterWait,
  useFormAlert,
} from '../app/api';
import { useScreenScope, useScreenToast } from '../app/cache';
import { FORM_GRID } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { OrgPicker } from '../app/OrgPicker';
import { useMe, useSession } from '../app/session';
import type { Role } from '../app/access';
import {
  Button,
  Card,
  CardBody,
  CardFooter,
  Combobox,
  DateInput,
  dateErrorText,
  Field,
  FieldSet,
  Radio,
  Select,
  type ComboOption,
  Page,
  type DateError,
} from '../ui';

type ReportType = Schemas['ReportType'];
type ReportFormat = Schemas['ReportFormat'];

export const REPORT_ACCESS: Record<ReportType, { roles: readonly Role[]; headRoles: readonly Role[] }> = {
  batches: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'RETAILER'] },
  recalls: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  recall: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  'lab-tests': { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['LAB'] },
  complaints: { roles: ['INSPECTOR', 'ADMIN'], headRoles: [] },
  org: { roles: ['INSPECTOR', 'ADMIN'], headRoles: ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER'] },
};
const TYPES = Object.keys(REPORT_ACCESS) as ReportType[];
const FORMATS: readonly ReportFormat[] = ['xlsx', 'pdf'];
const DAY = 86_400_000;
const MAX_DAYS = 366;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export function reportTypes(
  roles: readonly Role[],
  isOrgAdmin: boolean,
): { type: ReportType; head: boolean }[] {
  return TYPES.flatMap((type): { type: ReportType; head: boolean }[] => {
    const a = REPORT_ACCESS[type];
    if (roles.some((r) => a.roles.includes(r))) return [{ type, head: false }];
    if (isOrgAdmin && roles.some((r) => a.headRoles.includes(r))) return [{ type, head: true }];
    return [];
  });
}

export function fileNameOf(disposition: string | null, fallback: string): string {
  const m = /filename="([^"]+)"/.exec(disposition ?? '');
  return m?.[1] ?? fallback;
}

interface Errors {
  type?: string;
  id?: string;
  from?: string;
  to?: string;
  format?: string;
}

export function ReportsPage() {
  const { api } = useSession();
  const me = useMe();
  const scope = useScreenScope();
  const toast = useScreenToast();
  const alert = useFormAlert();
  const [params] = useSearchParams();
  const available = reportTypes(me.roles, me.isOrgAdmin);
  const fromUrl = params.get('type') as ReportType | null;
  const [type, setType] = useState<ReportType | ''>(
    available.some((a) => a.type === fromUrl) ? fromUrl! : (available[0]?.type ?? ''),
  );
  const idFromUrl = params.get('id');
  const [id, setId] = useState(idFromUrl && UUID.test(idFromUrl) ? idFromUrl.toLowerCase() : '');
  const today = isoDay(Date.now());
  const [from, setFrom] = useState<string | null>(isoDay(Date.now() - 29 * DAY));
  const [to, setTo] = useState<string | null>(today);
  const [dateErrors, setDateErrors] = useState<{ from?: DateError | null; to?: DateError | null }>({});
  const [format, setFormat] = useState<ReportFormat>('xlsx');
  const [errors, setErrors] = useState<Errors>({});
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(null);
  const [wait, startWait] = useCountdown();
  const button = useFocusAfterWait(wait);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const head = available.find((a) => a.type === type)?.head ?? false;
  const needsId = type === 'recall' || (type === 'org' && !head);
  const windowed = type !== 'recall' && type !== '';

  if (available.length === 0) return <Page title={t('page.reports')} />;

  const check = (): Errors => {
    const e: Errors = {};
    if (!type) e.type = t('validation.required');
    if (needsId && !id) e.id = t('validation.required');
    if (windowed) {
      if (dateErrors.from) e.from = dateErrorText(dateErrors.from)!;
      else if (!from) e.from = t('validation.required');
      if (dateErrors.to) e.to = dateErrorText(dateErrors.to)!;
      else if (!to) e.to = t('validation.required');
      if (from && to && !e.from && !e.to) {
        if (dayMs(from) > dayMs(to)) e.to = t('validation.range');
        else if ((dayMs(to) - dayMs(from)) / DAY + 1 > MAX_DAYS)
          e.to = t('reports.tooLong', { days: MAX_DAYS });
      }
    }
    return e;
  };

  const download = async () => {
    alert.clear();
    const found = check();
    setErrors(found);
    const first = (['type', 'id', 'from', 'to'] as const).find((k) => found[k]);
    if (first) {
      document.getElementById(`report-${first}`)?.focus();
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress({ received: 0, total: null });
    try {
      const res = await api.GET('/reports/{type}', {
        params: {
          path: { type: type as ReportType },
          query: {
            format,
            ...(windowed && from && to ? { from, to } : {}),
            ...(needsId ? { id } : {}),
          },
        },
        parseAs: 'stream',
        signal: ctl.signal,
      });
      if (res.error !== undefined || !res.response.ok) await call(Promise.resolve(res));
      const response = res.response;
      const total = Number(response.headers.get('Content-Length')) || null;
      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = (res.data as ReadableStream<Uint8Array> | null)?.getReader();
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (scope.alive()) setProgress({ received, total });
        }
      if (!scope.alive()) return;
      const name = fileNameOf(response.headers.get('Content-Disposition'), `agrotrace-${type}.${format}`);
      const blob = new Blob(chunks, {
        type: response.headers.get('Content-Type') ?? 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.done({ tone: 'ok', text: t('reports.saved', { name }) });
    } catch (e) {
      if (ctl.signal.aborted || !scope.alive()) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
        const next: Errors = {};
        const rest: string[] = [];
        for (const [k, keys] of Object.entries(e.errors)) {
          const text = keys[0] ? t(keys[0]) : '';
          if (k === 'type' || k === 'id' || k === 'from' || k === 'to' || k === 'format') next[k] = text;
          else rest.push(text);
        }
        setErrors(next);
        const firstBad = (['type', 'id', 'from', 'to'] as const).find((k) => next[k]);
        if (firstBad) document.getElementById(`report-${firstBad}`)?.focus();
        if (rest.length || next.format) alert.show([...rest, next.format ?? ''].filter(Boolean).join('. '));
      } else if (e instanceof ApiProblem && e.status === 404) {
        setErrors({ id: t('reports.notFound') });
        document.getElementById('report-id')?.focus();
      } else {
        if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
        alert.show(errorText(e), errorTone(e));
      }
    } finally {
      if (abort.current === ctl) abort.current = null;
      if (scope.alive()) setProgress(null);
    }
  };

  const busy = progress !== null;
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null;
  return (
    <Page title={t('page.reports')}>
      <Card>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void download();
          }}
        >
          <CardBody>
            <div style={{ ...FORM_GRID, maxWidth: '36rem' }}>
              <Field id="report-type" label={t('reports.type')} error={errors.type}>
                <Select
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value as ReportType);
                    setId('');
                    setErrors({});
                  }}
                >
                  {available.map((a) => (
                    <option key={a.type} value={a.type}>
                      {enumLabel(t, 'ReportType', a.type)}
                    </option>
                  ))}
                </Select>
              </Field>
              {type === 'recall' && (
                <RecallPicker value={id} error={errors.id} onChange={(v) => setId(v ?? '')} />
              )}
              {type === 'org' && !head && (
                <OrgPicker
                  id="report-id"
                  label={t('reports.organization')}
                  value={id}
                  error={errors.id}
                  onChange={(v) => setId(v ?? '')}
                />
              )}
              {type === 'org' && head && (
                <p style={{ margin: 0 }}>{t('reports.ownOrg', { name: me.organization.name })}</p>
              )}
              {windowed && (
                <div
                  style={{
                    display: 'grid',
                    gap: 'var(--sp-4)',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))',
                  }}
                >
                  <Field id="report-from" label={t('reports.from')} error={errors.from}>
                    <DateInput
                      value={from}
                      max={to ?? today}
                      onChange={setFrom}
                      onValidate={(err) => setDateErrors((d) => ({ ...d, from: err }))}
                    />
                  </Field>
                  <Field id="report-to" label={t('reports.to')} error={errors.to}>
                    <DateInput
                      value={to}
                      min={from ?? undefined}
                      max={today}
                      onChange={setTo}
                      onValidate={(err) => setDateErrors((d) => ({ ...d, to: err }))}
                    />
                  </Field>
                </div>
              )}
              <FieldSet legend={t('reports.format')} direction="row" error={errors.format}>
                {FORMATS.map((f) => (
                  <Radio
                    key={f}
                    name="report-format"
                    value={f}
                    checked={format === f}
                    onChange={() => setFormat(f)}
                  >
                    {enumLabel(t, 'ReportFormat', f)}
                  </Radio>
                ))}
              </FieldSet>
              {progress && (
                <div className="at-progress">
                  <span className="at-progress__label" id="report-progress">
                    {t('reports.progress')}
                  </span>
                  <span className="at-progress__value">
                    {progress.total
                      ? t('reports.progressOf', {
                          received: formatBytes(progress.received, LOCALE),
                          total: formatBytes(progress.total, LOCALE),
                        })
                      : formatBytes(progress.received, LOCALE)}
                  </span>
                  <progress
                    className="at-progress__bar"
                    max={100}
                    value={percent ?? undefined}
                    aria-labelledby="report-progress"
                  ></progress>
                </div>
              )}
            </div>
          </CardBody>
          <CardFooter>
            <Button
              ref={button}
              type="submit"
              variant="primary"
              icon="download"
              busy={busy}
              disabled={wait > 0}
            >
              {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('reports.download')}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </Page>
  );
}

function RecallPicker({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange: (id: string | null) => void;
}) {
  const { api } = useSession();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = useQuery({
    queryKey: ['recall', value],
    enabled: value !== '' && picked !== value,
    queryFn: () => call<Schemas['Recall']>(api.GET('/recalls/{id}', { params: { path: { id: value } } })),
  });
  useEffect(() => {
    if (value === '') setQuery('');
    else if (chosen.data) setQuery(chosen.data.sourceBatch.publicCode);
  }, [value, chosen.data]);
  const found = useQuery({
    queryKey: ['recalls', 'picker', search],
    enabled: search !== null && search.trim() !== '',
    queryFn: () =>
      call<Schemas['RecallPage']>(
        api.GET('/recalls', { params: { query: { q: search!.trim(), size: 20, sort: 'openedAt,desc' } } }),
      ),
  });
  const options: ComboOption[] = (found.data?.items ?? []).map((r) => ({
    value: r.id,
    label: r.sourceBatch.publicCode,
    meta: t('reports.recallMeta', {
      date: formatLocalDate(r.openedAt, LOCALE),
      status: enumLabel(t, 'RecallStatus', r.status),
    }),
  }));
  return (
    <Field id="report-id" label={t('reports.recall')} error={error}>
      <Combobox
        listLabel={t('reports.recall')}
        query={query}
        onQueryChange={(text) => {
          setQuery(text);
          if (text.trim() === '' && value !== '') onChange(null);
        }}
        onSearch={setSearch}
        options={search && search.trim() ? options : []}
        loading={found.isFetching}
        selected={value || null}
        onSelect={(o) => {
          setPicked(o.value);
          setQuery(o.label);
          onChange(o.value);
        }}
      />
    </Field>
  );
}
