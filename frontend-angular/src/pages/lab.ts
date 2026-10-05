import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { concludeLabTest } from '@agrotrace/domain';
import { enumLabel, formatBytes, formatDecimal, formatLocalDateTime } from '@agrotrace/i18n';
import { LabResultsInputSchema } from '@agrotrace/validation';
import { injectAlive, injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { DateFilterComponent } from '../app/date-filter';
import { focusLost } from '../app/focus';
import { dialogAlert, errorTone, FocusAfterWaitDirective, formAlert } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { CONCLUSION_TONE, LAB_STATUS_TONE } from '../app/lab-tests';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { ManualForm } from '../app/manual-form';
import { injectQuery, QueryCache } from '../app/query';
import { SessionService } from '../app/session';
import {
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type CardFact,
  type FileItem,
  type Tone,
} from '../app/ui';
import { BATCH_PREFIX, DASHBOARD_KEY, LAB_TESTS_KEY, labTestKey } from './keys';
import { areaLoading, listChanged, loadFailed } from './lists';

type LabTest = Schemas['LabTest'];
type ListItem = Schemas['LabTestListItem'];
type Status = Schemas['LabTestStatus'];
type Reason = Schemas['LabTestReason'];
type Conclusion = Schemas['LabConclusion'];
type Norm = Schemas['LabNorm'];
type Result = Schemas['LabResult'];

const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';
const STACK = 'display: grid; gap: var(--sp-4)';
const STATUSES: readonly Status[] = ['QUEUED', 'SAMPLED', 'ESCALATED', 'DONE', 'CANCELLED'];
const REASONS: readonly Reason[] = ['RISK', 'PLANNED', 'COMPLAINT', 'INSPECTOR'];
const SEVERAL = '__several';
const ACTIVE: readonly Status[] = ['QUEUED', 'SAMPLED', 'ESCALATED'];
const ALL = 'all';
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

const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

export function indicatorText(value: string): string {
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return formatDecimal(trimmed, LOCALE);
}

export function decimalOf(text: string): string | null {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m) return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1]!;
}
const DECIMAL = /^\d{1,8}(\.\d{1,6})?$/;
const validDecimal = (text: string) => {
  const d = decimalOf(text);
  return d !== null && DECIMAL.test(d) ? d : null;
};

export function exceeds(norm: Norm, text: string): boolean | null {
  const value = validDecimal(text);
  if (value === null) return null;
  const r = concludeLabTest({ results: [{ indicatorId: norm.indicatorId, value, maxValue: norm.maxValue }] });
  return 'error' in r ? null : r.conclusion === 'FAIL';
}

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

const isNormsMismatch = (e: unknown) =>
  e instanceof ApiProblem &&
  e.code === 'VALIDATION' &&
  Boolean(e.errors?.['results']?.includes('validation.results.mismatch'));

const normText = (maxValue: string, unit: string) =>
  t('lab.normValue', { value: indicatorText(maxValue), unit });

const IMPORTS = [
  ...UI,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  DateFilterComponent,
];

class LabView {
  protected readonly t = t;
  protected readonly at = at;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly statusTone = (s: Status): Tone => LAB_STATUS_TONE[s];
  protected readonly conclusionTone = (c: Conclusion): Tone => CONCLUSION_TONE[c];
}

function DUE(x: string): string {
  return `{{ at(${x}.dueAt) }}@if (${x}.overdue) {{{ ' ' }}<span class="at-chip" [tone]="'danger'">{{ t('labTests.overdue') }}</span>}`;
}
function STATUS_CHIP(s: string, size = 'undefined'): string {
  return `<span class="at-chip" [tone]="statusTone(${s})" [size]="${size}">{{ label('LabTestStatus', ${s}) }}</span>`;
}
function CONCLUSION_CHIP(c: string): string {
  return `<span class="at-chip" [tone]="conclusionTone(${c})">{{ label('LabConclusion', ${c}) }}</span>`;
}
function ASSESSMENT(exceeded: string): string {
  return `@if (${exceeded}) {
    <span class="at-chip" [tone]="'danger'">{{ t('lab.exceeded') }}</span>
  } @else {
    <span class="at-chip" [tone]="'ok'">{{ t('lab.within') }}</span>
  }`;
}

function multiSelect(key: string, values: string, all: string, enumName: string, first: string): string {
  return `<select class="at-select" (change)="list.set({ ${key}: $any($event.target).value })">
            ${first}
            @if (${values}.length > 1) {
              <!-- prettier-ignore -->
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: ${values}.length }) }}</option>
            }
            @for (v of ${all}; track v) {
              <option [value]="v" [selected]="${values}.length === 1 && ${values}[0] === v">{{ label('${enumName}', v) }}</option>
            }
          </select>`;
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.labTests')"></div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('labTests.status')">
          ${multiSelect(
            'status',
            'status()',
            'statuses',
            'LabTestStatus',
            `<option value="" [selected]="status().length === 0">{{ t('lab.active') }}</option>
            <option [value]="all" [selected]="status()[0] === all">{{ t('filters.any') }}</option>`,
          )}
        </div>
        <div class="at-field" [fieldId]="'filter-reason'" [label]="t('labTests.reason')">
          ${multiSelect(
            'reason',
            'reason()',
            'reasons',
            'LabTestReason',
            `<option value="" [selected]="reason().length === 0">{{ t('filters.any') }}</option>`,
          )}
        </div>
        <div class="at-field" [fieldId]="'filter-conclusion'" [label]="t('labTests.conclusion')">
          <select class="at-select" (change)="list.set({ conclusion: $any($event.target).value })">
            <option value="" [selected]="conclusion() === ''">{{ t('filters.any') }}</option>
            <!-- prettier-ignore -->
            <option value="PASS" [selected]="conclusion() === 'PASS'">{{ label('LabConclusion', 'PASS') }}</option>
            <!-- prettier-ignore -->
            <option value="FAIL" [selected]="conclusion() === 'FAIL'">{{ label('LabConclusion', 'FAIL') }}</option>
          </select>
        </div>
        <div class="at-field" [fieldId]="'filter-overdue'" [label]="t('lab.overdueFilter')">
          <select class="at-select" (change)="list.set({ overdue: $any($event.target).value })">
            <option value="" [selected]="overdue() === ''">{{ t('filters.any') }}</option>
            <option value="true" [selected]="overdue() === 'true'">{{ t('lab.overdueOnly') }}</option>
            <option value="false" [selected]="overdue() === 'false'">{{ t('lab.overdueNone') }}</option>
          </select>
        </div>
        <div
          class="at-field"
          [dateFilter]="'filter-from'"
          [label]="t('lab.from')"
          [value]="from()"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'filter-to'"
          [label]="t('lab.to')"
          [value]="to()"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('lab.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'query.refetch()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        @if (allOnly()) {
          <div class="at-empty" [art]="'empty-lab'" [text]="t('lab.empty')"></div>
        } @else if (q() || count()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-lab'" [text]="t('lab.empty')">
            <button class="at-button" [variant]="'primary'" (click)="list.set({ status: all })">
              {{ t('lab.showAll') }}
            </button>
          </div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.labTests')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template [atColumn]="'batch'" [header]="t('lab.batch')" [primary]="true" let-x>
            <span
              class="at-table__primary"
              [href]="'/lab/tests/' + x.id"
              [code]="x.batch.publicCode"
              [sub]="x.batch.product.name"
            ></span>
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('labTests.status')" [status]="true" let-x>
            ${STATUS_CHIP('x.status')}
          </ng-template>
          <ng-template [atColumn]="'reason'" [header]="t('labTests.reason')" let-x>{{
            label('LabTestReason', x.reason)
          }}</ng-template>
          <ng-template [atColumn]="'due'" [header]="t('labTests.dueAt')" [sortField]="'dueAt'" let-x
            >${DUE('x')}</ng-template
          >
          <ng-template [atColumn]="'created'" [header]="t('lab.createdAt')" [sortField]="'createdAt'" let-x>{{
            at(x.createdAt)
          }}</ng-template>
          <ng-template
            [atColumn]="'conclusion'"
            [header]="t('labTests.conclusion')"
            [sortField]="'completedAt'"
            let-x
          >
            @if (x.conclusion) {
              <span class="at-table__primary"
                >${CONCLUSION_CHIP('x.conclusion')}
                @if (x.completedAt) {
                  <span class="at-table__sub">{{ at(x.completedAt) }}</span>
                }
              </span>
            } @else {
              —
            }
          </ng-template>
        </div>
        <nav
          class="at-pagination"
          [page]="list.page()"
          [size]="size"
          [total]="query.data()!.total"
          [hrefFor]="list.hrefFor"
        ></nav>
      </div>
    }`,
})
export class LabTestsPage extends LabView {
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly all = ALL;
  protected readonly statuses = STATUSES;
  protected readonly reasons = REASONS;
  protected readonly rowKey = (x: ListItem) => x.id;
  protected readonly sortOptions = [
    { value: 'dueAt,asc', label: t('lab.sort.due') },
    { value: 'createdAt,desc', label: t('lab.sort.created') },
    { value: 'completedAt,desc', label: t('lab.sort.completed') },
  ];
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly list = injectListParams('/lab/tests', SPEC);
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly q = this.p('q');
  private readonly statusParam = computed(() => this.list.params().getAll('status'));
  protected readonly status = computed(() => (this.statusParam().includes(ALL) ? [ALL] : this.statusParam()));
  protected readonly reason = computed(() => this.list.params().getAll('reason'));
  protected readonly conclusion = this.p('conclusion');
  protected readonly overdue = this.p('overdue');
  protected readonly from = this.p('from');
  protected readonly to = this.p('to');
  protected readonly count = computed(
    () =>
      (this.status().length ? 1 : 0) +
      (this.reason().length ? 1 : 0) +
      [this.conclusion(), this.overdue(), this.from(), this.to()].filter(Boolean).length,
  );
  protected readonly allOnly = computed(() => this.status()[0] === ALL && !this.q() && this.count() === 1);
  protected readonly search = computed(() => ({
    label: t('lab.search'),
    placeholder: t('lab.searchPlaceholder'),
    value: this.q(),
  }));

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const sent: readonly Status[] = status[0] === ALL ? [] : status.length ? (status as Status[]) : ACTIVE;
      const f = {
        reason: this.reason(),
        conclusion: this.conclusion(),
        overdue: this.overdue(),
        from: this.from(),
        to: this.to(),
      };
      return {
        key: `${LAB_TESTS_KEY}${JSON.stringify([page, sort, q, status, f])}`,
        load: () =>
          call<Schemas['LabTestPage']>(
            this.session.api.GET('/lab-tests', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(q ? { q } : {}),
                  ...(sent.length ? { status: [...sent] } : {}),
                  ...(f.reason.length ? { reason: f.reason as Reason[] } : {}),
                  ...(f.conclusion ? { conclusion: f.conclusion as Conclusion } : {}),
                  ...(f.overdue ? { overdue: f.overdue === 'true' } : {}),
                  ...(f.from ? { from: f.from } : {}),
                  ...(f.to ? { to: f.to } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('lab.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));

  constructor() {
    super();
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
    effect(() => {
      const statuses = this.statusParam();
      if (!statuses.includes(ALL) || statuses.length < 2) return;
      untracked(() => {
        const next = new URLSearchParams(this.list.params());
        next.delete('status');
        next.append('status', ALL);
        void this.router.navigateByUrl(`/lab/tests?${next.toString()}`, { replaceUrl: true });
      });
    });
  }
}

export class LabProblems {
  readonly alert = formAlert();

  constructor(private readonly reread: () => void) {}

  describe(e: unknown): { text: string; tone: 'danger' | 'attention' } {
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      this.reread();
      return { text: t('lab.versionConflict'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      this.reread();
      const from = String(e.params?.['from'] ?? '');
      return { text: t('lab.stateChanged', { status: enumLabel(t, 'LabTestStatus', from) }), tone: 'danger' };
    }
    if (isNormsMismatch(e)) {
      this.reread();
      return { text: t('lab.normsChanged'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.status === 404) this.reread();
    return { text: errorText(e), tone: errorTone(e) };
  }

  fail(e: unknown): { text: string; tone: 'danger' | 'attention' } {
    const p = this.describe(e);
    this.alert.show(p.text, p.tone);
    return p;
  }
}

@Component({
  selector: 'form[atResults]',
  standalone: true,
  exportAs: 'atResults',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
      class="at-table-wrap"
      [cards]="true"
      [caption]="t('lab.results')"
      [rows]="norms()"
      [rowKey]="normKey"
    >
      <ng-template [atColumn]="'name'" [header]="t('lab.indicator')" [primary]="true" let-n>{{
        n.name
      }}</ng-template>
      <ng-template [atColumn]="'assessment'" [header]="t('lab.assessment')" [status]="true" let-n>
        @if (assess(n); as a) {
          ${ASSESSMENT("a === 'over'")}
        }
      </ng-template>
      <ng-template [atColumn]="'norm'" [header]="t('lab.norm')" let-n>{{
        normText(n.maxValue, n.unit)
      }}</ng-template>
      <ng-template [atColumn]="'value'" [header]="t('lab.value')" let-n>
        <div class="at-field" [cellId]="'value-' + n.indicatorId" [error]="f.errorOf(n.indicatorId)">
          <div class="at-input-group" [suffix]="n.unit">
            <input
              class="at-input"
              inputmode="decimal"
              autocomplete="off"
              [attr.aria-label]="t('lab.valueOf', { name: n.name })"
              [value]="f.values()[n.indicatorId] ?? ''"
              (input)="set(n.indicatorId, $any($event.target).value)"
            />
          </div>
        </div>
      </ng-template>
    </div>
    <div aria-live="polite">
      @if (preview(); as p) {
        <p [class.at-field__warning]="p === 'FAIL'" style="margin: 0">
          {{ t('lab.preview', { conclusion: label('LabConclusion', p) }) }}
        </p>
      }
    </div>`,
  host: { id: 'lab-results', novalidate: '', style: STACK, '(submit)': 'submit($event)' },
})
export class ResultsFormComponent extends LabView implements OnInit {
  protected readonly normText = normText;
  protected readonly normKey = (n: Norm) => n.indicatorId;
  readonly atResults = input.required<LabTest>();
  readonly problems = input.required<LabProblems>();
  readonly done = output<LabTest>();
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly live = injectLive();
  protected readonly norms = computed(() => this.atResults().norms);
  readonly f = new ManualForm<Record<string, string>>({}, (v) => this.check(v));
  readonly sending = signal(false);
  readonly confirming = signal<Record<string, string> | null>(null);
  private readonly failure = dialogAlert();
  readonly message = this.failure.message;
  readonly code = signal('');
  protected readonly preview = computed(() => previewConclusion(this.norms(), this.f.values()));
  private readonly covered = computed(() => {
    const c = this.confirming();
    const norms = this.norms();
    return (
      c !== null &&
      norms.every((n) => validDecimal(c[n.indicatorId] ?? '') !== null) &&
      previewConclusion(norms, c) === 'FAIL'
    );
  });
  readonly matches = computed(() => {
    const code = this.atResults().batch.publicCode;
    return code !== '' && this.code().trim().toUpperCase() === code;
  });

  constructor() {
    super();
    effect(
      () => {
        if (this.confirming() && !this.covered()) untracked(() => this.dismiss());
      },
      { allowSignalWrites: true },
    );
    let seen = '';
    effect(() => {
      const set = this.norms()
        .map((n) => n.indicatorId)
        .join();
      untracked(() => {
        if (seen === '' || seen === set) {
          seen = set;
          return;
        }
        seen = set;
        const empty = this.norms().find((n) => !(this.f.values()[n.indicatorId] ?? '').trim());
        if (!empty) return;
        setTimeout(() => {
          const active = document.activeElement;
          if (
            focusLost() ||
            (active instanceof HTMLButtonElement && active.type === 'submit' && active.form === this.host) ||
            active?.matches('h1.at-page__title')
          )
            document.getElementById(`value-${empty.indicatorId}`)?.focus();
        }, 0);
      });
    });
  }

  ngOnInit(): void {
    this.f.values.set(Object.fromEntries(this.norms().map((n) => [n.indicatorId, ''])));
  }

  protected readonly assess = (n: Norm): 'over' | 'within' | null => {
    const over = exceeds(n, this.f.values()[n.indicatorId] ?? '');
    return over === null ? null : over ? 'over' : 'within';
  };

  private toBody(v: Record<string, string>) {
    return {
      results: this.norms().map((n) => ({
        indicatorId: n.indicatorId,
        value: decimalOf(v[n.indicatorId] ?? '') ?? v[n.indicatorId] ?? '',
      })),
    };
  }

  private check(v: Record<string, string>): Record<string, string> {
    const norms = untracked(this.norms);
    const errors: Record<string, string> = {};
    for (const n of norms)
      if ((v[n.indicatorId] ?? '').trim() === '') errors[n.indicatorId] = 'validation.required';
    const res = LabResultsInputSchema.safeParse(this.toBody(v));
    for (const issue of res.success ? [] : res.error.issues) {
      const [head, index] = issue.path;
      const norm = head === 'results' && typeof index === 'number' ? norms[index] : undefined;
      if (norm) errors[norm.indicatorId] ??= issue.message;
    }
    return errors;
  }

  protected set(id: string, text: string): void {
    this.f.update((v) => ({ ...v, [id]: text }), id);
  }

  close(): void {
    this.confirming.set(null);
    this.code.set('');
    this.failure.clear();
  }

  dismiss(): void {
    this.failure.handOff();
    this.close();
  }

  protected submit(e: Event): void {
    void this.f.submit(e, async (v) => {
      if (previewConclusion(this.norms(), v) === 'FAIL') {
        this.failure.clear();
        this.confirming.set({ ...v });
      } else await this.send(v);
    });
  }

  async confirm(): Promise<void> {
    const values = this.confirming();
    if (!values || !this.covered()) return;
    await this.send(values, true);
  }

  private async send(v: Record<string, string>, inDialog = false): Promise<void> {
    const problems = this.problems();
    problems.alert.clear();
    this.failure.clear();
    this.sending.set(true);
    const test = this.atResults();
    const body = this.toBody(v) as Schemas['LabResultsInput'];
    const generation = this.session.generation;
    try {
      const next = await call<LabTest>(
        this.session.api.POST('/lab-tests/{id}/results', {
          params: { path: { id: test.id }, header: { 'If-Match': test.version } },
          body,
        }),
      );
      if (generation !== this.session.generation) return;
      this.close();
      this.done.emit(next);
      this.toasts.push({
        tone: 'ok',
        text:
          next.conclusion === 'FAIL'
            ? t('lab.submittedRecall', { code: next.batch.publicCode })
            : t('lab.submitted', { conclusion: enumLabel(t, 'LabConclusion', next.conclusion ?? 'PASS') }),
      });
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION' && !isNormsMismatch(e)) {
        this.close();
        const norms = this.norms();
        this.f.fail(
          e,
          norms.map((n) => n.indicatorId),
          (path) => {
            const m = /^results\[(\d+)\]\.value$/.exec(path);
            const norm = m ? norms[Number(m[1])] : undefined;
            return norm ? norm.indicatorId : path;
          },
          (text, tone) => problems.alert.show(text, tone),
        );
        afterNextRender(() => this.f.focusFirstInvalid(), { injector: this.injector });
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) this.f.rateLimited(retryAfterOf(e));
      if (!inDialog) {
        problems.fail(e);
        return;
      }
      const p = problems.describe(e);
      this.failure.show(p.text, p.tone);
    } finally {
      this.sending.set(false);
    }
  }
}

const isPdf = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
const tooLargeText = (max: number) => t('files.tooLarge', { max: formatBytes(max, LOCALE) });
const unsupportedText = () => t('files.unsupported', { allowed: 'PDF' });

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, ResultsFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!query.data() && missing()) {
      <div class="at-page__header" [pageTitle]="t('page.labTest')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('lab.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/lab/tests'">{{ t('lab.toList') }}</a>
        </div>
      </article>
    } @else {
      <div
        class="at-page__header"
        [pageTitle]="
          query.data() ? t('lab.title', { code: query.data()!.batch.publicCode }) : t('page.labTest')
        "
      >
        @if (query.data(); as x) {
          @if (can('sample')) {
            <div class="at-page__actions">
              <button
                class="at-button"
                [variant]="'primary'"
                [icon]="'flask'"
                [busy]="sampling()"
                [disabled]="sampleWait.left() > 0"
                [focusAfterWait]="sampleWait.left()"
                (click)="sample(x)"
              >
                {{
                  sampleWait.left() > 0 ? t('auth.retryIn', { seconds: sampleWait.left() }) : t('lab.sample')
                }}
              </button>
            </div>
          }
        }
      </div>
      @if (!query.data() && query.failed()) {
        ${loadFailed("t('lab.testFailed')", 'query.fetching()', 'query.refetch()')}
      } @else if (!query.data()) {
        ${areaLoading(2)}
      } @else {
        <div style="${GAP}">
          <article class="at-card">
            <header class="at-card__header" [cardTitle]="query.data()!.batch.product.name">
              ${STATUS_CHIP('query.data()!.status', "'l'")}
            </header>
            <div class="at-card__body">
              <dl class="at-card__facts">
                <div>
                  <dt>{{ t('lab.batch') }}</dt>
                  <dd>
                    <a class="at-mono" [to]="'/batches/' + query.data()!.batch.id">{{
                      query.data()!.batch.publicCode
                    }}</a>
                  </dd>
                </div>
                @for (f of facts(); track f.key) {
                  <div>
                    <dt>{{ f.term }}</dt>
                    <dd>{{ f.value }}</dd>
                  </div>
                }
                <div>
                  <dt>{{ t('labTests.dueAt') }}</dt>
                  <dd>${DUE('query.data()!')}</dd>
                </div>
                @for (f of laterFacts(); track f.key) {
                  <div>
                    <dt>{{ f.term }}</dt>
                    <dd>{{ f.value }}</dd>
                  </div>
                }
                @if (query.data()!.conclusion; as c) {
                  <div>
                    <dt>{{ t('labTests.conclusion') }}</dt>
                    <dd>${CONCLUSION_CHIP('c')}</dd>
                  </div>
                }
              </dl>
            </div>
          </article>
          @if (can('submitResults')) {
            @if (query.data()!.norms.length === 0) {
              <article class="at-card">
                <header class="at-card__header" [cardTitle]="t('lab.results')"></header>
                <div class="at-card__body">
                  <p style="margin: 0">{{ t('lab.noNorms') }}</p>
                </div>
              </article>
            } @else {
              @for (id of [query.data()!.id]; track id) {
                <article class="at-card">
                  <header class="at-card__header" [cardTitle]="t('lab.results')"></header>
                  <div class="at-card__body">
                    <form
                      #rf="atResults"
                      [atResults]="query.data()!"
                      [problems]="problems"
                      (done)="changed($event)"
                    ></form>
                  </div>
                  <footer class="at-card__footer">
                    <button
                      class="at-button"
                      [type]="'submit'"
                      [attr.form]="'lab-results'"
                      [variant]="'primary'"
                      [busy]="rf.sending() && !rf.confirming()"
                      [disabled]="rf.f.wait() > 0"
                      [focusAfterWait]="rf.f.wait()"
                    >
                      {{
                        rf.f.wait() > 0
                          ? t('auth.retryIn', { seconds: rf.f.wait() })
                          : t('action.submitResults')
                      }}
                    </button>
                  </footer>
                  <dialog
                    class="at-dialog"
                    [open]="rf.confirming() !== null"
                    [dialogTitle]="t('lab.failTitle', { code: query.data()!.batch.publicCode })"
                    (closed)="rf.dismiss()"
                  >
                    <div style="${STACK}">
                      @if (rf.message()) {
                        <p class="at-field__error" role="alert" style="margin: 0">{{ rf.message() }}</p>
                      }
                      <p style="margin: 0">{{ t('lab.failText') }}</p>
                      <div class="at-field" [fieldId]="'fail-code'" [label]="t('lab.failConfirm')">
                        <input
                          class="at-input at-mono"
                          autocomplete="off"
                          [value]="rf.code()"
                          (input)="rf.code.set($any($event.target).value)"
                        />
                      </div>
                    </div>
                    <div class="at-dialog__actions">
                      <button class="at-button" [variant]="'ghost'" (click)="rf.dismiss()">
                        {{ t('action.cancel') }}
                      </button>
                      <button
                        class="at-button"
                        [variant]="'danger'"
                        [busy]="rf.sending()"
                        [disabled]="!rf.matches() || rf.f.wait() > 0"
                        [focusAfterWait]="rf.f.wait()"
                        (click)="rf.confirm()"
                      >
                        {{
                          rf.f.wait() > 0 ? t('auth.retryIn', { seconds: rf.f.wait() }) : t('lab.failSubmit')
                        }}
                      </button>
                    </div>
                  </dialog>
                </article>
              }
            }
          } @else if (query.data()!.results.length > 0) {
            <article class="at-card">
              <header class="at-card__header" [cardTitle]="t('lab.results')"></header>
              <div class="at-card__body">
                <div
                  class="at-table-wrap"
                  [cards]="true"
                  [caption]="t('lab.results')"
                  [rows]="query.data()!.results"
                  [rowKey]="resultKey"
                >
                  <ng-template [atColumn]="'name'" [header]="t('lab.indicator')" [primary]="true" let-r>{{
                    r.name
                  }}</ng-template>
                  <ng-template [atColumn]="'assessment'" [header]="t('lab.assessment')" [status]="true" let-r>
                    ${ASSESSMENT('r.isExceeded')}
                  </ng-template>
                  <ng-template [atColumn]="'value'" [header]="t('lab.value')" [numeric]="true" let-r>{{
                    valueText(r)
                  }}</ng-template>
                  <ng-template [atColumn]="'norm'" [header]="t('lab.norm')" let-r>{{
                    normText(r.normValue, r.unit)
                  }}</ng-template>
                </div>
              </div>
            </article>
          } @else if (query.data()!.norms.length > 0) {
            <article class="at-card">
              <header class="at-card__header" [cardTitle]="t('lab.results')"></header>
              <div class="at-card__body">
                <div
                  class="at-table-wrap"
                  [cards]="true"
                  [caption]="t('lab.results')"
                  [rows]="query.data()!.norms"
                  [rowKey]="normKey"
                >
                  <ng-template [atColumn]="'name'" [header]="t('lab.indicator')" [primary]="true" let-n>{{
                    n.name
                  }}</ng-template>
                  <ng-template [atColumn]="'norm'" [header]="t('lab.norm')" let-n>{{
                    normText(n.maxValue, n.unit)
                  }}</ng-template>
                </div>
              </div>
            </article>
          }
          @if (query.data()!.protocol || can('uploadProtocol')) {
            <article class="at-card">
              <header class="at-card__header" [cardTitle]="t('lab.protocol')"></header>
              <div class="at-card__body">
                <div style="${STACK}">
                  @if (query.data()!.protocol; as p) {
                    <div style="display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center">
                      <a class="at-button" [variant]="'secondary'" [icon]="'download'" [attr.href]="p.url">{{
                        t('lab.protocolDownload')
                      }}</a>
                      <span class="at-table__sub">{{ p.originalName }}, {{ bytes(p.sizeBytes) }}</span>
                    </div>
                  } @else {
                    <p style="margin: 0">{{ t('lab.protocolNone') }}</p>
                  }
                  @if (can('uploadProtocol')) {
                    <div
                      class="at-field"
                      [files]="protocolItems()"
                      [fileId]="'protocol-file'"
                      [label]="t('field.file')"
                      [accept]="'application/pdf,.pdf'"
                      [hint]="t('lab.protocolHint')"
                      [error]="picked()?.error"
                      [disabled]="uploading()"
                      (chosen)="pick($event)"
                      (removed)="picked.set(null)"
                    ></div>
                  }
                </div>
              </div>
              @if (can('uploadProtocol') && picked() && !picked()!.error) {
                <footer class="at-card__footer">
                  <button
                    class="at-button"
                    [variant]="'primary'"
                    [icon]="'upload'"
                    [busy]="uploading()"
                    [disabled]="uploadWait.left() > 0"
                    [focusAfterWait]="uploadWait.left()"
                    (click)="upload(query.data()!)"
                  >
                    {{
                      uploadWait.left() > 0
                        ? t('auth.retryIn', { seconds: uploadWait.left() })
                        : query.data()!.protocol
                          ? t('lab.protocolReplace')
                          : t('action.upload')
                    }}
                  </button>
                </footer>
              }
            </article>
          }
        </div>
      }
    }`,
})
export class LabTestPage extends LabView {
  protected readonly normText = normText;
  protected readonly normKey = (n: Norm) => n.indicatorId;
  protected readonly resultKey = (r: Result) => r.indicatorId;
  protected readonly valueText = (r: Result) => `${indicatorText(r.value)} ${r.unit}`;
  protected readonly bytes = (n: number) => formatBytes(n, LOCALE);
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  private readonly id = computed(() => this.params().get('id') ?? '');
  protected readonly problems = new LabProblems(() => this.reread());
  protected readonly sampling = signal(false);
  protected readonly sampleWait = countdown();

  protected readonly query = injectQuery(
    () => {
      const id = this.id();
      return {
        key: labTestKey(id),
        load: () => call<LabTest>(this.session.api.GET('/lab-tests/{id}', { params: { path: { id } } })),
      };
    },
    { failedText: t('lab.testFailed') },
  );
  protected readonly missing = computed(() => notFound(this.query.error()));
  protected readonly can = (a: Schemas['LabTestActionName']) =>
    Boolean(this.query.data()?.actions.includes(a));
  protected readonly facts = computed<CardFact[]>(() => {
    const x = this.query.data();
    if (!x) return [];
    return [
      { key: 'lab', term: t('labTests.lab'), value: x.lab.name },
      { key: 'reason', term: t('labTests.reason'), value: enumLabel(t, 'LabTestReason', x.reason) },
      { key: 'created', term: t('lab.createdAt'), value: at(x.createdAt) },
    ];
  });
  protected readonly laterFacts = computed<CardFact[]>(() => {
    const x = this.query.data();
    if (!x) return [];
    return [
      ...(x.sampledAt ? [{ key: 'sampled', term: t('lab.sampledAt'), value: at(x.sampledAt) }] : []),
      ...(x.escalatedAt ? [{ key: 'escalated', term: t('lab.escalatedAt'), value: at(x.escalatedAt) }] : []),
      ...(x.completedAt ? [{ key: 'completed', term: t('lab.completedAt'), value: at(x.completedAt) }] : []),
    ];
  });

  private reread(): void {
    this.cache.invalidate(LAB_TESTS_KEY);
    if (!this.alive()) {
      this.cache.invalidate(labTestKey(this.id()));
      return;
    }
    void this.query.refetch().then(() =>
      setTimeout(() => {
        if (this.alive() && focusLost())
          document.querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')?.focus();
      }, 0),
    );
  }

  protected changed(next: LabTest): void {
    this.query.writer()(next);
    this.cache.invalidate(LAB_TESTS_KEY);
    this.cache.invalidate(DASHBOARD_KEY);
    this.cache.invalidate(BATCH_PREFIX);
  }

  protected async sample(x: LabTest): Promise<void> {
    const generation = this.session.generation;
    const write = this.query.writer();
    this.problems.alert.clear();
    this.sampling.set(true);
    try {
      const next = await call<LabTest>(
        this.session.api.POST('/lab-tests/{id}/sample', {
          params: { path: { id: x.id }, header: { 'If-Match': x.version } },
          body: {},
        }),
      );
      if (generation !== this.session.generation) return;
      write(next);
      this.cache.invalidate(LAB_TESTS_KEY);
      this.cache.invalidate(DASHBOARD_KEY);
      this.cache.invalidate(BATCH_PREFIX);
      this.toasts.push({ tone: 'ok', text: t('lab.sampled', { code: x.batch.publicCode }) });
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.status === 429) this.sampleWait.start(retryAfterOf(e));
      this.problems.fail(e);
    } finally {
      if (this.alive()) this.sampling.set(false);
    }
  }

  private readonly protocolAlert = formAlert();
  protected readonly picked = signal<{ file: File; error?: string } | null>(null);
  protected readonly uploading = signal(false);
  protected readonly uploadWait = countdown();
  protected readonly protocolItems = computed<FileItem[]>(() => {
    const p = this.picked();
    if (!p) return [];
    return [
      {
        key: 'protocol',
        name: p.file.name,
        sizeText: p.error ?? formatBytes(p.file.size, LOCALE),
        error: Boolean(p.error),
        kind: 'PDF',
        ...(this.uploading() ? { progress: null } : {}),
      },
    ];
  });

  protected pick(files: File[]): void {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!isPdf(file)) error = unsupportedText();
    else if (file.size > PROTOCOL_MAX_BYTES) error = tooLargeText(PROTOCOL_MAX_BYTES);
    this.picked.set(error ? { file, error } : { file });
  }

  protected async upload(x: LabTest): Promise<void> {
    const picked = this.picked();
    if (!picked || picked.error) return;
    const generation = this.session.generation;
    this.protocolAlert.clear();
    this.uploading.set(true);
    try {
      const body = new FormData();
      body.append('file', picked.file);
      await call(
        this.session.api.PUT('/lab-tests/{id}/protocol', {
          params: { path: { id: x.id } },
          body: body as never,
        }),
      );
      if (generation !== this.session.generation) return;
      this.cache.invalidate(LAB_TESTS_KEY);
      if (this.alive()) {
        this.picked.set(null);
        await this.query.refetch();
      } else this.cache.invalidate(labTestKey(x.id));
      this.toasts.push({ tone: 'ok', text: t('lab.protocolSaved') });
    } catch (e) {
      if (!this.live(generation)) return;
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.['maxBytes']) || PROTOCOL_MAX_BYTES);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE') error = unsupportedText();
      else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.['file']?.[0])
        error = t(e.errors['file'][0]);
      if (e instanceof ApiProblem && e.status === 429) this.uploadWait.start(retryAfterOf(e));
      if (error) this.picked.update((p) => (p ? { ...p, error } : p));
      this.protocolAlert.show(error ?? errorText(e), error ? 'danger' : errorTone(e));
    } finally {
      if (this.alive()) this.uploading.set(false);
    }
  }
}
