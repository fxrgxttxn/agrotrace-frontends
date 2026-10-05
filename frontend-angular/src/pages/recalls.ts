import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatLocalDateTime, formatMass } from '@agrotrace/i18n';
import { RecallCreateSchema } from '@agrotrace/validation';
import { injectAlive, injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { CodeConfirm, codeConfirmDialog } from '../app/code-confirm';
import { DateFilterComponent } from '../app/date-filter';
import {
  dialogAlert,
  errorTone,
  FocusAfterWaitDirective,
  formAlert,
  SchemaForm,
  wireSchema,
} from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { idempotency } from '../app/idempotency';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { injectNow } from '../app/now';
import { injectQuery, QueryCache } from '../app/query';
import { deadline, RECALL_TONE, TASK_TONE, taskConfirmable } from '../app/recalls';
import { SessionService } from '../app/session';
import {
  FieldContext,
  FullscreenOpenerDirective,
  injectFullscreen,
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type CardFact,
  type ComboOption,
  type Tone,
} from '../app/ui';
import { BatchGraphComponent } from '../graph/batch-graph';
import {
  BATCH_PREFIX,
  BATCHES_KEY,
  batchKey,
  DASHBOARD_KEY,
  RECALL_TASKS_KEY,
  recallKey,
  RECALLS_KEY,
} from './keys';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type Recall = Schemas['Recall'];
type RecallItem = Schemas['RecallListItem'];
type Task = Schemas['RecallTask'];
type TaskStatus = Schemas['RecallTaskStatus'];
type RecallBatch = Schemas['RecallBatch'];
type Batch = Schemas['Batch'];

const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';
const STACK = 'display: grid; gap: var(--sp-4)';
const ALL = 'all';
const SEVERAL = '__several';
const TASK_STATUSES: readonly TaskStatus[] = ['OPEN', 'OVERDUE', 'CONFIRMED'];
const ACTIVE: readonly TaskStatus[] = ['OPEN', 'OVERDUE'];
const TRIGGERS: readonly Schemas['RecallTrigger'][] = ['LAB', 'INSPECTOR', 'COMPLAINT'];
const TICK_MS = 30_000;

const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

function liveStatus(task: Pick<Task, 'status' | 'dueAt'>, now: number): TaskStatus {
  return deadline(task, now)?.overdue ? 'OVERDUE' : task.status;
}

const IMPORTS = [
  ...UI,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  DateFilterComponent,
  BatchGraphComponent,
  FullscreenOpenerDirective,
];

class RecallView {
  protected readonly t = t;
  protected readonly at = at;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly now = injectNow(TICK_MS);
  protected readonly taskStatus = (x: Task) => liveStatus(x, this.now());
  protected readonly taskTone = (x: Task): Tone => TASK_TONE[liveStatus(x, this.now())];
  protected readonly left = (x: Task) => deadline(x, this.now());
  protected readonly recallTone = (s: Schemas['RecallStatus']): Tone => RECALL_TONE[s];
}

function TASK_CHIP(x: string): string {
  return `<span class="at-chip" [tone]="taskTone(${x})">{{ label('RecallTaskStatus', taskStatus(${x})) }}</span>`;
}
function DUE(x: string): string {
  return `<span class="at-table__primary"
              ><span>{{ at(${x}.dueAt) }}</span>@if (left(${x}); as l) {<span
                  class="at-table__sub"
                  [class.at-field__warning]="l.overdue"
                  >{{ l.text }}</span
                >}</span
            >`;
}
function CONFIRMED(x: string): string {
  return `@if (${x}.confirmedAt) {
              <span class="at-table__primary"
                ><span>{{ at(${x}.confirmedAt) }}</span>@if (${x}.confirmedBy) {<span class="at-table__sub">{{
                    ${x}.confirmedBy.fullName
                  }}</span>}</span
              >
            } @else {
              —
            }`;
}
function RECALL_CHIP(s: string, size = 'undefined'): string {
  return `<span class="at-chip" [tone]="recallTone(${s})" [size]="${size}">{{ label('RecallStatus', ${s}) }}</span>`;
}
function PROGRESS(id: string, p: string, inTable: boolean): string {
  return `<div style="display: grid; gap: var(--sp-1)">
              <div
                class="at-progress"
                [progressId]="${id}"
                [label]="t('recalls.progress')"
                [value]="${p}.confirmed"
                [max]="${p}.total"
                [tone]="${p}.overdue > 0 ? 'danger' : undefined"
                [labelHidden]="${inTable}"
              ></div>
              @if (${p}.overdue > 0) {
                <span class="at-table__sub at-field__warning">{{ t('recalls.overdueCount', { count: ${p}.overdue }) }}</span>
              }
            </div>`;
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
function BATCH_CELL(x: string): string {
  return `<span class="at-table__primary" [href]="'/batches/' + ${x}.batch.id" [code]="${x}.batch.publicCode" [sub]="${x}.batch.product.name"></span>`;
}

const TASKS_SPEC: ListSpec = {
  sort: ['dueAt', 'createdAt', 'confirmedAt'],
  enums: { status: [...TASK_STATUSES, ALL], overdue: ['true', 'false'] },
  texts: ['q'],
};

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.recallTasks')"></div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('recallTasks.status')">
          ${multiSelect(
            'status',
            'status()',
            'statuses',
            'RecallTaskStatus',
            `<option value="" [selected]="status().length === 0">{{ t('recallTasks.active') }}</option>
            <option [value]="all" [selected]="status()[0] === all">{{ t('filters.any') }}</option>`,
          )}
        </div>
        <div class="at-field" [fieldId]="'filter-overdue'" [label]="t('recallTasks.overdueFilter')">
          <select class="at-select" (change)="list.set({ overdue: $any($event.target).value })">
            <option value="" [selected]="overdue() === ''">{{ t('filters.any') }}</option>
            <option value="true" [selected]="overdue() === 'true'">{{ t('recallTasks.overdueOnly') }}</option>
            <!-- prettier-ignore -->
            <option value="false" [selected]="overdue() === 'false'">{{ t('recallTasks.overdueNone') }}</option>
          </select>
        </div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('recallTasks.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'query.refetch()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        @if (allOnly()) {
          <div class="at-empty" [art]="'empty-recalls'" [text]="t('recallTasks.empty')"></div>
        } @else if (q() || count()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-recalls'" [text]="t('recallTasks.empty')">
            <button class="at-button" [variant]="'primary'" (click)="list.set({ status: all })">
              {{ t('recallTasks.showAll') }}
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
          [caption]="t('page.recallTasks')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template [atColumn]="'batch'" [header]="t('recallTasks.batch')" [primary]="true" let-x>
            ${BATCH_CELL('x')}
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('recallTasks.status')" [status]="true" let-x>
            ${TASK_CHIP('x')}
          </ng-template>
          <ng-template [atColumn]="'reason'" [header]="t('recallTasks.reason')" let-x>{{
            x.recallReason
          }}</ng-template>
          <ng-template [atColumn]="'due'" [header]="t('recallTasks.dueAt')" [sortField]="'dueAt'" let-x>
            ${DUE('x')}
          </ng-template>
          <ng-template
            [atColumn]="'confirmed'"
            [header]="t('recallTasks.confirmedAt')"
            [sortField]="'confirmedAt'"
            let-x
          >
            ${CONFIRMED('x')}
          </ng-template>
          <ng-template atRowActions let-x>
            @if (confirmable(x.status)) {
              <button
                class="at-button"
                [variant]="'danger'"
                [icon]="'check'"
                [attr.aria-label]="t('recallTasks.confirmFor', { code: x.batch.publicCode })"
                (click)="open(x)"
              >
                {{ t('action.confirmSeizure') }}
              </button>
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
    }
    ${codeConfirmDialog({
      state: 'confirmCode',
      open: 'shown() !== null',
      title: "shown() ? t('recallTasks.confirmTitle', { code: shown()!.batch.publicCode }) : ''",
      code: "shown()?.batch?.publicCode ?? ''",
      label: "label('BatchActionName', 'writeOff')",
      busy: 'busy()',
      wait: 'wait.left()',
      message: 'message()',
      close: 'close()',
      confirm: 'confirmShown()',
      text: `@if (shown(); as s) {
          <p style="margin: 0">{{ t('recallTasks.confirmText', { product: s.batch.product.name, mass: mass(s.batch.massKg) }) }}</p>
        }`,
    })}`,
})
export class RecallTasksPage extends RecallView {
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly all = ALL;
  protected readonly statuses = TASK_STATUSES;
  protected readonly confirmable = taskConfirmable;
  protected readonly mass = (kg: string) => formatMass(kg, LOCALE);
  protected readonly rowKey = (x: Task) => x.id;
  protected readonly sortOptions = [
    { value: 'dueAt,asc', label: t('recallTasks.sort.due') },
    { value: 'createdAt,desc', label: t('recallTasks.sort.created') },
    { value: 'confirmedAt,desc', label: t('recallTasks.sort.confirmed') },
  ];
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  private readonly alert = formAlert();
  private readonly idempotent = idempotency();
  protected readonly list = injectListParams('/recall-tasks', TASKS_SPEC);
  protected readonly q = computed(() => this.list.params().get('q') ?? '');
  private readonly statusParam = computed(() => this.list.params().getAll('status'));
  protected readonly status = computed(() => (this.statusParam().includes(ALL) ? [ALL] : this.statusParam()));
  protected readonly overdue = computed(() => this.list.params().get('overdue') ?? '');
  protected readonly count = computed(() => (this.status().length ? 1 : 0) + (this.overdue() ? 1 : 0));
  protected readonly allOnly = computed(() => this.status()[0] === ALL && !this.q() && this.count() === 1);
  protected readonly search = computed(() => ({
    label: t('recallTasks.search'),
    placeholder: t('recallTasks.searchPlaceholder'),
    value: this.q(),
  }));

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const overdue = this.overdue();
      const sent: readonly TaskStatus[] =
        status[0] === ALL ? [] : status.length ? (status as TaskStatus[]) : ACTIVE;
      return {
        key: `${RECALL_TASKS_KEY}${JSON.stringify([page, sort, q, status, overdue])}`,
        load: () =>
          call<Schemas['RecallTaskPage']>(
            this.session.api.GET('/recall-tasks', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(q ? { q } : {}),
                  ...(sent.length ? { status: [...sent] } : {}),
                  ...(overdue ? { overdue: overdue === 'true' } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('recallTasks.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));

  private readonly target = signal<string | null>(null);
  protected readonly shown = computed(() => this.items().find((x) => x.id === this.target()) ?? null);
  protected readonly busy = signal(false);
  protected readonly wait = countdown();
  protected readonly failure = dialogAlert();
  protected readonly message = this.failure.message;
  protected readonly confirmCode = new CodeConfirm(() => this.shown() !== null);

  constructor() {
    super();
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
    effect(
      () => {
        const target = this.target();
        const shown = this.shown();
        if (target !== null && this.query.data() && (!shown || !taskConfirmable(shown.status)))
          untracked(() => {
            this.target.set(null);
            this.failure.clear();
          });
      },
      { allowSignalWrites: true },
    );
    effect(() => {
      const statuses = this.statusParam();
      if (!statuses.includes(ALL) || statuses.length < 2) return;
      untracked(() => {
        const next = new URLSearchParams(this.list.params());
        next.delete('status');
        next.append('status', ALL);
        void this.router.navigateByUrl(`/recall-tasks?${next.toString()}`, { replaceUrl: true });
      });
    });
  }

  protected open(x: Task): void {
    this.failure.clear();
    this.target.set(x.id);
  }

  protected close(): void {
    this.failure.handOff();
    this.target.set(null);
  }

  private reread(): void {
    this.cache.invalidate(RECALL_TASKS_KEY);
    if (this.alive()) void this.query.refetch();
  }

  protected confirmShown(): void {
    const task = this.shown();
    if (task) void this.confirm(task);
  }

  private async confirm(task: Task): Promise<void> {
    const generation = this.session.generation;
    this.busy.set(true);
    this.failure.clear();
    this.alert.clear();
    try {
      await this.idempotent(
        { id: task.id, version: task.version },
        (key) =>
          call<Task>(
            this.session.api.POST('/recall-tasks/{id}/confirm', {
              params: { path: { id: task.id }, header: { 'If-Match': task.version, 'Idempotency-Key': key } },
              body: {},
            }),
          ),
        task.id,
      );
      if (generation !== this.session.generation) return;
      for (const key of [BATCHES_KEY, BATCH_PREFIX, DASHBOARD_KEY, 'notifications?', RECALLS_KEY, 'recall:'])
        this.cache.invalidate(key);
      this.toasts.push({ tone: 'ok', text: t('recallTasks.confirmed', { code: task.batch.publicCode }) });
      if (!this.alive()) return;
      this.target.set(null);
      this.reread();
    } catch (e) {
      if (!this.live(generation)) return;
      const code = task.batch.publicCode;
      let text: string;
      let closing = false;
      if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
        this.reread();
        text = t('recallTasks.versionConflict');
      } else if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
        this.reread();
        closing = true;
        text = t('recallTasks.alreadyConfirmed', { code });
      } else if (e instanceof ApiProblem && e.status === 404) {
        this.reread();
        closing = true;
        text = t('recallTasks.gone');
      } else {
        if (e instanceof ApiProblem && e.status === 429) this.wait.start(retryAfterOf(e));
        text = errorText(e);
      }
      if (closing) {
        this.target.set(null);
        this.alert.show(text, errorTone(e));
      } else this.failure.show(text, errorTone(e));
    } finally {
      this.busy.set(false);
    }
  }
}

const RECALLS_SPEC: ListSpec = {
  sort: ['openedAt', 'closedAt'],
  enums: { status: ['OPEN', 'CLOSED'], trigger: TRIGGERS },
  dates: ['from', 'to'],
  texts: ['q'],
};

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.recalls')">
      <div class="at-page__actions">
        <a class="at-button" [variant]="'danger'" [to]="'/recalls/new'">{{ t('action.startRecall') }}</a>
      </div>
    </div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('recalls.status')">
          <select class="at-select" (change)="list.set({ status: $any($event.target).value })">
            <option value="" [selected]="status() === ''">{{ t('filters.any') }}</option>
            <option value="OPEN" [selected]="status() === 'OPEN'">{{ label('RecallStatus', 'OPEN') }}</option>
            <!-- prettier-ignore -->
            <option value="CLOSED" [selected]="status() === 'CLOSED'">{{ label('RecallStatus', 'CLOSED') }}</option>
          </select>
        </div>
        <div class="at-field" [fieldId]="'filter-trigger'" [label]="t('recalls.trigger')">
          ${multiSelect(
            'trigger',
            'trigger()',
            'triggers',
            'RecallTrigger',
            `<option value="" [selected]="trigger().length === 0">{{ t('filters.any') }}</option>`,
          )}
        </div>
        <div
          class="at-field"
          [dateFilter]="'filter-from'"
          [label]="t('recalls.from')"
          [value]="from()"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'filter-to'"
          [label]="t('recalls.to')"
          [value]="to()"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('recalls.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'query.refetch()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        @if (q() || count()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-recalls'" [text]="t('empty.recalls')"></div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.recalls')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template [atColumn]="'source'" [header]="t('recalls.source')" [primary]="true" let-x>
            <span
              class="at-table__primary"
              [href]="'/recalls/' + x.id"
              [code]="x.sourceBatch.publicCode"
              [sub]="x.sourceBatch.product.name"
            ></span>
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('recalls.status')" [status]="true" let-x>
            ${RECALL_CHIP('x.status')}
          </ng-template>
          <ng-template [atColumn]="'trigger'" [header]="t('recalls.trigger')" let-x>
            <span class="at-table__primary"
              ><span>{{ label('RecallTrigger', x.trigger) }}</span
              ><span class="at-table__sub">{{ x.reason }}</span></span
            >
          </ng-template>
          <ng-template [atColumn]="'progress'" [header]="t('recalls.progress')" let-x>
            ${PROGRESS("'progress-' + x.id", 'x.progress', true)}
          </ng-template>
          <ng-template [atColumn]="'batches'" [header]="t('recalls.batchesCount')" [numeric]="true" let-x>{{
            x.batchesCount
          }}</ng-template>
          <ng-template
            [atColumn]="'opened'"
            [header]="t('recalls.openedAt')"
            [sortField]="'openedAt'"
            let-x
            >{{ at(x.openedAt) }}</ng-template
          >
          <ng-template
            [atColumn]="'closed'"
            [header]="t('recalls.closedAt')"
            [sortField]="'closedAt'"
            let-x
            >{{ x.closedAt ? at(x.closedAt) : '—' }}</ng-template
          >
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
export class RecallsPage extends RecallView {
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly triggers = TRIGGERS;
  protected readonly rowKey = (x: RecallItem) => x.id;
  protected readonly sortOptions = [
    { value: 'openedAt,desc', label: t('recalls.sort.opened') },
    { value: 'closedAt,desc', label: t('recalls.sort.closed') },
  ];
  private readonly session = inject(SessionService);
  protected readonly list = injectListParams('/recalls', RECALLS_SPEC);
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly q = this.p('q');
  protected readonly status = this.p('status');
  protected readonly trigger = computed(() => this.list.params().getAll('trigger'));
  protected readonly from = this.p('from');
  protected readonly to = this.p('to');
  protected readonly count = computed(
    () => (this.trigger().length ? 1 : 0) + [this.status(), this.from(), this.to()].filter(Boolean).length,
  );
  protected readonly search = computed(() => ({
    label: t('recalls.search'),
    placeholder: t('recalls.searchPlaceholder'),
    value: this.q(),
  }));

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const trigger = this.trigger();
      const from = this.from();
      const to = this.to();
      return {
        key: `${RECALLS_KEY}${JSON.stringify([page, sort, q, status, trigger, from, to])}`,
        load: () =>
          call<Schemas['RecallPage']>(
            this.session.api.GET('/recalls', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(q ? { q } : {}),
                  ...(status ? { status: status as Schemas['RecallStatus'] } : {}),
                  ...(trigger.length ? { trigger: trigger as Schemas['RecallTrigger'][] } : {}),
                  ...(from ? { from } : {}),
                  ...(to ? { to } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('recalls.failed') },
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
  }
}

function asBatchGraph(recall: Recall, graph: Schemas['RecallGraph']): Schemas['BatchGraph'] {
  return {
    rootId: recall.sourceBatch.id,
    depth: Math.min(5, Math.max(1, ...graph.nodes.map((n) => n.depth))),
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      publicCode: n.publicCode,
      product: n.product,
      status: n.status,
      holder: n.holder,
      depth: n.direction === 'UP' ? -n.depth : n.depth,
      accessible: true,
    })),
    edges: graph.edges,
  };
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!query.data() && missing()) {
      <div class="at-page__header" [pageTitle]="t('page.recall')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('recalls.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/recalls'">{{ t('recalls.toList') }}</a>
        </div>
      </article>
    } @else {
      <div
        class="at-page__header"
        [pageTitle]="
          query.data() ? t('recalls.title', { code: query.data()!.sourceBatch.publicCode }) : t('page.recall')
        "
      ></div>
      @if (!query.data() && query.failed()) {
        ${loadFailed("t('recalls.cardFailed')", 'query.fetching()', 'query.refetch()')}
      } @else if (!query.data()) {
        ${areaLoading(2)}
      } @else {
        <div style="${GAP}">
          <article class="at-card">
            <header class="at-card__header" [cardTitle]="query.data()!.sourceBatch.product.name">
              ${RECALL_CHIP('query.data()!.status', "'l'")}
            </header>
            <div class="at-card__body">
              <div style="${STACK}">
                <dl class="at-card__facts">
                  <div style="grid-column: 1 / -1">
                    <dt>{{ t('recalls.reason') }}</dt>
                    <dd>{{ query.data()!.reason }}</dd>
                  </div>
                </dl>
                <dl class="at-card__facts">
                  <div>
                    <dt>{{ t('recalls.source') }}</dt>
                    <dd>
                      <a class="at-mono" [to]="'/batches/' + query.data()!.sourceBatch.id">{{
                        query.data()!.sourceBatch.publicCode
                      }}</a>
                    </dd>
                  </div>
                  @for (f of facts(); track f.key) {
                    <div>
                      <dt>{{ f.term }}</dt>
                      <dd>{{ f.value }}</dd>
                    </div>
                  }
                  @if (query.data()!.complaintId; as c) {
                    <div>
                      <dt>{{ t('recalls.complaint') }}</dt>
                      <dd>
                        <a [to]="'/complaints/' + c">{{ t('recalls.complaintOpen') }}</a>
                      </dd>
                    </div>
                  }
                  @if (query.data()!.labTestId) {
                    <div>
                      <dt>{{ t('recalls.labTest') }}</dt>
                      <dd>
                        <a [to]="'/batches/' + query.data()!.sourceBatch.id + '?tab=tests'">{{
                          t('recalls.labTestOpen')
                        }}</a>
                      </dd>
                    </div>
                  }
                </dl>
                ${PROGRESS("'recall-progress'", 'query.data()!.progress', false)}
              </div>
            </div>
          </article>
          <article class="at-card">
            <header class="at-card__header" [cardTitle]="t('recalls.tasks')"></header>
            <div class="at-card__body">
              @if (query.data()!.tasks.length === 0) {
                <p style="margin: 0">{{ t('recalls.noTasks') }}</p>
              } @else {
                <div
                  class="at-table-wrap"
                  [cards]="true"
                  [caption]="t('recalls.tasks')"
                  [rows]="query.data()!.tasks"
                  [rowKey]="taskKey"
                >
                  <ng-template [atColumn]="'batch'" [header]="t('recallTasks.batch')" [primary]="true" let-x>
                    ${BATCH_CELL('x')}
                  </ng-template>
                  <ng-template [atColumn]="'status'" [header]="t('recallTasks.status')" [status]="true" let-x>
                    ${TASK_CHIP('x')}
                  </ng-template>
                  <ng-template [atColumn]="'holder'" [header]="t('recallTasks.holder')" let-x>{{
                    x.holder.name
                  }}</ng-template>
                  <ng-template [atColumn]="'due'" [header]="t('recallTasks.dueAt')" let-x
                    >${DUE('x')}</ng-template
                  >
                  <ng-template [atColumn]="'confirmed'" [header]="t('recallTasks.confirmedAt')" let-x>
                    ${CONFIRMED('x')}
                  </ng-template>
                </div>
              }
            </div>
          </article>
          <article class="at-card">
            <header class="at-card__header" [cardTitle]="t('recalls.affected')"></header>
            <div class="at-card__body">
              <div style="${STACK}">
                @if (graphView(); as g) {
                  @if (graphFs.wide() || graphFs.full()) {
                    <div
                      class="at-graph"
                      [atBatchGraph]="g"
                      [code]="query.data()!.sourceBatch.publicCode"
                      [labelKey]="'recalls.graphLabel'"
                      [fs]="graphFs"
                    ></div>
                  } @else {
                    <button
                      class="at-button"
                      [icon]="'graph'"
                      [atFullscreenOpener]="graphFs"
                      (click)="graphFs.open()"
                    >
                      {{ t('graph.open') }}
                    </button>
                  }
                } @else if (graph.failed()) {
                  ${loadFailed("t('graph.failed')", 'graph.fetching()', 'graph.refetch()')}
                } @else {
                  ${areaLoading(1)}
                }
                <div
                  class="at-table-wrap"
                  [cards]="true"
                  [caption]="t('recalls.affected')"
                  [rows]="query.data()!.batches"
                  [rowKey]="batchKey"
                >
                  <ng-template [atColumn]="'batch'" [header]="t('recallTasks.batch')" [primary]="true" let-x>
                    ${BATCH_CELL('x')}
                  </ng-template>
                  <ng-template [atColumn]="'now'" [header]="t('recalls.statusNow')" [status]="true" let-x>
                    <span class="at-chip" [status]="x.batch.status"></span>
                  </ng-template>
                  <ng-template [atColumn]="'link'" [header]="t('recalls.direction')" let-x>{{
                    relation(x)
                  }}</ng-template>
                  <ng-template [atColumn]="'before'" [header]="t('recalls.statusBefore')" let-x>
                    <span class="at-chip" [status]="x.statusBefore"></span>
                  </ng-template>
                  <ng-template [atColumn]="'holder'" [header]="t('recalls.holder')" let-x>{{
                    x.batch.holder.name
                  }}</ng-template>
                </div>
              </div>
            </div>
          </article>
        </div>
      }
    }`,
})
export class RecallPage extends RecallView {
  protected readonly taskKey = (x: Task) => x.id;
  protected readonly batchKey = (x: RecallBatch) => x.batch.id;
  protected readonly relation = (b: Pick<RecallBatch, 'direction' | 'depth'>) =>
    b.direction === 'SOURCE'
      ? enumLabel(t, 'RecallDirection', 'SOURCE')
      : b.direction === 'UP'
        ? t('graph.up', { level: b.depth })
        : t('graph.down', { level: b.depth });
  private readonly session = inject(SessionService);
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  private readonly id = computed(() => this.params().get('id') ?? '');
  protected readonly graphFs = injectFullscreen();

  protected readonly query = injectQuery(
    () => {
      const id = this.id();
      return {
        key: recallKey(id),
        load: () => call<Recall>(this.session.api.GET('/recalls/{id}', { params: { path: { id } } })),
      };
    },
    { failedText: t('recalls.cardFailed') },
  );
  protected readonly missing = computed(() => notFound(this.query.error()));
  protected readonly graph = injectQuery(
    () => {
      if (!this.query.data()) return null;
      const id = this.id();
      return {
        key: `${recallKey(id)}:graph`,
        load: () =>
          call<Schemas['RecallGraph']>(
            this.session.api.GET('/recalls/{id}/graph', { params: { path: { id } } }),
          ),
      };
    },
    { failedText: t('graph.failed') },
  );
  protected readonly graphView = computed(() => {
    const r = this.query.data();
    const g = this.graph.data();
    return r && g ? asBatchGraph(r, g) : null;
  });
  protected readonly facts = computed<CardFact[]>(() => {
    const r = this.query.data();
    if (!r) return [];
    return [
      { key: 'trigger', term: t('recalls.trigger'), value: enumLabel(t, 'RecallTrigger', r.trigger) },
      { key: 'opened', term: t('recalls.openedAt'), value: at(r.openedAt) },
      ...(r.openedBy ? [{ key: 'by', term: t('recalls.openedBy'), value: r.openedBy.fullName }] : []),
      ...(r.closedAt ? [{ key: 'closed', term: t('recalls.closedAt'), value: at(r.closedAt) }] : []),
      {
        key: 'upstream',
        term: t('recalls.blockUpstream'),
        value: r.blockUpstream ? t('recalls.upstreamBlocked') : t('recalls.upstreamKept'),
      },
    ];
  });
}

interface NewRecall extends Record<string, unknown> {
  sourceBatchId: string;
  reason: string;
  blockUpstream: boolean;
}

const newRecallSchema = wireSchema<NewRecall>(RecallCreateSchema, (v) => v);

@Component({
  selector: 'div.at-field[batchPicker]',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: BatchPickerComponent }],
  template: `<label class="at-field__label" [attr.for]="batchPicker()">{{ t('recalls.new.batch') }}</label>
    <div
      class="at-combobox"
      [listLabel]="t('recalls.new.batch')"
      [query]="query()"
      [options]="options()"
      [loading]="searching()"
      [selected]="value() || null"
      (queryChange)="typed($event)"
      (search)="search.set($event)"
      (chosen)="pick($event)"
    ></div>
    @if (shownError()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ shownError() }}</p>
    }`,
  host: { '[attr.data-invalid]': "shownError() ? '' : null" },
})
export class BatchPickerComponent extends FieldContext {
  protected readonly t = t;
  readonly batchPicker = input.required<string>();
  readonly value = input.required<string>();
  readonly error = input<string | null | undefined>(null);
  readonly batch = output<{ id: string; code: string } | null>();
  readonly pending = output<boolean>();

  private readonly session = inject(SessionService);
  protected readonly query = signal('');
  protected readonly search = signal<string | null>(null);
  private readonly picked = signal<string | null>(null);

  private readonly linked = injectQuery(() => {
    const id = this.value();
    if (id === '' || this.picked() === id) return null;
    return {
      key: batchKey(id),
      load: () => call<Batch>(this.session.api.GET('/batches/{id}', { params: { path: { id } } })),
    };
  });
  private readonly found = injectQuery(() => {
    const text = this.search()?.trim() ?? '';
    if (!text) return null;
    return {
      key: `${BATCHES_KEY}search:${text}`,
      load: () =>
        call<Schemas['BatchPage']>(
          this.session.api.GET('/batches', {
            params: { query: { q: text, size: 20, sort: 'publicCode,asc' } },
          }),
        ),
    };
  });
  protected readonly searching = computed(() => Boolean(this.search()?.trim()) && this.found.fetching());
  protected readonly options = computed<ComboOption[]>(() =>
    this.search()?.trim()
      ? (this.found.data()?.items ?? []).map((b) => ({
          value: b.id,
          label: b.publicCode,
          meta: b.product.name,
        }))
      : [],
  );
  private readonly linkError = computed(() => {
    const id = this.value();
    if (id === '' || this.picked() === id || this.linked.data() || !this.linked.failed()) return null;
    return notFound(this.linked.error()) ? t('validation.notFound') : t('recalls.new.batchFailed');
  });
  protected readonly shownError = computed(() => this.error() || this.linkError());
  readonly controlId = computed(() => this.batchPicker());
  readonly errorId = computed(() => (this.shownError() ? `${this.batchPicker()}-error` : null));
  readonly invalid = computed(() => Boolean(this.shownError()));

  constructor() {
    super();
    effect(() => {
      const pending = this.linked.fetching() && !this.linked.data();
      untracked(() => this.pending.emit(pending));
    });
    effect(
      () => {
        const b = this.linked.data();
        const id = this.value();
        untracked(() => {
          if (b && b.id === id) {
            this.query.set(b.publicCode);
            this.batch.emit({ id: b.id, code: b.publicCode });
          }
        });
      },
      { allowSignalWrites: true },
    );
  }

  protected typed(text: string): void {
    this.query.set(text);
    if (this.value() !== '') {
      this.picked.set(null);
      this.batch.emit(null);
    }
  }

  protected pick(o: ComboOption): void {
    this.picked.set(o.value);
    this.query.set(o.label);
    this.batch.emit({ id: o.value, code: o.label });
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, ReactiveFormsModule, BatchPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.recallNew')"></div>
    <article class="at-card">
      <div class="at-card__body">
        <form novalidate style="${FORM_GRID}" (submit)="submit($event)">
          <div
            class="at-field"
            [batchPicker]="'recall-batch'"
            [value]="f.valueOf('sourceBatchId')"
            [error]="f.errorOf('sourceBatchId')"
            (pending)="linkPending.set($event)"
            (batch)="setBatch($event)"
          ></div>
          <div
            class="at-field"
            [fieldId]="'recall-reason'"
            [label]="t('recalls.new.reason')"
            [error]="f.errorOf('reason')"
          >
            <textarea class="at-textarea" rows="4" [formControl]="f.control('reason')"></textarea>
          </div>
          <label
            class="at-check"
            [label]="t('recalls.new.blockUpstream')"
            [name]="'blockUpstream'"
            [checked]="f.valueOf('blockUpstream')"
            (toggled)="f.control('blockUpstream').setValue($event)"
          ></label>
          <div>
            <button
              class="at-button"
              [type]="'submit'"
              [variant]="'primary'"
              [busy]="(busy() && !confirming()) || linkPending()"
              [disabled]="f.wait() > 0"
              [focusAfterWait]="f.wait()"
            >
              {{ f.wait() > 0 ? t('auth.retryIn', { seconds: f.wait() }) : t('recalls.new.submit') }}
            </button>
          </div>
        </form>
      </div>
    </article>
    ${codeConfirmDialog({
      state: 'confirmCode',
      open: "confirming() !== null && code() !== ''",
      title: "t('recalls.new.confirmTitle', { code: code() })",
      code: 'code()',
      label: "t('recalls.new.submit')",
      busy: 'busy()',
      wait: 'f.wait()',
      message: 'message()',
      close: 'closeConfirm()',
      confirm: 'confirm()',
      text: `<p style="margin: 0">{{ t('recalls.new.confirmText') }}</p>
        @if (confirming()?.blockUpstream) {
          <p style="margin: 0">{{ t('recalls.new.confirmUpstream') }}</p>
        }`,
    })}`,
})
export class RecallNewPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly live = injectLive();
  private readonly linked = inject(ActivatedRoute).snapshot.queryParamMap.get('batchId') ?? '';
  readonly f = new SchemaForm<NewRecall, Schemas['RecallCreate']>(
    newRecallSchema,
    {
      sourceBatchId: /^[0-9a-f-]{36}$/i.test(this.linked) ? this.linked : '',
      reason: '',
      blockUpstream: false,
    },
    ['sourceBatchId', 'reason', 'blockUpstream'],
  );
  protected readonly code = signal('');
  protected readonly linkPending = signal(false);
  protected readonly confirming = signal<Schemas['RecallCreate'] | null>(null);
  protected readonly busy = signal(false);
  protected readonly failure = dialogAlert();
  protected readonly message = this.failure.message;
  protected readonly confirmCode = new CodeConfirm(() => this.confirming() !== null && this.code() !== '');

  protected closeConfirm(): void {
    this.failure.handOff();
    this.confirming.set(null);
  }

  protected setBatch(b: { id: string; code: string } | null): void {
    this.code.set(b?.code ?? '');
    const control = this.f.control('sourceBatchId');
    control.setValue(b?.id ?? '');
    control.markAsDirty();
  }

  protected submit(e: Event): void {
    void this.f.submit(e, async (body) => {
      if (!this.code()) {
        if (!this.linkPending()) document.getElementById('recall-batch')?.focus();
        return;
      }
      this.failure.clear();
      this.confirming.set(body);
    });
  }

  protected confirm(): void {
    const v = this.confirming();
    if (v) void this.start(v);
  }

  private async start(v: Schemas['RecallCreate']): Promise<void> {
    const generation = this.session.generation;
    this.busy.set(true);
    this.failure.clear();
    this.f.alert.clear();
    try {
      const res = await this.session.api.POST('/recalls', { body: v });
      const recall = await call<Recall>(Promise.resolve(res));
      if (generation !== this.session.generation) return;
      this.cache.put(recallKey(recall.id), recall, generation);
      for (const key of [RECALLS_KEY, BATCHES_KEY, BATCH_PREFIX, DASHBOARD_KEY]) this.cache.invalidate(key);
      const shown = recall.sourceBatch.publicCode;
      if (res.response.status === 200) {
        if (this.live(generation))
          this.toasts.push({ tone: 'attention', text: t('recalls.new.existing', { code: shown }) });
      } else this.toasts.push({ tone: 'ok', text: t('recalls.new.started', { code: shown }) });
      if (!this.live(generation)) return;
      this.confirming.set(null);
      void this.router.navigateByUrl(`/recalls/${recall.id}`);
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        this.confirming.set(null);
        this.f.fail(e);
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) this.f.rateLimited(retryAfterOf(e));
      this.failure.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
