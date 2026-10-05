import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, newIdempotencyKey, withVariant, type Schemas } from '@agrotrace/api-client';
import { BATCH_STATUSES } from '@agrotrace/domain';
import {
  enumLabel,
  formatBytes,
  formatDate,
  formatDecimal,
  formatLocalDate,
  formatLocalDateTime,
  formatMass,
} from '@agrotrace/i18n';
import { BatchCreateSchema } from '@agrotrace/validation';
import { canAccess } from '../app/access';
import { injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { DateFilterComponent } from '../app/date-filter';
import { injectDictionary } from '../app/dictionaries';
import {
  errorTone,
  FocusAfterWaitDirective,
  dialogAlert,
  normalizeDecimal,
  SchemaForm,
  wireSchema,
} from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { LAB_STATUS_TONE } from '../app/lab-tests';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { momentCheck, momentDefaults, MomentInputComponent, momentWire } from '../app/moment';
import { OrgPickerComponent } from '../app/org-picker';
import { injectQuery, QueryCache } from '../app/query';
import { CABINET_ROUTES, matchPath } from '../app/routes';
import { SessionService } from '../app/session';
import {
  FullscreenOpenerDirective,
  injectFullscreen,
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type TimelineEntry,
  type Tone,
} from '../app/ui';
import { BatchGraphComponent } from '../graph/batch-graph';
import { BATCHES_KEY, batchKey, FIELDS_KEY } from './keys';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed, rolesOf } from './lists';

type Batch = Schemas['Batch'];
type BatchItem = Schemas['BatchListItem'];
type BatchStatus = Schemas['BatchStatus'];
type OrgRef = Schemas['OrganizationRef'];
type GraphNode = Schemas['BatchGraph']['nodes'][number];
const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';

const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const producedOf = (b: BatchItem) => b.harvestedAt ?? b.producedAt;

const BATCHES_SPEC: ListSpec = {
  sort: ['publicCode', 'massKg', 'updatedAt', 'harvestedAt', 'producedAt'],
  enums: { status: BATCH_STATUSES, kind: ['RAW', 'DERIVED'], holder: ['me'], origin: ['me'] },
  uuids: ['productId', 'orgId'],
  dates: ['from', 'to'],
  texts: ['q'],
};
const SEVERAL = '__several';

export const STATUS_TONE: Record<BatchStatus, Tone> = {
  Created: 'neutral',
  OnTest: 'attention',
  Approved: 'ok',
  InTransit: 'move',
  Accepted: 'ok',
  OnSale: 'ok',
  Processed: 'neutral',
  Sold: 'neutral',
  Blocked: 'danger',
  Recalled: 'danger-solid',
  WrittenOff: 'neutral',
};

const IMPORTS = [
  ...UI,
  ReactiveFormsModule,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  OrgPickerComponent,
  DateFilterComponent,
  MomentInputComponent,
  BatchGraphComponent,
  FullscreenOpenerDirective,
];

function mayOpen(me: Schemas['Me'] | null, href: string): boolean {
  if (!me) return false;
  const path = href.split('?')[0]!;
  const route = CABINET_ROUTES.find((r) => matchPath(r.path, path));
  return Boolean(route && canAccess(me, route.access));
}

function org(expr: string): string {
  return `<span style="display: inline-flex; align-items: center; gap: var(--sp-2)"
      ><span
        class="at-avatar"
        [name]="${expr}.name"
        [src]="logo(${expr})"
        [size]="'s'"
        [shape]="'square'"
        [decorative]="true"
      ></span
      >{{ ${expr}.name }}</span
    >`;
}

function tabFailed(text: string, q: string): string {
  return loadFailed(text, `${q}.fetching()`, `${q}.refetch()`);
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.batches')">
      @if (roles().farmer) {
        <div class="at-page__actions">
          <a class="at-button" [variant]="'primary'" [icon]="'plus'" [to]="'/batches/new'">{{
            t('action.createBatch')
          }}</a>
        </div>
      }
    </div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('batches.status')">
          <select class="at-select" (change)="list.set({ status: $any($event.target).value })">
            <option value="" [selected]="statusValue() === ''">{{ t('filters.any') }}</option>
            @if (status().length > 1) {
              <!-- prettier-ignore -->
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: status().length }) }}</option>
            }
            @for (s of statuses; track s) {
              <option [value]="s" [selected]="s === statusValue()">{{ label('BatchStatus', s) }}</option>
            }
          </select>
        </div>
        <div class="at-field" [fieldId]="'filter-product'" [label]="t('batches.product')">
          <select class="at-select" (change)="list.set({ productId: $any($event.target).value })">
            <option value="" [selected]="productId() === ''">{{ t('filters.any') }}</option>
            @for (p of products.data() ?? []; track p.id) {
              <option [value]="p.id" [selected]="p.id === productId()">{{ p.name }}</option>
            }
          </select>
        </div>
        <div class="at-field" [fieldId]="'filter-kind'" [label]="t('batches.kind')">
          <select class="at-select" (change)="list.set({ kind: $any($event.target).value })">
            <option value="" [selected]="kind() === ''">{{ t('filters.any') }}</option>
            @for (k of kinds; track k) {
              <option [value]="k" [selected]="k === kind()">{{ label('BatchKind', k) }}</option>
            }
          </select>
        </div>
        @if (roles().participant) {
          <div class="at-field" [fieldId]="'filter-holder'" [label]="t('batches.holder')">
            <select class="at-select" (change)="list.set({ holder: $any($event.target).value })">
              <option value="" [selected]="holder() === ''">{{ label('param:holder', 'all') }}</option>
              <option value="me" [selected]="holder() === 'me'">{{ label('param:holder', 'me') }}</option>
            </select>
          </div>
          <div class="at-field" [fieldId]="'filter-origin'" [label]="t('batches.origin')">
            <select class="at-select" (change)="list.set({ origin: $any($event.target).value })">
              <option value="" [selected]="origin() === ''">{{ label('param:origin', 'all') }}</option>
              <option value="me" [selected]="origin() === 'me'">{{ label('param:origin', 'me') }}</option>
            </select>
          </div>
        }
        @if (roles().overseer) {
          <div
            class="at-field"
            [orgPicker]="'filter-org'"
            [label]="t('batches.organization')"
            [value]="orgId()"
            (valueChange)="list.set({ orgId: $event })"
          ></div>
        }
        <div
          class="at-field"
          [dateFilter]="'filter-from'"
          [label]="t('batches.from')"
          [value]="from()"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'filter-to'"
          [label]="t('batches.to')"
          [value]="to()"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('batches.failed')", 'query.fetching()', 'retry()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'retry()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        @if (q() || count()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-batches'" [text]="t('empty.batches')">
            <a class="at-button" [variant]="'primary'" [to]="roles().farmer ? '/batches/new' : '/'">{{
              roles().farmer ? t('action.createBatch') : t('action.home')
            }}</a>
          </div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="display: grid; gap: var(--sp-4)">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions()"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.batches')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template
            [atColumn]="'code'"
            [header]="t('batches.code')"
            [primary]="true"
            [sortField]="'publicCode'"
            let-b
          >
            <span
              class="at-table__primary"
              [href]="'/batches/' + b.id"
              [code]="b.publicCode"
              [sub]="b.product.name"
            ></span>
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('batches.status')" [status]="true" let-b>
            <span class="at-chip" [status]="b.status"></span>
          </ng-template>
          <ng-template
            [atColumn]="'mass'"
            [header]="t('batches.mass')"
            [numeric]="true"
            [sortField]="'massKg'"
            let-b
            >{{ decimal(b.massKg) }}</ng-template
          >
          <ng-template [atColumn]="'holder'" [header]="t('batches.holder')" let-b>{{
            b.holder.name
          }}</ng-template>
          <ng-template
            [atColumn]="'produced'"
            [header]="t('batches.producedOn')"
            [sortField]="producedSort()"
            let-b
            >{{ produced(b) }}</ng-template
          >
          <ng-template
            [atColumn]="'updated'"
            [header]="t('batches.updatedAt')"
            [sortField]="'updatedAt'"
            let-b
            >{{ moment(b.updatedAt) }}</ng-template
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
export class BatchesPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly statuses = BATCH_STATUSES;
  protected readonly kinds = ['RAW', 'DERIVED'] as const;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  protected readonly moment = (iso: string) => formatLocalDateTime(iso, LOCALE);
  protected readonly produced = (b: BatchItem) => {
    const at = producedOf(b);
    return at ? formatLocalDate(at, LOCALE) : '—';
  };
  private readonly session = inject(SessionService);
  protected readonly roles = computed(() => rolesOf(this.session.me()?.roles));
  protected readonly list = injectListParams('/batches', BATCHES_SPEC);
  protected readonly products = injectDictionary('products');
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly q = this.p('q');
  protected readonly status = computed(() => this.list.params().getAll('status'));
  protected readonly statusValue = computed(() => {
    const s = this.status();
    return s.length === 1 ? s[0]! : s.length > 1 ? SEVERAL : '';
  });
  protected readonly productId = this.p('productId');
  protected readonly kind = this.p('kind');
  private readonly holderRaw = this.p('holder');
  private readonly originRaw = this.p('origin');
  private readonly orgIdRaw = this.p('orgId');
  protected readonly holder = computed(() => (this.roles().participant ? this.holderRaw() : ''));
  protected readonly origin = computed(() => (this.roles().participant ? this.originRaw() : ''));
  protected readonly orgId = computed(() => (this.roles().overseer ? this.orgIdRaw() : ''));
  protected readonly from = this.p('from');
  protected readonly to = this.p('to');
  protected readonly count = computed(
    () =>
      (this.status().length ? 1 : 0) +
      [
        this.productId(),
        this.kind(),
        this.holder(),
        this.origin(),
        this.orgId(),
        this.from(),
        this.to(),
      ].filter(Boolean).length,
  );
  protected readonly search = computed(() => ({
    label: t('batches.search'),
    placeholder: t('batches.searchPlaceholder'),
    value: this.q(),
  }));
  protected readonly producedSort = computed(() =>
    this.kind() === 'DERIVED' ? 'producedAt' : this.kind() === 'RAW' ? 'harvestedAt' : undefined,
  );
  protected readonly sortOptions = computed(() => {
    const produced = this.producedSort();
    return [
      { value: 'updatedAt,desc', label: t('batches.sort.updated') },
      { value: 'publicCode,asc', label: t('batches.sort.code') },
      { value: 'massKg,desc', label: t('batches.sort.massDesc') },
      { value: 'massKg,asc', label: t('batches.sort.massAsc') },
      ...(produced ? [{ value: `${produced},desc`, label: t('batches.sort.producedDesc') }] : []),
    ];
  });

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const f = {
        productId: this.productId(),
        kind: this.kind(),
        holder: this.holder(),
        origin: this.origin(),
        orgId: this.orgId(),
        from: this.from(),
        to: this.to(),
      };
      return {
        key: `${BATCHES_KEY}${JSON.stringify([page, sort, q, status, f])}`,
        load: () =>
          call<Schemas['BatchPage']>(
            this.session.api.GET('/batches', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(q ? { q } : {}),
                  ...(status.length ? { status: status as BatchStatus[] } : {}),
                  ...(f.productId ? { productId: f.productId } : {}),
                  ...(f.kind ? { kind: f.kind as Schemas['BatchKind'] } : {}),
                  ...(f.holder ? { holder: f.holder as 'me' | 'all' } : {}),
                  ...(f.origin ? { origin: f.origin as 'me' | 'all' } : {}),
                  ...(f.orgId ? { orgId: f.orgId } : {}),
                  ...(f.from ? { from: f.from } : {}),
                  ...(f.to ? { to: f.to } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('batches.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));
  protected readonly rowKey = (b: BatchItem) => b.id;

  constructor() {
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
  }

  protected retry(): void {
    void this.query.refetch();
  }
}

interface BatchValues extends Record<string, unknown> {
  fieldId: string;
  productId: string;
  massKg: string;
  harvestedAt: string | null;
  harvestTime: string;
  original: string | null;
}
const BATCH_FIELDS = ['fieldId', 'productId', 'massKg', 'harvestedAt', 'harvestTime'] as const;

const harvest = (v: BatchValues) => ({ date: v.harvestedAt, time: v.harvestTime, original: v.original });
const batchSchema = wireSchema<BatchValues>(
  BatchCreateSchema,
  (v) => ({
    fieldId: v.fieldId,
    productId: v.productId,
    massKg: normalizeDecimal(v.massKg, 3),
    harvestedAt: momentWire(harvest(v)),
  }),
  (v) => momentCheck(harvest(v), 'harvestedAt', 'harvestTime'),
);

@Component({
  selector: 'form[atBatchNew]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <div
      class="at-field"
      [fieldId]="'batch-field'"
      [label]="t('field.fieldId')"
      [error]="f.errorOf('fieldId')"
    >
      <select class="at-select" [formControl]="f.control('fieldId')">
        <option value="" disabled>{{ t('ui.choose') }}</option>
        @for (fl of atBatchNew(); track fl.id) {
          <option [value]="fl.id">{{ fl.name }}</option>
        }
      </select>
    </div>
    <div
      class="at-field"
      [fieldId]="'batch-product'"
      [label]="t('field.productId')"
      [error]="f.errorOf('productId')"
    >
      <select class="at-select" [formControl]="f.control('productId')">
        <option value="" disabled>{{ t('ui.choose') }}</option>
        @for (p of products(); track p.id) {
          <option [value]="p.id">{{ p.name }}</option>
        }
      </select>
    </div>
    <div
      class="at-field"
      [fieldId]="'batch-mass'"
      [label]="t('batches.massValue')"
      [error]="f.errorOf('massKg')"
    >
      <div class="at-input-group" [suffix]="t('unit.kg')">
        <input class="at-input" inputmode="decimal" autocomplete="off" [formControl]="f.control('massKg')" />
      </div>
    </div>
    <div
      [atMoment]="'batch-harvested'"
      [form]="f"
      [dateName]="'harvestedAt'"
      [timeName]="'harvestTime'"
      [dateLabel]="t('field.harvestedAt')"
      [timeLabel]="t('batches.harvestTime')"
    ></div>
    <div>
      <button
        class="at-button"
        [type]="'submit'"
        [variant]="'primary'"
        [busy]="f.busy()"
        [disabled]="f.wait() > 0"
        [focusAfterWait]="f.wait()"
      >
        {{ f.wait() > 0 ? t('auth.retryIn', { seconds: f.wait() }) : t('action.createBatch') }}
      </button>
    </div>`,
  host: { id: 'batch-new', novalidate: '', style: FORM_GRID, '(submit)': 'f.submit($event, send)' },
})
export class BatchNewFormComponent implements OnInit {
  protected readonly t = t;
  readonly atBatchNew = input.required<Schemas['Field'][]>();
  readonly products = input.required<Schemas['Product'][]>();
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly live = injectLive();
  private readonly wanted = inject(ActivatedRoute).snapshot.queryParamMap.get('fieldId') ?? '';
  readonly f = new SchemaForm<BatchValues, Schemas['BatchCreate']>(
    batchSchema,
    {
      fieldId: '',
      productId: '',
      massKg: '',
      harvestedAt: momentDefaults(null).date,
      harvestTime: momentDefaults(null).time,
      original: null,
    },
    BATCH_FIELDS,
  );

  ngOnInit(): void {
    if (this.atBatchNew().some((fl) => fl.id === this.wanted))
      this.f.control('fieldId').setValue(this.wanted);
  }

  protected readonly send = async (body: Schemas['BatchCreate']): Promise<void> => {
    const generation = this.session.generation;
    let batch: Batch;
    try {
      batch = await call<Batch>(this.session.api.POST('/batches', { body }));
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.code === 'NO_LAB_AVAILABLE') this.f.alert.show(t('batches.noLab'));
      else this.f.fail(e);
      return;
    }
    if (generation !== this.session.generation) return;
    this.cache.put(batchKey(batch.id), batch, generation);
    this.cache.invalidate(BATCHES_KEY);
    this.cache.invalidate(FIELDS_KEY);
    this.toasts.push(
      batch.testRequired
        ? {
            tone: 'attention',
            text: t('batches.createdTest', {
              code: batch.publicCode,
              reason: enumLabel(t, 'TestReason', batch.testReason),
            }),
          }
        : { tone: 'ok', text: t('batches.createdNoTest', { code: batch.publicCode }) },
    );
    if (this.live(generation)) void this.router.navigateByUrl(`/batches/${batch.id}`);
  };
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, BatchNewFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.batchNew')"></div>
    @if (fields.data()?.items?.length === 0) {
      <article class="at-card">
        <div class="at-empty" [art]="'empty-fields'" [text]="t('empty.fields')">
          <a class="at-button" [variant]="'primary'" [to]="'/fields/new'">{{ t('fields.add') }}</a>
        </div>
      </article>
    } @else if (failed()) {
      ${loadFailed("t('batches.formFailed')", 'fields.fetching() || products.fetching()', 'retry()')}
    } @else if (fields.data() && products.data()) {
      <article class="at-card" style="max-width: 40rem">
        <div class="at-card__body"><form [atBatchNew]="fields.data()!.items" [products]="raw()"></form></div>
      </article>
    } @else {
      ${areaLoading(2)}
    }`,
})
export class BatchNewPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  protected readonly products = injectDictionary('products');
  protected readonly fields = injectQuery(
    () => ({
      key: `${FIELDS_KEY}all`,
      load: () =>
        call<Schemas['FieldPage']>(
          this.session.api.GET('/fields', { params: { query: { size: 100, sort: 'name,asc' } } }),
        ),
    }),
    { failedText: t('batches.formFailed') },
  );
  protected readonly failed = computed(
    () => (!this.fields.data() && this.fields.failed()) || (!this.products.data() && this.products.failed()),
  );
  protected readonly raw = computed(() =>
    (this.products.data() ?? []).filter((p) => p.category !== 'PROCESSED'),
  );

  protected retry(): void {
    void this.fields.refetch();
    void this.products.refetch();
  }
}

const TABS = ['history', 'path', 'graph', 'tests', 'docs'] as const;
type Tab = (typeof TABS)[number];

const ACTION_TARGET: Record<string, (b: Batch) => string> = {
  ship: (b) => `/waybills/new?batchId=${b.id}`,
  accept: () => '/waybills?direction=incoming',
  reject: () => '/waybills?direction=incoming',
  process: (b) => `/processing/new?batchId=${b.id}`,
  putOnSale: () => '/stock',
  sell: () => '/stock',
  recall: (b) => `/recalls/new?batchId=${b.id}`,
  writeOff: () => '/recall-tasks',
};

const VSD_TONE: Record<Schemas['VsdImportStatus'], Tone> = {
  PENDING: 'move',
  IMPORTED: 'ok',
  NOT_FOUND: 'attention',
  FAILED: 'danger',
};

interface Fact {
  key: string;
  term: string;
  text?: string;
  org?: OrgRef;
  link?: { href: string; text: string };
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!query.data() && missing()) {
      <div class="at-page__header" [pageTitle]="t('page.batch')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('batches.notFound')">
          @if (may('/batches')) {
            <a class="at-button" [variant]="'primary'" [to]="'/batches'">{{ t('batches.toList') }}</a>
          } @else {
            <a class="at-button" [variant]="'primary'" [to]="'/'">{{ t('action.home') }}</a>
          }
        </div>
      </article>
    } @else {
      <div class="at-page__header" [pageTitle]="query.data()?.publicCode ?? t('page.batch')">
        @if (query.data() && (actions().length > 0 || inspector())) {
          <div class="at-page__actions">
            @for (a of actions(); track a.action; let first = $first) {
              <a class="at-button" [variant]="first ? 'primary' : 'secondary'" [to]="a.href">{{ a.label }}</a>
            }
            @if (inspector()) {
              <button
                class="at-button"
                [variant]="'secondary'"
                [icon]="'flask'"
                (click)="assigning.set(true)"
              >
                {{ t('lab.assign') }}
              </button>
            }
          </div>
        }
      </div>
      @if (!query.data() && query.failed()) {
        ${loadFailed("t('batches.failed')", 'query.fetching()', 'query.refetch()')}
      } @else if (!query.data()) {
        ${areaLoading(2)}
      } @else {
        <div style="${GAP}">
          <article class="at-card">
            <header class="at-card__header" [cardTitle]="query.data()!.product.name">
              <span class="at-chip" [status]="query.data()!.status" [size]="'l'"></span>
            </header>
            <div class="at-card__body">
              <div style="display: flex; gap: var(--sp-5); align-items: flex-start; flex-wrap: wrap">
                @if (query.data()!.product.imageUrl; as image) {
                  <span
                    class="at-avatar"
                    [name]="query.data()!.product.name"
                    [src]="variant(image)"
                    [size]="'l'"
                    [shape]="'square'"
                    [decorative]="true"
                  ></span>
                }
                <div style="flex: 1 1 16rem; min-width: 0">
                  <dl class="at-card__facts">
                    @for (f of facts(); track f.key) {
                      <div>
                        <dt>{{ f.term }}</dt>
                        <dd>
                          @if (f.org; as o) {
                            ${org('o')}
                          } @else if (f.link) {
                            <a [to]="f.link.href">{{ f.link.text }}</a>
                          } @else {
                            {{ f.text }}
                          }
                        </dd>
                      </div>
                    }
                  </dl>
                </div>
              </div>
            </div>
          </article>
          <div
            class="at-tabs"
            [label]="t('batches.tabs', { code: query.data()!.publicCode })"
            [tabs]="tabs"
            [selected]="tab()"
            (select)="showTab($event)"
          >
            <ng-template [atTabPanel]="'history'">
              @if (!history.data() && history.failed()) {
                ${tabFailed("t('batches.historyFailed')", 'history')}
              } @else if (!history.data()) {
                ${areaLoading(1)}
              } @else {
                <article class="at-card">
                  <div class="at-card__body">
                    <ol class="at-timeline" [items]="historyItems()">
                      <ng-template #meta let-it>
                        @if (historyOf(it.key); as h) {
                          @if (h.changedBy; as by) {
                            <span
                              class="at-avatar"
                              [name]="by.fullName"
                              [src]="by.avatarUrl ? variant(by.avatarUrl) : null"
                              [size]="'s'"
                              [decorative]="true"
                            ></span>
                          }
                          {{ reason(h.reason) }}, {{ h.changedBy?.fullName ?? t('batches.system') }}
                        }
                      </ng-template>
                    </ol>
                  </div>
                </article>
              }
            </ng-template>
            <ng-template [atTabPanel]="'path'">
              @if (!path.data() && path.failed()) {
                ${tabFailed("t('batches.pathFailed')", 'path')}
              } @else if (!path.data()) {
                ${areaLoading(1)}
              } @else {
                <article class="at-card">
                  <div class="at-card__body">
                    <ol class="at-timeline" [items]="pathItems()">
                      <ng-template #meta let-it>
                        @if (stepOf(it.key); as s) {
                          <span
                            class="at-avatar"
                            [name]="s.org.name"
                            [src]="logo(s.org)"
                            [size]="'s'"
                            [shape]="'square'"
                            [decorative]="true"
                          ></span
                          >{{ orgType(s.org.type) }}
                          @if (s.waybillNumber) {
                            , {{ byWaybill(s.waybillNumber) }}
                          }
                        }
                      </ng-template>
                    </ol>
                  </div>
                </article>
              }
            </ng-template>
            <ng-template [atTabPanel]="'graph'">
              @if (!graph.data() && graph.failed()) {
                ${tabFailed("t('graph.failed')", 'graph')}
              } @else if (!graph.data()) {
                ${areaLoading(1)}
              } @else {
                <div style="${GAP}">
                  @if (graphFs.wide() || graphFs.full()) {
                    <div
                      class="at-graph"
                      [atBatchGraph]="graph.data()!"
                      [code]="query.data()!.publicCode"
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
                  <div
                    class="at-table-wrap"
                    [cards]="true"
                    [caption]="t('graph.related')"
                    [rows]="graph.data()!.nodes"
                    [rowKey]="nodeKey"
                  >
                    <ng-template [atColumn]="'code'" [header]="t('batches.code')" [primary]="true" let-n>
                      @if (n.accessible && n.id !== query.data()!.id) {
                        <span
                          class="at-table__primary"
                          [href]="'/batches/' + n.id + '?tab=graph'"
                          [code]="n.publicCode"
                          [sub]="n.product.name"
                        ></span>
                      } @else if (n.accessible) {
                        <span class="at-table__primary"
                          ><span class="at-mono">{{ n.publicCode }}</span
                          ><span class="at-table__sub">{{ n.product.name }}</span></span
                        >
                      } @else {
                        <span class="at-table__primary"
                          ><a class="at-mono" [attr.href]="'/p/' + n.publicCode">{{ n.publicCode }}</a
                          ><span class="at-table__sub">{{ n.product.name }}, {{ noAccess }}</span></span
                        >
                      }
                    </ng-template>
                    <ng-template [atColumn]="'status'" [header]="t('batches.status')" [status]="true" let-n>
                      <span class="at-chip" [status]="n.status"></span>
                    </ng-template>
                    <ng-template [atColumn]="'holder'" [header]="t('batches.holder')" let-n>{{
                      n.holder.name
                    }}</ng-template>
                    <ng-template [atColumn]="'link'" [header]="t('graph.link')" let-n>{{
                      relation(n)
                    }}</ng-template>
                    <ng-template [atColumn]="'used'" [header]="t('graph.used')" [numeric]="true" let-n>{{
                      used(n)
                    }}</ng-template>
                  </div>
                </div>
              }
            </ng-template>
            <ng-template [atTabPanel]="'tests'">
              @if (!tests.data() && tests.failed()) {
                ${tabFailed("t('labTests.failed')", 'tests')}
              } @else if (!tests.data()) {
                ${areaLoading(1)}
              } @else if (tests.data()!.items.length === 0) {
                <article class="at-card">
                  <div class="at-empty" [art]="'empty-lab'" [text]="t('labTests.empty')"></div>
                </article>
              } @else {
                <div
                  class="at-table-wrap"
                  [cards]="true"
                  [caption]="t('batches.tab.tests')"
                  [rows]="tests.data()!.items"
                  [rowKey]="testKey"
                >
                  <ng-template [atColumn]="'lab'" [header]="t('labTests.lab')" [primary]="true" let-x>
                    <span class="at-table__primary">
                      @if (may('/lab/tests/x')) {
                        <a [to]="'/lab/tests/' + x.id">{{ x.lab.name }}</a>
                      } @else {
                        <span>{{ x.lab.name }}</span>
                      }
                      <span class="at-table__sub">{{ label('LabTestReason', x.reason) }}</span></span
                    >
                  </ng-template>
                  <ng-template [atColumn]="'status'" [header]="t('labTests.status')" [status]="true" let-x>
                    <span class="at-chip" [tone]="labTone(x.status)">{{
                      label('LabTestStatus', x.status)
                    }}</span>
                  </ng-template>
                  <ng-template [atColumn]="'conclusion'" [header]="t('labTests.conclusion')" let-x>
                    @if (x.conclusion) {
                      <span class="at-chip" [tone]="x.conclusion === 'PASS' ? 'ok' : 'danger'">{{
                        label('LabConclusion', x.conclusion)
                      }}</span>
                    } @else {
                      —
                    }
                  </ng-template>
                  <ng-template [atColumn]="'due'" [header]="t('labTests.dueAt')" let-x
                    >{{ moment(x.completedAt ?? x.dueAt) }}
                    @if (x.overdue) {
                      {{ ' ' }}<span class="at-chip" [tone]="'danger'">{{ t('labTests.overdue') }}</span>
                    }
                  </ng-template>
                </div>
              }
            </ng-template>
            <ng-template [atTabPanel]="'docs'">
              @if (!docs.data() && docs.failed()) {
                ${tabFailed("t('documents.failed')", 'docs')}
              } @else if (!docs.data()) {
                ${areaLoading(1)}
              } @else if (!docs.data()!.vsd && docs.data()!.labProtocols.length === 0 && !docs.data()!.qr) {
                <article class="at-card">
                  <div class="at-empty" [art]="'empty-batches'" [text]="t('documents.empty')"></div>
                </article>
              } @else {
                <div
                  style="${GAP}; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); align-items: start"
                >
                  @if (docs.data()!.vsd; as vsd) {
                    <article class="at-card">
                      <header class="at-card__header" [cardTitle]="t('documents.vsd')">
                        <span class="at-chip" [tone]="vsdTone(vsd.importStatus)">{{
                          label('VsdImportStatus', vsd.importStatus)
                        }}</span>
                      </header>
                      <div class="at-card__body">
                        <dl class="at-card__facts">
                          @if (vsd.document; as doc) {
                            <div>
                              <dt>{{ t('documents.number') }}</dt>
                              <dd>
                                <span class="at-mono">{{ doc.number }}</span>
                              </dd>
                            </div>
                            <div>
                              <dt>{{ t('documents.issueDate') }}</dt>
                              <dd>{{ date(doc.issueDate) }}</dd>
                            </div>
                            <div>
                              <dt>{{ t('documents.vsdStatus') }}</dt>
                              <dd>{{ label('VsdStatus', doc.status) }}</dd>
                            </div>
                            <div>
                              <dt>{{ t('documents.product') }}</dt>
                              <dd>{{ doc.productName }}</dd>
                            </div>
                            <div>
                              <dt>{{ t('documents.volume') }}</dt>
                              <dd>{{ volume(doc.volume) }}</dd>
                            </div>
                            <div>
                              <dt>{{ t('documents.consignor') }}</dt>
                              <dd>{{ doc.consignor.name }}</dd>
                            </div>
                            <div>
                              <dt>{{ t('documents.consignee') }}</dt>
                              <dd>{{ doc.consignee.name }}</dd>
                            </div>
                          } @else {
                            <div>
                              <dt>{{ t('documents.attempts') }}</dt>
                              <dd>{{ vsd.attempts }}</dd>
                            </div>
                            <div>
                              <dt>{{ t('batches.updatedAt') }}</dt>
                              <dd>{{ moment(vsd.updatedAt) }}</dd>
                            </div>
                          }
                        </dl>
                      </div>
                      @if (holder() && (vsd.importStatus === 'NOT_FOUND' || vsd.importStatus === 'FAILED')) {
                        <footer class="at-card__footer">
                          <button
                            class="at-button"
                            [variant]="'primary'"
                            [busy]="retrying()"
                            [disabled]="vsdWait.left() > 0"
                            [focusAfterWait]="vsdWait.left()"
                            (click)="retryVsd()"
                          >
                            {{
                              vsdWait.left() > 0
                                ? t('auth.retryIn', { seconds: vsdWait.left() })
                                : t('documents.retry')
                            }}
                          </button>
                        </footer>
                      }
                    </article>
                  }
                  @if (docs.data()!.labProtocols.length > 0) {
                    <article class="at-card">
                      <header class="at-card__header" [cardTitle]="t('documents.protocols')"></header>
                      <div class="at-card__body">
                        <ul style="display: grid; gap: var(--sp-4); margin: 0; padding: 0; list-style: none">
                          @for (p of docs.data()!.labProtocols; track p.labTestId) {
                            <li style="display: grid; gap: var(--sp-2)">
                              <span>{{ p.lab.name }}</span>
                              <span
                                style="display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center"
                              >
                                @if (p.conclusion) {
                                  <span class="at-chip" [tone]="p.conclusion === 'PASS' ? 'ok' : 'danger'">{{
                                    label('LabConclusion', p.conclusion)
                                  }}</span>
                                }
                                @if (p.completedAt) {
                                  {{ day(p.completedAt) }}
                                }
                              </span>
                              <span
                                ><a
                                  class="at-button"
                                  [size]="'s'"
                                  [icon]="'file-pdf'"
                                  [attr.href]="p.file.url"
                                  [attr.download]="p.file.originalName"
                                  >{{ p.file.originalName }}, {{ bytes(p.file.sizeBytes) }}</a
                                ></span
                              >
                            </li>
                          }
                        </ul>
                      </div>
                    </article>
                  }
                  @if (docs.data()!.qr; as qr) {
                    <article class="at-card">
                      <header class="at-card__header" [cardTitle]="t('documents.qr')"></header>
                      <div class="at-card__body">
                        <dl class="at-card__facts">
                          <div>
                            <dt>{{ t('documents.publicPage') }}</dt>
                            <dd>
                              <a [attr.href]="qr.publicUrl" style="overflow-wrap: anywhere">{{
                                qr.publicUrl
                              }}</a>
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <footer class="at-card__footer">
                        <a
                          class="at-button"
                          [icon]="'download'"
                          [attr.href]="qr.pngUrl"
                          [attr.download]="query.data()!.publicCode + '.png'"
                          >{{ t('documents.png') }}</a
                        >
                        <a
                          class="at-button"
                          [icon]="'file-pdf'"
                          [attr.href]="qr.pdfUrl"
                          [attr.download]="query.data()!.publicCode + '.pdf'"
                          >{{ t('documents.pdf') }}</a
                        >
                      </footer>
                    </article>
                  }
                </div>
              }
            </ng-template>
          </div>
        </div>
      }
      @if (query.data() && inspector()) {
        <dialog
          class="at-dialog"
          [open]="assigning()"
          [dialogTitle]="t('lab.assignTitle', { code: query.data()!.publicCode })"
          (closed)="closeAssign()"
        >
          <div style="display: grid; gap: var(--sp-4)">
            @if (assignFailure.message()) {
              <p class="at-field__error" role="alert" style="margin: 0">{{ assignFailure.message() }}</p>
            }
            <div
              class="at-field"
              [orgPicker]="'assign-lab'"
              [label]="t('field.labOrgId')"
              [types]="labTypes"
              [value]="labOrgId()"
              [error]="labError()"
              (valueChange)="labOrgId.set($event ?? ''); labError.set(null)"
            ></div>
          </div>
          <div class="at-dialog__actions">
            <button class="at-button" [variant]="'ghost'" (click)="closeAssign()">
              {{ t('action.cancel') }}
            </button>
            <button
              class="at-button"
              [variant]="'primary'"
              [busy]="assignBusy()"
              [disabled]="assignWait.left() > 0"
              [focusAfterWait]="assignWait.left()"
              (click)="assign(query.data()!)"
            >
              {{
                assignWait.left() > 0 ? t('auth.retryIn', { seconds: assignWait.left() }) : t('lab.assign')
              }}
            </button>
          </div>
        </dialog>
      }
    }`,
})
export class BatchPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly live = injectLive();
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.paramMap, { requireSync: true });
  private readonly queryParams = toSignal(this.route.queryParamMap, { requireSync: true });
  private readonly id = computed(() => this.params().get('id') ?? '');
  protected readonly tab = computed<Tab>(() => {
    const v = this.queryParams().get('tab') ?? '';
    return (TABS as readonly string[]).includes(v) ? (v as Tab) : 'history';
  });
  protected readonly tabs = TABS.map((id) => ({ id, label: t(`batches.tab.${id}`) }));
  protected readonly noAccess = t('graph.noAccess').toLocaleLowerCase('ru');

  protected readonly label = (name: string, v: string | null | undefined) => enumLabel(t, name, v ?? '');
  protected readonly moment = (iso: string) => formatLocalDateTime(iso, LOCALE);
  protected readonly day = (iso: string) => formatLocalDate(iso, LOCALE);
  protected readonly date = (iso: string) => formatDate(iso, LOCALE);
  protected readonly bytes = (n: number) => formatBytes(n, LOCALE);
  protected readonly volume = (v: { value: number; unit: string }) =>
    `${formatDecimal(String(v.value), LOCALE)} ${v.unit}`;
  protected readonly variant = (url: string) => withVariant(url, 96);
  protected readonly logo = (o: OrgRef) => (o.logoUrl ? withVariant(o.logoUrl, 96) : null);
  protected readonly reason = (r: string) => enumLabel(t, 'BatchStatusReason', r);
  protected readonly orgType = (type: string) => enumLabel(t, 'OrganizationType', type);
  protected readonly byWaybill = (number: string) => t('batches.byWaybill', { number });
  protected readonly labTone = (s: Schemas['LabTestStatus']) => LAB_STATUS_TONE[s];
  protected readonly vsdTone = (s: Schemas['VsdImportStatus']) => VSD_TONE[s];
  protected readonly nodeKey = (n: GraphNode) => n.id;
  protected readonly testKey = (x: Schemas['LabTestListItem']) => x.id;
  protected readonly may = (href: string) => mayOpen(this.session.me(), href);

  protected readonly query = injectQuery(
    () => {
      const id = this.id();
      return {
        key: batchKey(id),
        load: () => call<Batch>(this.session.api.GET('/batches/{id}', { params: { path: { id } } })),
      };
    },
    { failedText: t('batches.failed') },
  );
  protected readonly missing = computed(() => notFound(this.query.error()));
  protected readonly actions = computed(() => {
    const b = this.query.data();
    if (!b) return [];
    return b.actions
      .map((a) => ({
        action: a.action,
        href: ACTION_TARGET[a.action]?.(b),
        label: enumLabel(t, 'BatchActionName', a.action),
      }))
      .flatMap((x) => (x.href && this.may(x.href) ? [{ ...x, href: x.href }] : []));
  });
  protected readonly facts = computed<Fact[]>(() => {
    const b = this.query.data();
    if (!b) return [];
    return [
      { key: 'product', term: t('batches.product'), text: b.product.name },
      { key: 'mass', term: t('batches.massValue'), text: formatMass(b.massKg, LOCALE) },
      { key: 'holder', term: t('batches.holder'), org: b.holder },
      ...(b.origin.id !== b.holder.id ? [{ key: 'origin', term: t('batches.origin'), org: b.origin }] : []),
      ...(b.field
        ? [
            this.may('/fields/x')
              ? {
                  key: 'field',
                  term: t('batches.field'),
                  link: { href: `/fields/${b.field.id}`, text: b.field.name },
                }
              : { key: 'field', term: t('batches.field'), text: b.field.name },
          ]
        : []),
      b.harvestedAt
        ? { key: 'date', term: t('batches.harvestedAt'), text: formatLocalDateTime(b.harvestedAt, LOCALE) }
        : {
            key: 'date',
            term: t('batches.producedAt'),
            text: b.producedAt ? formatLocalDateTime(b.producedAt, LOCALE) : '—',
          },
      { key: 'kind', term: t('batches.kind'), text: enumLabel(t, 'BatchKind', b.kind) },
      ...(b.kind === 'RAW'
        ? [{ key: 'test', term: t('batches.test'), text: enumLabel(t, 'TestReason', b.testReason) }]
        : []),
    ];
  });

  private tabQuery<T>(which: Tab, key: string, load: (id: string) => Promise<T>, failed: string) {
    return injectQuery<T>(
      () => {
        if (!this.query.data() || this.tab() !== which) return null;
        const id = this.id();
        return { key: `${batchKey(id)}:${key}`, load: () => load(id) };
      },
      { failedText: failed },
    );
  }

  protected readonly history = this.tabQuery(
    'history',
    'history',
    (id) =>
      call<Schemas['StatusHistoryItem'][]>(
        this.session.api.GET('/batches/{id}/history', { params: { path: { id } } }),
      ),
    t('batches.historyFailed'),
  );
  protected readonly path = this.tabQuery(
    'path',
    'path',
    (id) =>
      call<Schemas['PathStep'][]>(this.session.api.GET('/batches/{id}/path', { params: { path: { id } } })),
    t('batches.pathFailed'),
  );
  protected readonly graph = this.tabQuery(
    'graph',
    'graph',
    (id) =>
      call<Schemas['BatchGraph']>(
        this.session.api.GET('/batches/{id}/graph', { params: { path: { id }, query: { depth: 2 } } }),
      ),
    t('graph.failed'),
  );
  protected readonly tests = this.tabQuery(
    'tests',
    'tests',
    (id) =>
      call<Schemas['LabTestPage']>(
        this.session.api.GET('/lab-tests', {
          params: { query: { batchId: id, size: 100, sort: 'dueAt,asc' } },
        }),
      ),
    t('labTests.failed'),
  );
  protected readonly docs = this.tabQuery(
    'docs',
    'documents',
    (id) =>
      call<Schemas['BatchDocuments']>(
        this.session.api.GET('/batches/{id}/documents', { params: { path: { id } } }),
      ),
    t('documents.failed'),
  );

  protected readonly historyItems = computed<TimelineEntry[]>(() =>
    (this.history.data() ?? []).map((h, i) => ({
      key: String(i),
      at: h.changedAt,
      atText: formatLocalDateTime(h.changedAt, LOCALE),
      title: enumLabel(t, 'BatchStatus', h.to),
      tone: STATUS_TONE[h.to],
    })),
  );
  protected readonly historyOf = (key: string) => this.history.data()?.[Number(key)];
  protected readonly pathItems = computed<TimelineEntry[]>(() =>
    (this.path.data() ?? []).map((s, i) => ({
      key: String(i),
      at: s.from,
      atText: s.to
        ? t('batches.period', { from: formatLocalDate(s.from, LOCALE), to: formatLocalDate(s.to, LOCALE) })
        : t('batches.since', { date: formatLocalDate(s.from, LOCALE) }),
      title: s.org.name,
    })),
  );
  protected readonly stepOf = (key: string) => this.path.data()?.[Number(key)];

  protected readonly graphFs = injectFullscreen();
  protected readonly relation = (n: GraphNode) =>
    n.depth === 0
      ? t('graph.root')
      : n.depth < 0
        ? t('graph.up', { level: -n.depth })
        : t('graph.down', { level: n.depth });
  protected readonly used = (n: GraphNode) => {
    const edges = this.graph.data()?.edges ?? [];
    const edge = edges.find((e) => (n.depth < 0 ? e.parent === n.id : e.child === n.id));
    return n.depth !== 0 && edge ? formatDecimal(edge.massUsedKg, LOCALE) : '—';
  };

  protected readonly holder = computed(() => {
    const me = this.session.me();
    const b = this.query.data();
    return Boolean(
      me &&
      b &&
      me.organization.id === b.holder.id &&
      me.roles.some((r) => r === 'FARMER' || r === 'PROCESSOR'),
    );
  });
  protected readonly retrying = signal(false);
  protected readonly vsdWait = countdown();
  private idempotency: string | null = null;

  constructor() {
    effect(
      () => {
        if (this.assigning()) return;
        untracked(() => {
          this.labOrgId.set('');
          this.labError.set(null);
          this.assignFailure.clear();
        });
      },
      { allowSignalWrites: true },
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    effect((onCleanup) => {
      const pending = this.docs.data()?.vsd?.importStatus === 'PENDING';
      if (!pending) return;
      timer = setTimeout(() => void this.docs.refetch(), 3000);
      onCleanup(() => {
        if (timer) clearTimeout(timer);
      });
    });
  }

  protected readonly inspector = computed(() => Boolean(this.session.me()?.roles.includes('INSPECTOR')));
  protected readonly labTypes = ['LAB'] as Schemas['OrganizationType'][];
  protected readonly assigning = signal(false);
  protected readonly labOrgId = signal('');
  protected readonly labError = signal<string | null>(null);
  protected readonly assignFailure = dialogAlert();
  protected readonly assignBusy = signal(false);
  protected readonly assignWait = countdown();

  protected closeAssign(): void {
    this.assignFailure.handOff();
    this.assigning.set(false);
  }

  protected async assign(b: Batch): Promise<void> {
    const labOrgId = this.labOrgId();
    if (!labOrgId) {
      this.labError.set(t('validation.required'));
      return;
    }
    const generation = this.session.generation;
    this.assignBusy.set(true);
    this.assignFailure.clear();
    try {
      const test = await call<Schemas['LabTest']>(
        this.session.api.POST('/lab-tests', { body: { batchId: b.id, labOrgId } }),
      );
      this.cache.invalidate(`${batchKey(b.id)}:tests`);
      if (generation === this.session.generation)
        this.toasts.push({ tone: 'ok', text: t('lab.assigned', { code: b.publicCode, lab: test.lab.name }) });
      if (!this.live(generation)) return;
      this.assigning.set(false);
      if (this.tab() === 'tests') void this.tests.refetch();
      else this.showTab('tests');
    } catch (e) {
      if (!this.live(generation)) return;
      const key =
        e instanceof ApiProblem && e.code === 'VALIDATION' ? e.errors?.['labOrgId']?.[0] : undefined;
      if (key) this.labError.set(t(key));
      else {
        if (e instanceof ApiProblem && e.status === 429) this.assignWait.start(retryAfterOf(e));
        this.assignFailure.show(errorText(e), errorTone(e));
      }
    } finally {
      this.assignBusy.set(false);
    }
  }
  protected showTab(next: string): void {
    const q = new URLSearchParams();
    const current = this.queryParams();
    for (const k of current.keys) for (const v of current.getAll(k)) q.append(k, v);
    if (next === 'history') q.delete('tab');
    else q.set('tab', next);
    const s = q.toString();
    void this.router.navigateByUrl(`/batches/${this.id()}${s ? `?${s}` : ''}`, { replaceUrl: true });
  }

  protected async retryVsd(): Promise<void> {
    const b = this.query.data();
    if (!b) return;
    const generation = this.session.generation;
    const write = this.docs.writer();
    this.retrying.set(true);
    this.idempotency ??= newIdempotencyKey();
    try {
      const vsd = await call<Schemas['BatchVsd']>(
        this.session.api.POST('/batches/{id}/documents/vsd/retry', {
          params: { path: { id: b.id }, header: { 'Idempotency-Key': this.idempotency } },
        }),
      );
      this.idempotency = null;
      const current = this.docs.data();
      if (current) write({ ...current, vsd });
      if (generation === this.session.generation)
        this.toasts.push({ tone: 'ok', text: t('documents.retried') });
    } catch (e) {
      if (e instanceof ApiProblem && e.status === 429) this.vsdWait.start(retryAfterOf(e));
      else if (e instanceof ApiProblem && e.status < 500) {
        this.idempotency = null;
        if (e.status === 409) this.cache.invalidate(`${batchKey(b.id)}:documents`);
      }
      if (this.live(generation)) {
        this.toasts.push({ tone: errorTone(e), text: errorText(e) });
        if (e instanceof ApiProblem && e.status === 409) void this.docs.refetch();
      }
    } finally {
      this.retrying.set(false);
    }
  }
}
