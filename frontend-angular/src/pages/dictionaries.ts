import {
  ChangeDetectionStrategy,
  Directive,
  Component,
  computed,
  effect,
  inject,
  Injector,
  input,
  output,
  runInInjectionContext,
  signal,
  untracked,
  viewChild,
  type OnInit,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, withVariant, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatBytes, formatDecimal } from '@agrotrace/i18n';
import {
  IndicatorInputSchema,
  NormInputSchema,
  ProductInputSchema,
  RegionInputSchema,
  SubstanceInputSchema,
} from '@agrotrace/validation';
import {
  DICTIONARIES,
  IMAGE_TYPES,
  IMPORT_ACCEPT,
  IMPORT_HEADER,
  IMPORT_TYPES,
  importFileProblem,
  isImportFile,
  tooLargeText,
  typesText,
  UPLOAD_MAX_BYTES,
  type DictName,
} from '../app/admin';
import { injectAlive, injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { injectDictionary } from '../app/dictionaries';
import {
  errorTone,
  FocusAfterWaitDirective,
  dialogAlert,
  normalizeDecimal,
  SchemaForm,
  wireSchema,
  type SchemaLike,
} from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { ImageUploadComponent } from '../app/image-upload';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { injectQuery, QueryCache } from '../app/query';
import { RouteFocusService } from '../app/route-focus';
import { SessionService } from '../app/session';
import { PageToolbarComponent, ToastService, ToolbarFiltersDirective, UI, type FileItem } from '../app/ui';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type Product = Schemas['Product'];
type Substance = Schemas['Substance'];
type Indicator = Schemas['Indicator'];
type Norm = Schemas['Norm'];
type Region = Schemas['RegionEntry'];
type Entry = Product | Substance | Indicator | Norm | Region;
type Report = Schemas['ImportReport'];
type ReportError = Report['errors'][number];

const SIZE = 20;
const STACK = 'display: grid; gap: var(--sp-4)';
const CATEGORIES: readonly Schemas['ProductCategory'][] = [
  'GRAIN',
  'VEGETABLE',
  'FRUIT',
  'DAIRY',
  'MEAT',
  'OILSEED',
  'PROCESSED',
];
const SUBSTANCE_TYPES: readonly Schemas['SubstanceType'][] = ['PESTICIDE', 'FERTILIZER'];
const SOFT: readonly DictName[] = ['products', 'substances', 'indicators'];
const REPORT_ROWS = 200;
const METRICS =
  'display: grid; gap: var(--sp-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))';
const adminKey = (name: DictName) => `dictionaryAdmin:${name}?`;

const SPECS: Record<DictName, ListSpec> = {
  products: {
    sort: ['name'],
    enums: { category: CATEGORIES },
    patterns: { includeDeleted: /^true$/ },
    texts: ['q'],
  },
  substances: {
    sort: ['name'],
    enums: { type: SUBSTANCE_TYPES },
    patterns: { includeDeleted: /^true$/ },
    texts: ['q'],
  },
  indicators: { sort: ['name'], patterns: { includeDeleted: /^true$/ }, texts: ['q'] },
  norms: { sort: ['name'], texts: ['q'] },
  regions: { sort: ['name'], texts: ['q'] },
};

const isDict = (s: string | null | undefined): s is DictName => DICTIONARIES.includes(s as DictName);

function entryName(name: DictName, e: Entry): string {
  if (name === 'norms') {
    const n = e as Norm;
    return `${n.product.name} — ${n.indicator.name}`;
  }
  return (e as { name: string }).name;
}

const IMPORTS = [
  ...UI,
  ReactiveFormsModule,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  ImageUploadComponent,
];

function refreshAfter(cache: QueryCache, name: DictName): void {
  cache.refresh(adminKey(name));
  cache.invalidate(`dictionary:${name}`);
  if (name === 'products' || name === 'indicators') cache.invalidate(adminKey('norms'));
}

type Values = Record<string, string>;

interface FormDef {
  fields: string[];
  defaults: (e?: Entry) => Values;
  schema: SchemaLike;
  toWire: (v: Values) => Record<string, unknown>;
  precheck?: (v: Values) => Record<string, string>;
}

const FORMS: Record<DictName, FormDef> = {
  products: {
    fields: ['name', 'category', 'lossNormPercent', 'mercuryCode'],
    defaults: (e) => {
      const p = e as Product | undefined;
      return {
        name: p?.name ?? '',
        category: p?.category ?? '',
        lossNormPercent: p ? p.lossNormPercent.replace('.', ',') : '',
        mercuryCode: p?.mercuryCode ?? '',
      };
    },
    schema: ProductInputSchema,
    toWire: (v) => ({
      name: v['name'],
      category: v['category'],
      lossNormPercent: normalizeDecimal(v['lossNormPercent']!, 2),
      mercuryCode: v['mercuryCode']!.trim() === '' ? null : v['mercuryCode']!.trim(),
    }),
  },
  substances: {
    fields: ['name', 'type', 'waitingPeriodDays'],
    defaults: (e) => {
      const s = e as Substance | undefined;
      return {
        name: s?.name ?? '',
        type: s?.type ?? '',
        waitingPeriodDays: s ? String(s.waitingPeriodDays) : '',
      };
    },
    schema: SubstanceInputSchema,
    toWire: (v) => ({
      name: v['name'],
      type: v['type'],
      waitingPeriodDays: /^\d{1,4}$/.test(v['waitingPeriodDays']!.trim())
        ? Number(v['waitingPeriodDays'])
        : '',
    }),
    precheck: (v): Record<string, string> =>
      v['waitingPeriodDays']!.trim() !== '' && !/^\d{1,4}$/.test(v['waitingPeriodDays']!.trim())
        ? { waitingPeriodDays: 'validation.pattern' }
        : {},
  },
  indicators: {
    fields: ['name', 'unit'],
    defaults: (e) => ({
      name: (e as Indicator | undefined)?.name ?? '',
      unit: (e as Indicator | undefined)?.unit ?? '',
    }),
    schema: IndicatorInputSchema,
    toWire: (v) => ({ name: v['name'], unit: v['unit'] }),
  },
  norms: {
    fields: ['productId', 'indicatorId', 'maxValue'],
    defaults: (e) => {
      const n = e as Norm | undefined;
      return {
        productId: n?.product.id ?? '',
        indicatorId: n?.indicator.id ?? '',
        maxValue: n ? n.maxValue.replace(/\.?0+$/, '').replace('.', ',') : '',
      };
    },
    schema: NormInputSchema,
    toWire: (v) => ({
      productId: v['productId'],
      indicatorId: v['indicatorId'],
      maxValue: v['maxValue']!.trim().replace(',', '.'),
    }),
  },
  regions: {
    fields: ['code', 'name'],
    defaults: (e) => ({
      code: (e as Region | undefined)?.code ?? '',
      name: (e as Region | undefined)?.name ?? '',
    }),
    schema: RegionInputSchema,
    toWire: (v) => ({ code: v['code']!.trim().toUpperCase(), name: v['name'] }),
  },
};

function text(field: string, label: string, extra = '', mono = false): string {
  return `<div class="at-field" [fieldId]="'entry-${field}'" [label]="${label}" [error]="f.errorOf('${field}')">
      <input class="${mono ? 'at-input at-mono' : 'at-input'}" autocomplete="off" ${extra} name="${field}" [formControl]="f.control('${field}')" />
    </div>`;
}
function select(field: string, label: string, options: string): string {
  return `<div class="at-field" [fieldId]="'entry-${field}'" [label]="${label}" [error]="f.errorOf('${field}')">
      <select class="at-select" name="${field}" [formControl]="f.control('${field}')">
        <option value="" disabled>{{ t('ui.choose') }}</option>
        @for (o of ${options}; track o.value) {
          <option [value]="o.value">{{ o.label }}</option>
        }
      </select>
    </div>`;
}

@Component({
  selector: 'form[atEntry]',
  standalone: true,
  exportAs: 'atEntry',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (f.message()) {
      <p class="at-field__error" role="alert" style="margin: 0">{{ f.message() }}</p>
    }
    @switch (atEntry()) {
      @case ('products') {
        ${text('name', "t('field.name')")} ${select('category', "t('field.category')", 'categories')}
        <div
          class="at-field"
          [fieldId]="'entry-lossNormPercent'"
          [label]="t('field.lossNormPercent')"
          [error]="f.errorOf('lossNormPercent')"
        >
          <div class="at-input-group" [suffix]="'%'">
            <input
              class="at-input"
              inputmode="decimal"
              autocomplete="off"
              name="lossNormPercent"
              [formControl]="f.control('lossNormPercent')"
            />
          </div>
        </div>
        ${text('mercuryCode', "t('field.mercuryCode')", '', true)}
      }
      @case ('substances') {
        ${text('name', "t('field.name')")} ${select('type', "t('field.type')", 'substanceTypes')}
        ${text('waitingPeriodDays', "t('field.waitingPeriodDays')", 'inputmode="numeric"')}
      }
      @case ('indicators') {
        ${text('name', "t('field.name')")} ${text('unit', "t('field.unit')")}
      }
      @case ('norms') {
        ${select('productId', "t('field.productId')", 'productOptions()')}
        ${select('indicatorId', "t('field.indicatorId')", 'indicatorOptions()')}
        ${text('maxValue', "t('field.maxValue')", 'inputmode="decimal"')}
      }
      @case ('regions') {
        ${text('code', "t('field.code')", '', true)} ${text('name', "t('field.name')")}
      }
    }`,
  host: { id: 'entry-form', novalidate: '', style: FORM_GRID, '(submit)': 'submit($event)' },
})
export class EntryFormComponent implements OnInit {
  protected readonly t = t;
  readonly atEntry = input.required<DictName>();
  readonly entry = input<Entry | undefined>(undefined);
  readonly products = input<Product[]>([]);
  readonly indicators = input<Indicator[]>([]);
  readonly saved = output<Entry>();
  readonly gone = output<void>();
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly live = injectLive();
  f!: SchemaForm<Values>;
  protected readonly categories = CATEGORIES.map((c) => ({
    value: c,
    label: enumLabel(t, 'ProductCategory', c),
  }));
  protected readonly substanceTypes = SUBSTANCE_TYPES.map((x) => ({
    value: x,
    label: enumLabel(t, 'SubstanceType', x),
  }));
  protected readonly productOptions = computed(() => {
    const opts = this.products().map((p) => ({ value: p.id, label: p.name }));
    const n = this.entry() as Norm | undefined;
    return n && !opts.some((o) => o.value === n.product.id)
      ? [{ value: n.product.id, label: n.product.name }, ...opts]
      : opts;
  });
  protected readonly indicatorOptions = computed(() => {
    const opts = this.indicators().map((i) => ({ value: i.id, label: `${i.name}, ${i.unit}` }));
    const n = this.entry() as Norm | undefined;
    return n && !opts.some((o) => o.value === n.indicator.id)
      ? [{ value: n.indicator.id, label: `${n.indicator.name}, ${n.indicator.unit}` }, ...opts]
      : opts;
  });

  ngOnInit(): void {
    const def = FORMS[this.atEntry()];
    runInInjectionContext(this.injector, () => {
      this.f = new SchemaForm<Values>(
        wireSchema<Values>(def.schema, def.toWire, def.precheck),
        def.defaults(this.entry()),
        def.fields,
        { dialog: true },
      );
    });
  }

  protected submit(e: Event): void {
    const name = this.atEntry();
    const entry = this.entry();
    void this.f.submit(e, async (body) => {
      const generation = this.session.generation;
      try {
        const saved = entry
          ? await call<Entry>(
              this.session.api.PUT('/dictionaries/{name}/{id}', {
                params: { path: { name, id: entry.id } },
                body: body as unknown as Schemas['DictionaryInput'],
              }),
            )
          : await call<Entry>(
              this.session.api.POST('/dictionaries/{name}', {
                params: { path: { name } },
                body: body as unknown as Schemas['DictionaryInput'],
              }),
            );
        if (generation !== this.session.generation) return;
        refreshAfter(this.cache, name);
        this.toasts.push({
          tone: 'ok',
          text: t(entry ? 'dict.saved' : 'dict.created', { name: entryName(name, saved) }),
        });
        this.saved.emit(saved);
      } catch (err) {
        if (
          generation === this.session.generation &&
          entry &&
          err instanceof ApiProblem &&
          err.status === 404
        )
          refreshAfter(this.cache, name);
        if (!this.live(generation)) return;
        if (entry && err instanceof ApiProblem && err.status === 404) this.gone.emit();
        else this.f.fail(err);
      }
    });
  }
}

const ENTRY_DIALOG = `@if (entryDialog(); as d) {
      <dialog
        class="at-dialog"
        [open]="true"
        [dialogTitle]="d.entry ? t('dict.editTitle', { name: entryName(d.name, d.entry) }) : t('dict.addTitle.' + d.name)"
        (closed)="closeEntry()"
      >
        @if (d.name === 'norms' && (!products.data() || !indicators.data())) {
          ${areaLoading(1)}
        } @else {
          <form
            [atEntry]="d.name"
            [entry]="d.entry"
            [products]="products.data() ?? []"
            [indicators]="indicators.data() ?? []"
            (saved)="entrySaved(d.name)"
            (gone)="entryGone(d.name, d.entry!)"
          ></form>
        }
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closeEntry()">{{ t('action.cancel') }}</button>
          <button
            class="at-button"
            [type]="'submit'"
            [attr.form]="'entry-form'"
            [variant]="'primary'"
            [busy]="entryBusy()"
            [disabled]="entryWait() > 0"
            [focusAfterWait]="entryWait()"
          >
            {{ entryWait() > 0 ? t('auth.retryIn', { seconds: entryWait() }) : d.entry ? t('action.save') : t('dict.add') }}
          </button>
        </div>
      </dialog>
    }`;

@Directive()
abstract class EntryHost {
  private readonly entryForm = viewChild(EntryFormComponent);
  protected readonly entryBusy = () => this.entryForm()?.f?.busy() ?? false;
  protected readonly entryWait = () => this.entryForm()?.f?.wait() ?? 0;
  protected readonly t = t;
  protected readonly entryName = entryName;
  protected readonly cache = inject(QueryCache);
  protected readonly toasts = inject(ToastService);
  protected readonly products = injectDictionary('products');
  protected readonly indicators = injectDictionary('indicators');
  protected readonly entryDialog = signal<{ name: DictName; entry?: Entry } | null>(null);

  protected entrySaved(name: DictName): void {
    refreshAfter(this.cache, name);
    this.entryDialog.set(null);
  }

  protected closeEntry(): void {
    this.entryForm()?.f?.handOff();
    this.entryDialog.set(null);
  }

  protected entryGone(name: DictName, entry: Entry): void {
    refreshAfter(this.cache, name);
    this.entryDialog.set(null);
    this.toasts.push({ tone: 'danger', text: t('dict.gone', { name: entryName(name, entry) }) });
  }
}

const COLUMN_LABEL: Record<string, string> = {
  name: 'field.name',
  category: 'field.category',
  lossNormPercent: 'field.lossNormPercent',
  type: 'field.type',
  waitingPeriodDays: 'field.waitingPeriodDays',
  unit: 'field.unit',
  product: 'field.productId',
  indicator: 'field.indicatorId',
  maxValue: 'field.maxValue',
  code: 'field.code',
};

const NAME_COLUMN = `<ng-template [atColumn]="'name'" [header]="t('field.name')" [primary]="true" [sortField]="'name'" let-e>
              <span class="at-table__primary"><span>{{ e.name }}</span></span>
            </ng-template>`;
const STATE_COLUMN = `@if (deleted() && soft) {
              <ng-template [atColumn]="'deleted'" [header]="t('dict.state')" [status]="true" let-e>
                @if (e.deletedAt) {
                  <span class="at-chip" [tone]="'neutral'">{{ t('dict.deleted') }}</span>
                } @else {
                  <span class="at-chip" [tone]="'ok'">{{ t('dict.inUse') }}</span>
                }
              </ng-template>
            }`;

@Component({
  selector: 'div[atDictList]',
  standalone: true,
  imports: [...IMPORTS, EntryFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      @if (name === 'products' || name === 'substances' || soft) {
        <ng-template atToolbarFilters>
          @if (name === 'products') {
            <div class="at-field" [fieldId]="'filter-category'" [label]="t('field.category')">
              <select class="at-select" (change)="list.set({ category: $any($event.target).value })">
                <option value="" [selected]="category() === ''">{{ t('filters.any') }}</option>
                @for (c of categories; track c) {
                  <option [value]="c" [selected]="category() === c">{{ label('ProductCategory', c) }}</option>
                }
              </select>
            </div>
          }
          @if (name === 'substances') {
            <div class="at-field" [fieldId]="'filter-type'" [label]="t('field.type')">
              <select class="at-select" (change)="list.set({ type: $any($event.target).value })">
                <option value="" [selected]="type() === ''">{{ t('filters.any') }}</option>
                @for (x of substanceTypes; track x) {
                  <option [value]="x" [selected]="type() === x">{{ label('SubstanceType', x) }}</option>
                }
              </select>
            </div>
          }
          @if (soft) {
            <label
              class="at-check"
              [label]="t('dict.showDeleted')"
              [checked]="deleted()"
              (toggled)="list.set({ includeDeleted: $event ? 'true' : null })"
            ></label>
          }
        </ng-template>
      }
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('dict.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
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
          <div class="at-empty" [art]="'empty-search'" [text]="t('dict.empty')"></div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="label('DictionaryName', name)"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          @switch (name) {
            @case ('products') {
              <ng-template [atColumn]="'photo'" [header]="t('dict.photo')" let-e>
                <span
                  class="at-avatar"
                  [name]="e.name"
                  [src]="e.imageUrl ? variant(e.imageUrl) : null"
                  [size]="'s'"
                  [shape]="'square'"
                  [decorative]="true"
                ></span>
              </ng-template>
              ${NAME_COLUMN} ${STATE_COLUMN}
              <ng-template [atColumn]="'category'" [header]="t('field.category')" let-e>{{
                label('ProductCategory', e.category)
              }}</ng-template>
              <ng-template [atColumn]="'loss'" [header]="t('field.lossNormPercent')" [numeric]="true" let-e>{{
                decimal(e.lossNormPercent)
              }}</ng-template>
              <ng-template [atColumn]="'mercury'" [header]="t('field.mercuryCode')" let-e>
                <span class="at-mono">{{ e.mercuryCode ?? '—' }}</span>
              </ng-template>
            }
            @case ('substances') {
              ${NAME_COLUMN} ${STATE_COLUMN}
              <ng-template [atColumn]="'type'" [header]="t('field.type')" let-e>{{
                label('SubstanceType', e.type)
              }}</ng-template>
              <ng-template
                [atColumn]="'days'"
                [header]="t('field.waitingPeriodDays')"
                [numeric]="true"
                let-e
                >{{ e.waitingPeriodDays }}</ng-template
              >
            }
            @case ('indicators') {
              ${NAME_COLUMN} ${STATE_COLUMN}
              <ng-template [atColumn]="'unit'" [header]="t('field.unit')" let-e>{{ e.unit }}</ng-template>
            }
            @case ('norms') {
              <ng-template
                [atColumn]="'product'"
                [header]="t('field.productId')"
                [primary]="true"
                [sortField]="'name'"
                let-e
              >
                <span class="at-table__primary"
                  ><span>{{ e.product.name }}</span
                  ><span class="at-table__sub">{{ e.indicator.name }}</span></span
                >
              </ng-template>
              <ng-template [atColumn]="'indicator'" [header]="t('field.indicatorId')" let-e>{{
                e.indicator.name
              }}</ng-template>
              <ng-template [atColumn]="'max'" [header]="t('field.maxValue')" [numeric]="true" let-e>{{
                decimal(e.maxValue) + ' ' + e.indicator.unit
              }}</ng-template>
            }
            @case ('regions') {
              <ng-template [atColumn]="'code'" [header]="t('field.code')" let-e>
                <span class="at-mono">{{ e.code }}</span>
              </ng-template>
              ${NAME_COLUMN}
            }
          }
          <ng-template atRowActions let-e>
            @if (!isDeleted(e)) {
              <button
                class="at-button"
                [size]="'s'"
                [attr.aria-label]="t('dict.editOf', { name: entryName(name, e) })"
                (click)="entryDialog.set({ name, entry: e })"
              >
                {{ t('dict.edit') }}
              </button>
              @if (name === 'products') {
                <button
                  class="at-button"
                  [size]="'s'"
                  [icon]="'image'"
                  [iconOnly]="true"
                  [attr.aria-label]="t('dict.photoOf', { name: entryName(name, e) })"
                  (click)="photo.set(e)"
                ></button>
              }
              <button
                class="at-button"
                [size]="'s'"
                [variant]="'ghost'"
                [icon]="'trash'"
                [iconOnly]="true"
                [attr.aria-label]="t('dict.deleteOf', { name: entryName(name, e) })"
                (click)="openRemove(e)"
              ></button>
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
    ${ENTRY_DIALOG}
    @if (removing(); as e) {
      <dialog
        class="at-dialog"
        [open]="true"
        [dialogTitle]="t('dict.deleteTitle', { name: entryName(name, e) })"
        (closed)="closeRemove()"
      >
        <div style="${STACK}">
          @if (removeFailure.message()) {
            <p class="at-field__error" role="alert" style="margin: 0">{{ removeFailure.message() }}</p>
          }
          <p style="margin: 0">{{ soft ? t('dict.deleteSoft') : t('dict.deleteHard') }}</p>
        </div>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closeRemove()">
            {{ t('action.cancel') }}
          </button>
          <button
            class="at-button"
            [variant]="'danger'"
            [busy]="removeBusy()"
            [disabled]="removeWait.left() > 0"
            [focusAfterWait]="removeWait.left()"
            (click)="remove(e)"
          >
            {{
              removeWait.left() > 0 ? t('auth.retryIn', { seconds: removeWait.left() }) : t('action.delete')
            }}
          </button>
        </div>
      </dialog>
    }
    @if (photo(); as p) {
      <dialog
        class="at-dialog"
        [open]="true"
        [dialogTitle]="t('dict.photoTitle', { name: p.name })"
        (closed)="closePhoto()"
      >
        <div style="${STACK}">
          @if (photoFailure.message()) {
            <p class="at-field__error" role="alert" style="margin: 0">{{ photoFailure.message() }}</p>
          }
          @if (p.imageUrl) {
            <img
              [attr.src]="photoUrl(p.imageUrl)"
              [attr.alt]="t('dict.photoAlt', { name: p.name })"
              style="max-width: 100%; max-height: 12rem; border-radius: var(--r-m); justify-self: start"
            />
          }
          <div
            [imageUpload]="'photo-file'"
            [label]="t('field.file')"
            [hint]="t('dict.photoHint')"
            [types]="imageTypes"
            [maxBytes]="maxBytes"
            [upload]="uploadPhoto(p)"
            [dialogAlert]="photoFailure"
            (done)="closePhoto()"
          ></div>
        </div>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closePhoto()">
            {{ t('action.cancel') }}
          </button>
        </div>
      </dialog>
    }`,
  host: { style: STACK },
})
export class DictionaryListComponent extends EntryHost {
  protected readonly size = SIZE;
  protected readonly categories = CATEGORIES;
  protected readonly substanceTypes = SUBSTANCE_TYPES;
  protected readonly imageTypes = IMAGE_TYPES;
  protected readonly maxBytes = UPLOAD_MAX_BYTES;
  protected readonly label = (enumName: string, v: string) => enumLabel(t, enumName, v);
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  protected readonly variant = (url: string) => withVariant(url, 96);
  protected readonly photoUrl = (url: string) => withVariant(url, 480);
  protected readonly rowKey = (e: Entry) => e.id;
  protected readonly isDeleted = (e: Entry) => 'deletedAt' in e && e.deletedAt !== null;
  protected readonly sortOptions = [
    { value: 'name,asc', label: t('dict.sort.nameAsc') },
    { value: 'name,desc', label: t('dict.sort.nameDesc') },
  ];
  private readonly session = inject(SessionService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  protected readonly name: DictName = (() => {
    const n = inject(ActivatedRoute).snapshot.paramMap.get('name');
    return isDict(n) ? n : 'products';
  })();
  protected readonly soft = SOFT.includes(this.name);
  protected readonly list = injectListParams(`/admin/dictionaries/${this.name}`, SPECS[this.name]);
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly q = this.p('q');
  protected readonly category = this.p('category');
  protected readonly type = this.p('type');
  protected readonly deleted = computed(() => this.list.params().get('includeDeleted') === 'true');
  protected readonly count = computed(
    () => [this.category(), this.type(), this.deleted() ? 'yes' : ''].filter(Boolean).length,
  );
  protected readonly search = computed(() => ({
    label: t('dict.search', { name: enumLabel(t, 'DictionaryName', this.name) }),
    placeholder: t(`dict.searchPlaceholder.${this.name}`),
    value: this.q(),
  }));

  protected readonly query = injectQuery(
    () => {
      const name = this.name;
      const page = this.list.page();
      const sort = this.list.sort();
      const f = { q: this.q(), category: this.category(), type: this.type(), deleted: this.deleted() };
      return {
        key: `${adminKey(name)}${JSON.stringify([page, sort, f])}`,
        load: () =>
          call<Schemas['DictionaryPage']>(
            this.session.api.GET('/dictionaries/{name}', {
              params: {
                path: { name },
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(f.q ? { q: f.q } : {}),
                  ...(f.category ? { category: f.category as Schemas['ProductCategory'] } : {}),
                  ...(f.type ? { type: f.type as Schemas['SubstanceType'] } : {}),
                  ...(f.deleted ? { includeDeleted: true } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('dict.failed') },
  );
  protected readonly items = computed(() => (this.query.data()?.items ?? []) as Entry[]);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));

  protected readonly removing = signal<Entry | null>(null);
  protected readonly removeBusy = signal(false);
  protected readonly removeFailure = dialogAlert();
  protected readonly photoFailure = dialogAlert();
  protected readonly removeWait = countdown();
  protected readonly photo = signal<Product | null>(null);

  constructor() {
    super();
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
  }

  protected openRemove(e: Entry): void {
    this.removeFailure.clear();
    this.removing.set(e);
  }

  protected closeRemove(): void {
    this.removeFailure.handOff();
    this.removing.set(null);
  }

  protected closePhoto(): void {
    this.photoFailure.handOff();
    this.photo.set(null);
  }

  protected async remove(entry: Entry): Promise<void> {
    const name = this.name;
    const label = entryName(name, entry);
    const generation = this.session.generation;
    this.removeBusy.set(true);
    this.removeFailure.clear();
    try {
      await call(
        this.session.api.DELETE('/dictionaries/{name}/{id}', { params: { path: { name, id: entry.id } } }),
      );
      if (generation !== this.session.generation) return;
      refreshAfter(this.cache, name);
      this.toasts.push({ tone: 'ok', text: t('dict.removed', { name: label }) });
      if (this.alive()) this.removing.set(null);
    } catch (e) {
      const gone = e instanceof ApiProblem && e.status === 404;
      if (gone && generation === this.session.generation) refreshAfter(this.cache, name);
      if (!this.live(generation)) return;
      let text = errorText(e);
      if (e instanceof ApiProblem && e.code === 'REFERENCE_IN_USE') {
        const usedBy = e.params?.['usedBy'];
        const used = Array.isArray(usedBy) ? (usedBy as string[]) : [];
        text = t('dict.inUseBy', { name: label, by: used.map((u) => t(`dict.usedBy.${u}`)).join(', ') });
      } else if (gone) {
        this.removing.set(null);
        this.toasts.push({ tone: 'danger', text: t('dict.gone', { name: label }) });
        return;
      }
      if (e instanceof ApiProblem && e.status === 429) this.removeWait.start(retryAfterOf(e));
      this.removeFailure.show(text, errorTone(e));
    } finally {
      if (this.alive()) this.removeBusy.set(false);
    }
  }

  protected readonly uploadPhoto = (p: Product) => async (file: File) => {
    const generation = this.session.generation;
    const body = new FormData();
    body.append('file', file);
    await call(
      this.session.api.PUT('/dictionaries/products/{id}/image', {
        params: { path: { id: p.id } },
        body: body as never,
      }),
    );
    if (generation !== this.session.generation) return;
    refreshAfter(this.cache, 'products');
    this.toasts.push({ tone: 'ok', text: t('dict.photoSaved', { name: p.name }) });
  };
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, NgTemplateOutlet, EntryFormComponent, DictionaryListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!name()) {
      <div class="at-page__header" [pageTitle]="t('page.dictionaries')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('dict.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/admin/dictionaries/products'">{{
            t('dict.toProducts')
          }}</a>
        </div>
      </article>
    } @else {
      <div class="at-page__header" [pageTitle]="t('page.dictionaries')">
        <div class="at-page__actions">
          <button class="at-button" [icon]="'upload'" (click)="openImport()">
            {{ t('dict.import.open') }}
          </button>
          <button
            class="at-button"
            [variant]="'primary'"
            [icon]="'plus'"
            (click)="entryDialog.set({ name: name()! })"
          >
            {{ t('dict.add') }}
          </button>
        </div>
      </div>
      <div
        class="at-tabs"
        [label]="t('page.dictionaries')"
        [tabs]="tabs"
        [selected]="name()!"
        (select)="showTab($event)"
      >
        <ng-template [atTabPanel]="'products'"
          ><ng-container *ngTemplateOutlet="dictPanel; context: { $implicit: 'products' }"
        /></ng-template>
        <ng-template [atTabPanel]="'substances'"
          ><ng-container *ngTemplateOutlet="dictPanel; context: { $implicit: 'substances' }"
        /></ng-template>
        <ng-template [atTabPanel]="'indicators'"
          ><ng-container *ngTemplateOutlet="dictPanel; context: { $implicit: 'indicators' }"
        /></ng-template>
        <ng-template [atTabPanel]="'norms'"
          ><ng-container *ngTemplateOutlet="dictPanel; context: { $implicit: 'norms' }"
        /></ng-template>
        <ng-template [atTabPanel]="'regions'"
          ><ng-container *ngTemplateOutlet="dictPanel; context: { $implicit: 'regions' }"
        /></ng-template>
      </div>
      <ng-template #dictPanel let-d>
        <div style="${STACK}; padding-top: var(--sp-4)">
          @if (report(); as r) {
            @if (r.name === d) {
              <article class="at-card">
                <header
                  class="at-card__header"
                  [cardTitle]="t('dict.report.title', { name: label('DictionaryName', d) })"
                >
                  <button
                    class="at-button"
                    [variant]="'ghost'"
                    [iconOnly]="true"
                    [icon]="'close'"
                    [attr.aria-label]="t('dict.report.close')"
                    (click)="report.set(null)"
                  ></button>
                </header>
                <div class="at-card__body">
                  <div style="${STACK}">
                    <div style="${METRICS}">
                      <div
                        class="at-metric"
                        [label]="t('dict.report.created')"
                        [value]="'' + r.report.created"
                      ></div>
                      <div
                        class="at-metric"
                        [label]="t('dict.report.updated')"
                        [value]="'' + r.report.updated"
                      ></div>
                      <div
                        class="at-metric"
                        [label]="t('dict.report.unchanged')"
                        [value]="'' + r.report.unchanged"
                      ></div>
                      <div
                        class="at-metric"
                        [label]="t('dict.report.rejected')"
                        [value]="'' + rejected(r.report)"
                        [tone]="rejected(r.report) ? 'danger' : undefined"
                      ></div>
                    </div>
                    @if (r.report.errors.length > 0) {
                      <div
                        class="at-table-wrap"
                        [cards]="true"
                        [caption]="t('dict.report.errors')"
                        [rows]="reportRows(r.report, reportPage())"
                        [rowKey]="reportKey"
                      >
                        <ng-template
                          [atColumn]="'row'"
                          [header]="t('dict.report.row')"
                          [numeric]="true"
                          let-x
                          >{{ x.row }}</ng-template
                        >
                        <ng-template [atColumn]="'column'" [header]="t('dict.report.column')" let-x>
                          @if (x.column) {
                            <span class="at-table__primary"
                              ><span>{{ columnLabel(x.column) }}</span
                              ><span class="at-table__sub at-mono">{{ x.column }}</span></span
                            >
                          } @else {
                            {{ t('dict.report.wholeRow') }}
                          }
                        </ng-template>
                        <ng-template [atColumn]="'message'" [header]="t('dict.report.message')" let-x>{{
                          t(x.message)
                        }}</ng-template>
                      </div>
                    }
                    @if (r.report.errors.length > reportLimit) {
                      <nav
                        class="at-pagination"
                        [page]="reportPage()"
                        [size]="reportLimit"
                        [total]="r.report.errors.length"
                        [label]="t('dict.report.pages')"
                        (pageChange)="reportPage.set($event)"
                      ></nav>
                    }
                  </div>
                </div>
              </article>
            }
          }
          <div atDictList></div>
        </div>
      </ng-template>
      ${ENTRY_DIALOG}
      @if (importing()) {
        <dialog
          class="at-dialog"
          [open]="true"
          [dialogTitle]="t('dict.import.title', { name: label('DictionaryName', name()!) })"
          (closed)="closeImport()"
        >
          <div style="${STACK}">
            @if (importFailure.message()) {
              <p class="at-field__error" role="alert" style="margin: 0">{{ importFailure.message() }}</p>
            }
            <div
              class="at-field"
              [files]="importItems()"
              [fileId]="'import-file'"
              [label]="t('field.file')"
              [accept]="importAccept"
              [hint]="t('dict.import.hint', { header: header(name()!) })"
              [error]="picked()?.error"
              [disabled]="importBusy()"
              (chosen)="pick($event)"
              (removed)="picked.set(null)"
            ></div>
          </div>
          <div class="at-dialog__actions">
            <button class="at-button" [variant]="'ghost'" (click)="closeImport()">
              {{ t('action.cancel') }}
            </button>
            <button
              class="at-button"
              [variant]="'primary'"
              [icon]="'upload'"
              [busy]="importBusy()"
              [disabled]="!picked() || !!picked()!.error || importWait.left() > 0"
              [focusAfterWait]="importWait.left()"
              (click)="send(name()!)"
            >
              {{
                importWait.left() > 0
                  ? t('auth.retryIn', { seconds: importWait.left() })
                  : t('dict.import.send')
              }}
            </button>
          </div>
        </dialog>
      }
    }`,
})
export class DictionaryPage extends EntryHost {
  protected readonly dictionaries = DICTIONARIES;
  protected readonly tabs = DICTIONARIES.map((d) => ({ id: d, label: enumLabel(t, 'DictionaryName', d) }));
  protected readonly label = (enumName: string, v: string) => enumLabel(t, enumName, v);
  protected readonly header = (name: DictName) => IMPORT_HEADER[name];
  protected readonly importAccept = IMPORT_ACCEPT;
  protected readonly reportLimit = REPORT_ROWS;
  protected readonly rejected = (r: Report) => new Set(r.errors.map((x) => x.row)).size;
  protected readonly reportRows = (r: Report, page: number) =>
    r.errors
      .slice((page - 1) * REPORT_ROWS, page * REPORT_ROWS)
      .map((x, i) => ({ ...x, key: `${x.row}-${x.column ?? ''}-${(page - 1) * REPORT_ROWS + i}` }));
  protected readonly reportKey = (x: ReportError & { key: string }) => x.key;
  protected readonly columnLabel = (c: string) => (COLUMN_LABEL[c] ? t(COLUMN_LABEL[c]!) : c);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly routeFocus = inject(RouteFocusService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  protected readonly name = computed(() => {
    const n = this.params().get('name');
    return isDict(n) ? n : null;
  });
  protected readonly report = signal<{ name: DictName; report: Report } | null>(null);
  protected readonly reportPage = signal(1);

  protected showTab(id: string): void {
    if (id === this.name()) return;
    const to = `/admin/dictionaries/${id}`;
    this.routeFocus.skipNext(to);
    void this.router.navigateByUrl(to);
  }

  protected readonly importing = signal(false);
  protected readonly picked = signal<{ file: File; error?: string } | null>(null);
  protected readonly importBusy = signal(false);
  protected readonly importFailure = dialogAlert();
  protected readonly importWait = countdown();
  protected readonly importItems = computed<FileItem[]>(() => {
    const p = this.picked();
    if (!p) return [];
    return [
      {
        key: 'import',
        name: p.file.name,
        sizeText: p.error ?? formatBytes(p.file.size, LOCALE),
        error: Boolean(p.error),
        kind: p.file.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV',
        ...(this.importBusy() ? { progress: null } : {}),
      },
    ];
  });

  protected openImport(): void {
    this.picked.set(null);
    this.importFailure.clear();
    this.importing.set(true);
  }

  protected closeImport(): void {
    this.importFailure.handOff();
    this.importing.set(false);
  }

  protected pick(files: File[]): void {
    const file = files[0];
    if (!file) return;
    this.importFailure.clear();
    let error: string | undefined;
    if (!isImportFile(file)) error = t('files.unsupported', { allowed: typesText(IMPORT_TYPES) });
    else if (file.size > UPLOAD_MAX_BYTES) error = tooLargeText(UPLOAD_MAX_BYTES);
    this.picked.set(error ? { file, error } : { file });
  }

  protected async send(name: DictName): Promise<void> {
    const picked = this.picked();
    if (!picked || picked.error) return;
    const generation = this.session.generation;
    this.importFailure.clear();
    this.importBusy.set(true);
    try {
      const body = new FormData();
      body.append('file', picked.file);
      const report = await call<Report>(
        this.session.api.POST('/dictionaries/{name}/import', {
          params: { path: { name } },
          body: body as never,
        }),
      );
      if (generation !== this.session.generation) return;
      refreshAfter(this.cache, name);
      this.toasts.push({
        tone: report.errors.length ? 'attention' : 'ok',
        text: t('dict.import.done', {
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          rejected: new Set(report.errors.map((x) => x.row)).size,
        }),
      });
      if (!this.alive()) return;
      this.importing.set(false);
      this.reportPage.set(1);
      this.report.set({ name, report });
    } catch (e) {
      if (!this.live(generation)) return;
      const problem = importFileProblem(e, name);
      if (problem) this.picked.update((p) => (p ? { ...p, error: problem } : p));
      if (e instanceof ApiProblem && e.status === 429) this.importWait.start(retryAfterOf(e));
      if (!problem) this.importFailure.show(errorText(e), errorTone(e));
    } finally {
      if (this.alive()) this.importBusy.set(false);
    }
  }
}
