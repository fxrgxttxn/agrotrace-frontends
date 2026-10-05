import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatBytes, formatLocalDate } from '@agrotrace/i18n';
import type { Role } from '../app/access';
import { injectAlive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { errorTone, FocusAfterWaitDirective, formAlert } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { OrgPickerComponent } from '../app/org-picker';
import { injectQuery } from '../app/query';
import { SessionService } from '../app/session';
import { dateErrorText, FieldContext, ToastService, UI, type ComboOption, type DateError } from '../app/ui';
import { FORM_GRID } from './layout';

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

@Component({
  selector: 'div.at-field[recallPicker]',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: RecallPickerComponent }],
  template: `<label class="at-field__label" [attr.for]="recallPicker()">{{ t('reports.recall') }}</label>
    <div
      class="at-combobox"
      [listLabel]="t('reports.recall')"
      [query]="query()"
      [options]="options()"
      [loading]="searching()"
      [selected]="value() || null"
      (queryChange)="typed($event)"
      (search)="search.set($event)"
      (chosen)="pick($event)"
    ></div>
    @if (error()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ error() }}</p>
    }`,
  host: { '[attr.data-invalid]': "error() ? '' : null" },
})
export class RecallPickerComponent extends FieldContext {
  protected readonly t = t;
  readonly recallPicker = input.required<string>();
  readonly value = input.required<string>();
  readonly error = input<string | null | undefined>(null);
  readonly valueChange = output<string | null>();
  readonly controlId = computed(() => this.recallPicker());
  readonly errorId = computed(() => (this.error() ? `${this.recallPicker()}-error` : null));
  readonly invalid = computed(() => Boolean(this.error()));
  private readonly session = inject(SessionService);
  protected readonly query = signal('');
  protected readonly search = signal<string | null>(null);
  private readonly picked = signal<string | null>(null);
  private readonly chosen = injectQuery(() => {
    const id = this.value();
    if (id === '' || this.picked() === id) return null;
    return {
      key: `recall:${id}`,
      load: () =>
        call<Schemas['Recall']>(this.session.api.GET('/recalls/{id}', { params: { path: { id } } })),
    };
  });
  private readonly found = injectQuery(() => {
    const text = this.search()?.trim() ?? '';
    if (!text) return null;
    return {
      key: `recalls?picker:${text}`,
      load: () =>
        call<Schemas['RecallPage']>(
          this.session.api.GET('/recalls', {
            params: { query: { q: text, size: 20, sort: 'openedAt,desc' } },
          }),
        ),
    };
  });
  protected readonly searching = computed(() => Boolean(this.search()?.trim()) && this.found.fetching());
  protected readonly options = computed<ComboOption[]>(() =>
    this.search()?.trim()
      ? (this.found.data()?.items ?? []).map((r) => ({
          value: r.id,
          label: r.sourceBatch.publicCode,
          meta: t('reports.recallMeta', {
            date: formatLocalDate(r.openedAt, LOCALE),
            status: enumLabel(t, 'RecallStatus', r.status),
          }),
        }))
      : [],
  );

  constructor() {
    super();
    effect(
      () => {
        const value = this.value();
        const r = this.chosen.data();
        untracked(() => {
          if (value === '') this.query.set('');
          else if (r && r.id === value) this.query.set(r.sourceBatch.publicCode);
        });
      },
      { allowSignalWrites: true },
    );
  }

  protected typed(text: string): void {
    this.query.set(text);
    if (text.trim() === '' && this.value() !== '') this.valueChange.emit(null);
  }

  protected pick(o: ComboOption): void {
    this.picked.set(o.value);
    this.query.set(o.label);
    this.valueChange.emit(o.value);
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...UI, FocusAfterWaitDirective, OrgPickerComponent, RecallPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.reports')"></div>
    @if (available.length > 0) {
      <article class="at-card">
        <form novalidate (submit)="submit($event)">
          <div class="at-card__body">
            <div style="${FORM_GRID}; max-width: 36rem">
              <div
                class="at-field"
                [fieldId]="'report-type'"
                [label]="t('reports.type')"
                [error]="errors().type"
              >
                <select class="at-select" (change)="pickType($any($event.target).value)">
                  @for (a of available; track a.type) {
                    <!-- prettier-ignore -->
                    <option [value]="a.type" [selected]="a.type === type()">{{ label('ReportType', a.type) }}</option>
                  }
                </select>
              </div>
              @if (type() === 'recall') {
                <div
                  class="at-field"
                  [recallPicker]="'report-id'"
                  [value]="id()"
                  [error]="errors().id"
                  (valueChange)="id.set($event ?? '')"
                ></div>
              }
              @if (type() === 'org' && !head()) {
                <div
                  class="at-field"
                  [orgPicker]="'report-id'"
                  [label]="t('reports.organization')"
                  [value]="id()"
                  [error]="errors().id"
                  (valueChange)="id.set($event ?? '')"
                ></div>
              }
              @if (type() === 'org' && head()) {
                <p style="margin: 0">{{ t('reports.ownOrg', { name: orgName() }) }}</p>
              }
              @if (windowed()) {
                <div
                  style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr))"
                >
                  <div
                    class="at-field"
                    [fieldId]="'report-from'"
                    [label]="t('reports.from')"
                    [error]="errors().from"
                  >
                    <div
                      class="at-date"
                      [value]="from()"
                      [max]="to() ?? today"
                      (valueChange)="from.set($event)"
                      (validate)="fromError.set($event)"
                    ></div>
                  </div>
                  <div
                    class="at-field"
                    [fieldId]="'report-to'"
                    [label]="t('reports.to')"
                    [error]="errors().to"
                  >
                    <div
                      class="at-date"
                      [value]="to()"
                      [min]="from() ?? undefined"
                      [max]="today"
                      (valueChange)="to.set($event)"
                      (validate)="toError.set($event)"
                    ></div>
                  </div>
                </div>
              }
              <fieldset
                class="at-field"
                [legend]="t('reports.format')"
                [direction]="'row'"
                [error]="errors().format"
              >
                @for (f of formats; track f) {
                  <label
                    class="at-radio"
                    [label]="label('ReportFormat', f)"
                    [name]="'report-format'"
                    [value]="f"
                    [checked]="format() === f"
                    (picked)="format.set(f)"
                  ></label>
                }
              </fieldset>
              @if (progress(); as p) {
                <div class="at-progress">
                  <span class="at-progress__label" id="report-progress">{{ t('reports.progress') }}</span>
                  <span class="at-progress__value">{{ progressText(p) }}</span>
                  <progress
                    class="at-progress__bar"
                    max="100"
                    [attr.value]="percent()"
                    aria-labelledby="report-progress"
                  ></progress>
                </div>
              }
            </div>
          </div>
          <footer class="at-card__footer">
            <button
              class="at-button"
              [type]="'submit'"
              [variant]="'primary'"
              [icon]="'download'"
              [busy]="progress() !== null"
              [disabled]="wait.left() > 0"
              [focusAfterWait]="wait.left()"
            >
              {{ wait.left() > 0 ? t('auth.retryIn', { seconds: wait.left() }) : t('reports.download') }}
            </button>
          </footer>
        </form>
      </article>
    }`,
})
export class ReportsPage {
  protected readonly t = t;
  protected readonly formats = FORMATS;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly alert = formAlert();
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly available = (() => {
    const me = this.session.me();
    return me ? reportTypes(me.roles, me.isOrgAdmin) : [];
  })();
  protected readonly orgName = computed(() => this.session.me()?.organization.name ?? '');
  protected readonly type = signal<ReportType | ''>(
    (() => {
      const fromUrl = this.params.get('type') as ReportType | null;
      return this.available.some((a) => a.type === fromUrl) ? fromUrl! : (this.available[0]?.type ?? '');
    })(),
  );
  protected readonly id = signal(
    (() => {
      const v = this.params.get('id');
      return v && UUID.test(v) ? v.toLowerCase() : '';
    })(),
  );
  protected readonly today = isoDay(Date.now());
  protected readonly from = signal<string | null>(isoDay(Date.now() - 29 * DAY));
  protected readonly to = signal<string | null>(this.today);
  protected readonly fromError = signal<DateError | null>(null);
  protected readonly toError = signal<DateError | null>(null);
  protected readonly format = signal<ReportFormat>('xlsx');
  protected readonly errors = signal<Errors>({});
  protected readonly progress = signal<{ received: number; total: number | null } | null>(null);
  protected readonly wait = countdown();
  protected readonly head = computed(() => this.available.find((a) => a.type === this.type())?.head ?? false);
  private readonly needsId = computed(
    () => this.type() === 'recall' || (this.type() === 'org' && !this.head()),
  );
  protected readonly windowed = computed(() => this.type() !== 'recall' && this.type() !== '');
  protected readonly percent = computed(() => {
    const p = this.progress();
    return p?.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null;
  });
  protected readonly progressText = (p: { received: number; total: number | null }) =>
    p.total
      ? t('reports.progressOf', {
          received: formatBytes(p.received, LOCALE),
          total: formatBytes(p.total, LOCALE),
        })
      : formatBytes(p.received, LOCALE);
  private abort: AbortController | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.abort?.abort());
  }

  protected pickType(value: string): void {
    this.type.set(value as ReportType);
    this.id.set('');
    this.errors.set({});
  }

  private check(): Errors {
    const e: Errors = {};
    const from = this.from();
    const to = this.to();
    if (!this.type()) e.type = t('validation.required');
    if (this.needsId() && !this.id()) e.id = t('validation.required');
    if (this.windowed()) {
      if (this.fromError()) e.from = dateErrorText(this.fromError())!;
      else if (!from) e.from = t('validation.required');
      if (this.toError()) e.to = dateErrorText(this.toError())!;
      else if (!to) e.to = t('validation.required');
      if (from && to && !e.from && !e.to) {
        if (dayMs(from) > dayMs(to)) e.to = t('validation.range');
        else if ((dayMs(to) - dayMs(from)) / DAY + 1 > MAX_DAYS)
          e.to = t('reports.tooLong', { days: MAX_DAYS });
      }
    }
    return e;
  }

  protected submit(e: Event): void {
    e.preventDefault();
    if (this.progress() === null) void this.download();
  }

  private async download(): Promise<void> {
    this.alert.clear();
    const found = this.check();
    this.errors.set(found);
    const first = (['type', 'id', 'from', 'to'] as const).find((k) => found[k]);
    if (first) {
      setTimeout(() => document.getElementById(`report-${first}`)?.focus(), 0);
      return;
    }
    const type = this.type() as ReportType;
    const format = this.format();
    const windowed = this.windowed();
    const needsId = this.needsId();
    const from = this.from();
    const to = this.to();
    const id = this.id();
    const ctl = new AbortController();
    this.abort = ctl;
    this.progress.set({ received: 0, total: null });
    try {
      const res = await this.session.api.GET('/reports/{type}', {
        params: {
          path: { type },
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
      const reader = (res.data as ReadableStream<Uint8Array> | null)?.getReader();
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (this.alive()) this.progress.set({ received, total });
        }
      if (!this.alive()) return;
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
      this.toasts.push({ tone: 'ok', text: t('reports.saved', { name }) });
    } catch (e) {
      if (ctl.signal.aborted || !this.alive()) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors) {
        const next: Errors = {};
        const rest: string[] = [];
        for (const [k, keys] of Object.entries(e.errors)) {
          const text = keys[0] ? t(keys[0]) : '';
          if (k === 'type' || k === 'id' || k === 'from' || k === 'to' || k === 'format') next[k] = text;
          else rest.push(text);
        }
        this.errors.set(next);
        const firstBad = (['type', 'id', 'from', 'to'] as const).find((k) => next[k]);
        if (firstBad) setTimeout(() => document.getElementById(`report-${firstBad}`)?.focus(), 0);
        if (rest.length || next.format)
          this.alert.show([...rest, next.format ?? ''].filter(Boolean).join('. '));
      } else if (e instanceof ApiProblem && e.status === 404) {
        this.errors.set({ id: t('reports.notFound') });
        setTimeout(() => document.getElementById('report-id')?.focus(), 0);
      } else {
        if (e instanceof ApiProblem && e.status === 429) this.wait.start(retryAfterOf(e));
        this.alert.show(errorText(e), errorTone(e));
      }
    } finally {
      if (this.abort === ctl) this.abort = null;
      if (this.alive()) this.progress.set(null);
    }
  }
}
