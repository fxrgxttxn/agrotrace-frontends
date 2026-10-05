import {
  afterRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  type OnInit,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatBytes, formatDecimal, formatLocalDate, formatLocalDateTime } from '@agrotrace/i18n';
import { FieldInputSchema, TreatmentInputSchema } from '@agrotrace/validation';
import { injectAlive, injectLive } from '../app/alive';
import { call } from '../app/api';
import { addDays } from '../app/dates';
import { injectDictionary } from '../app/dictionaries';
import { focusLost, gone } from '../app/focus';
import { dialogAlert, FocusAfterWaitDirective, normalizeDecimal, SchemaForm, wireSchema } from '../app/forms';
import { GEOJSON_MAX_BYTES, parseGeometry, prettyGeometry, readText } from '../app/geometry';
import { LOCALE, t } from '../app/i18n';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { momentCheck, momentDefaults, MomentInputComponent, momentWire } from '../app/moment';
import { OrgPickerComponent } from '../app/org-picker';
import { injectNow } from '../app/now';
import { injectQuery, QueryCache } from '../app/query';
import { SessionService } from '../app/session';
import {
  FullscreenOpenerDirective,
  injectFullscreen,
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type CardFact,
  type FileItem,
} from '../app/ui';
import { FieldMapComponent, MAPS_KEY, mappable } from '../maps/field-map';
import { FORM_GRID } from './layout';
import { FIELDS_KEY, fieldKey } from './keys';
import { areaLoading, listChanged, loadFailed, rolesOf } from './lists';

type FieldT = Schemas['Field'];
type Treatment = Schemas['Treatment'];
const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';

const FIELDS_SPEC: ListSpec = {
  sort: ['name', 'areaHa', 'lastTreatmentAt', 'createdAt'],
  patterns: { regionCode: /^[0-9A-Z-]{1,8}$/ },
  uuids: ['organizationId'],
  texts: ['q'],
};
const TREATMENTS_SPEC: ListSpec = { sort: ['appliedAt', 'createdAt'] };

const IMPORTS = [
  ...UI,
  ReactiveFormsModule,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  OrgPickerComponent,
  FieldMapComponent,
  FullscreenOpenerDirective,
  MomentInputComponent,
];

const dateOrDash = (iso: string | null) => (iso ? formatLocalDate(iso, LOCALE) : '—');
const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;
const sortParam = (s: { field: string; dir: string } | null) => (s ? { sort: `${s.field},${s.dir}` } : {});

const treatmentsKey = (id: string) => `treatments:${id}?`;

const MAP = `@if (mapFields().length > 0) {
      @if (mapFs.wide() || mapFs.full()) {
        <div class="at-graph" [atFieldMap]="mapFields()" [fs]="mapFs"></div>
      } @else {
        <button class="at-button" [icon]="'map'" [atFullscreenOpener]="mapFs" (click)="mapFs.open()">
          {{ t('maps.open') }}
        </button>
      }
    }`;

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.fields')">
      @if (roles().farmer) {
        <div class="at-page__actions">
          <a class="at-button" [variant]="'primary'" [icon]="'plus'" [to]="'/fields/new'">{{
            t('fields.add')
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
        <div class="at-field" [fieldId]="'filter-region'" [label]="t('fields.region')">
          <select class="at-select" (change)="list.set({ regionCode: $any($event.target).value })">
            <option value="" [selected]="regionCode() === ''">{{ t('filters.any') }}</option>
            @for (r of regions.data() ?? []; track r.id) {
              <option [value]="r.code" [selected]="r.code === regionCode()">{{ r.name }}</option>
            }
          </select>
        </div>
        @if (roles().overseer) {
          <div
            class="at-field"
            [orgPicker]="'filter-org'"
            [label]="t('fields.farm')"
            [types]="['FARM']"
            [value]="organizationId()"
            (valueChange)="list.set({ organizationId: $event })"
          ></div>
        }
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('fields.failed')", 'query.fetching()', 'retry()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'retry()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        @if (filtered()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-fields'" [text]="t('empty.fields')">
            @if (roles().farmer) {
              <a class="at-button" [variant]="'primary'" [to]="'/fields/new'">{{ t('fields.add') }}</a>
            } @else {
              <a class="at-button" [variant]="'primary'" [to]="'/'">{{ t('action.home') }}</a>
            }
          </div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${GAP}">
        ${MAP}
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.fields')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template
            [atColumn]="'name'"
            [header]="t('field.name')"
            [primary]="true"
            [sortField]="'name'"
            let-f
          >
            <span class="at-table__primary"
              ><a [to]="'/fields/' + f.id">{{ f.name }}</a
              ><span class="at-table__sub">{{ f.region.name }}</span></span
            >
          </ng-template>
          @if (roles().overseer) {
            <ng-template [atColumn]="'farm'" [header]="t('fields.farm')" let-f>{{
              f.organization.name
            }}</ng-template>
          }
          <ng-template
            [atColumn]="'area'"
            [header]="t('fields.area')"
            [numeric]="true"
            [sortField]="'areaHa'"
            let-f
            >{{ decimal(f.areaHa) }}</ng-template
          >
          <ng-template
            [atColumn]="'last'"
            [header]="t('fields.lastTreatment')"
            [sortField]="'lastTreatmentAt'"
            let-f
            >{{ dateOrDash(f.lastTreatmentAt) }}</ng-template
          >
          <ng-template [atColumn]="'count'" [header]="t('fields.treatments')" [numeric]="true" let-f>{{
            f.treatmentsCount
          }}</ng-template>
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
export class FieldsPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly dateOrDash = dateOrDash;
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  private readonly session = inject(SessionService);
  protected readonly roles = computed(() => rolesOf(this.session.me()?.roles));
  protected readonly list = injectListParams('/fields', FIELDS_SPEC);
  protected readonly regions = injectDictionary('regions');
  protected readonly regionCode = computed(() => this.list.params().get('regionCode') ?? '');
  protected readonly organizationId = computed(() =>
    this.roles().overseer ? (this.list.params().get('organizationId') ?? '') : '',
  );
  private readonly q = computed(() => this.list.params().get('q') ?? '');
  protected readonly search = computed(() => ({
    label: t('fields.search'),
    placeholder: t('fields.searchPlaceholder'),
    value: this.q(),
  }));
  protected readonly count = computed(
    () => [this.regionCode(), this.organizationId()].filter(Boolean).length,
  );
  protected readonly filtered = computed(() =>
    Boolean(this.q() || this.regionCode() || this.organizationId()),
  );

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const regionCode = this.regionCode();
      const organizationId = this.organizationId();
      return {
        key: `${FIELDS_KEY}${JSON.stringify([page, sort, q, regionCode, organizationId])}`,
        load: () =>
          call<Schemas['FieldPage']>(
            this.session.api.GET('/fields', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...sortParam(sort),
                  ...(q ? { q } : {}),
                  ...(regionCode ? { regionCode } : {}),
                  ...(organizationId ? { organizationId } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('fields.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));
  protected readonly rowKey = (f: FieldT) => f.id;
  protected readonly sortOptions = [
    { value: 'name,asc', label: t('fields.sort.name') },
    { value: 'areaHa,desc', label: t('fields.sort.areaDesc') },
    { value: 'areaHa,asc', label: t('fields.sort.areaAsc') },
    { value: 'lastTreatmentAt,desc', label: t('fields.sort.lastTreatment') },
  ];
  private readonly mapsKey = inject(MAPS_KEY);
  protected readonly mapFields = computed(() => mappable(this.items(), this.mapsKey));
  protected readonly mapFs = injectFullscreen();

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

interface FieldValues extends Record<string, unknown> {
  name: string;
  areaHa: string;
  regionCode: string;
  geometry: string;
}
const FIELD_FIELDS = ['name', 'areaHa', 'regionCode', 'geometry'] as const;
const GEOMETRY_PLACEHOLDER =
  '{\n  "type": "Polygon",\n  "coordinates": [[[39.01, 45.04], …, [39.01, 45.04]]]\n}';

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

const fieldAlias = (path: string) => (path.startsWith('geometry') ? 'geometry' : path);

function valuesOf(f?: FieldT): FieldValues {
  return {
    name: f?.name ?? '',
    areaHa: f ? f.areaHa.replace('.', ',') : '',
    regionCode: f?.region.code ?? '',
    geometry: f?.geometry ? prettyGeometry(f.geometry) : '',
  };
}

@Component({
  selector: 'form[atFieldForm]',
  standalone: true,
  exportAs: 'atFieldForm',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (f.message()) {
      <p class="at-field__error" role="alert" style="margin: 0">{{ f.message() }}</p>
    }
    <div
      class="at-field"
      [fieldId]="atFieldForm() + '-name'"
      [label]="t('field.name')"
      [error]="f.errorOf('name')"
    >
      <input class="at-input" autocomplete="off" [formControl]="f.control('name')" />
    </div>
    <div
      class="at-field"
      [fieldId]="atFieldForm() + '-area'"
      [label]="t('field.areaHa')"
      [error]="f.errorOf('areaHa')"
    >
      <div class="at-input-group" [suffix]="t('unit.ha')">
        <input class="at-input" inputmode="decimal" autocomplete="off" [formControl]="f.control('areaHa')" />
      </div>
    </div>
    <div
      class="at-field"
      [fieldId]="atFieldForm() + '-region'"
      [label]="t('field.regionCode')"
      [error]="f.errorOf('regionCode')"
    >
      <select class="at-select" [formControl]="f.control('regionCode')">
        <option value="" disabled>{{ t('ui.choose') }}</option>
        @for (r of regions(); track r.id) {
          <option [value]="r.code">{{ r.name }}</option>
        }
      </select>
    </div>
    <div
      class="at-field"
      [fieldId]="atFieldForm() + '-geometry'"
      [label]="t('fields.geometry')"
      [error]="f.errorOf('geometry')"
    >
      <textarea
        class="at-textarea at-mono"
        rows="6"
        spellcheck="false"
        [describedBy]="atFieldForm() + '-geometry-file-hint'"
        [attr.placeholder]="placeholder"
        [formControl]="f.control('geometry')"
      ></textarea>
    </div>
    <div
      class="at-field"
      [files]="file()"
      [fileId]="atFieldForm() + '-geometry-file'"
      [label]="t('fields.geometryFile')"
      [accept]="'.geojson,.json,application/geo+json,application/json'"
      [hint]="t('fields.geometryFileHint')"
      [error]="fileError()"
      (chosen)="importFile($event)"
      (removed)="file.set([])"
    ></div>`,
  host: {
    '[attr.id]': 'atFieldForm()',
    novalidate: '',
    style: FORM_GRID,
    '(submit)': 'f.submit($event, send)',
  },
})
export class FieldFormComponent implements OnInit {
  protected readonly t = t;
  protected readonly placeholder = GEOMETRY_PLACEHOLDER;
  readonly atFieldForm = input.required<string>();
  readonly field = input<FieldT | undefined>(undefined);
  readonly regions = input.required<Schemas['RegionEntry'][]>();
  readonly saved = output<FieldT>();
  readonly inDialog = input(false);

  private readonly session = inject(SessionService);
  private readonly live = injectLive();
  readonly f = new SchemaForm<FieldValues, Schemas['FieldInput']>(fieldSchema, valuesOf(), FIELD_FIELDS, {
    alias: fieldAlias,
  });
  protected readonly file = signal<FileItem[]>([]);
  protected readonly fileError = signal<string | null>(null);

  ngOnInit(): void {
    this.f.useDialog(this.inDialog());
    this.f.reset(valuesOf(this.field()));
  }

  protected readonly send = async (body: Schemas['FieldInput']): Promise<void> => {
    const field = this.field();
    const generation = this.session.generation;
    let saved: FieldT;
    try {
      saved = field
        ? await call<FieldT>(
            this.session.api.PUT('/fields/{id}', { params: { path: { id: field.id } }, body }),
          )
        : await call<FieldT>(this.session.api.POST('/fields', { body }));
    } catch (e) {
      if (this.live(generation)) this.f.fail(e);
      return;
    }
    if (generation === this.session.generation) this.saved.emit(saved);
  };

  protected async importFile(files: File[]): Promise<void> {
    const file = files[0];
    if (!file) return;
    this.fileError.set(null);
    const text = file.size <= GEOJSON_MAX_BYTES ? await readText(file) : null;
    if (text === null) {
      this.file.set([]);
      this.fileError.set(t('fields.geometryUnreadable'));
      return;
    }
    const parsed = parseGeometry(text);
    const control = this.f.control('geometry');
    control.setValue(parsed.ok && parsed.value ? prettyGeometry(parsed.value) : text);
    control.markAsDirty();
    this.file.set([{ key: file.name, name: file.name, sizeText: formatBytes(file.size, LOCALE) }]);
    if (parsed.ok) this.f.clearError('geometry');
    else this.f.fieldError('geometry', 'fields.geometryInvalid');
  }
}

function outsideSubmit(ref: string, id: string, label: string): string {
  return `<button
    class="at-button"
    [type]="'submit'"
    [attr.form]="${id}"
    [variant]="'primary'"
    [busy]="${ref}.f.busy()"
    [disabled]="${ref}.f.wait() > 0"
    [focusAfterWait]="${ref}.f.wait()"
  >
    {{ ${ref}.f.wait() > 0 ? t('auth.retryIn', { seconds: ${ref}.f.wait() }) : ${label} }}
  </button>`;
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, FieldFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.fieldNew')"></div>
    <article class="at-card" style="max-width: 40rem">
      <div class="at-card__body">
        @if (regions.data(); as list) {
          <form [atFieldForm]="'field-new'" #ff="atFieldForm" [regions]="list" (saved)="saved($event)"></form>
          <div style="margin-top: var(--sp-5)">${outsideSubmit('ff', "'field-new'", "t('fields.add')")}</div>
        } @else if (regions.failed()) {
          ${loadFailed("t('fields.failed')", 'regions.fetching()', 'regions.refetch()')}
        } @else {
          ${areaLoading(1)}
        }
      </div>
    </article>`,
})
export class FieldNewPage {
  protected readonly t = t;
  protected readonly regions = injectDictionary('regions');
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly alive = injectAlive();

  protected saved(f: FieldT): void {
    this.cache.invalidate(FIELDS_KEY);
    this.toasts.push({ tone: 'ok', text: t('fields.created', { name: f.name }) });
    if (this.alive()) void this.router.navigateByUrl(`/fields/${f.id}`);
  }
}

interface TreatmentValues extends Record<string, unknown> {
  substanceId: string;
  dose: string;
  doseUnit: string;
  appliedAt: string | null;
  appliedTime: string;
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

function treatmentValues(tr?: Treatment): TreatmentValues {
  const at = momentDefaults(tr?.appliedAt);
  return {
    substanceId: tr?.substance.id ?? '',
    dose: tr ? tr.dose.replace('.', ',') : '',
    doseUnit: tr?.doseUnit ?? 'л/га',
    appliedAt: at.date,
    appliedTime: at.time,
    original: at.original,
  };
}

@Component({
  selector: 'form[atTreatmentForm]',
  standalone: true,
  exportAs: 'atTreatmentForm',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (f.message()) {
      <p class="at-field__error" role="alert" style="margin: 0">{{ f.message() }}</p>
    }
    <div
      class="at-field"
      [fieldId]="'treatment-substance'"
      [label]="t('field.substanceId')"
      [error]="f.errorOf('substanceId')"
    >
      <select class="at-select" [formControl]="f.control('substanceId')">
        <option value="" disabled>{{ t('ui.choose') }}</option>
        @for (s of options(); track s.id) {
          <option [value]="s.id">{{ s.name }}</option>
        }
      </select>
    </div>
    <div class="at-field" [fieldId]="'treatment-dose'" [label]="t('field.dose')" [error]="f.errorOf('dose')">
      <input class="at-input" inputmode="decimal" autocomplete="off" [formControl]="f.control('dose')" />
    </div>
    <div
      class="at-field"
      [fieldId]="'treatment-unit'"
      [label]="t('field.doseUnit')"
      [error]="f.errorOf('doseUnit')"
    >
      <select class="at-select" [formControl]="f.control('doseUnit')">
        @for (u of units; track u) {
          <option [value]="u">{{ unitLabel(u) }}</option>
        }
      </select>
    </div>
    <div
      [atMoment]="'treatment'"
      [form]="f"
      [dateName]="'appliedAt'"
      [timeName]="'appliedTime'"
      [dateLabel]="t('field.appliedAt')"
      [timeLabel]="t('treatments.time')"
    ></div>`,
  host: { id: 'treatment-form', novalidate: '', style: FORM_GRID, '(submit)': 'f.submit($event, send)' },
})
export class TreatmentFormComponent implements OnInit {
  protected readonly t = t;
  protected readonly units = DOSE_UNITS;
  protected readonly unitLabel = (u: string) => enumLabel(t, 'DoseUnit', u);
  readonly atTreatmentForm = input.required<string>();
  readonly treatment = input<Treatment | undefined>(undefined);
  readonly substances = input.required<Schemas['Substance'][]>();
  readonly saved = output<boolean>();
  readonly closedWindow = output<string>();

  private readonly session = inject(SessionService);
  private readonly live = injectLive();
  readonly f = new SchemaForm<TreatmentValues, Schemas['TreatmentInput']>(
    treatmentSchema,
    treatmentValues(),
    TREATMENT_FIELDS,
    { dialog: true },
  );
  protected readonly options = computed(() => {
    const tr = this.treatment();
    const list = this.substances();
    return tr && !list.some((s) => s.id === tr.substance.id) ? [tr.substance, ...list] : list;
  });

  ngOnInit(): void {
    this.f.reset(treatmentValues(this.treatment()));
  }

  protected readonly send = async (body: Schemas['TreatmentInput']): Promise<void> => {
    const tr = this.treatment();
    const generation = this.session.generation;
    try {
      if (tr)
        await call<Treatment>(
          this.session.api.PUT('/treatments/{id}', { params: { path: { id: tr.id } }, body }),
        );
      else
        await call<Treatment>(
          this.session.api.POST('/fields/{id}/treatments', {
            params: { path: { id: this.atTreatmentForm() } },
            body,
          }),
        );
    } catch (e) {
      if (!this.live(generation)) return;
      if (
        tr &&
        e instanceof ApiProblem &&
        e.status === 403 &&
        e.params?.['reason'] === 'EDIT_WINDOW_CLOSED'
      ) {
        const until = e.params['editableUntil'];
        this.closedWindow.emit(typeof until === 'string' ? until : tr.editableUntil);
      } else this.f.fail(e);
      return;
    }
    if (generation === this.session.generation) this.saved.emit(!tr);
  };
}

interface Editing {
  tr?: Treatment;
  key: number;
  open: boolean;
}

@Component({
  selector: 'div[atTreatments]',
  standalone: true,
  imports: [...IMPORTS, TreatmentFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<article class="at-card">
    <header class="at-card__header" [cardTitle]="t('treatments.title')">
      @if (farmer() && items().length > 0) {
        <button #add class="at-button" [icon]="'plus'" (click)="edit('new')">
          {{ t('treatments.add') }}
        </button>
      }
    </header>
    <div class="at-card__body">
      @if (!query.data() && query.failed()) {
        @if (badQuery()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('filters.invalid')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-search'" [text]="t('treatments.failed')">
            <button class="at-button" [variant]="'primary'" [busy]="query.fetching()" (click)="retry()">
              {{ t('action.retry') }}
            </button>
          </div>
        }
      } @else if (!query.data() || gap() === 'pastEnd') {
        ${areaLoading(1)}
      } @else if (gap() === 'changed') {
        ${listChanged('query.fetching()', 'retry()')}
      } @else if (items().length === 0) {
        <div class="at-empty" [art]="'empty-fields'" [text]="t('treatments.empty')">
          @if (farmer()) {
            <button class="at-button" [variant]="'primary'" (click)="edit('new')">
              {{ t('treatments.add') }}
            </button>
          }
        </div>
      } @else {
        <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="display: grid; gap: var(--sp-4)">
          <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
          <div
            class="at-table-wrap"
            #table="atTable"
            [cards]="true"
            [caption]="t('treatments.title')"
            [rows]="items()"
            [rowKey]="rowKey"
            [sort]="list.sort()"
            (sortChange)="list.setSort($event)"
          >
            <ng-template [atColumn]="'substance'" [header]="t('field.substanceId')" [primary]="true" let-tr>
              <span class="at-table__primary"
                ><span>{{ tr.substance.name }}</span
                ><span class="at-table__sub">{{ typeLabel(tr.substance.type) }}</span></span
              >
            </ng-template>
            <ng-template [atColumn]="'dose'" [header]="t('treatments.dose')" [numeric]="true" let-tr>{{
              dose(tr)
            }}</ng-template>
            <ng-template
              [atColumn]="'applied'"
              [header]="t('field.appliedAt')"
              [sortField]="'appliedAt'"
              let-tr
              >{{ moment(tr.appliedAt) }}</ng-template
            >
            <ng-template [atColumn]="'wait'" [header]="t('treatments.waitUntil')" let-tr>{{
              waitUntil(tr)
            }}</ng-template>
            @if (farmer()) {
              <ng-template atRowActions let-tr>
                @if (editable(tr)) {
                  <button
                    class="at-button"
                    [size]="'s'"
                    [attr.aria-label]="editOf(tr)"
                    [attr.title]="editableUntil(tr)"
                    (click)="edit(tr)"
                  >
                    {{ t('treatments.edit') }}
                  </button>
                }
              </ng-template>
            }
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
    </div>
    @if (substances.data(); as subs) {
      @for (e of editingList(); track e.key) {
        <dialog
          class="at-dialog"
          [open]="e.open"
          [dialogTitle]="e.tr ? t('treatments.editTitle') : t('treatments.add')"
          (closed)="close()"
        >
          <form
            [atTreatmentForm]="field().id"
            #tf="atTreatmentForm"
            [treatment]="e.tr"
            [substances]="subs"
            (saved)="saved($event)"
            (closedWindow)="closedWindow($event)"
          ></form>
          <div class="at-dialog__actions">
            <button class="at-button" [variant]="'ghost'" (click)="close()">{{ t('action.cancel') }}</button>
            ${outsideSubmit('tf', "'treatment-form'", "e.tr ? t('action.save') : t('treatments.add')")}
          </div>
        </dialog>
      }
    }
  </article>`,
  host: { '(focusin)': 'lastFocus = $any($event.target)' },
})
export class TreatmentsComponent {
  protected readonly t = t;
  protected readonly size = SIZE;
  readonly atTreatments = input.required<FieldT>();
  readonly farmer = input.required<boolean>();
  protected readonly field = this.atTreatments;

  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly addButton = viewChild('add', { read: ElementRef });
  private readonly treatmentForm = viewChild(TreatmentFormComponent);
  protected readonly substances = injectDictionary('substances');
  protected readonly list = injectListParams(() => `/fields/${this.field().id}`, TREATMENTS_SPEC);
  private readonly now = injectNow();
  protected lastFocus: Element | null = null;

  protected readonly query = injectQuery(
    () => {
      const id = this.field().id;
      const page = this.list.page();
      const sort = this.list.sort();
      return {
        key: `${treatmentsKey(id)}${JSON.stringify([page, sort])}`,
        load: () =>
          call<Schemas['TreatmentPage']>(
            this.session.api.GET('/fields/{id}/treatments', {
              params: { path: { id }, query: { page, size: SIZE, ...sortParam(sort) } },
            }),
          ),
      };
    },
    { failedText: t('treatments.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));
  protected readonly rowKey = (tr: Treatment) => tr.id;
  protected readonly sortOptions = [
    { value: 'appliedAt,desc', label: t('treatments.sort.newest') },
    { value: 'appliedAt,asc', label: t('treatments.sort.oldest') },
  ];

  private readonly editing = signal<Editing | null>(null);
  protected readonly editingList = computed(() => {
    const e = this.editing();
    return e ? [e] : [];
  });

  protected readonly typeLabel = (type: string) => enumLabel(t, 'SubstanceType', type);
  protected readonly dose = (tr: Treatment) => `${formatDecimal(tr.dose, LOCALE)} ${tr.doseUnit}`;
  protected readonly moment = (iso: string) => formatLocalDateTime(iso, LOCALE);
  protected readonly waitUntil = (tr: Treatment) =>
    formatLocalDateTime(addDays(tr.appliedAt, tr.substance.waitingPeriodDays), LOCALE);
  protected readonly editable = (tr: Treatment) =>
    this.farmer() && this.now() <= Date.parse(tr.editableUntil);
  protected readonly editOf = (tr: Treatment) =>
    t('treatments.editOf', { substance: tr.substance.name, date: formatLocalDate(tr.appliedAt, LOCALE) });
  protected readonly editableUntil = (tr: Treatment) =>
    t('treatments.editableUntil', { time: formatLocalDateTime(tr.editableUntil, LOCALE) });

  constructor() {
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
    afterRender(() => {
      const last = this.lastFocus;
      if (!last || !gone(last) || !focusLost()) return;
      this.lastFocus = null;
      const title = this.host.querySelector<HTMLElement>('.at-card__title');
      ((this.addButton()?.nativeElement as HTMLElement | undefined) ?? title)?.focus();
    });
  }

  protected retry(): void {
    void this.query.refetch();
  }

  protected edit(target: Treatment | 'new'): void {
    if (!this.substances.data() && this.substances.failed()) {
      this.toasts.push({ tone: 'danger', text: t('treatments.substancesFailed') });
      void this.substances.refetch();
      return;
    }
    const key = (untracked(this.editing)?.key ?? 0) + 1;
    this.editing.set({ tr: target === 'new' ? undefined : target, key, open: true });
  }

  protected close(): void {
    this.treatmentForm()?.f.handOff();
    const cur = untracked(this.editing);
    if (cur) this.editing.set({ ...cur, open: false });
  }

  private refresh(): void {
    const id = this.field().id;
    this.cache.invalidate(treatmentsKey(id));
    this.cache.invalidate(fieldKey(id));
    this.cache.invalidate(FIELDS_KEY);
    if (this.alive()) void this.query.refetch();
  }

  protected saved(created: boolean): void {
    this.close();
    this.refresh();
    this.toasts.push({ tone: 'ok', text: t(created ? 'treatments.created' : 'treatments.saved') });
  }

  protected closedWindow(until: string): void {
    this.close();
    this.refresh();
    this.toasts.push({
      tone: 'danger',
      text: t('treatments.editClosed', { time: formatLocalDateTime(until, LOCALE) }),
    });
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, FieldFormComponent, TreatmentsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!query.data() && missing()) {
      <div class="at-page__header" [pageTitle]="t('page.field')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('fields.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/fields'">{{ t('fields.toList') }}</a>
        </div>
      </article>
    } @else {
      <div class="at-page__header" [pageTitle]="query.data()?.name ?? t('page.field')">
        @if (roles().farmer && query.data(); as field) {
          <div class="at-page__actions">
            <a class="at-button" [variant]="'primary'" [to]="'/batches/new?fieldId=' + field.id">{{
              t('fields.batch')
            }}</a>
            <button class="at-button" (click)="openEdit()">{{ t('fields.edit') }}</button>
            <button class="at-button" [variant]="'ghost'" [icon]="'trash'" (click)="dialog.set('delete')">
              {{ t('fields.delete') }}
            </button>
          </div>
        }
      </div>
      @if (!query.data() && query.failed()) {
        ${loadFailed("t('fields.failed')", 'query.fetching()', 'retry()')}
      } @else if (!query.data()) {
        ${areaLoading(2)}
      } @else {
        <div style="${GAP}">
          <article class="at-card">
            <div class="at-card__body"><dl class="at-card__facts" [facts]="facts()"></dl></div>
          </article>
          ${MAP}
          <div [atTreatments]="query.data()!" [farmer]="roles().farmer"></div>
        </div>
      }
      @if (query.data(); as field) {
        @if (regions.data(); as list) {
          @for (k of editKeys(); track k) {
            <dialog
              class="at-dialog"
              [open]="dialog() === 'edit'"
              [dialogTitle]="t('fields.editTitle')"
              (closed)="closeEdit(ef)"
            >
              <form
                [atFieldForm]="'field-edit'"
                #ef="atFieldForm"
                [inDialog]="true"
                [field]="field"
                [regions]="list"
                (saved)="saved($event)"
              ></form>
              <div class="at-dialog__actions">
                <button class="at-button" [variant]="'ghost'" (click)="closeEdit(ef)">
                  {{ t('action.cancel') }}
                </button>
                ${outsideSubmit('ef', "'field-edit'", "t('action.save')")}
              </div>
            </dialog>
          }
        }
      }
      <dialog
        class="at-dialog"
        [open]="dialog() === 'delete'"
        [dialogTitle]="t('fields.deleteTitle')"
        (closed)="closeDelete()"
      >
        <div style="${FORM_GRID}">
          @if (deleteFailure.message()) {
            <p class="at-field__error" role="alert" style="margin: 0">{{ deleteFailure.message() }}</p>
          }
          <p style="margin: 0">{{ t('fields.deleteText', { name: query.data()?.name ?? '' }) }}</p>
        </div>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closeDelete()">
            {{ t('action.cancel') }}
          </button>
          <button class="at-button" [variant]="'danger'" [busy]="deleting()" (click)="remove()">
            {{ t('fields.delete') }}
          </button>
        </div>
      </dialog>
    }`,
})
export class FieldPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  protected readonly deleteFailure = dialogAlert();
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  private readonly id = computed(() => this.params().get('id') ?? '');
  protected readonly roles = computed(() => rolesOf(this.session.me()?.roles));
  protected readonly regions = injectDictionary('regions');
  protected readonly dialog = signal<'edit' | 'delete' | null>(null);
  private readonly editKey = signal(0);
  protected readonly editKeys = computed(() => [this.editKey()]);
  protected readonly deleting = signal(false);

  protected readonly query = injectQuery(
    () => {
      const id = this.id();
      return {
        key: fieldKey(id),
        load: () => call<FieldT>(this.session.api.GET('/fields/{id}', { params: { path: { id } } })),
      };
    },
    { failedText: t('fields.failed') },
  );
  protected readonly missing = computed(() => notFound(this.query.error()));
  protected readonly facts = computed<CardFact[]>(() => {
    const field = this.query.data();
    if (!field) return [];
    return [
      ...(this.roles().overseer
        ? [{ key: 'farm', term: t('fields.farm'), value: field.organization.name }]
        : []),
      { key: 'region', term: t('fields.region'), value: field.region.name },
      { key: 'area', term: t('fields.area'), value: formatDecimal(field.areaHa, LOCALE) },
      { key: 'count', term: t('fields.treatments'), value: String(field.treatmentsCount) },
      { key: 'last', term: t('fields.lastTreatment'), value: dateOrDash(field.lastTreatmentAt) },
      ...(field.geometry ? [] : [{ key: 'geo', term: t('field.geometry'), value: t('fields.noGeometry') }]),
    ];
  });
  private readonly mapsKey = inject(MAPS_KEY);
  protected readonly mapFields = computed(() => {
    const field = this.query.data();
    return field ? mappable([field], this.mapsKey) : [];
  });
  protected readonly mapFs = injectFullscreen();

  protected retry(): void {
    void this.query.refetch();
  }

  protected openEdit(): void {
    if (!this.regions.data() && this.regions.failed()) {
      this.toasts.push({ tone: 'danger', text: t('fields.regionsFailed') });
      void this.regions.refetch();
      return;
    }
    this.editKey.update((k) => k + 1);
    this.dialog.set('edit');
  }

  protected closeEdit(form: FieldFormComponent): void {
    form.f.handOff();
    this.dialog.set(null);
  }

  protected closeDelete(): void {
    this.deleteFailure.handOff();
    this.dialog.set(null);
  }

  protected saved(f: FieldT): void {
    this.cache.put(fieldKey(f.id), f, this.cache.generation);
    this.cache.invalidate(FIELDS_KEY);
    this.toasts.push({ tone: 'ok', text: t('fields.saved', { name: f.name }) });
    if (!this.alive()) return;
    this.dialog.set(null);
    void this.query.refetch();
  }

  protected async remove(): Promise<void> {
    const field = this.query.data();
    if (!field) return;
    const generation = this.session.generation;
    this.deleting.set(true);
    this.deleteFailure.clear();
    try {
      await call(this.session.api.DELETE('/fields/{id}', { params: { path: { id: field.id } } }));
    } catch (e) {
      if (this.live(generation)) this.deleteFailure.error(e);
      this.deleting.set(false);
      return;
    }
    this.cache.invalidate(fieldKey(field.id));
    this.cache.invalidate(FIELDS_KEY);
    if (generation === this.session.generation)
      this.toasts.push({ tone: 'ok', text: t('fields.deleted', { name: field.name }) });
    if (!this.live(generation)) return;
    this.deleting.set(false);
    this.dialog.set(null);
    void this.router.navigateByUrl('/fields');
  }
}
