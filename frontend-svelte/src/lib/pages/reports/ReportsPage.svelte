<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { page } from '$app/state';
  import { ApiProblem } from '@agrotrace/api-client';
  import { enumLabel, formatBytes } from '@agrotrace/i18n';
  import { call, Countdown, errorText, errorTone, focusAfterWait, retryAfterOf } from '../../app/api.svelte';
  import { FormAlert } from '../../app/forms.svelte';
  import { userAction } from '../../app/focusRescue';
  import { LOCALE, t } from '../../app/i18n';
  import OrgPicker from '../../app/OrgPicker.svelte';
  import { screenScope } from '../../app/screen';
  import { session } from '../../app/session.svelte';
  import Button from '../../ui/Button.svelte';
  import Card from '../../ui/Card.svelte';
  import CardBody from '../../ui/CardBody.svelte';
  import CardFooter from '../../ui/CardFooter.svelte';
  import DateInput, { type DateError } from '../../ui/DateInput.svelte';
  import Field from '../../ui/Field.svelte';
  import FieldSet from '../../ui/FieldSet.svelte';
  import Page from '../../ui/Page.svelte';
  import Radio from '../../ui/Radio.svelte';
  import Select from '../../ui/Select.svelte';
  import { FORM_GRID } from '../layout';
  import RecallPicker from './RecallPicker.svelte';
  import { fileNameOf, reportTypes, type ReportFormat, type ReportType } from './reports';

  const FORMATS: readonly ReportFormat[] = ['xlsx', 'pdf'];
  const DAY = 86_400_000;
  const MAX_DAYS = 366;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  type Key = 'type' | 'id' | 'from' | 'to' | 'format';
  type Errors = Partial<Record<Key, string>>;

  const screen = screenScope();
  const alert = new FormAlert();
  onDestroy(() => alert.clear());
  const me = $derived(session.me!);
  const available = $derived(reportTypes(me.roles, me.isOrgAdmin));
  const initial = untrack(() => {
    const params = page.url.searchParams;
    const fromUrl = params.get('type') as ReportType | null;
    const id = params.get('id');
    return {
      type: available.some((a) => a.type === fromUrl) ? fromUrl! : (available[0]?.type ?? ''),
      id: id && UUID.test(id) ? id.toLowerCase() : '',
    };
  });
  let type = $state<ReportType | ''>(initial.type as ReportType | '');
  let id = $state(initial.id);
  const today = isoDay(Date.now());
  let from = $state<string | null>(isoDay(Date.now() - 29 * DAY));
  let to = $state<string | null>(today);
  let dateErrors = $state<{ from?: DateError | null; to?: DateError | null }>({});
  let format = $state<ReportFormat>('xlsx');
  let errors = $state<Errors>({});
  let progress = $state<{ received: number; total: number | null } | null>(null);
  const wait = new Countdown();
  onDestroy(() => wait.stop());
  let button = $state<HTMLElement | null>(null);
  focusAfterWait(
    () => wait.left,
    () => button,
  );
  let abort: AbortController | null = null;
  onDestroy(() => abort?.abort());

  const head = $derived(available.find((a) => a.type === type)?.head ?? false);
  const needsId = $derived(type === 'recall' || (type === 'org' && !head));
  const windowed = $derived(type !== 'recall' && type !== '');

  function check(): Errors {
    const e: Errors = {};
    if (!type) e.type = t('validation.required');
    if (needsId && !id) e.id = t('validation.required');
    if (windowed) {
      if (dateErrors.from) e.from = t(dateErrors.from);
      else if (!from) e.from = t('validation.required');
      if (dateErrors.to) e.to = t(dateErrors.to);
      else if (!to) e.to = t('validation.required');
      if (from && to && !e.from && !e.to) {
        if (dayMs(from) > dayMs(to)) e.to = t('validation.range');
        else if ((dayMs(to) - dayMs(from)) / DAY + 1 > MAX_DAYS) e.to = t('reports.tooLong', { days: MAX_DAYS });
      }
    }
    return e;
  }

  const focusField = (k: Key) => document.getElementById(`report-${k}`)?.focus();

  async function download() {
    alert.clear();
    const found = check();
    errors = found;
    const first = (['type', 'id', 'from', 'to'] as const).find((k) => found[k]);
    if (first) {
      focusField(first);
      return;
    }
    const ctl = new AbortController();
    abort = ctl;
    progress = { received: 0, total: null };
    const reportType = type as ReportType;
    try {
      const res = await session.api.GET('/reports/{type}', {
        params: {
          path: { type: reportType },
          query: { format, ...(windowed && from && to ? { from, to } : {}), ...(needsId ? { id } : {}) },
        },
        parseAs: 'stream',
        signal: ctl.signal,
      });
      if (res.error !== undefined || !res.response.ok) await call(Promise.resolve(res));
      const response = res.response;
      const total = Number(response.headers.get('Content-Length')) || null;
      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = (res.data as ReadableStream<Uint8Array> | null | undefined)?.getReader();
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (screen.alive()) progress = { received, total };
        }
      if (!screen.alive()) return;
      const name = fileNameOf(response.headers.get('Content-Disposition'), `agrotrace-${reportType}.${format}`);
      const blob = new Blob(chunks, { type: response.headers.get('Content-Type') ?? 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      screen.done({ tone: 'ok', text: t('reports.saved', { name }) });
    } catch (e) {
      if (ctl.signal.aborted || !screen.alive()) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
        const next: Errors = {};
        const rest: string[] = [];
        for (const [k, keys] of Object.entries(e.errors)) {
          const text = keys[0] ? t(keys[0]) : '';
          if (k === 'type' || k === 'id' || k === 'from' || k === 'to' || k === 'format') next[k] = text;
          else rest.push(text);
        }
        errors = next;
        const firstBad = (['type', 'id', 'from', 'to'] as const).find((k) => next[k]);
        if (firstBad) focusField(firstBad);
        if (rest.length || next.format) alert.show([...rest, next.format ?? ''].filter(Boolean).join('. '));
      } else if (e instanceof ApiProblem && e.status === 404) {
        errors = { id: t('reports.notFound') };
        focusField('id');
      } else {
        if (e instanceof ApiProblem && e.status === 429) wait.start(retryAfterOf(e));
        alert.show(errorText(e), errorTone(e));
      }
    } finally {
      if (abort === ctl) abort = null;
      if (screen.alive()) progress = null;
    }
  }

  const busy = $derived(progress !== null);
  const percent = $derived(
    progress?.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null,
  );
</script>

<Page title={t('page.reports')}>
  {#if available.length > 0}
    <Card>
      <form
        novalidate
        onsubmit={(e) => {
          e.preventDefault();
          if (!busy) void userAction(download);
        }}
      >
        <CardBody>
          <div style="{FORM_GRID}; max-width: 36rem">
            <Field id="report-type" label={t('reports.type')} error={errors.type}>
              <Select
                value={type}
                onchange={(e) => {
                  type = e.currentTarget.value as ReportType;
                  id = '';
                  errors = {};
                }}
              >
                {#each available as a (a.type)}
                  <option value={a.type}>{enumLabel(t, 'ReportType', a.type)}</option>
                {/each}
              </Select>
            </Field>
            {#if type === 'recall'}
              <RecallPicker value={id} error={errors.id} onchange={(v) => (id = v ?? '')} />
            {/if}
            {#if type === 'org' && !head}
              <OrgPicker
                id="report-id"
                label={t('reports.organization')}
                value={id}
                error={errors.id}
                onchange={(v) => (id = v ?? '')}
              />
            {/if}
            {#if type === 'org' && head}
              <p style="margin: 0">{t('reports.ownOrg', { name: me.organization.name })}</p>
            {/if}
            {#if windowed}
              <div
                style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr))"
              >
                <Field id="report-from" label={t('reports.from')} error={errors.from}>
                  <DateInput
                    value={from}
                    max={to ?? today}
                    onchange={(v) => (from = v)}
                    onvalidate={(err) => (dateErrors = { ...dateErrors, from: err })}
                  />
                </Field>
                <Field id="report-to" label={t('reports.to')} error={errors.to}>
                  <DateInput
                    value={to}
                    min={from ?? undefined}
                    max={today}
                    onchange={(v) => (to = v)}
                    onvalidate={(err) => (dateErrors = { ...dateErrors, to: err })}
                  />
                </Field>
              </div>
            {/if}
            <FieldSet legend={t('reports.format')} direction="row" error={errors.format}>
              {#each FORMATS as f (f)}
                <Radio name="report-format" value={f} checked={format === f} onchange={() => (format = f)}>
                  {enumLabel(t, 'ReportFormat', f)}
                </Radio>
              {/each}
            </FieldSet>
            {#if progress}
              <div class="at-progress">
                <span class="at-progress__label" id="report-progress">{t('reports.progress')}</span>
                <span class="at-progress__value"
                  >{progress.total
                    ? t('reports.progressOf', {
                        received: formatBytes(progress.received, LOCALE),
                        total: formatBytes(progress.total, LOCALE),
                      })
                    : formatBytes(progress.received, LOCALE)}</span
                >
                <progress class="at-progress__bar" max="100" value={percent ?? undefined} aria-labelledby="report-progress"
                ></progress>
              </div>
            {/if}
          </div>
        </CardBody>
        <CardFooter>
          <Button
            bind:element={button}
            type="submit"
            variant="primary"
            icon="download"
            {busy}
            disabled={wait.left > 0}
          >
            {wait.left > 0 ? t('auth.retryIn', { seconds: wait.left }) : t('reports.download')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  {/if}
</Page>
