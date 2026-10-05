import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
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
import { checkDiscrepancy, compareDecimalStrings, gramsToKg, kgToGrams } from '@agrotrace/domain';
import { enumLabel, formatDecimal, formatLocalDateTime, formatPercent } from '@agrotrace/i18n';
import { WaybillAcceptSchema, WaybillCreateSchema, WaybillRejectSchema } from '@agrotrace/validation';
import { injectAlive, injectLive } from '../app/alive';
import { call, countdown, errorText, retryAfterOf } from '../app/api';
import { DateFilterComponent } from '../app/date-filter';
import { actionOrigin, focusLost, restoreFocus } from '../app/focus';
import { dialogAlert, errorTone, FocusAfterWaitDirective, formAlert, normalizeDecimal } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { idempotency } from '../app/idempotency';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { ManualForm } from '../app/manual-form';
import { OrgPickerComponent } from '../app/org-picker';
import { injectQuery, QueryCache } from '../app/query';
import { SessionService } from '../app/session';
import {
  PageToolbarComponent,
  ToastService,
  ToolbarFiltersDirective,
  UI,
  type CardFact,
  type Tone,
} from '../app/ui';
import { BATCH_PREFIX, BATCHES_KEY, WAYBILLS_KEY, waybillKey } from './keys';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type Waybill = Schemas['Waybill'];
type WaybillStatus = Schemas['WaybillStatus'];
type BatchItem = Schemas['BatchListItem'];
type Item = Schemas['WaybillItem'];
const SIZE = 20;
const GAP = 'display: grid; gap: var(--sp-5)';
const WAYBILL_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const;
const SEVERAL = '__several';
const MASS = /^\d{1,9}\.\d{3}$/;

export const WAYBILL_TONE: Record<WaybillStatus, Tone> = {
  DRAFT: 'neutral',
  SENT: 'move',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
};

const notFound = (e: unknown) => e instanceof ApiProblem && e.status === 404;

const PARTICIPANT_SPEC: ListSpec = {
  sort: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  enums: { status: WAYBILL_STATUSES, direction: ['incoming', 'outgoing'] },
  dates: ['from', 'to'],
  texts: ['q'],
};
const OVERSEER_SPEC: ListSpec = {
  sort: ['createdAt', 'sentAt', 'acceptedAt', 'number'],
  enums: { status: WAYBILL_STATUSES },
  uuids: ['counterpartyOrgId'],
  dates: ['from', 'to'],
  texts: ['q'],
};

function rolesOf(roles: readonly string[] | undefined) {
  const has = (r: string) => (roles ?? []).includes(r);
  return {
    sender: has('FARMER') || has('PROCESSOR'),
    overseer: !(has('FARMER') || has('PROCESSOR') || has('RETAILER')),
  };
}

function totalKg(masses: string[]): string {
  return gramsToKg(masses.reduce((s, m) => s + kgToGrams(m), 0n));
}

const massText = (kg: string) => (LOCALE === 'ru' ? kg.replace('.', ',') : kg);

const IMPORTS = [
  ...UI,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  OrgPickerComponent,
  DateFilterComponent,
];

function statusChip(expr: string, size = 'undefined'): string {
  return `<span class="at-chip" [tone]="tone(${expr})" [size]="${size}">{{ label('WaybillStatus', ${expr}) }}</span>`;
}

function dialogMessage(expr: string): string {
  return `@if (${expr}) {
          <p class="at-field__error" role="alert" style="margin: 0">{{ ${expr} }}</p>
        }`;
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.waybills')">
      @if (roles().sender) {
        <div class="at-page__actions">
          <a class="at-button" [variant]="'primary'" [icon]="'plus'" [to]="'/waybills/new'">{{
            t('action.createWaybill')
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
        @if (!roles().overseer) {
          <div class="at-field" [fieldId]="'filter-direction'" [label]="t('waybills.direction')">
            <select class="at-select" (change)="list.set({ direction: $any($event.target).value })">
              <option value="" [selected]="direction() === ''">{{ t('filters.any') }}</option>
              <!-- prettier-ignore -->
              <option value="incoming" [selected]="direction() === 'incoming'">{{ t('waybillDirection.incoming') }}</option>
              <!-- prettier-ignore -->
              <option value="outgoing" [selected]="direction() === 'outgoing'">{{ t('waybillDirection.outgoing') }}</option>
            </select>
          </div>
        }
        <div class="at-field" [fieldId]="'filter-status'" [label]="t('waybills.status')">
          <select class="at-select" (change)="list.set({ status: $any($event.target).value })">
            <option value="" [selected]="statusValue() === ''">{{ t('filters.any') }}</option>
            @if (status().length > 1) {
              <!-- prettier-ignore -->
              <option [value]="several" disabled [selected]="true">{{ t('filters.several', { count: status().length }) }}</option>
            }
            @for (s of statuses; track s) {
              <option [value]="s" [selected]="s === statusValue()">{{ label('WaybillStatus', s) }}</option>
            }
          </select>
        </div>
        @if (roles().overseer) {
          <div
            class="at-field"
            [orgPicker]="'filter-counterparty'"
            [label]="t('waybills.counterparty')"
            [value]="counterpartyOrgId()"
            (valueChange)="list.set({ counterpartyOrgId: $event })"
          ></div>
        }
        <div
          class="at-field"
          [dateFilter]="'filter-from'"
          [label]="t('waybills.from')"
          [value]="from()"
          [max]="to() || undefined"
          (valueChange)="list.set({ from: $event })"
        ></div>
        <div
          class="at-field"
          [dateFilter]="'filter-to'"
          [label]="t('waybills.to')"
          [value]="to()"
          [min]="from() || undefined"
          (valueChange)="list.set({ to: $event })"
        ></div>
      </ng-template>
    </div>
    @if (!query.data() && query.failed()) {
      ${loadFailed("t('waybills.failed')", 'query.fetching()', 'retry()', 'badQuery()', 'list.reset()')}
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
          <div class="at-empty" [art]="'empty-waybills'" [text]="t('empty.waybills')">
            <a class="at-button" [variant]="'primary'" [to]="roles().sender ? '/waybills/new' : '/'">{{
              roles().sender ? t('action.createWaybill') : t('action.home')
            }}</a>
          </div>
        }
      </article>
    } @else {
      <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="display: grid; gap: var(--sp-4)">
        <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
        <div
          class="at-table-wrap"
          #table="atTable"
          [cards]="true"
          [caption]="t('page.waybills')"
          [rows]="items()"
          [rowKey]="rowKey"
          [sort]="list.sort()"
          (sortChange)="list.setSort($event)"
        >
          <ng-template
            [atColumn]="'number'"
            [header]="t('waybills.number')"
            [primary]="true"
            [sortField]="'number'"
            let-w
          >
            <span
              class="at-table__primary"
              [href]="'/waybills/' + w.id"
              [code]="w.number"
              [sub]="t('count.batches', { count: w.items.length })"
            ></span>
          </ng-template>
          <ng-template [atColumn]="'status'" [header]="t('waybills.status')" [status]="true" let-w>
            ${statusChip('w.status')}
          </ng-template>
          <ng-template [atColumn]="'sender'" [header]="t('waybills.sender')" let-w>{{
            w.sender.name
          }}</ng-template>
          <ng-template [atColumn]="'receiver'" [header]="t('waybills.receiver')" let-w>{{
            w.receiver.name
          }}</ng-template>
          <ng-template [atColumn]="'mass'" [header]="t('waybills.mass')" [numeric]="true" let-w>{{
            total(w)
          }}</ng-template>
          <ng-template
            [atColumn]="'created'"
            [header]="t('waybills.createdAt')"
            [sortField]="'createdAt'"
            let-w
            >{{ moment(w.createdAt) }}</ng-template
          >
          <ng-template [atColumn]="'sent'" [header]="t('waybills.sentAt')" [sortField]="'sentAt'" let-w>{{
            w.sentAt ? moment(w.sentAt) : '—'
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
export class WaybillsPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly several = SEVERAL;
  protected readonly statuses = WAYBILL_STATUSES;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly tone = (s: WaybillStatus) => WAYBILL_TONE[s];
  protected readonly moment = (iso: string) => formatLocalDateTime(iso, LOCALE);
  protected readonly total = (w: Waybill) =>
    formatDecimal(totalKg(w.items.map((i) => i.massDeclaredKg)), LOCALE);
  private readonly session = inject(SessionService);
  protected readonly roles = computed(() => rolesOf(this.session.me()?.roles));
  protected readonly list = injectListParams(
    '/waybills',
    rolesOf(this.session.me()?.roles).overseer ? OVERSEER_SPEC : PARTICIPANT_SPEC,
  );
  private readonly p = (key: string) => computed(() => this.list.params().get(key) ?? '');
  protected readonly q = this.p('q');
  protected readonly status = computed(() => this.list.params().getAll('status'));
  protected readonly statusValue = computed(() => {
    const s = this.status();
    return s.length === 1 ? s[0]! : s.length > 1 ? SEVERAL : '';
  });
  private readonly directionRaw = this.p('direction');
  private readonly counterpartyRaw = this.p('counterpartyOrgId');
  protected readonly direction = computed(() => (this.roles().overseer ? '' : this.directionRaw()));
  protected readonly counterpartyOrgId = computed(() =>
    this.roles().overseer ? this.counterpartyRaw() : '',
  );
  protected readonly from = this.p('from');
  protected readonly to = this.p('to');
  protected readonly count = computed(
    () =>
      (this.status().length ? 1 : 0) +
      [this.direction(), this.counterpartyOrgId(), this.from(), this.to()].filter(Boolean).length,
  );
  protected readonly search = computed(() => ({
    label: t('waybills.search'),
    placeholder: t('waybills.searchPlaceholder'),
    value: this.q(),
  }));
  protected readonly sortOptions = [
    { value: 'createdAt,desc', label: t('waybills.sort.created') },
    { value: 'number,asc', label: t('waybills.sort.number') },
    { value: 'sentAt,desc', label: t('waybills.sort.sent') },
    { value: 'acceptedAt,desc', label: t('waybills.sort.accepted') },
  ];

  protected readonly query = injectQuery(
    () => {
      const page = this.list.page();
      const sort = this.list.sort();
      const q = this.q();
      const status = this.status();
      const f = {
        direction: this.direction(),
        counterpartyOrgId: this.counterpartyOrgId(),
        from: this.from(),
        to: this.to(),
      };
      return {
        key: `${WAYBILLS_KEY}${JSON.stringify([page, sort, q, status, f])}`,
        load: () =>
          call<Schemas['WaybillPage']>(
            this.session.api.GET('/waybills', {
              params: {
                query: {
                  page,
                  size: SIZE,
                  ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                  ...(q ? { q } : {}),
                  ...(status.length ? { status: status as WaybillStatus[] } : {}),
                  ...(f.direction ? { direction: f.direction as 'incoming' | 'outgoing' } : {}),
                  ...(f.counterpartyOrgId ? { counterpartyOrgId: f.counterpartyOrgId } : {}),
                  ...(f.from ? { from: f.from } : {}),
                  ...(f.to ? { to: f.to } : {}),
                },
              },
            }),
          ),
      };
    },
    { failedText: t('waybills.failed') },
  );
  protected readonly items = computed(() => this.query.data()?.items ?? []);
  protected readonly gap = computed(() => {
    const d = this.query.data();
    return d ? listGap(d, this.list.page(), SIZE) : null;
  });
  protected readonly badQuery = computed(() => isBadListQuery(this.query.error()));
  protected readonly rowKey = (w: Waybill) => w.id;

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

interface NewValues {
  receiverOrgId: string;
  picked: string[];
  mass: Record<string, string>;
}

@Component({
  selector: 'form[atWaybillNew]',
  standalone: true,
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<article class="at-card" style="max-width: 40rem">
      <div class="at-card__body">
        <div
          class="at-field"
          [orgPicker]="'waybill-receiver'"
          [label]="t('field.receiverOrgId')"
          [value]="f.values().receiverOrgId"
          [types]="receiverTypes"
          [exclude]="ownOrg()"
          [error]="f.errorOf('receiverOrgId')"
          (valueChange)="setReceiver($event)"
        ></div>
      </div>
    </article>
    <article class="at-card">
      <header class="at-card__header" [cardTitle]="t('waybills.items')"></header>
      <div class="at-card__body">
        <div style="${FORM_GRID}">
          @if (f.errorOf('picked'); as error) {
            <p class="at-field__error" id="waybill-items-error" role="alert">{{ error }}</p>
          }
          <div class="at-table-mobilebar" [table]="table"></div>
          <div
            class="at-table-wrap"
            #table="atTable"
            [cards]="true"
            [caption]="t('waybills.items')"
            [rows]="atWaybillNew()"
            [rowKey]="rowKey"
            [selection]="selection()"
            (selectionChange)="pick($event)"
          >
            <ng-template [atColumn]="'code'" [header]="t('waybills.batch')" [primary]="true" let-b>
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
            <ng-template [atColumn]="'current'" [header]="t('waybills.currentMass')" [numeric]="true" let-b>{{
              decimal(b.massKg)
            }}</ng-template>
            <ng-template [atColumn]="'declared'" [header]="t('waybills.declared')" let-b>
              <div class="at-field" [cellId]="'declared-' + b.id" [error]="f.errorOf('mass.' + b.id)">
                <div class="at-input-group" [suffix]="t('unit.kg')">
                  <input
                    class="at-input"
                    inputmode="decimal"
                    autocomplete="off"
                    [attr.aria-label]="t('waybills.declaredOf', { code: b.publicCode })"
                    [disabled]="!f.values().picked.includes(b.id)"
                    [value]="f.values().mass[b.id] ?? ''"
                    (input)="setMass(b.id, $any($event.target).value)"
                  />
                </div>
              </div>
            </ng-template>
          </div>
        </div>
      </div>
      <footer class="at-card__footer">
        <button
          class="at-button"
          [type]="'submit'"
          [variant]="'primary'"
          [busy]="f.busy()"
          [disabled]="f.wait() > 0"
          [focusAfterWait]="f.wait()"
        >
          {{ f.wait() > 0 ? t('auth.retryIn', { seconds: f.wait() }) : t('action.createWaybill') }}
        </button>
      </footer>
    </article>`,
  host: { id: 'waybill-new', novalidate: '', style: GAP, '(submit)': 'submit($event)' },
})
export class WaybillNewFormComponent implements OnInit {
  protected readonly t = t;
  protected readonly receiverTypes = ['PROCESSOR', 'RETAILER'] as Schemas['OrganizationType'][];
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  readonly atWaybillNew = input.required<BatchItem[]>();
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly live = injectLive();
  private readonly idempotent = idempotency();
  private readonly wanted = inject(ActivatedRoute).snapshot.queryParamMap.get('batchId') ?? '';
  protected readonly ownOrg = computed(() => this.session.me()?.organization.id);
  protected readonly rowKey = (b: BatchItem) => b.id;
  private sentIds: string[] = [];

  readonly f = new ManualForm<NewValues>({ receiverOrgId: '', picked: [], mass: {} }, (v) => this.check(v));
  protected readonly selection = computed(() => ({
    selected: new Set(this.f.values().picked),
    allLabel: t('waybills.pickAll'),
    rowLabel: (b: BatchItem) => t('waybills.pick', { code: b.publicCode }),
    errorId: this.f.errorOf('picked') ? 'waybill-items-error' : null,
  }));

  ngOnInit(): void {
    const batches = this.atWaybillNew();
    this.f.values.set({
      receiverOrgId: '',
      picked: batches.some((b) => b.id === this.wanted) ? [this.wanted] : [],
      mass: Object.fromEntries(batches.map((b) => [b.id, massText(b.massKg)])),
    });
  }

  private toBody(v: NewValues) {
    return {
      receiverOrgId: v.receiverOrgId,
      items: this.atWaybillNew()
        .filter((b) => v.picked.includes(b.id))
        .map((b) => ({ batchId: b.id, massDeclaredKg: normalizeDecimal(v.mass[b.id] ?? '', 3) })),
    };
  }

  private check(v: NewValues): Record<string, string> {
    const errors: Record<string, string> = {};
    const body = this.toBody(v);
    if (!v.receiverOrgId) errors['receiverOrgId'] = 'validation.required';
    if (body.items.length === 0) errors['picked'] = 'waybills.chooseItems';
    for (const item of body.items)
      if ((v.mass[item.batchId] ?? '').trim() === '') errors[`mass.${item.batchId}`] = 'validation.required';
    const res = WaybillCreateSchema.safeParse({ ...body, receiverOrgId: body.receiverOrgId || undefined });
    for (const issue of res.success ? [] : res.error.issues) {
      const [head, index, leaf] = issue.path;
      if (head === 'items' && typeof index === 'number' && leaf)
        errors[`mass.${body.items[index]!.batchId}`] ??= issue.message;
      else if (head === 'receiverOrgId') errors['receiverOrgId'] ??= issue.message;
    }
    for (const item of body.items) {
      const batch = this.atWaybillNew().find((b) => b.id === item.batchId);
      if (
        !errors[`mass.${item.batchId}`] &&
        batch &&
        compareDecimalStrings(item.massDeclaredKg, batch.massKg) > 0
      )
        errors[`mass.${item.batchId}`] = 'validation.mass.exceedsBatch';
    }
    return errors;
  }

  protected setReceiver(id: string | null): void {
    this.f.update((v) => ({ ...v, receiverOrgId: id ?? '' }), 'receiverOrgId');
  }

  protected pick(next: Set<string>): void {
    const ids = this.atWaybillNew()
      .map((b) => b.id)
      .filter((id) => next.has(id));
    this.f.update((v) => ({ ...v, picked: ids }), 'picked');
  }

  protected setMass(id: string, text: string): void {
    this.f.update((v) => ({ ...v, mass: { ...v.mass, [id]: text } }), `mass.${id}`);
  }

  protected submit(e: Event): void {
    void this.f.submit(e, async (v) => {
      const body = this.toBody(v) as Schemas['WaybillCreate'];
      this.sentIds = body.items.map((i) => i.batchId);
      const generation = this.session.generation;
      let waybill: Waybill;
      try {
        waybill = await this.idempotent(body, (key) =>
          call<Waybill>(
            this.session.api.POST('/waybills', { params: { header: { 'Idempotency-Key': key } }, body }),
          ),
        );
      } catch (e) {
        if (!this.live(generation)) return;
        const ids = this.sentIds;
        this.f.fail(e, ['receiverOrgId', 'picked', ...ids.map((id) => `mass.${id}`)], (path) => {
          const m = /^items\[(\d+)\]\./.exec(path);
          const id = m ? ids[Number(m[1])] : undefined;
          if (id) return `mass.${id}`;
          return path === 'items' ? 'picked' : path;
        });
        return;
      }
      if (generation !== this.session.generation) return;
      this.cache.put(waybillKey(waybill.id), waybill, generation);
      this.cache.invalidate(WAYBILLS_KEY);
      this.toasts.push({ tone: 'ok', text: t('waybills.created', { number: waybill.number }) });
      if (this.live(generation)) void this.router.navigateByUrl(`/waybills/${waybill.id}`);
    });
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, WaybillNewFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.waybillNew')"></div>
    @if (!stock.data() && stock.failed()) {
      ${loadFailed("t('waybills.formFailed')", 'stock.fetching()', 'stock.refetch()')}
    } @else if (!stock.data()) {
      ${areaLoading(2)}
    } @else if (stock.data()!.items.length === 0) {
      <article class="at-card">
        <div class="at-empty" [art]="'empty-batches'" [text]="t('waybills.noStock')">
          <a class="at-button" [variant]="'primary'" [to]="'/batches'">{{ t('batches.toList') }}</a>
        </div>
      </article>
    } @else {
      <form [atWaybillNew]="stock.data()!.items"></form>
    }`,
})
export class WaybillNewPage {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  protected readonly stock = injectQuery(
    () => ({
      key: `${BATCHES_KEY}shippable`,
      load: () =>
        call<Schemas['BatchPage']>(
          this.session.api.GET('/batches', {
            params: {
              query: { holder: 'me', status: ['Approved', 'Accepted'], size: 100, sort: 'publicCode,asc' },
            },
          }),
        ),
    }),
    { failedText: t('waybills.formFailed') },
  );
}

interface Problem {
  text: string;
  tone: 'danger' | 'attention';
}

export class WaybillProblems {
  readonly alert = formAlert();

  constructor(private readonly reread: () => void) {}

  describe(e: unknown): Problem {
    if (e instanceof ApiProblem && e.code === 'VERSION_CONFLICT') {
      this.reread();
      return { text: t('waybills.versionConflict'), tone: 'danger' };
    }
    if (e instanceof ApiProblem && e.code === 'INVALID_TRANSITION') {
      this.reread();
      const from = String(e.params?.['from'] ?? '');
      const code = e.params?.['publicCode'];
      return typeof code === 'string'
        ? {
            text: t('waybills.batchState', { publicCode: code, status: enumLabel(t, 'BatchStatus', from) }),
            tone: 'danger',
          }
        : {
            text: t('waybills.stateChanged', { status: enumLabel(t, 'WaybillStatus', from) }),
            tone: 'danger',
          };
    }
    if (e instanceof ApiProblem && (e.rule === 'BR-06' || e.status === 404)) this.reread();
    return { text: errorText(e), tone: errorTone(e) };
  }

  fail(e: unknown): Problem {
    const p = this.describe(e);
    this.alert.show(p.text, p.tone);
    return p;
  }
}

export function discrepancyOf(declaredKg: string, actualText: string) {
  const actualKg = normalizeDecimal(actualText, 3);
  if (!MASS.test(actualKg)) return null;
  const r = checkDiscrepancy({ declaredKg, actualKg });
  return 'error' in r ? null : r;
}

export function discrepancyText(d: { percent: string; actRequired: boolean }): string {
  return d.actRequired && compareDecimalStrings(d.percent, '2.00') <= 0
    ? t('waybills.overLimit')
    : formatPercent(d.percent, LOCALE);
}

interface AcceptValues {
  actual: Record<string, string>;
  act: Record<string, string>;
}

@Component({
  selector: 'form[atAccept]',
  standalone: true,
  exportAs: 'atAccept',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (i of atAccept().items; track i.batch.id) {
    <div style="${FORM_GRID}">
      <div
        style="display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: end"
      >
        <div
          class="at-field"
          [fieldId]="'actual-' + i.batch.id"
          [label]="t('waybills.actualOf', { code: i.batch.publicCode })"
          [error]="f.errorOf('actual.' + i.batch.id)"
        >
          <div class="at-input-group" [suffix]="t('unit.kg')">
            <input
              class="at-input"
              inputmode="decimal"
              autocomplete="off"
              [value]="f.values().actual[i.batch.id] ?? ''"
              (input)="set('actual', i.batch.id, $any($event.target).value)"
            />
          </div>
        </div>
        <p
          aria-live="polite"
          style="margin: 0; min-height: 2.75rem; display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center"
        >
          @if (discrepancy(i); as d) {
            <span>{{ t('waybills.discrepancy') }}: {{ text(d) }}</span>
            @if (d.actRequired) {
              <span class="at-chip" [tone]="'attention'">{{ t('waybills.actRequired') }}</span>
            }
          }
        </p>
      </div>
      @if (discrepancy(i)?.actRequired) {
        <div
          class="at-field"
          [fieldId]="'act-' + i.batch.id"
          [label]="t('waybills.actOf', { code: i.batch.publicCode })"
          [error]="f.errorOf('act.' + i.batch.id)"
        >
          <textarea
            class="at-textarea"
            rows="3"
            [value]="f.values().act[i.batch.id] ?? ''"
            (input)="set('act', i.batch.id, $any($event.target).value)"
          ></textarea>
        </div>
      }
    </div>
  }`,
  host: { id: 'waybill-accept', novalidate: '', style: GAP, '(submit)': 'submit($event)' },
})
export class AcceptFormComponent implements OnInit {
  protected readonly t = t;
  protected readonly text = discrepancyText;
  readonly atAccept = input.required<Waybill>();
  readonly problems = input.required<WaybillProblems>();
  readonly done = output<Waybill>();
  private readonly session = inject(SessionService);
  private readonly live = injectLive();
  private readonly idempotent = idempotency();
  readonly f = new ManualForm<AcceptValues>({ actual: {}, act: {} }, (v) => this.check(v));

  ngOnInit(): void {
    const items = this.atAccept().items;
    this.f.values.set({
      actual: Object.fromEntries(items.map((i) => [i.batch.id, massText(i.massDeclaredKg)])),
      act: Object.fromEntries(items.map((i) => [i.batch.id, ''])),
    });
  }

  protected readonly discrepancy = (i: Item) =>
    discrepancyOf(i.massDeclaredKg, this.f.values().actual[i.batch.id] ?? '');

  private toBody(v: AcceptValues) {
    return {
      items: this.atAccept().items.map((i) => {
        const id = i.batch.id;
        const d = discrepancyOf(i.massDeclaredKg, v.actual[id] ?? '');
        const act = v.act[id] ?? '';
        return {
          batchId: id,
          massActualKg: normalizeDecimal(v.actual[id] ?? '', 3),
          ...(d?.actRequired && act.trim() ? { discrepancyAct: act } : {}),
        };
      }),
    };
  }

  private check(v: AcceptValues): Record<string, string> {
    const items = this.atAccept().items;
    const errors: Record<string, string> = {};
    for (const i of items) {
      const id = i.batch.id;
      if ((v.actual[id] ?? '').trim() === '') errors[`actual.${id}`] = 'validation.required';
      const d = discrepancyOf(i.massDeclaredKg, v.actual[id] ?? '');
      if (d?.actRequired && !(v.act[id] ?? '').trim()) errors[`act.${id}`] = 'validation.required';
    }
    const res = WaybillAcceptSchema.safeParse(this.toBody(v));
    for (const issue of res.success ? [] : res.error.issues) {
      const [, index, leaf] = issue.path;
      const id = typeof index === 'number' ? items[index]?.batch.id : undefined;
      if (!id) continue;
      if (leaf === 'massActualKg') errors[`actual.${id}`] ??= issue.message;
      else if (leaf === 'discrepancyAct') errors[`act.${id}`] ??= issue.message;
    }
    return errors;
  }

  protected set(kind: 'actual' | 'act', id: string, text: string): void {
    this.f.update((v) => ({ ...v, [kind]: { ...v[kind], [id]: text } }), `${kind}.${id}`);
  }

  protected submit(e: Event): void {
    void this.f.submit(e, async (v) => {
      const problems = this.problems();
      problems.alert.clear();
      const waybill = this.atAccept();
      const version = waybill.version;
      const body = this.toBody(v) as Schemas['WaybillAccept'];
      const items = waybill.items;
      const generation = this.session.generation;
      let next: Waybill;
      try {
        next = await this.idempotent({ version, body }, (key) =>
          call<Waybill>(
            this.session.api.POST('/waybills/{id}/accept', {
              params: { path: { id: waybill.id }, header: { 'If-Match': version, 'Idempotency-Key': key } },
              body,
            }),
          ),
        );
      } catch (e) {
        if (!this.live(generation)) return;
        if (e instanceof ApiProblem && e.code === 'VALIDATION') {
          this.f.fail(
            e,
            items.flatMap((i) => [`actual.${i.batch.id}`, `act.${i.batch.id}`]),
            (path) => {
              const m = /^items\[(\d+)\]\.(massActualKg|discrepancyAct)$/.exec(path);
              const item = m ? items[Number(m[1])] : undefined;
              return item && m ? `${m[2] === 'massActualKg' ? 'actual' : 'act'}.${item.batch.id}` : path;
            },
            (text, tone) => problems.alert.show(text, tone),
          );
        } else {
          if (e instanceof ApiProblem && e.status === 429) this.f.rateLimited(retryAfterOf(e));
          const code = e instanceof ApiProblem && e.rule === 'BR-07' ? e.params?.['publicCode'] : undefined;
          if (typeof code === 'string') {
            const item = items.find((i) => i.batch.publicCode === code);
            if (item) this.f.setError(`act.${item.batch.id}`, 'validation.required');
          }
          problems.fail(e);
        }
        return;
      }
      if (generation === this.session.generation) this.done.emit(next);
    });
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, AcceptFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (!query.data() && missing()) {
      <div class="at-page__header" [pageTitle]="t('page.waybill')"></div>
      <article class="at-card">
        <div class="at-empty" [art]="'not-found'" [text]="t('waybills.notFound')">
          <a class="at-button" [variant]="'primary'" [to]="'/waybills'">{{ t('waybills.toList') }}</a>
        </div>
      </article>
    } @else {
      <div class="at-page__header" [pageTitle]="query.data()?.number ?? t('page.waybill')">
        @if (query.data(); as w) {
          @if (can('send') || can('delete') || can('reject')) {
            <div class="at-page__actions">
              @if (can('send')) {
                <button
                  class="at-button"
                  [variant]="'primary'"
                  [icon]="'truck'"
                  [busy]="sending()"
                  [disabled]="sendWait.left() > 0"
                  [focusAfterWait]="sendWait.left()"
                  (click)="send(w)"
                >
                  {{
                    sendWait.left() > 0
                      ? t('auth.retryIn', { seconds: sendWait.left() })
                      : actionLabel('send')
                  }}
                </button>
              }
              @if (can('delete')) {
                <button class="at-button" [variant]="'secondary'" (click)="dialog.set('delete')">
                  {{ actionLabel('delete') }}
                </button>
              }
              @if (can('reject')) {
                <button class="at-button" [variant]="'secondary'" (click)="dialog.set('reject')">
                  {{ actionLabel('reject') }}
                </button>
              }
            </div>
          }
        }
      </div>
      @if (!query.data() && query.failed()) {
        ${loadFailed("t('waybills.failed')", 'query.fetching()', 'query.refetch()')}
      } @else if (!query.data()) {
        ${areaLoading(2)}
      } @else {
        <div style="${GAP}">
          <article class="at-card">
            <header
              class="at-card__header"
              [cardTitle]="t('count.batches', { count: query.data()!.items.length })"
            >
              ${statusChip('query.data()!.status', "'l'")}
            </header>
            <div class="at-card__body"><dl class="at-card__facts" [facts]="facts()"></dl></div>
          </article>
          <div
            class="at-table-wrap"
            [cards]="true"
            [caption]="t('waybills.items')"
            [rows]="query.data()!.items"
            [rowKey]="itemKey"
          >
            <ng-template [atColumn]="'code'" [header]="t('waybills.batch')" [primary]="true" let-i>
              <span
                class="at-table__primary"
                [href]="'/batches/' + i.batch.id"
                [code]="i.batch.publicCode"
                [sub]="i.batch.product.name"
              ></span>
            </ng-template>
            <ng-template [atColumn]="'status'" [header]="t('batches.status')" [status]="true" let-i>
              <span class="at-chip" [status]="i.batch.status"></span>
            </ng-template>
            <ng-template [atColumn]="'declared'" [header]="t('waybills.declared')" [numeric]="true" let-i>{{
              decimal(i.massDeclaredKg)
            }}</ng-template>
            @if (accepted()) {
              <ng-template [atColumn]="'actual'" [header]="t('waybills.actual')" [numeric]="true" let-i>{{
                i.massActualKg ? decimal(i.massActualKg) : '—'
              }}</ng-template>
              <ng-template
                [atColumn]="'discrepancy'"
                [header]="t('waybills.discrepancy')"
                [numeric]="true"
                let-i
                >{{ i.discrepancyPercent ? percent(i.discrepancyPercent) : '—' }}</ng-template
              >
              <ng-template [atColumn]="'act'" [header]="t('waybills.act')" let-i>{{
                i.discrepancyAct ?? '—'
              }}</ng-template>
            }
          </div>
          @if (can('accept')) {
            <article class="at-card">
              <header class="at-card__header" [cardTitle]="t('waybills.acceptance')"></header>
              <div class="at-card__body">
                <form
                  #af="atAccept"
                  [atAccept]="query.data()!"
                  [problems]="problems"
                  (done)="acceptDone($event)"
                ></form>
              </div>
              <footer class="at-card__footer">
                <button
                  class="at-button"
                  [type]="'submit'"
                  [attr.form]="'waybill-accept'"
                  [variant]="'primary'"
                  [busy]="af.f.busy()"
                  [disabled]="af.f.wait() > 0"
                  [focusAfterWait]="af.f.wait()"
                >
                  {{ af.f.wait() > 0 ? t('auth.retryIn', { seconds: af.f.wait() }) : actionLabel('accept') }}
                </button>
              </footer>
            </article>
          }
        </div>
      }
      @if (query.data(); as w) {
        <dialog
          class="at-dialog"
          [open]="dialog() === 'delete'"
          [dialogTitle]="t('waybills.deleteTitle', { number: w.number })"
          (closed)="dialog.set(null)"
        >
          ${dialogMessage('deleteFailure.message()')}
          <div class="at-dialog__actions">
            <button class="at-button" [variant]="'ghost'" (click)="dialog.set(null)">
              {{ t('action.cancel') }}
            </button>
            <button
              class="at-button"
              [variant]="'danger'"
              [busy]="deleting()"
              [disabled]="deleteWait.left() > 0"
              [focusAfterWait]="deleteWait.left()"
              (click)="remove(w)"
            >
              {{
                deleteWait.left() > 0
                  ? t('auth.retryIn', { seconds: deleteWait.left() })
                  : actionLabel('delete')
              }}
            </button>
          </div>
        </dialog>
        <dialog
          class="at-dialog"
          [open]="dialog() === 'reject'"
          [dialogTitle]="t('waybills.rejectTitle', { number: w.number })"
          (closed)="dialog.set(null)"
        >
          <div style="${FORM_GRID}">
            ${dialogMessage('rejectFailure.message()')}
            <div
              class="at-field"
              [fieldId]="'reject-reason'"
              [label]="t('waybills.rejectReason')"
              [error]="reasonError()"
            >
              <textarea
                class="at-textarea"
                rows="3"
                [value]="reason()"
                (input)="typeReason($any($event.target).value)"
              ></textarea>
            </div>
            <div class="at-field" [fieldId]="'reject-number'" [label]="t('waybills.repeatNumber')">
              <input
                class="at-input at-mono"
                autocomplete="off"
                [value]="number()"
                (input)="number.set($any($event.target).value)"
              />
            </div>
          </div>
          <div class="at-dialog__actions">
            <button class="at-button" [variant]="'ghost'" (click)="dialog.set(null)">
              {{ t('action.cancel') }}
            </button>
            <button
              class="at-button"
              [variant]="'danger'"
              [busy]="rejecting()"
              [disabled]="!numberMatches() || rejectWait.left() > 0"
              [focusAfterWait]="rejectWait.left()"
              (click)="reject(w)"
            >
              {{
                rejectWait.left() > 0
                  ? t('auth.retryIn', { seconds: rejectWait.left() })
                  : actionLabel('reject')
              }}
            </button>
          </div>
        </dialog>
      }
    }`,
})
export class WaybillPage {
  protected readonly t = t;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly tone = (s: WaybillStatus) => WAYBILL_TONE[s];
  protected readonly actionLabel = (a: string) => enumLabel(t, 'WaybillActionName', a);
  protected readonly decimal = (v: string) => formatDecimal(v, LOCALE);
  protected readonly percent = (v: string) => formatPercent(v, LOCALE);
  protected readonly itemKey = (i: Item) => i.batch.id;
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  private readonly params = toSignal(inject(ActivatedRoute).paramMap, { requireSync: true });
  private readonly id = computed(() => this.params().get('id') ?? '');
  private readonly idempotentSend = idempotency();
  protected readonly problems = new WaybillProblems(() => this.reread());

  protected readonly query = injectQuery(
    () => {
      const id = this.id();
      return {
        key: waybillKey(id),
        load: () => call<Waybill>(this.session.api.GET('/waybills/{id}', { params: { path: { id } } })),
      };
    },
    { failedText: t('waybills.failed') },
  );
  protected readonly missing = computed(() => notFound(this.query.error()));
  protected readonly can = (a: Schemas['WaybillActionName']) =>
    Boolean(this.query.data()?.actions.includes(a));
  protected readonly accepted = computed(() =>
    (this.query.data()?.items ?? []).some((i) => i.massActualKg !== null),
  );
  protected readonly facts = computed<CardFact[]>(() => {
    const w = this.query.data();
    if (!w) return [];
    const at = (iso: string) => formatLocalDateTime(iso, LOCALE);
    return [
      { key: 'sender', term: t('waybills.sender'), value: w.sender.name },
      { key: 'receiver', term: t('waybills.receiver'), value: w.receiver.name },
      {
        key: 'mass',
        term: t('waybills.mass'),
        value: formatDecimal(totalKg(w.items.map((i) => i.massDeclaredKg)), LOCALE),
      },
      { key: 'created', term: t('waybills.createdAt'), value: at(w.createdAt) },
      ...(w.sentAt ? [{ key: 'sent', term: t('waybills.sentAt'), value: at(w.sentAt) }] : []),
      ...(w.acceptedAt ? [{ key: 'accepted', term: t('waybills.acceptedAt'), value: at(w.acceptedAt) }] : []),
      ...(w.rejectReason ? [{ key: 'reason', term: t('waybills.rejectReason'), value: w.rejectReason }] : []),
    ];
  });

  protected readonly dialog = signal<'delete' | 'reject' | null>(null);
  protected readonly sending = signal(false);
  protected readonly sendWait = countdown();
  protected readonly deleting = signal(false);
  protected readonly deleteWait = countdown();
  protected readonly deleteFailure = dialogAlert();
  protected readonly rejecting = signal(false);
  protected readonly rejectWait = countdown();
  protected readonly rejectFailure = dialogAlert();
  protected readonly reason = signal('');
  protected readonly reasonError = signal<string | null>(null);
  protected readonly number = signal('');
  protected readonly numberMatches = computed(() => {
    const n = this.query.data()?.number ?? '';
    return n !== '' && this.number().trim().toUpperCase() === n;
  });

  constructor() {
    effect(
      () => {
        const open = this.dialog();
        untracked(() => {
          if (open !== 'reject') {
            this.reason.set('');
            this.number.set('');
            this.reasonError.set(null);
            this.rejectFailure.handOff();
          }
          if (open !== 'delete') this.deleteFailure.handOff();
        });
      },
      { allowSignalWrites: true },
    );
    effect(
      () => {
        const open = this.dialog();
        if (!this.query.data()) return;
        if ((open === 'reject' && !this.can('reject')) || (open === 'delete' && !this.can('delete')))
          untracked(() => this.dialog.set(null));
      },
      { allowSignalWrites: true },
    );
  }

  private reread(): void {
    this.cache.invalidate(WAYBILLS_KEY);
    this.cache.invalidate(BATCHES_KEY);
    this.cache.invalidate(BATCH_PREFIX);
    if (!this.alive()) {
      this.cache.invalidate(waybillKey(this.id()));
      return;
    }
    void this.query.refetch().then(() =>
      setTimeout(() => {
        if (this.alive() && focusLost())
          document.querySelector<HTMLElement>('.at-page:not([hidden]) h1.at-page__title')?.focus();
      }, 0),
    );
  }

  private changed(next: Waybill, write: (w: Waybill) => void): void {
    write(next);
    this.cache.invalidate(WAYBILLS_KEY);
    this.cache.invalidate(BATCHES_KEY);
    this.cache.invalidate(BATCH_PREFIX);
  }

  protected async send(w: Waybill): Promise<void> {
    const origin = actionOrigin();
    const generation = this.session.generation;
    const write = this.query.writer();
    this.problems.alert.clear();
    this.sending.set(true);
    try {
      const next = await this.idempotentSend({ id: w.id, version: w.version }, (key) =>
        call<Waybill>(
          this.session.api.POST('/waybills/{id}/send', {
            params: { path: { id: w.id }, header: { 'If-Match': w.version, 'Idempotency-Key': key } },
          }),
        ),
      );
      if (generation !== this.session.generation) return;
      this.changed(next, write);
      this.toasts.push({ tone: 'ok', text: t('waybills.sent', { number: next.number }) });
      if (this.alive()) afterNextRender(() => restoreFocus(origin), { injector: this.injector });
    } catch (e) {
      if (!this.live(generation)) return;
      if (e instanceof ApiProblem && e.status === 429) this.sendWait.start(retryAfterOf(e));
      this.problems.fail(e);
    } finally {
      this.sending.set(false);
    }
  }

  protected acceptDone(next: Waybill): void {
    this.changed(next, this.query.writer());
    this.toasts.push({ tone: 'ok', text: t('waybills.accepted', { number: next.number }) });
  }

  protected async remove(w: Waybill): Promise<void> {
    const generation = this.session.generation;
    this.deleting.set(true);
    this.deleteFailure.clear();
    try {
      await call(
        this.session.api.DELETE('/waybills/{id}', {
          params: { path: { id: w.id }, header: { 'If-Match': w.version } },
        }),
      );
    } catch (e) {
      if (this.live(generation)) {
        if (e instanceof ApiProblem && e.status === 429) this.deleteWait.start(retryAfterOf(e));
        const p = this.problems.describe(e);
        this.deleteFailure.show(p.text, p.tone);
      }
      this.deleting.set(false);
      return;
    }
    this.deleting.set(false);
    this.cache.remove(waybillKey(w.id));
    this.cache.invalidate(WAYBILLS_KEY);
    if (generation !== this.session.generation) return;
    this.toasts.push({ tone: 'ok', text: t('waybills.deleted', { number: w.number }) });
    if (!this.alive()) return;
    this.dialog.set(null);
    void this.router.navigateByUrl('/waybills');
  }

  protected typeReason(text: string): void {
    this.reason.set(text);
    this.reasonError.set(null);
  }

  protected async reject(w: Waybill): Promise<void> {
    const reason = this.reason();
    const checked = WaybillRejectSchema.safeParse({ reason });
    if (!checked.success) {
      this.reasonError.set(t(reason.trim() ? checked.error.issues[0]!.message : 'validation.required'));
      return;
    }
    const generation = this.session.generation;
    const write = this.query.writer();
    this.rejecting.set(true);
    this.rejectFailure.clear();
    let next: Waybill;
    try {
      next = await call<Waybill>(
        this.session.api.POST('/waybills/{id}/reject', {
          params: { path: { id: w.id }, header: { 'If-Match': w.version } },
          body: { reason },
        }),
      );
    } catch (e) {
      if (this.live(generation)) {
        const key =
          e instanceof ApiProblem && e.code === 'VALIDATION' ? e.errors?.['reason']?.[0] : undefined;
        if (key) this.reasonError.set(t(key));
        else {
          if (e instanceof ApiProblem && e.status === 429) this.rejectWait.start(retryAfterOf(e));
          const p = this.problems.describe(e);
          this.rejectFailure.show(p.text, p.tone);
        }
      }
      this.rejecting.set(false);
      return;
    }
    this.rejecting.set(false);
    if (generation !== this.session.generation) return;
    this.changed(next, write);
    this.toasts.push({ tone: 'ok', text: t('waybills.rejected', { number: next.number }) });
    if (this.alive()) this.dialog.set(null);
  }
}
