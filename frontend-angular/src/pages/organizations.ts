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
  type OnInit,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ApiProblem, type Schemas } from '@agrotrace/api-client';
import { enumLabel, formatLocalDate } from '@agrotrace/i18n';
import { OrganizationAdminPatchSchema } from '@agrotrace/validation';
import { APPLICATION, ORG_TONE, orgActions, orgTarget, type OrgAction } from '../app/admin';
import { injectAlive, injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { injectDictionary } from '../app/dictionaries';
import { dialogAlert, errorTone, FocusAfterWaitDirective, SchemaForm, wireSchema } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { injectQuery, QueryCache } from '../app/query';
import { SessionService } from '../app/session';
import { PageToolbarComponent, ToastService, ToolbarFiltersDirective, UI, type Tone } from '../app/ui';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type Org = Schemas['OrganizationAdmin'];
type Status = Schemas['OrganizationStatus'];
type OrgType = Schemas['OrganizationType'];

const SIZE = 20;
const STACK = 'display: grid; gap: var(--sp-4)';
const STATUSES: readonly Status[] = ['PENDING', 'MANUAL_CHECK', 'ACTIVE', 'REJECTED', 'SUSPENDED'];
const TYPES: readonly OrgType[] = ['FARM', 'PROCESSOR', 'LAB', 'RETAILER', 'AUTHORITY', 'PLATFORM'];
const APPLICATIONS = '__applications';
const SEVERAL = '__several';
const KEY = 'adminOrganizations?';

const SPEC: ListSpec = {
  sort: ['createdAt', 'name'],
  enums: { status: STATUSES, type: TYPES },
  patterns: { regionCode: /^[0-9A-Z-]{1,8}$/ },
  texts: ['q'],
};

const CONFIRMED: readonly OrgAction[] = ['reject', 'suspend'];

const IMPORTS = [
  ...UI,
  ReactiveFormsModule,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
];

interface EditValues extends Record<string, unknown> {
  name: string;
  address: string;
  regionCode: string;
}

@Component({
  selector: 'form[atOrgForm]',
  standalone: true,
  exportAs: 'atOrgForm',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (f.message()) {
      <p class="at-field__error" role="alert" style="margin: 0">{{ f.message() }}</p>
    }
    <div class="at-field" [fieldId]="'org-name'" [label]="t('field.name')" [error]="f.errorOf('name')">
      <input class="at-input" autocomplete="off" name="name" [formControl]="f.control('name')" />
    </div>
    <div
      class="at-field"
      [fieldId]="'org-address'"
      [label]="t('field.address')"
      [error]="f.errorOf('address')"
    >
      <textarea class="at-textarea" rows="2" name="address" [formControl]="f.control('address')"></textarea>
    </div>
    <div
      class="at-field"
      [fieldId]="'org-region'"
      [label]="t('field.regionCode')"
      [error]="f.errorOf('regionCode')"
    >
      <select class="at-select" name="regionCode" [formControl]="f.control('regionCode')">
        @if (!regionKnown()) {
          <option [value]="atOrgForm().region.code">{{ atOrgForm().region.name }}</option>
        }
        @for (r of regions(); track r.id) {
          <option [value]="r.code">{{ r.name }}</option>
        }
      </select>
    </div>`,
  host: { id: 'org-form', novalidate: '', style: FORM_GRID, '(submit)': 'submit($event)' },
})
export class OrgFormComponent implements OnInit {
  protected readonly t = t;
  readonly atOrgForm = input.required<Org>();
  readonly regions = input.required<Schemas['RegionEntry'][]>();
  readonly saved = output<Org>();
  readonly gone = output<unknown>();
  readonly unchanged = output<void>();
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly live = injectLive();
  protected readonly regionKnown = computed(() =>
    this.regions().some((r) => r.code === this.atOrgForm().region.code),
  );
  readonly f = new SchemaForm<EditValues>(
    wireSchema<EditValues>(
      OrganizationAdminPatchSchema,
      (v) => this.full(v),
      (v): Record<string, string> => (v.name.trim() === '' ? { name: 'validation.required' } : {}),
    ),
    { name: '', address: '', regionCode: '' },
    ['name', 'address', 'regionCode'],
    { dialog: true },
  );
  private readonly toasts = inject(ToastService);

  ngOnInit(): void {
    const o = this.atOrgForm();
    this.f.reset({ name: o.name, address: o.address ?? '', regionCode: o.region.code });
  }

  private full(v: EditValues) {
    return {
      name: v.name.trim(),
      address: v.address.trim() === '' ? null : v.address.trim(),
      regionCode: v.regionCode,
    };
  }

  private toWire(v: EditValues) {
    const o = this.atOrgForm();
    const f = this.full(v);
    return {
      ...(f.name !== o.name ? { name: f.name } : {}),
      ...(f.address !== o.address ? { address: f.address } : {}),
      ...(f.regionCode !== o.region.code ? { regionCode: f.regionCode } : {}),
    };
  }

  protected submit(e: Event): void {
    void this.f.submit(e, async () => {
      const body = this.toWire(this.f.group.getRawValue() as EditValues);
      if (Object.keys(body).length === 0) {
        this.unchanged.emit();
        return;
      }
      const generation = this.session.generation;
      try {
        const next = await call<Org>(
          this.session.api.PATCH('/admin/organizations/{id}', {
            params: { path: { id: this.atOrgForm().id } },
            body,
          }),
        );
        if (generation !== this.session.generation) return;
        this.cache.invalidate(KEY);
        this.toasts.push({ tone: 'ok', text: t('orgs.saved', { name: next.name }) });
        this.saved.emit(next);
      } catch (e) {
        const gone = e instanceof ApiProblem && e.status === 404;
        if (gone && generation === this.session.generation) this.cache.invalidate(KEY);
        if (!this.live(generation)) return;
        if (gone) this.gone.emit(e);
        else this.f.fail(e);
      }
    });
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, OrgFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.organizations')"></div>
    <div
      class="at-page__toolbar"
      [search]="search()"
      [count]="count()"
      (searchChange)="list.set({ q: $event })"
    >
      <ng-template atToolbarFilters>
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('orgs.status')">
          <select class="at-select" (change)="pickStatus($any($event.target).value)">
            <option value="" [selected]="statusValue() === ''">{{ t('filters.any') }}</option>
            <!-- prettier-ignore -->
            <option [value]="applications" [selected]="statusValue() === applications">{{ t('orgs.applications') }}</option>
            @if (statusValue() === several) {
              <!-- prettier-ignore -->
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: status().length }) }}</option>
            }
            @for (s of statuses; track s) {
              <!-- prettier-ignore -->
              <option [value]="s" [selected]="statusValue() === s">{{ label('OrganizationStatus', s) }}</option>
            }
          </select>
        </div>
        <div class="at-field" [fieldId]="'filter-type'" [label]="t('orgs.type')">
          <select class="at-select" (change)="list.set({ type: $any($event.target).value })">
            <option value="" [selected]="typeValue() === ''">{{ t('filters.any') }}</option>
            @if (typeValue() === several) {
              <!-- prettier-ignore -->
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: type().length }) }}</option>
            }
            @for (x of types; track x) {
              <option [value]="x" [selected]="typeValue() === x">{{ label('OrganizationType', x) }}</option>
            }
          </select>
        </div>
        <div class="at-field" [fieldId]="'filter-region'" [label]="t('orgs.region')">
          <select class="at-select" (change)="list.set({ regionCode: $any($event.target).value })">
            <option value="" [selected]="regionCode() === ''">{{ t('filters.any') }}</option>
            @if (regionCode() && !regionKnown()) {
              <option [value]="regionCode()" [selected]="true">{{ regionCode() }}</option>
            }
            @for (r of regions.data() ?? []; track r.id) {
              <option [value]="r.code" [selected]="r.code === regionCode()">{{ r.name }}</option>
            }
          </select>
        </div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('orgs.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
    } @else if (!query.data() || gap() === 'pastEnd') {
      ${areaLoading(2)}
    } @else if (gap() === 'changed') {
      ${listChanged('query.fetching()', 'query.refetch()')}
    } @else if (items().length === 0) {
      <article class="at-card">
        <div
          class="at-empty"
          [art]="'empty-search'"
          [text]="
            statusValue() === applications && !q() && count() === 1
              ? t('orgs.noApplications')
              : t('empty.search')
          "
        >
          <button class="at-button" [variant]="'primary'" (click)="list.reset()">
            {{ t('filters.reset') }}
          </button>
        </div>
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.organizations')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template
            [atColumn]="'name'"
            [header]="t('orgs.name')"
            [primary]="true"
            [sortField]="'name'"
            let-o
          >
            <span class="at-table__primary"
              ><span>{{ o.name }}</span
              ><span class="at-table__sub">{{ t('orgs.inn', { inn: o.inn }) }}</span
              ><span class="at-table__sub">{{ typeRegion(o) }}</span></span
            >
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('orgs.status')" [status]="true" let-o>
            <span class="at-chip" [tone]="tone(o.status)">{{ label('OrganizationStatus', o.status) }}</span>
          </ng-template>
          <ng-template [atColumn]="'head'" [header]="t('orgs.head')" let-o>
            @if (o.head) {
              <span class="at-table__primary"
                ><span>{{ o.head.fullName }}</span
                ><span class="at-table__sub" style="overflow-wrap: anywhere">{{ o.head.email }}</span></span
              >
            } @else {
              —
            }
          </ng-template>
          <ng-template
            [atColumn]="'created'"
            [header]="t('orgs.createdAt')"
            [sortField]="'createdAt'"
            let-o
            >{{ day(o.createdAt) }}</ng-template
          >
          <ng-template atRowActions let-o>
            @for (action of actionsOf(o); track action) {
              <button
                class="at-button"
                [size]="'s'"
                [variant]="action === 'approve' ? 'primary' : confirmed(action) ? 'danger' : 'secondary'"
                [busy]="busyId() === o.id && !confirming()"
                [disabled]="wait.left() > 0 || (busyId() !== null && busyId() !== o.id)"
                [attr.aria-label]="t('orgs.actionOf.' + action, { name: o.name })"
                (click)="press(o, action)"
              >
                {{ t('orgs.action.' + action) }}
              </button>
            }
            <button
              class="at-button"
              [size]="'s'"
              [variant]="'ghost'"
              [attr.aria-label]="t('orgs.editOf', { name: o.name })"
              (click)="editing.set(o)"
            >
              {{ t('orgs.edit') }}
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
      [open]="confirming() !== null"
      [dialogTitle]="
        confirming()
          ? t('orgs.confirm.' + confirming()!.action + '.title', { name: confirming()!.org.name })
          : ''
      "
      (closed)="closeConfirm()"
    >
      <div style="${STACK}">
        @if (failure.message()) {
          <p class="at-field__error" role="alert" style="margin: 0">{{ failure.message() }}</p>
        }
        <p style="margin: 0">{{ confirming() ? t('orgs.confirm.' + confirming()!.action + '.text') : '' }}</p>
      </div>
      <div class="at-dialog__actions">
        <button class="at-button" [variant]="'ghost'" (click)="closeConfirm()">
          {{ t('action.cancel') }}
        </button>
        <button
          class="at-button"
          [variant]="'danger'"
          [busy]="busyId() !== null"
          [disabled]="wait.left() > 0"
          [focusAfterWait]="wait.left()"
          (click)="confirm()"
        >
          {{
            wait.left() > 0
              ? t('auth.retryIn', { seconds: wait.left() })
              : confirming()
                ? t('orgs.confirm.' + confirming()!.action + '.button')
                : ''
          }}
        </button>
      </div>
    </dialog>
    @if (editing(); as o) {
      <dialog
        class="at-dialog"
        [open]="true"
        [dialogTitle]="t('orgs.editTitle', { name: o.name })"
        (closed)="closeEdit(ef)"
      >
        <form
          #ef="atOrgForm"
          [atOrgForm]="o"
          [regions]="regions.data() ?? []"
          (saved)="saved()"
          (gone)="gone($event, o)"
          (unchanged)="editing.set(null)"
        ></form>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closeEdit(ef)">
            {{ t('action.cancel') }}
          </button>
          <button
            class="at-button"
            [type]="'submit'"
            [attr.form]="'org-form'"
            [variant]="'primary'"
            [busy]="ef.f.busy()"
            [disabled]="ef.f.wait() > 0"
            [focusAfterWait]="ef.f.wait()"
          >
            {{ ef.f.wait() > 0 ? t('auth.retryIn', { seconds: ef.f.wait() }) : t('action.save') }}
          </button>
        </div>
      </dialog>
    }`,
})
export class OrganizationsPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly applications = APPLICATIONS;
  protected readonly statuses = STATUSES;
  protected readonly types = TYPES;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly tone = (s: Status): Tone => ORG_TONE[s];
  protected readonly day = (iso: string) => formatLocalDate(iso, LOCALE);
  protected readonly rowKey = (o: Org) => o.id;
  protected readonly typeRegion = (o: Org) =>
    t('orgs.typeRegionOf', { type: enumLabel(t, 'OrganizationType', o.type), region: o.region.name });
  protected readonly actionsOf = (o: Org) => orgActions(o.status, o.type);
  protected readonly confirmed = (a: OrgAction) => CONFIRMED.includes(a);
  protected readonly sortOptions = [
    { value: 'createdAt,desc', label: t('orgs.sort.created') },
    { value: 'name,asc', label: t('orgs.sort.name') },
  ];
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  protected readonly regions = injectDictionary('regions');
  protected readonly list = injectListParams('/admin/organizations', SPEC);
  protected readonly q = computed(() => this.list.params().get('q') ?? '');
  protected readonly status = computed(() => this.list.params().getAll('status'));
  protected readonly type = computed(() => this.list.params().getAll('type'));
  protected readonly regionCode = computed(() => this.list.params().get('regionCode') ?? '');
  protected readonly regionKnown = computed(() =>
    Boolean(this.regions.data()?.some((r) => r.code === this.regionCode())),
  );
  protected readonly count = computed(
    () => (this.status().length ? 1 : 0) + (this.type().length ? 1 : 0) + (this.regionCode() ? 1 : 0),
  );
  protected readonly statusValue = computed(() => {
    const s = this.status();
    return s.length === 2 && APPLICATION.every((x) => s.includes(x))
      ? APPLICATIONS
      : s.length === 1
        ? s[0]!
        : s.length > 1
          ? SEVERAL
          : '';
  });
  protected readonly typeValue = computed(() => {
    const x = this.type();
    return x.length === 1 ? x[0]! : x.length > 1 ? SEVERAL : '';
  });
  protected readonly search = computed(() => ({
    label: t('orgs.search'),
    placeholder: t('orgs.searchPlaceholder'),
    value: this.q(),
  }));

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const type = this.type();
      const regionCode = this.regionCode();
      return {
        key: `${KEY}${JSON.stringify([page, sort, q, status, type, regionCode])}`,
        load: () =>
          call<Schemas['OrganizationAdminPage']>(
            this.session.api.GET('/admin/organizations', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(q ? { q } : {}),
                  ...(status.length ? { status: status as Status[] } : {}),
                  ...(type.length ? { type: type as OrgType[] } : {}),
                  ...(regionCode ? { regionCode } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('orgs.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));

  protected readonly busyId = signal<string | null>(null);
  protected readonly wait = countdown();
  protected readonly confirming = signal<{ org: Org; action: OrgAction } | null>(null);
  protected readonly failure = dialogAlert();
  protected readonly editing = signal<Org | null>(null);

  constructor() {
    effect(() => {
      const d = this.query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => this.list.clampPage(d.total, SIZE));
    });
  }

  protected pickStatus(value: string): void {
    this.list.set({ status: value === APPLICATIONS ? [...APPLICATION] : value });
  }

  private reread(): void {
    this.cache.invalidate(KEY);
    if (this.alive()) void this.query.refetch();
  }

  private describe(e: unknown, org: Org): string {
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      this.reread();
      return t('orgs.stateChanged', {
        name: org.name,
        status: enumLabel(t, 'OrganizationStatus', String(e.params?.['from'] ?? '')),
      });
    }
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      this.reread();
      return t('orgs.busy', { name: org.name });
    }
    if (e instanceof ApiProblem && e.status === 404) {
      this.reread();
      return t('orgs.gone', { name: org.name });
    }
    if (e instanceof ApiProblem && e.status === 429) this.wait.start(retryAfterOf(e));
    return errorText(e);
  }

  protected press(o: Org, action: OrgAction): void {
    if (CONFIRMED.includes(action)) {
      this.failure.clear();
      this.confirming.set({ org: o, action });
    } else void this.act(o, action);
  }

  protected confirm(): void {
    const c = this.confirming();
    if (c) void this.act(c.org, c.action);
  }

  private async act(org: Org, action: OrgAction): Promise<void> {
    const generation = this.session.generation;
    this.busyId.set(org.id);
    this.failure.clear();
    try {
      const next =
        action === 'approve'
          ? await call<Org>(
              this.session.api.POST('/admin/organizations/{id}/approve', {
                params: { path: { id: org.id } },
              }),
            )
          : await call<Org>(
              this.session.api.PATCH('/admin/organizations/{id}', {
                params: { path: { id: org.id } },
                body: { status: orgTarget(action) as 'ACTIVE' | 'REJECTED' | 'SUSPENDED' },
              }),
            );
      if (generation !== this.session.generation) return;
      this.cache.invalidate(KEY);
      this.toasts.push({ tone: 'ok', text: t(`orgs.done.${action}`, { name: next.name }) });
      if (!this.alive()) return;
      this.confirming.set(null);
      this.reread();
    } catch (e) {
      if (!this.live(generation)) return;
      const text = this.describe(e, org);
      const stale = e instanceof ApiProblem && (e.code === 'INVALID_TRANSITION' || e.status === 404);
      if (stale) this.confirming.set(null);
      if (CONFIRMED.includes(action) && !stale) this.failure.show(text, errorTone(e));
      else this.toasts.push({ tone: errorTone(e), text });
    } finally {
      if (this.alive()) this.busyId.set(null);
    }
  }

  protected closeConfirm(): void {
    this.failure.handOff();
    this.confirming.set(null);
  }

  protected closeEdit(form: OrgFormComponent): void {
    form.f.handOff();
    this.editing.set(null);
  }

  protected saved(): void {
    this.editing.set(null);
    this.reread();
  }

  protected gone(e: unknown, o: Org): void {
    this.editing.set(null);
    this.toasts.push({ tone: 'danger', text: this.describe(e, o) });
  }
}
