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
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { availableActions, canUseAsInput, checkMassBalance, compareDecimalStrings } from '@agrotrace/domain';
import { enumLabel, formatDecimal, formatLocalDate, formatLocalDateTime, formatMass } from '@agrotrace/i18n';
import { ProcessingRequestSchema } from '@agrotrace/validation';
import { injectAlive, injectLive } from '../app/alive';
import { call, errorText } from '../app/api';
import { injectDictionary } from '../app/dictionaries';
import { dialogAlert, errorTone, FocusAfterWaitDirective, normalizeDecimal } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { injectListParams, isBadListQuery, listGap, type ListParams, type ListSpec } from '../app/list-state';
import { ManualForm } from '../app/manual-form';
import { injectQuery, QueryCache, type Query } from '../app/query';
import { SessionService } from '../app/session';
import {
  injectWide,
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type CardFact,
} from '../app/ui';
import { QrComponent } from '../app/ui/qr';
import { BATCH_PREFIX, BATCHES_KEY, batchKey } from './keys';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type BatchItem = Schemas['BatchListItem'];
type Batch = Schemas['Batch'];
type BatchStatus = Schemas['BatchStatus'];
type QrLinks = Schemas['QrLinks'];
const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';
const MASS = /^\d{1,9}\.\d{3}$/;
const SEVERAL = '__several';

const massText = (kg: string) => (LOCALE === 'ru' ? kg.replace('.', ',') : kg);

function rolesOf(roles: readonly string[] | undefined) {
  const has = (r: string) => (roles ?? []).includes(r);
  return { processor: has('PROCESSOR'), retailer: has('RETAILER') };
}

function stockStatuses(processor: boolean, retailer: boolean): BatchStatus[] {
  const out = new Set<BatchStatus>();
  if (processor) (['Approved', 'Accepted'] as const).forEach((s) => out.add(s));
  if (retailer) (['Accepted', 'OnSale'] as const).forEach((s) => out.add(s));
  return [...out];
}

function qrStatuses(processor: boolean): BatchStatus[] {
  return processor ? ['Accepted', 'OnSale', 'Approved'] : ['Accepted', 'OnSale'];
}

const IMPORTS = [...UI, FocusAfterWaitDirective, PageToolbarComponent, ToolbarFiltersDirective];

interface OwnBatches {
  list: ListParams;
  query: Query<Schemas['BatchPage']>;
  q: () => string;
  chosen: () => string[];
  statusValue: () => string;
  productId: () => string;
  gap: () => 'pastEnd' | 'changed' | null;
  badQuery: () => boolean;
  count: () => number;
}

function injectOwnBatches(key: string, statuses: BatchStatus[], spec: ListSpec, path: string): OwnBatches {
  const session = inject(SessionService);
  const list = injectListParams(path, spec);
  const q = computed(() => list.params().get('q') ?? '');
  const chosen = computed(() =>
    list
      .params()
      .getAll('status')
      .filter((s) => statuses.includes(s as BatchStatus)),
  );
  const productId = computed(() => list.params().get('productId') ?? '');
  const query = injectQuery(
    () => {
      const page = list.page();
      const sort = list.sort();
      const text = q();
      const status = chosen();
      const product = productId();
      return {
        key: `${BATCHES_KEY}${key}:${JSON.stringify([page, sort, text, status, product, statuses])}`,
        load: () =>
          call<Schemas['BatchPage']>(
            session.api.GET('/batches', {
              params: {
                query: {
                  holder: 'me',
                  status: (status.length ? status : statuses) as BatchStatus[],
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(text ? { q: text } : {}),
                  ...(product ? { productId: product } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('stock.failed') },
  );
  const gap = computed(() => {
    const d = query.data();
    return d ? listGap(d, list.page(), SIZE) : null;
  });
  effect(() => {
    const d = query.data();
    if (d && d.items.length === 0 && d.total > 0) untracked(() => list.clampPage(d.total, SIZE));
  });
  return {
    list,
    query,
    q,
    chosen,
    statusValue: computed(() => {
      const s = chosen();
      return s.length === 1 ? s[0]! : s.length > 1 ? SEVERAL : '';
    }),
    productId,
    gap,
    badQuery: computed(() => isBadListQuery(query.error())),
    count: computed(() => (chosen().length ? 1 : 0) + (productId() ? 1 : 0)),
  };
}

function ownList(failed: string, empty: string, emptyAction: string, rows: string): string {
  return `@if (!own.query.data() && own.query.failed()) {
      ${loadFailed(failed, 'own.query.fetching()', 'own.query.refetch()', 'own.badQuery()', 'own.list.reset()')}
    } @else if (!own.query.data() || own.gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (own.gap() === 'changed') {
      ${listChanged('own.query.fetching()', 'own.query.refetch()')}
    } @else if (own.query.data()!.items.length === 0) {
      <article class="at-card">
        @if (own.q() || own.count()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="own.list.reset()">{{ t('filters.reset') }}</button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-batches'" [text]="${empty}">${emptyAction}</div>
        }
      </article>
    } @else {
      ${rows}
    }`;
}

const STATUS_FILTER = `<div class="at-field" [fieldId]="'filter-status'" [label]="t('batches.status')">
          <select class="at-select" (change)="own.list.set({ status: $any($event.target).value })">
            <option value="" [selected]="own.statusValue() === ''">{{ t('filters.any') }}</option>
            @if (own.chosen().length > 1) {
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: own.chosen().length }) }}</option>
            }
            @for (s of statuses; track s) {
              <option [value]="s" [selected]="s === own.statusValue()">{{ label('BatchStatus', s) }}</option>
            }
          </select>
        </div>`;

const CODE_COLUMN = `<ng-template [atColumn]="'code'" [header]="t('batches.code')" [primary]="true" [sortField]="'publicCode'" let-b>
            <span class="at-table__primary" [href]="'/batches/' + b.id" [code]="b.publicCode" [sub]="b.product.name"></span>
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('batches.status')" [status]="true" let-b>
            <span class="at-chip" [status]="b.status"></span>
          </ng-template>`;

type Transition = 'putOnSale' | 'sell';

const STOCK_SPEC: ListSpec = {
  sort: ['publicCode', 'massKg', 'updatedAt'],
  enums: { status: ['Approved', 'Accepted', 'OnSale'] },
  uuids: ['productId'],
  texts: ['q'],
};

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.stock')">
      @if (roles.processor) {
        <div class="at-page__actions">
          <a class="at-button" [variant]="'primary'" [icon]="'factory'" [to]="'/processing/new'">{{
            t('processing.submit')
          }}</a>
        </div>
      }
    </div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="own.count()"
      (searchChange)="own.list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        ${STATUS_FILTER}
        <div class="at-field" [fieldId]="'filter-product'" [label]="t('batches.product')">
          <select class="at-select" (change)="own.list.set({ productId: $any($event.target).value })">
            <option value="" [selected]="own.productId() === ''">{{ t('filters.any') }}</option>
            @for (p of products.data() ?? []; track p.id) {
              <option [value]="p.id" [selected]="p.id === own.productId()">{{ p.name }}</option>
            }
          </select>
        </div>
      </ng-template>
    </div>
    ${ownList(
      "t('stock.failed')",
      "t('stock.empty')",
      `<a class="at-button" [variant]="'primary'" [to]="'/waybills?direction=incoming'">{{ t('waybillDirection.incoming') }}</a>`,
      `<div [attr.aria-busy]="own.query.fetching() ? 'true' : null" style="display: grid; gap: var(--sp-4)">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.stock')"
          [rows]="own.query.data()!.items"
          [rowKey]="rowKey"
          [sort]="own.list.sort()"
          (sortChange)="own.list.setSort($event)"
        >
          ${CODE_COLUMN}
          <ng-template [atColumn]="'mass'" [header]="t('batches.mass')" [numeric]="true" [sortField]="'massKg'" let-b>{{
            decimal(b.massKg)
          }}</ng-template>
          <ng-template [atColumn]="'origin'" [header]="t('batches.origin')" let-b>{{ b.origin.name }}</ng-template>
          <ng-template [atColumn]="'updated'" [header]="t('batches.updatedAt')" [sortField]="'updatedAt'" let-b>{{
            moment(b.updatedAt)
          }}</ng-template>
          <ng-template atRowActions let-b>
            @if (roles.processor && allowed(b, 'process')) {
              <a class="at-button" [size]="'s'" [variant]="'primary'" [to]="'/processing/new?batchId=' + b.id">{{
                action('process')
              }}</a>
            }
            @if (roles.processor && allowed(b, 'ship')) {
              <a class="at-button" [size]="'s'" [to]="'/waybills/new?batchId=' + b.id">{{ action('ship') }}</a>
            }
            @if (roles.retailer) {
              @for (a of transitions; track a) {
                @if (allowed(b, a)) {
                  <button
                    class="at-button"
                    [size]="'s'"
                    [variant]="a === 'putOnSale' ? 'primary' : 'secondary'"
                    [busy]="busy() === b.id"
                    (click)="run(b, a)"
                  >
                    {{ action(a) }}
                  </button>
                }
              }
            }
          </ng-template>
        </div>
        <nav
          class="at-pagination"
          [page]="own.list.page()"
          [size]="size"
          [total]="own.query.data()!.total"
          [hrefFor]="own.list.hrefFor"
        ></nav>
      </div>`,
    )}`,
})
export class StockPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly transitions: Transition[] = ['putOnSale', 'sell'];
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly action = (a: string) => enumLabel(t, 'BatchActionName', a);
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  protected readonly moment = (iso: string) => formatLocalDateTime(iso, LOCALE);
  protected readonly rowKey = (b: BatchItem) => b.id;
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  protected readonly roles = rolesOf(this.session.me()?.roles);
  protected readonly statuses = stockStatuses(this.roles.processor, this.roles.retailer);
  protected readonly own = injectOwnBatches('stock', this.statuses, STOCK_SPEC, '/stock');
  protected readonly products = injectDictionary('products');
  protected readonly busy = signal<string | null>(null);
  protected readonly search = computed(() => ({
    label: t('stock.search'),
    placeholder: t('stock.searchPlaceholder'),
    value: this.own.q(),
  }));
  protected readonly sortOptions = [
    { value: 'updatedAt,desc', label: t('batches.sort.updated') },
    { value: 'publicCode,asc', label: t('batches.sort.code') },
    { value: 'massKg,desc', label: t('batches.sort.massDesc') },
    { value: 'massKg,asc', label: t('batches.sort.massAsc') },
  ];
  protected readonly allowed = (b: BatchItem, a: string) =>
    availableActions(b.status).some((x) => x.action === a);

  private reread(): void {
    this.cache.invalidate(BATCHES_KEY);
    this.cache.invalidate(BATCH_PREFIX);
    if (this.alive()) void this.own.query.refetch();
  }

  protected async run(row: BatchItem, action: Transition): Promise<void> {
    const generation = this.session.generation;
    const code = row.publicCode;
    this.busy.set(row.id);
    try {
      const batch = await call<Batch>(
        this.session.api.GET('/batches/{id}', { params: { path: { id: row.id } } }),
      );
      if (!batch.actions.some((a) => a.action === action)) {
        this.reread();
        if (this.live(generation))
          this.toasts.push({ tone: 'danger', text: t('stock.unavailable', { code }) });
        return;
      }
      const params = { path: { id: row.id }, header: { 'If-Match': batch.version } };
      const next = await call<Batch>(
        action === 'putOnSale'
          ? this.session.api.POST('/batches/{id}/on-sale', { params })
          : this.session.api.POST('/batches/{id}/sold', { params }),
      );
      this.cache.put(batchKey(next.id), next, generation);
      this.reread();
      if (generation === this.session.generation)
        this.toasts.push({
          tone: 'ok',
          text: t(action === 'putOnSale' ? 'stock.putOnSale' : 'stock.sold', { code }),
        });
    } catch (e) {
      if (e instanceof ApiProblem && (e.code === 'VERSION_CONFLICT' || e.code === 'INVALID_TRANSITION')) {
        this.reread();
        if (this.live(generation)) this.toasts.push({ tone: 'danger', text: t('stock.changed', { code }) });
      } else {
        if (e instanceof ApiProblem && (e.status === 404 || e.status === 403)) this.reread();
        if (this.live(generation)) this.toasts.push({ tone: errorTone(e), text: errorText(e) });
      }
    } finally {
      if (this.alive()) this.busy.set(null);
    }
  }
}

const STEPS = ['inputs', 'outputs', 'balance'] as const;
const MAX_OUTPUTS = 20;

interface OutputRow {
  key: number;
  productId: string;
  massKg: string;
}

interface ProcValues {
  picked: string[];
  used: Record<string, string>;
  outputs: OutputRow[];
}

const isInputPath = (p: string) => p === 'picked' || p.startsWith('used.');
const isOutputPath = (p: string) => p.startsWith('outputs.');

@Component({
  selector: 'form[atProcessing]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ol
      class="at-stepper"
      [label]="t('processing.steps')"
      [steps]="stepLabels"
      [current]="current()"
    ></ol>
    @for (n of shownSteps(); track $index) {
      <article class="at-card">
        <header class="at-card__header">
          <h2 class="at-card__title" tabindex="-1">{{ t('processing.step.' + steps[n]) }}</h2>
        </header>
        <div class="at-card__body">
          @switch (steps[n]) {
            @case ('inputs') {
              <div style="${FORM_GRID}">
                @if (f.errorOf('picked'); as error) {
                  <p class="at-field__error" id="processing-inputs-error" role="alert">{{ error }}</p>
                }
                <div class="at-table-mobilebar" [table]="inputs"></div>
                <div
                  class="at-table-wrap"
                  #inputs="atTable"
                  [cards]="true"
                  [caption]="t('processing.step.inputs')"
                  [rows]="atProcessing()"
                  [rowKey]="rowKey"
                  [selection]="selection()"
                  (selectionChange)="pick($event)"
                >
                  <ng-template [atColumn]="'code'" [header]="t('batches.code')" [primary]="true" let-b>
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
                    [atColumn]="'available'"
                    [header]="t('processing.available')"
                    [numeric]="true"
                    let-b
                    >{{ decimal(b.massKg) }}</ng-template
                  >
                  <ng-template [atColumn]="'used'" [header]="t('field.massUsedKg')" let-b>
                    <div class="at-field" [cellId]="'used-' + b.id" [error]="f.errorOf('used.' + b.id)">
                      <div class="at-input-group" [suffix]="t('unit.kg')">
                        <input
                          class="at-input"
                          inputmode="decimal"
                          autocomplete="off"
                          [attr.aria-label]="t('processing.usedOf', { code: b.publicCode })"
                          [disabled]="!f.values().picked.includes(b.id)"
                          [value]="f.values().used[b.id] ?? ''"
                          (input)="setUsed(b.id, $any($event.target).value)"
                        />
                      </div>
                    </div>
                  </ng-template>
                </div>
              </div>
            }
            @case ('outputs') {
              <div style="${GAP}">
                @for (row of f.values().outputs; track row.key; let i = $index) {
                  <div
                    style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: start"
                  >
                    <div
                      class="at-field"
                      [fieldId]="'output-' + i + '-product'"
                      [label]="t('processing.productOf', { n: i + 1 })"
                      [error]="f.errorOf('outputs.' + i + '.productId')"
                    >
                      <select
                        class="at-select"
                        (change)="setOutput(i, 'productId', $any($event.target).value)"
                      >
                        <!-- prettier-ignore -->
                        <option value="" disabled [selected]="row.productId === ''">{{ t('ui.choose') }}</option>
                        @for (p of products(); track p.id) {
                          <option [value]="p.id" [selected]="p.id === row.productId">{{ p.name }}</option>
                        }
                      </select>
                    </div>
                    <div style="display: flex; gap: var(--sp-2); align-items: flex-end">
                      <div style="flex: 1; min-width: 0">
                        <div
                          class="at-field"
                          [fieldId]="'output-' + i + '-mass'"
                          [label]="t('processing.massOf', { n: i + 1 })"
                          [error]="f.errorOf('outputs.' + i + '.massKg')"
                        >
                          <div class="at-input-group" [suffix]="t('unit.kg')">
                            <input
                              class="at-input"
                              inputmode="decimal"
                              autocomplete="off"
                              [value]="row.massKg"
                              (input)="setOutput(i, 'massKg', $any($event.target).value)"
                            />
                          </div>
                        </div>
                      </div>
                      @if (f.values().outputs.length > 1) {
                        <button
                          class="at-button"
                          [variant]="'ghost'"
                          [iconOnly]="true"
                          [icon]="'close'"
                          [attr.aria-label]="t('processing.removeOutput', { n: i + 1 })"
                          (click)="removeOutput(i)"
                        ></button>
                      }
                    </div>
                  </div>
                }
                @if (f.values().outputs.length < maxOutputs) {
                  <div>
                    <button class="at-button" [icon]="'plus'" (click)="addOutput()">
                      {{ t('processing.addOutput') }}
                    </button>
                  </div>
                }
              </div>
            }
            @case ('balance') {
              @if (balance(); as b) {
                <div style="${FORM_GRID}">
                  <dl class="at-card__facts" [facts]="balanceFacts()"></dl>
                  <div aria-live="polite">
                    @if (b.ok) {
                      <!-- prettier-ignore -->
                      <p style="margin: 0">{{ t('processing.balanceOk', { allowedKg: mass(b.allowedKg) }) }}</p>
                    } @else {
                      <!-- prettier-ignore -->
                      <p class="at-field__warning">{{ t('rules.BR-04', { outputKg: mass(b.outputKg), allowedKg: mass(b.allowedKg), inputKg: mass(b.inputKg) }) }}</p>
                    }
                  </div>
                </div>
              } @else {
                <p style="margin: 0">{{ t('processing.chooseInputs') }}</p>
              }
            }
          }
        </div>
        @if (!wide() || n === steps.length - 1) {
          <footer class="at-card__footer">
            @if (!wide() && n > 0) {
              <button class="at-button" [variant]="'ghost'" (click)="goTo(n - 1)">
                {{ t('processing.back') }}
              </button>
            }
            @if (n === steps.length - 1) {
              <button
                class="at-button"
                [type]="'submit'"
                [attr.form]="'processing'"
                [variant]="'primary'"
                [busy]="f.busy()"
                [disabled]="f.wait() > 0"
                [focusAfterWait]="f.wait()"
              >
                {{ f.wait() > 0 ? t('auth.retryIn', { seconds: f.wait() }) : t('processing.submit') }}
              </button>
            } @else {
              <button class="at-button" [variant]="'primary'" (click)="next()">
                {{ t('processing.next') }}
              </button>
            }
          </footer>
        }
      </article>
    }`,
  host: { id: 'processing', novalidate: '', style: GAP, '(submit)': 'submit($event)' },
})
export class ProcessingWizardComponent implements OnInit {
  protected readonly t = t;
  protected readonly steps = STEPS;
  protected readonly stepLabels = STEPS.map((s) => t(`processing.step.${s}`));
  protected readonly maxOutputs = MAX_OUTPUTS;
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  protected readonly mass = (kg: string) => formatMass(kg, LOCALE);
  protected readonly rowKey = (b: BatchItem) => b.id;
  readonly atProcessing = input.required<BatchItem[]>();
  readonly products = input.required<Schemas['Product'][]>();
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly live = injectLive();
  private readonly wanted = inject(ActivatedRoute).snapshot.queryParamMap.get('batchId') ?? '';
  protected readonly wide = injectWide();
  protected readonly step = signal(0);
  private nextKey = 1;
  private sentInputs: string[] = [];

  readonly f = new ManualForm<ProcValues>({ picked: [], used: {}, outputs: [] }, (v) => this.check(v));
  protected readonly selection = computed(() => ({
    selected: new Set(this.f.values().picked),
    allLabel: t('processing.pickAll'),
    rowLabel: (b: BatchItem) => t('processing.pick', { code: b.publicCode }),
    errorId: this.f.errorOf('picked') ? 'processing-inputs-error' : null,
  }));
  protected readonly shownSteps = computed(() => (this.wide() ? [0, 1, 2] : [this.step()]));
  protected readonly current = computed(() => {
    if (!this.wide()) return this.step();
    const v = this.f.values();
    const done = [
      v.picked.length > 0,
      v.outputs.every((o) => o.productId && MASS.test(normalizeDecimal(o.massKg, 3))),
    ];
    return done[0] ? (done[1] ? 2 : 1) : 0;
  });

  protected readonly balance = computed(() => {
    const v = this.f.values();
    const loss = new Map(this.products().map((p) => [p.id, p.lossNormPercent]));
    const ins = this.atProcessing()
      .filter((b) => v.picked.includes(b.id))
      .map((b) => ({
        massUsedKg: normalizeDecimal(v.used[b.id] ?? '', 3),
        lossNormPercent: loss.get(b.product.id) ?? '0.00',
      }))
      .filter((i) => MASS.test(i.massUsedKg));
    const outs = v.outputs
      .map((o) => ({ massKg: normalizeDecimal(o.massKg, 3) }))
      .filter((o) => MASS.test(o.massKg));
    const r = checkMassBalance({ inputs: ins, outputs: outs.length ? outs : [{ massKg: '0.000' }] });
    return 'error' in r ? null : r;
  });
  protected readonly balanceFacts = computed<CardFact[]>(() => {
    const b = this.balance();
    if (!b) return [];
    return [
      { key: 'in', term: t('processing.input'), value: this.mass(b.inputKg) },
      { key: 'allowed', term: t('processing.allowed'), value: this.mass(b.allowedKg) },
      { key: 'out', term: t('processing.outputTotal'), value: this.mass(b.outputKg) },
    ];
  });

  ngOnInit(): void {
    const batches = this.atProcessing();
    this.f.values.set({
      picked: batches.some((b) => b.id === this.wanted) ? [this.wanted] : [],
      used: Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)])),
      outputs: [{ key: this.nextKey++, productId: '', massKg: '' }],
    });
  }

  private toBody(v: ProcValues) {
    return {
      inputs: this.atProcessing()
        .filter((b) => v.picked.includes(b.id))
        .map((b) => ({ batchId: b.id, massUsedKg: normalizeDecimal(v.used[b.id] ?? '', 3) })),
      outputs: v.outputs.map((o) => ({ productId: o.productId, massKg: normalizeDecimal(o.massKg, 3) })),
    };
  }

  private check(v: ProcValues): Record<string, string> {
    const body = this.toBody(v);
    const errors: Record<string, string> = {};
    if (body.inputs.length === 0) errors['picked'] = 'processing.chooseInputs';
    for (const i of body.inputs)
      if ((v.used[i.batchId] ?? '').trim() === '') errors[`used.${i.batchId}`] = 'validation.required';
    v.outputs.forEach((o, n) => {
      if (!o.productId) errors[`outputs.${n}.productId`] = 'validation.required';
      if (o.massKg.trim() === '') errors[`outputs.${n}.massKg`] = 'validation.required';
    });
    const res = ProcessingRequestSchema.safeParse({
      ...body,
      outputs: body.outputs.map((o) => ({ ...o, productId: o.productId || undefined })),
    });
    for (const issue of res.success ? [] : res.error.issues) {
      const [head, index, leaf] = issue.path;
      if (typeof index !== 'number' || typeof leaf !== 'string') continue;
      if (head === 'inputs') errors[`used.${body.inputs[index]!.batchId}`] ??= issue.message;
      else if (head === 'outputs') errors[`outputs.${index}.${leaf}`] ??= issue.message;
    }
    for (const i of body.inputs) {
      const b = this.atProcessing().find((x) => x.id === i.batchId);
      if (
        !errors[`used.${i.batchId}`] &&
        b &&
        MASS.test(i.massUsedKg) &&
        compareDecimalStrings(i.massUsedKg, b.massKg) > 0
      )
        errors[`used.${i.batchId}`] = 'validation.mass.exceedsBatch';
    }
    return errors;
  }

  protected pick(next: Set<string>): void {
    const ids = this.atProcessing()
      .map((b) => b.id)
      .filter((id) => next.has(id));
    this.f.update((v) => ({ ...v, picked: ids }), 'picked');
  }

  protected setUsed(id: string, text: string): void {
    this.f.update((v) => ({ ...v, used: { ...v.used, [id]: text } }), `used.${id}`);
  }

  protected setOutput(n: number, field: 'productId' | 'massKg', value: string): void {
    this.f.update(
      (v) => ({ ...v, outputs: v.outputs.map((o, i) => (i === n ? { ...o, [field]: value } : o)) }),
      `outputs.${n}.${field}`,
    );
  }

  protected addOutput(): void {
    this.f.update((v) => ({
      ...v,
      outputs: [...v.outputs, { key: this.nextKey++, productId: '', massKg: '' }],
    }));
  }

  protected removeOutput(n: number): void {
    this.f.update((v) => ({ ...v, outputs: v.outputs.filter((_, i) => i !== n) }));
  }

  protected goTo(n: number): void {
    this.step.set(n);
    afterNextRender(
      () => this.host.querySelector<HTMLElement>('h2.at-card__title')?.focus({ preventScroll: false }),
      {
        injector: this.injector,
      },
    );
  }

  protected next(): void {
    const n = this.step();
    if (this.f.valid(n === 0 ? isInputPath : isOutputPath)) this.goTo(n + 1);
    else this.f.focusFirstInvalid(this.host);
  }

  protected submit(e: Event): void {
    void this.f.submit(
      e,
      async (v) => {
        const body = this.toBody(v) as Schemas['ProcessingRequest'];
        this.sentInputs = body.inputs.map((i) => i.batchId);
        const generation = this.session.generation;
        let result: Schemas['ProcessingResult'];
        try {
          result = await call<Schemas['ProcessingResult']>(this.session.api.POST('/processing', { body }));
        } catch (err) {
          if (!this.live(generation)) return;
          const ids = this.sentInputs;
          this.f.fail(
            err,
            [
              'picked',
              ...ids.map((id) => `used.${id}`),
              ...v.outputs.flatMap((_, n) => [`outputs.${n}.productId`, `outputs.${n}.massKg`]),
            ],
            (path) => {
              const inputIdx = /^inputs\[(\d+)\]\./.exec(path);
              const id = inputIdx ? ids[Number(inputIdx[1])] : undefined;
              if (id) return `used.${id}`;
              const output = /^outputs\[(\d+)\]\.(productId|massKg)$/.exec(path);
              if (output) return `outputs.${output[1]}.${output[2]}`;
              return path === 'inputs' ? 'picked' : path;
            },
          );
          if (!this.wide() && this.f.serverError(isInputPath)) this.goTo(0);
          else if (!this.wide() && this.f.serverError(isOutputPath)) this.goTo(1);
          return;
        }
        if (generation !== this.session.generation) return;
        for (const b of result.outputs) this.cache.put(batchKey(b.id), b, generation);
        this.cache.invalidate(BATCHES_KEY);
        this.cache.invalidate(BATCH_PREFIX);
        this.toasts.push({
          tone: 'ok',
          text: t('processing.done', {
            count: result.outputs.length,
            codes: result.outputs.map((b) => b.publicCode).join(', '),
          }),
        });
        if (this.live(generation)) void this.router.navigateByUrl(`/batches/${result.outputs[0]!.id}`);
      },
      (errors) => {
        if (!this.wide()) this.goTo(Object.keys(errors).some(isInputPath) ? 0 : 1);
      },
    );
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, ProcessingWizardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.processing')"></div>
    @if (failed()) {
      ${loadFailed("t('processing.formFailed')", 'inputs.fetching() || products.fetching()', 'retry()')}
    } @else if (!inputs.data() || !products.data()) {
      ${areaLoading(2)}
    } @else if (eligible().length === 0) {
      <article class="at-card">
        <div class="at-empty" [art]="'empty-batches'" [text]="t('processing.noInputs')">
          <a class="at-button" [variant]="'primary'" [to]="'/waybills?direction=incoming'">{{
            t('waybillDirection.incoming')
          }}</a>
        </div>
      </article>
    } @else {
      <form [atProcessing]="eligible()" [products]="products.data()!"></form>
    }`,
})
export class ProcessingPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  protected readonly products = injectDictionary('products');
  protected readonly inputs = injectQuery(
    () => ({
      key: `${BATCHES_KEY}processable`,
      load: () =>
        call<Schemas['BatchPage']>(
          this.session.api.GET('/batches', {
            params: {
              query: { holder: 'me', status: ['Approved', 'Accepted'], size: 100, sort: 'publicCode,asc' },
            },
          }),
        ),
    }),
    { failedText: t('processing.formFailed') },
  );
  protected readonly eligible = computed(() =>
    (this.inputs.data()?.items ?? []).filter((b) => canUseAsInput({ status: b.status }).allowed),
  );
  protected readonly failed = computed(
    () => (!this.inputs.data() && this.inputs.failed()) || (!this.products.data() && this.products.failed()),
  );

  protected retry(): void {
    void this.inputs.refetch();
    void this.products.refetch();
  }
}

const QR_SPEC: ListSpec = {
  sort: ['publicCode', 'updatedAt'],
  enums: { status: ['Approved', 'Accepted', 'OnSale'] },
  texts: ['q'],
};

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, QrComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.qr')"></div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="own.count()"
      (searchChange)="own.list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>${STATUS_FILTER}</ng-template>
    </div>
    ${ownList(
      "t('qr.failed')",
      "t('qr.empty')",
      `<a class="at-button" [variant]="'primary'" [to]="'/stock'">{{ t('nav.stock') }}</a>`,
      `<div [attr.aria-busy]="own.query.fetching() ? 'true' : null" style="display: grid; gap: var(--sp-4)">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.qr')"
          [rows]="own.query.data()!.items"
          [rowKey]="rowKey"
          [sort]="own.list.sort()"
          (sortChange)="own.list.setSort($event)"
        >
          ${CODE_COLUMN}
          <ng-template [atColumn]="'qr'" [header]="t('qr.state')" let-b>{{ qrState(b) }}</ng-template>
          <ng-template [atColumn]="'updated'" [header]="t('batches.updatedAt')" [sortField]="'updatedAt'" let-b>{{
            moment(b.updatedAt)
          }}</ng-template>
          <ng-template atRowActions let-b>
            @if (b.qrGeneratedAt) {
              <button
                class="at-button"
                [size]="'s'"
                [icon]="'download'"
                [attr.aria-label]="t('qr.downloadOf', { code: b.publicCode })"
                (click)="shown.set({ batch: b, links: null })"
              >
                {{ t('qr.download') }}
              </button>
            } @else {
              <button
                class="at-button"
                [size]="'s'"
                [variant]="'primary'"
                [icon]="'qr'"
                [busy]="busy() === b.id"
                [attr.aria-label]="t('qr.generateOf', { code: b.publicCode })"
                (click)="generate(b)"
              >
                {{ t('action.generateQr') }}
              </button>
            }
          </ng-template>
        </div>
        <nav
          class="at-pagination"
          [page]="own.list.page()"
          [size]="size"
          [total]="own.query.data()!.total"
          [hrefFor]="own.list.hrefFor"
        ></nav>
      </div>`,
    )}
    <dialog
      class="at-dialog"
      [open]="shown() !== null"
      [lightDismiss]="true"
      [dialogTitle]="shown() ? t('qr.title', { code: shown()!.batch.publicCode }) : ''"
      (closed)="closeQr()"
    >
      @if (shown(); as s) {
        @if (qrFailure.message()) {
          <p class="at-field__error" role="alert" style="margin: 0">{{ qrFailure.message() }}</p>
        }
        @if (qrOf(s); as qr) {
          <div style="display: grid; gap: var(--sp-4); justify-items: start">
            <span
              [qr]="qr.publicUrl"
              [label]="t('qr.image', { code: s.batch.publicCode, url: qr.publicUrl })"
            ></span>
            <a [attr.href]="qr.publicUrl" style="overflow-wrap: anywhere">{{ qr.publicUrl }}</a>
            <div style="display: flex; flex-wrap: wrap; gap: var(--sp-3)">
              <a
                class="at-button"
                [icon]="'download'"
                [attr.href]="qr.pngUrl"
                [attr.download]="s.batch.publicCode + '.png'"
                >{{ t('qr.png') }}</a
              >
              <a
                class="at-button"
                [icon]="'file-pdf'"
                [attr.href]="qr.pdfUrl"
                [attr.download]="s.batch.publicCode + '.pdf'"
                >{{ t('qr.pdf') }}</a
              >
            </div>
          </div>
        } @else if (!s.links && !docs.data() && !docs.failed()) {
          ${areaLoading(1)}
        } @else {
          <p style="margin: 0">{{ t('qr.linksFailed') }}</p>
        }
      }
      @if (shown() && !shown()!.links) {
        <div class="at-dialog__actions">
          <button
            class="at-button"
            [busy]="busy() === shown()!.batch.id"
            (click)="generate(shown()!.batch, true)"
          >
            {{ t('qr.regenerate') }}
          </button>
        </div>
      }
    </dialog>`,
})
export class QrPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly moment = (iso: string) => formatLocalDateTime(iso, LOCALE);
  protected readonly rowKey = (b: BatchItem) => b.id;
  protected readonly qrState = (b: BatchItem) =>
    b.qrGeneratedAt
      ? t('qr.generatedAt', { date: formatLocalDate(b.qrGeneratedAt, LOCALE) })
      : t('qr.notGenerated');
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  protected readonly statuses = qrStatuses(rolesOf(this.session.me()?.roles).processor);
  protected readonly own = injectOwnBatches('qr', this.statuses, QR_SPEC, '/qr');
  protected readonly busy = signal<string | null>(null);
  protected readonly shown = signal<{ batch: BatchItem; links: QrLinks | null } | null>(null);
  protected readonly qrFailure = dialogAlert();
  protected readonly search = computed(() => ({
    label: t('qr.search'),
    placeholder: t('qr.searchPlaceholder'),
    value: this.own.q(),
  }));
  protected readonly sortOptions = [
    { value: 'updatedAt,desc', label: t('batches.sort.updated') },
    { value: 'publicCode,asc', label: t('batches.sort.code') },
  ];
  protected readonly docs = injectQuery(
    () => {
      const s = this.shown();
      if (!s || s.links) return null;
      const id = s.batch.id;
      return {
        key: `${batchKey(id)}:documents`,
        load: () =>
          call<Schemas['BatchDocuments']>(
            this.session.api.GET('/batches/{id}/documents', { params: { path: { id } } }),
          ),
      };
    },
    { failedText: t('qr.linksFailed') },
  );
  protected readonly qrOf = (s: { links: QrLinks | null }) => s.links ?? this.docs.data()?.qr ?? null;

  protected closeQr(): void {
    this.qrFailure.handOff();
    this.shown.set(null);
  }

  protected async generate(b: BatchItem, inDialog = false): Promise<void> {
    const generation = this.session.generation;
    this.busy.set(b.id);
    this.qrFailure.clear();
    try {
      const links = await call<QrLinks>(
        this.session.api.POST('/batches/{id}/qr', { params: { path: { id: b.id } }, body: {} }),
      );
      this.cache.invalidate(BATCHES_KEY);
      this.cache.invalidate(`${batchKey(b.id)}:documents`);
      if (generation !== this.session.generation) return;
      this.toasts.push({ tone: 'ok', text: t('qr.done', { code: b.publicCode }) });
      if (!this.alive()) return;
      void this.own.query.refetch();
      this.shown.set({ batch: b, links });
    } catch (e) {
      if (e instanceof ApiProblem && (e.status === 403 || e.status === 404)) {
        this.cache.invalidate(BATCHES_KEY);
        if (this.alive()) void this.own.query.refetch();
      }
      if (!this.live(generation)) return;
      if (inDialog) this.qrFailure.show(errorText(e), errorTone(e));
      else this.toasts.push({ tone: errorTone(e), text: errorText(e) });
    } finally {
      if (this.alive()) this.busy.set(null);
    }
  }
}
