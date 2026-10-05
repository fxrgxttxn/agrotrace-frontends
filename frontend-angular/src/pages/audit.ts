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
import { type Schemas } from '@agrotrace/api-client';
import {
  auditActionLabel,
  auditFieldLabel,
  auditValue,
  enumLabel,
  formatLocalDateTime,
} from '@agrotrace/i18n';
import { call } from '../app/api';
import { DateFilterComponent } from '../app/date-filter';
import { injectDictionary } from '../app/dictionaries';
import { LOCALE, t } from '../app/i18n';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { injectQuery } from '../app/query';
import { SessionService } from '../app/session';
import { FieldContext, PageToolbarComponent, ToolbarFiltersDirective, UI, type CardFact } from '../app/ui';
import { areaLoading, listChanged, loadFailed } from './lists';

type Entry = Schemas['AuditEntry'];
type EntityType = Schemas['AuditEntityType'];
type Backend = Entry['backend'];

const SIZE = 20;
const VALUE = 'overflow-wrap: anywhere; white-space: pre-wrap';
const STACK = 'display: grid; gap: var(--sp-4)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPES: readonly EntityType[] = [
  'organization',
  'user',
  'field',
  'treatment',
  'batch',
  'waybill',
  'labTest',
  'recall',
  'recallTask',
  'complaint',
  'product',
  'substance',
  'indicator',
  'norm',
  'region',
  'file',
  'batchDocument',
];
const BACKENDS: readonly Backend[] = ['express', 'django', 'laravel', 'seed', 'system'];

const SPEC: ListSpec = {
  sort: ['createdAt'],
  enums: { entityType: ENTITY_TYPES, backend: BACKENDS },
  uuids: ['actorId', 'entityId'],
  dates: ['from', 'to'],
  patterns: { action: /^[A-Za-z0-9._-]{1,64}$/ },
};

const at = (iso: string) => formatLocalDateTime(iso, LOCALE);

@Component({
  selector: 'div.at-field[idFilter]',
  standalone: true,
  imports: [...UI],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FieldContext, useExisting: IdFilterComponent }],
  template: `<label class="at-field__label" [attr.for]="idFilter()">{{ label() }}</label>
    <input
      class="at-input at-mono"
      autocomplete="off"
      [value]="text()"
      (input)="typed($any($event.target).value)"
    />
    @if (bad()) {
      <p class="at-field__error" [attr.id]="errorId()" role="alert">{{ t('validation.uuid') }}</p>
    }`,
  host: { '[attr.data-invalid]': "bad() ? '' : null" },
})
export class IdFilterComponent extends FieldContext {
  protected readonly t = t;
  readonly idFilter = input.required<string>();
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly valueChange = output<string | null>();
  protected readonly text = signal('');
  protected readonly bad = computed(() => this.text().trim() !== '' && !UUID.test(this.text().trim()));
  readonly controlId = computed(() => this.idFilter());
  readonly errorId = computed(() => (this.bad() ? `${this.idFilter()}-error` : null));
  readonly invalid = computed(() => this.bad());

  constructor() {
    super();
    effect(
      () => {
        const v = this.value();
        untracked(() => this.text.set(v));
      },
      { allowSignalWrites: true },
    );
  }

  protected typed(v: string): void {
    this.text.set(v);
    if (v.trim() === '') this.valueChange.emit(null);
    else if (UUID.test(v.trim())) this.valueChange.emit(v.trim().toLowerCase());
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...UI, PageToolbarComponent, ToolbarFiltersDirective, DateFilterComponent, IdFilterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.audit')"></div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ action: $event.trim() })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-entity'" [label]="t('audit.entity')">
          <select class="at-select" (change)="list.set({ entityType: $any($event.target).value })">
            <option value="" [selected]="entityType() === ''">{{ t('filters.any') }}</option>
            @for (x of entityTypes; track x) {
              <option [value]="x" [selected]="entityType() === x">{{ label('AuditEntityType', x) }}</option>
            }
          </select>
        </div>
        <div
          class="at-field"
          [idFilter]="'filter-entity-id'"
          [label]="t('audit.entityId')"
          [value]="entityId()"
          (valueChange)="list.set({ entityId: $event })"
        ></div>
        <div
          class="at-field"
          [idFilter]="'filter-actor'"
          [label]="t('audit.actorId')"
          [value]="actorId()"
          (valueChange)="list.set({ actorId: $event })"
        ></div>
        <div class="at-field" [fieldId]="'filter-backend'" [label]="t('audit.backend')">
          <select class="at-select" (change)="list.set({ backend: $any($event.target).value })">
            <option value="" [selected]="backend() === ''">{{ t('filters.any') }}</option>
            @for (x of backends; track x) {
              <option [value]="x" [selected]="backend() === x">{{ label('AuditEntry.backend', x) }}</option>
            }
          </select>
        </div>
        <div
          class="at-field"
          [dateFilter]="'filter-from'"
          [label]="t('audit.from')"
          [value]="from()"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'filter-to'"
          [label]="t('audit.to')"
          [value]="to()"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('audit.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'query.refetch()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        @if (action() || count()) {
          <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
            <button class="at-button" [variant]="'primary'" (click)="list.reset()">
              {{ t('filters.reset') }}
            </button>
          </div>
        } @else {
          <div class="at-empty" [art]="'empty-search'" [text]="t('audit.empty')"></div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.audit')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template
            [atColumn]="'time'"
            [header]="t('audit.time')"
            [primary]="true"
            [sortField]="'createdAt'"
            let-e
          >
            <span class="at-table__primary"
              ><span>{{ at(e.createdAt) }}</span
              ><span class="at-table__sub at-mono">{{ e.action }}</span></span
            >
          </ng-template>
          <ng-template [atColumn]="'actor'" [header]="t('audit.actor')" let-e>
            @if (e.actor) {
              <span class="at-table__primary"
                ><a
                  [to]="hrefWith({ actorId: e.actor.id })"
                  [attr.aria-label]="t('audit.byActor', { name: e.actor.fullName })"
                  >{{ e.actor.fullName }}</a
                ><span class="at-table__sub">{{ e.actor.organization.name }}</span></span
              >
            } @else {
              {{ t('audit.system') }}
            }
          </ng-template>
          <ng-template [atColumn]="'entity'" [header]="t('audit.entity')" let-e>
            <span class="at-table__primary"
              ><span>{{ label('AuditEntityType', e.entityType) }}</span>
              @if (e.entityId) {
                <a
                  class="at-mono"
                  [to]="hrefWith({ entityType: e.entityType, entityId: e.entityId })"
                  [attr.aria-label]="
                    t('audit.byEntity', { entity: label('AuditEntityType', e.entityType), id: e.entityId })
                  "
                  >{{ short(e.entityId) }}</a
                >
              }
            </span>
          </ng-template>
          <ng-template [atColumn]="'backend'" [header]="t('audit.backend')" let-e>{{
            label('AuditEntry.backend', e.backend)
          }}</ng-template>
          <ng-template atRowActions let-e>
            <button
              class="at-button"
              [size]="'s'"
              [attr.aria-label]="t('audit.diffOf', { id: e.id })"
              (click)="viewing.set(e)"
            >
              {{ t('audit.diff') }}
            </button>
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
    <dialog
      class="at-dialog"
      [open]="viewing() !== null"
      [size]="'l'"
      [lightDismiss]="true"
      [dialogTitle]="
        viewing()
          ? t('audit.diffTitle', {
              entity: label('AuditEntityType', viewing()!.entityType),
              action: actionLabel(viewing()!.action),
            })
          : ''
      "
      (closed)="viewing.set(null)"
    >
      @if (viewing(); as e) {
        <div style="${STACK}">
          <dl class="at-card__facts">
            @for (f of facts(); track f.key) {
              <div>
                <dt>{{ f.term }}</dt>
                <dd>
                  @if (f.mono) {
                    <span class="at-mono">{{ f.value }}</span>
                  } @else {
                    {{ f.value }}
                  }
                </dd>
              </div>
            }
          </dl>
          @if (diffRows().length) {
            <div
              class="at-table-wrap"
              [cards]="true"
              [caption]="t('audit.changes')"
              [rows]="diffRows()"
              [rowKey]="diffKey"
            >
              <ng-template [atColumn]="'field'" [header]="t('audit.field')" [primary]="true" let-r>
                <span class="at-table__primary"
                  ><span>{{ fieldLabel(r.field) }}</span
                  ><span class="at-table__sub at-mono">{{ r.field }}</span></span
                >
              </ng-template>
              <ng-template [atColumn]="'before'" [header]="t('audit.before')" let-r>
                <span style="${VALUE}">{{ shown(r.before, r.field) }}</span>
              </ng-template>
              <ng-template [atColumn]="'after'" [header]="t('audit.after')" let-r>
                <span style="${VALUE}">{{ shown(r.after, r.field) }}</span>
              </ng-template>
            </div>
          } @else {
            <p style="margin: 0">{{ t('audit.noChanges') }}</p>
          }
        </div>
      }
      <div class="at-dialog__actions">
        <button class="at-button" [variant]="'ghost'" (click)="viewing.set(null)">
          {{ t('shell.close') }}
        </button>
      </div>
    </dialog>`,
})
export class AuditPage {
  protected readonly t = t;
  protected readonly at = at;
  protected readonly size = SIZE;
  protected readonly entityTypes = ENTITY_TYPES;
  protected readonly backends = BACKENDS;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly short = (id: string) => id.slice(0, 8);
  protected readonly rowKey = (e: Entry) => String(e.id);
  protected readonly diffKey = (r: { field: string }) => r.field;
  protected readonly sortOptions = [
    { value: 'createdAt,desc', label: t('audit.sort.newest') },
    { value: 'createdAt,asc', label: t('audit.sort.oldest') },
  ];
  private readonly session = inject(SessionService);
  protected readonly list = injectListParams('/admin/audit', SPEC);
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly action = this.p('action');
  protected readonly entityType = this.p('entityType');
  protected readonly entityId = this.p('entityId');
  protected readonly actorId = this.p('actorId');
  protected readonly backend = this.p('backend');
  protected readonly from = this.p('from');
  protected readonly to = this.p('to');
  protected readonly count = computed(
    () =>
      [this.entityType(), this.entityId(), this.actorId(), this.backend(), this.from(), this.to()].filter(
        Boolean,
      ).length,
  );
  protected readonly search = computed(() => ({
    label: t('audit.action'),
    placeholder: t('audit.actionPlaceholder'),
    value: this.action(),
  }));
  protected readonly hrefWith = (patch: Record<string, string>) => {
    const next = new URLSearchParams(this.list.params());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    next.delete('page');
    return `/admin/audit?${next.toString()}`;
  };

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const f = {
        action: this.action(),
        entityType: this.entityType(),
        entityId: this.entityId(),
        actorId: this.actorId(),
        backend: this.backend(),
        from: this.from(),
        to: this.to(),
      };
      return {
        key: `audit?${JSON.stringify([page, sort, f])}`,
        load: () =>
          call<Schemas['AuditPage']>(
            this.session.api.GET('/audit-log', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(f.action ? { action: f.action } : {}),
                  ...(f.entityType ? { entityType: f.entityType as EntityType } : {}),
                  ...(f.entityId ? { entityId: f.entityId } : {}),
                  ...(f.actorId ? { actorId: f.actorId } : {}),
                  ...(f.backend ? { backend: f.backend as Backend } : {}),
                  ...(f.from ? { from: f.from } : {}),
                  ...(f.to ? { to: f.to } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('audit.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));

  protected readonly viewing = signal<Entry | null>(null);
  private readonly has = (...fields: string[]) => {
    const e = this.viewing();
    return e !== null && fields.some((f) => f in e.diff);
  };
  private readonly products = injectDictionary('products', () => this.has('productId'));
  private readonly indicators = injectDictionary('indicators', () => this.has('indicatorId'));
  private readonly substances = injectDictionary('substances', () => this.has('substanceId'));
  private readonly regions = injectDictionary('regions', () => this.has('regionId', 'regionCode'));
  private readonly resolve = (field: string, value: string): string | undefined => {
    const byId = (list: { id: string; name: string }[] | null | undefined) =>
      list?.find((x) => x.id === value)?.name;
    if (field === 'productId') return byId(this.products.data());
    if (field === 'indicatorId') return byId(this.indicators.data());
    if (field === 'substanceId') return byId(this.substances.data());
    if (field === 'regionId') return byId(this.regions.data());
    if (field === 'regionCode') return this.regions.data()?.find((r) => r.code === value)?.name;
    return undefined;
  };
  protected readonly shown = (v: unknown, field: string): string => {
    const e = this.viewing();
    return auditValue(
      t,
      v,
      LOCALE,
      e ? { field, entityType: e.entityType, resolve: this.resolve } : undefined,
    );
  };
  protected readonly fieldLabel = (field: string) => auditFieldLabel(t, field);
  protected readonly actionLabel = (action: string) => auditActionLabel(t, action);
  protected readonly diffRows = computed(() => {
    const e = this.viewing();
    return e
      ? Object.entries(e.diff).map(([field, pair]) => ({ field, before: pair[0], after: pair[1] }))
      : [];
  });
  protected readonly facts = computed<(CardFact & { mono?: boolean })[]>(() => {
    const e = this.viewing();
    if (!e) return [];
    return [
      { key: 'time', term: t('audit.time'), value: at(e.createdAt) },
      {
        key: 'actor',
        term: t('audit.actor'),
        value: e.actor ? `${e.actor.fullName}, ${e.actor.organization.name}` : t('audit.system'),
      },
      ...(e.entityId ? [{ key: 'id', term: t('audit.entityId'), value: e.entityId, mono: true }] : []),
      { key: 'backend', term: t('audit.backend'), value: enumLabel(t, 'AuditEntry.backend', e.backend) },
      ...(e.ip ? [{ key: 'ip', term: t('audit.ip'), value: e.ip, mono: true }] : []),
      ...(e.requestId ? [{ key: 'req', term: t('audit.requestId'), value: e.requestId, mono: true }] : []),
    ];
  });

  constructor() {
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
  }
}
