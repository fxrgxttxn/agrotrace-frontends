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
import { ActivatedRoute } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
import { ComplaintDecisionSchema } from '@agrotrace/validation';
import { injectAlive, injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { CodeConfirm, codeConfirmDialog } from '../app/code-confirm';
import { DateFilterComponent } from '../app/date-filter';
import { focusLost } from '../app/focus';
import { dialogAlert, errorTone, FocusAfterWaitDirective, SchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { OrgPickerComponent } from '../app/org-picker';
import { injectQuery, QueryCache } from '../app/query';
import { complaintActions, COMPLAINT_TONE } from '../app/recalls';
import { SessionService } from '../app/session';
import {
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type CardFact,
  type Tone,
} from '../app/ui';
import { COMPLAINTS_KEY, complaintKey } from './keys';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type Complaint = Schemas['Complaint'];
type Item = Schemas['ComplaintListItem'];
type Status = Schemas['ComplaintStatus'];
type Decision = Schemas['ComplaintDecisionType'];

const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';
const STACK = 'display: grid; gap: var(--sp-4)';
const SEVERAL = '__several';
const STATUSES: readonly Status[] = ['NEW', 'IN_REVIEW', 'DECIDED'];
const DECISIONS: readonly Decision[] = ['REJECT', 'LAB_TEST', 'RECALL'];

const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

const IMPORTS = [
  ...UI,
  ReactiveFormsModule,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  DateFilterComponent,
  OrgPickerComponent,
];

function STATUS_CHIP(s: string, size = 'undefined'): string {
  return `<span class="at-chip" [tone]="tone(${s})" [size]="${size}">{{ label('ComplaintStatus', ${s}) }}</span>`;
}

function multiSelect(key: string, values: string, all: string, enumName: string): string {
  return `<select class="at-select" (change)="list.set({ ${key}: $any($event.target).value })">
            <option value="" [selected]="${values}.length === 0">{{ t('filters.any') }}</option>
            @if (${values}.length > 1) {
              <!-- prettier-ignore -->
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: ${values}.length }) }}</option>
            }
            @for (v of ${all}; track v) {
              <option [value]="v" [selected]="${values}.length === 1 && ${values}[0] === v">{{ label('${enumName}', v) }}</option>
            }
          </select>`;
}

class ComplaintView {
  protected readonly t = t;
  protected readonly at = at;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly tone = (s: Status): Tone => COMPLAINT_TONE[s];
}

const SPEC: ListSpec = {
  sort: ['createdAt', 'decidedAt'],
  enums: { status: STATUSES, decision: DECISIONS },
  dates: ['from', 'to'],
  texts: ['q'],
};

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.complaints')"></div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('complaints.status')">
          ${multiSelect('status', 'status()', 'statuses', 'ComplaintStatus')}
        </div>
        <div class="at-field" [fieldId]="'filter-decision'" [label]="t('complaints.decision')">
          ${multiSelect('decision', 'decision()', 'decisions', 'ComplaintDecisionType')}
        </div>
        <div
          class="at-field"
          [dateFilter]="'filter-from'"
          [label]="t('complaints.from')"
          [value]="from()"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'filter-to'"
          [label]="t('complaints.to')"
          [value]="to()"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('complaints.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
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
          <div class="at-empty" [art]="'empty-complaints'" [text]="t('empty.complaints')"></div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.complaints')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template [atColumn]="'batch'" [header]="t('complaints.batch')" [primary]="true" let-x>
            <span
              class="at-table__primary"
              [href]="'/complaints/' + x.id"
              [code]="x.batch.publicCode"
              [sub]="x.batch.product.name"
            ></span>
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('complaints.status')" [status]="true" let-x>
            ${STATUS_CHIP('x.status')}
          </ng-template>
          <ng-template [atColumn]="'text'" [header]="t('complaints.text')" let-x>{{ x.text }}</ng-template>
          <ng-template
            [atColumn]="'decision'"
            [header]="t('complaints.decision')"
            [sortField]="'decidedAt'"
            let-x
          >
            @if (x.decision) {
              <span class="at-table__primary"
                ><span>{{ label('ComplaintDecisionType', x.decision) }}</span>
                @if (x.decidedAt) {
                  <span class="at-table__sub">{{ at(x.decidedAt) }}</span>
                }
              </span>
            } @else {
              —
            }
          </ng-template>
          <ng-template
            [atColumn]="'created'"
            [header]="t('complaints.createdAt')"
            [sortField]="'createdAt'"
            let-x
            >{{ at(x.createdAt) }}</ng-template
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
export class ComplaintsPage extends ComplaintView {
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly statuses = STATUSES;
  protected readonly decisions = DECISIONS;
  protected readonly rowKey = (x: Item) => x.id;
  protected readonly sortOptions = [
    { value: 'createdAt,desc', label: t('complaints.sort.created') },
    { value: 'decidedAt,desc', label: t('complaints.sort.decided') },
  ];
  private readonly session = inject(SessionService);
  protected readonly list = injectListParams('/complaints', SPEC);
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly q = this.p('q');
  protected readonly status = computed(() => this.list.params().getAll('status'));
  protected readonly decision = computed(() => this.list.params().getAll('decision'));
  protected readonly from = this.p('from');
  protected readonly to = this.p('to');
  protected readonly count = computed(
    () =>
      (this.status().length ? 1 : 0) +
      (this.decision().length ? 1 : 0) +
      [this.from(), this.to()].filter(Boolean).length,
  );
  protected readonly search = computed(() => ({
    label: t('complaints.search'),
    placeholder: t('complaints.searchPlaceholder'),
    value: this.q(),
  }));

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const decision = this.decision();
      const from = this.from();
      const to = this.to();
      return {
        key: `${COMPLAINTS_KEY}${JSON.stringify([page, sort, q, status, decision, from, to])}`,
        load: () =>
          call<Schemas['ComplaintPage']>(
            this.session.api.GET('/complaints', {
              params: {
                query: {
                  page,
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
      };
    },
    { failedText: t('complaints.failed') },
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

interface DecisionValues extends Record<string, unknown> {
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

@Component({
  selector: 'article.at-card[atDecision]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-card__body">
      <form novalidate style="${FORM_GRID}" (submit)="submit($event)">
        <fieldset
          class="at-field"
          [legend]="t('complaints.decision')"
          [error]="f.errorOf('decision')"
          [errorId]="'decision-error'"
        >
          @for (d of decisions; track d) {
            <label
              class="at-radio"
              [label]="label('ComplaintDecisionType', d)"
              [name]="'decision'"
              [value]="d"
              [checked]="f.valueOf('decision') === d"
              [invalid]="!!f.errorOf('decision')"
              [describedBy]="f.errorOf('decision') ? 'decision-error' : undefined"
              (picked)="f.control('decision').setValue($event)"
            ></label>
          }
        </fieldset>
        <div
          class="at-field"
          [fieldId]="'decision-comment'"
          [label]="t('complaints.comment')"
          [error]="f.errorOf('comment')"
        >
          <textarea class="at-textarea" rows="3" [formControl]="f.control('comment')"></textarea>
        </div>
        @if (f.valueOf('decision') === 'LAB_TEST') {
          <div
            class="at-field"
            [orgPicker]="'decision-lab'"
            [label]="t('complaints.labOrg')"
            [types]="labTypes"
            [value]="f.valueOf('labOrgId')"
            [error]="f.errorOf('labOrgId')"
            (valueChange)="f.control('labOrgId').setValue($event ?? '')"
          ></div>
        }
        @if (f.valueOf('decision') === 'RECALL') {
          <label
            class="at-check"
            [label]="t('complaints.blockUpstream')"
            [name]="'blockUpstream'"
            [checked]="f.valueOf('blockUpstream')"
            (toggled)="f.control('blockUpstream').setValue($event)"
          ></label>
        }
        <div>
          <button
            class="at-button"
            [type]="'submit'"
            [variant]="'primary'"
            [busy]="busy() && !confirming()"
            [disabled]="f.wait() > 0"
            [focusAfterWait]="f.wait()"
          >
            {{
              f.wait() > 0
                ? t('auth.retryIn', { seconds: f.wait() })
                : f.valueOf('decision')
                  ? t('complaints.submit.' + f.valueOf('decision'))
                  : t('action.decide')
            }}
          </button>
        </div>
      </form>
    </div>
    ${codeConfirmDialog({
      state: 'confirmCode',
      open: 'confirming() !== null',
      title: "t('complaints.confirmTitle', { code: code() })",
      code: 'code()',
      label: "t('complaints.submit.RECALL')",
      busy: 'busy()',
      wait: 'f.wait()',
      message: 'message()',
      close: 'closeConfirm()',
      confirm: 'confirm()',
      text: `<p style="margin: 0">{{ t('complaints.confirmText') }}</p>`,
    })}`,
})
export class DecisionComponent extends ComplaintView {
  protected readonly decisions = DECISIONS;
  protected readonly labTypes = ['LAB'] as Schemas['OrganizationType'][];
  readonly atDecision = input.required<Complaint>();
  readonly describe = input.required<(e: unknown) => string>();
  readonly done = output<Complaint>();
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly live = injectLive();
  readonly f = new SchemaForm<DecisionValues, Schemas['ComplaintDecision']>(
    decisionSchema,
    { decision: '', comment: '', labOrgId: '', blockUpstream: false },
    ['decision', 'comment', 'labOrgId', 'blockUpstream'],
  );
  protected readonly busy = signal(false);
  protected readonly confirming = signal<Schemas['ComplaintDecision'] | null>(null);
  private readonly failure = dialogAlert();
  protected readonly message = this.failure.message;
  protected readonly code = computed(() => this.atDecision().batch.publicCode);
  protected readonly confirmCode = new CodeConfirm(() => this.confirming() !== null);

  protected submit(e: Event): void {
    void this.f.submit(e, async (body) => {
      if (body.decision === 'RECALL') {
        this.failure.clear();
        this.confirming.set(body);
      } else await this.send(body);
    });
  }

  protected closeConfirm(): void {
    this.failure.handOff();
    this.confirming.set(null);
  }

  protected confirm(): void {
    const v = this.confirming();
    if (v) void this.send(v);
  }

  private async send(body: Schemas['ComplaintDecision']): Promise<void> {
    const complaint = this.atDecision();
    const code = complaint.batch.publicCode;
    const generation = this.session.generation;
    const inDialog = body.decision === 'RECALL';
    this.busy.set(true);
    this.failure.clear();
    this.f.alert.clear();
    try {
      const next = await call<Complaint>(
        this.session.api.POST('/complaints/{id}/decision', { params: { path: { id: complaint.id } }, body }),
      );
      if (generation !== this.session.generation) return;
      this.toasts.push({ tone: 'ok', text: t(`complaints.decided.${body.decision}`, { code }) });
      this.confirming.set(null);
      this.done.emit(next);
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.code === 'VALIDATION') {
        this.confirming.set(null);
        this.f.fail(e);
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) this.f.rateLimited(retryAfterOf(e));
      const text = this.describe()(e);
      if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
        this.confirming.set(null);
        this.toasts.push({ tone: 'danger', text });
        return;
      }
      if (inDialog) this.failure.show(text, errorTone(e));
      else this.f.alert.show(text, errorTone(e));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, DecisionComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!query.data() && missing()) {
      <div class="at-page__header" [pageTitle]="t('page.complaint')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('complaints.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/complaints'">{{ t('complaints.toList') }}</a>
        </div>
      </article>
    } @else {
      <div
        class="at-page__header"
        [pageTitle]="
          query.data() ? t('complaints.title', { code: query.data()!.batch.publicCode }) : t('page.complaint')
        "
      >
        @if (query.data(); as c) {
          @if (can().includes('review')) {
            <div class="at-page__actions">
              <button
                class="at-button"
                [variant]="'primary'"
                [busy]="reviewing()"
                [disabled]="reviewWait.left() > 0"
                [focusAfterWait]="reviewWait.left()"
                (click)="review(c)"
              >
                {{
                  reviewWait.left() > 0
                    ? t('auth.retryIn', { seconds: reviewWait.left() })
                    : t('complaints.review')
                }}
              </button>
            </div>
          }
        }
      </div>
      @if (!query.data() && query.failed()) {
        ${loadFailed("t('complaints.cardFailed')", 'query.fetching()', 'query.refetch()')}
      } @else if (!query.data()) {
        ${areaLoading(2)}
      } @else {
        <div style="${GAP}">
          <article class="at-card">
            <header class="at-card__header" [cardTitle]="query.data()!.batch.product.name">
              ${STATUS_CHIP('query.data()!.status', "'l'")}
            </header>
            <div class="at-card__body">
              <div style="${STACK}">
                <dl class="at-card__facts">
                  <div style="grid-column: 1 / -1">
                    <dt>{{ t('complaints.text') }}</dt>
                    <dd style="white-space: pre-line">{{ query.data()!.text }}</dd>
                  </div>
                  @if (query.data()!.decisionComment) {
                    <div style="grid-column: 1 / -1">
                      <dt>{{ t('complaints.comment') }}</dt>
                      <dd>{{ query.data()!.decisionComment }}</dd>
                    </div>
                  }
                </dl>
                <dl class="at-card__facts">
                  <div>
                    <dt>{{ t('complaints.batch') }}</dt>
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
                  @if (query.data()!.recallId; as r) {
                    <div>
                      <dt>{{ t('page.recall') }}</dt>
                      <dd>
                        <a [to]="'/recalls/' + r">{{ t('complaints.recallLink') }}</a>
                      </dd>
                    </div>
                  }
                  @if (query.data()!.labTestId) {
                    <div>
                      <dt>{{ t('recalls.labTest') }}</dt>
                      <dd>
                        <a [to]="'/batches/' + query.data()!.batch.id + '?tab=tests'">{{
                          t('complaints.labLink')
                        }}</a>
                      </dd>
                    </div>
                  }
                </dl>
              </div>
            </div>
          </article>
          @if (can().includes('decide')) {
            @for (id of [query.data()!.id]; track id) {
              <article
                class="at-card"
                [atDecision]="query.data()!"
                [describe]="describe"
                (done)="changed($event)"
              ></article>
            }
          }
        </div>
      }
    }`,
})
export class ComplaintPage extends ComplaintView {
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  private readonly id = computed(() => this.params().get('id') ?? '');
  protected readonly reviewing = signal(false);
  protected readonly reviewWait = countdown();

  protected readonly query = injectQuery(
    () => {
      const id = this.id();
      return {
        key: complaintKey(id),
        load: () => call<Complaint>(this.session.api.GET('/complaints/{id}', { params: { path: { id } } })),
      };
    },
    { failedText: t('complaints.cardFailed') },
  );
  protected readonly missing = computed(() => notFound(this.query.error()));
  protected readonly can = computed(() => {
    const c = this.query.data();
    return c ? complaintActions(c.status) : [];
  });
  protected readonly facts = computed<CardFact[]>(() => {
    const c = this.query.data();
    if (!c) return [];
    return [
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
    ];
  });

  private reread(): void {
    this.cache.invalidate(COMPLAINTS_KEY);
    if (!this.alive()) {
      this.cache.invalidate(complaintKey(this.id()));
      return;
    }
    void this.query.refetch().then(() =>
      setTimeout(() => {
        if (this.alive() && focusLost())
          document.querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')?.focus();
      }, 0),
    );
  }

  protected readonly describe = (e: unknown): string => {
    if (e instanceof ApiProblem && (e.code === 'INVALID_TRANSITION' || e.status === 404)) {
      this.reread();
      if (e.code === 'INVALID_TRANSITION')
        return t('complaints.stateChanged', {
          status: enumLabel(t, 'ComplaintStatus', String(e.params?.['from'] ?? '')),
        });
    }
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      this.reread();
      return t('complaints.versionConflict');
    }
    return errorText(e);
  };

  protected changed(next: Complaint): void {
    this.query.writer()(next);
    this.cache.invalidate(COMPLAINTS_KEY);
  }

  protected async review(c: Complaint): Promise<void> {
    const generation = this.session.generation;
    const write = this.query.writer();
    this.reviewing.set(true);
    try {
      const next = await call<Complaint>(
        this.session.api.POST('/complaints/{id}/review', { params: { path: { id: c.id } }, body: {} }),
      );
      if (generation !== this.session.generation) return;
      write(next);
      this.cache.invalidate(COMPLAINTS_KEY);
      this.toasts.push({ tone: 'ok', text: t('complaints.reviewed') });
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.status === 429) this.reviewWait.start(retryAfterOf(e));
      this.toasts.push({ tone: errorTone(e), text: this.describe(e) });
    } finally {
      if (this.alive()) this.reviewing.set(false);
    }
  }
}
