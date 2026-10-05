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
import { ApiProblem, withVariant, type Schemas } from '@agrotrace/api-client';
import { enumLabel } from '@agrotrace/i18n';
import { UserInviteSchema } from '@agrotrace/validation';
import type { Role } from '../app/access';
import { IMAGE_TYPES, ROLE_OF_TYPE, USER_TONE } from '../app/admin';
import { injectAlive, injectLive } from '../app/alive';
import { call, errorText } from '../app/api';
import { dialogAlert, errorTone, FocusAfterWaitDirective, SchemaForm, wireSchema } from '../app/forms';
import { t } from '../app/i18n';
import { ImageUploadComponent } from '../app/image-upload';
import { injectListParams, isBadListQuery, listGap, type ListSpec } from '../app/list-state';
import { OrgPickerComponent } from '../app/org-picker';
import { injectQuery, QueryCache } from '../app/query';
import { SessionService } from '../app/session';
import { PageToolbarComponent, ToastService, ToolbarFiltersDirective, UI, type Tone } from '../app/ui';
import { FORM_GRID } from './layout';
import { areaLoading, listChanged, loadFailed } from './lists';

type User = Schemas['User'];
type UserStatus = Schemas['UserStatus'];

const SIZE = 20;
const STACK = 'display: grid; gap: var(--sp-4)';
const GAP = 'display: grid; gap: var(--sp-5)';
const STATUSES: readonly UserStatus[] = ['INVITED', 'ACTIVE', 'BLOCKED'];
const ROLES: readonly Role[] = ['FARMER', 'PROCESSOR', 'LAB', 'RETAILER', 'INSPECTOR', 'ADMIN'];
const LOGO_MAX_BYTES = 2097152;
const LOGO_TYPES = [...IMAGE_TYPES, 'image/svg+xml'];
const KEY = 'users?';

const ADMIN_SPEC: ListSpec = {
  sort: ['fullName', 'email', 'createdAt'],
  enums: { status: STATUSES, role: ROLES },
  uuids: ['organizationId'],
  texts: ['q'],
};
const STAFF_SPEC: ListSpec = {
  sort: ['fullName', 'email', 'createdAt'],
  enums: { status: STATUSES },
  texts: ['q'],
};

const IMPORTS = [
  ...UI,
  ReactiveFormsModule,
  FocusAfterWaitDirective,
  PageToolbarComponent,
  ToolbarFiltersDirective,
  OrgPickerComponent,
  ImageUploadComponent,
];

interface InviteValues extends Record<string, unknown> {
  email: string;
  fullName: string;
  organizationId: string;
  isOrgAdmin: boolean;
}

@Component({
  selector: 'form[atInvite]',
  standalone: true,
  exportAs: 'atInvite',
  imports: IMPORTS,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (f.message()) {
      <p class="at-field__error" role="alert" style="margin: 0">{{ f.message() }}</p>
    }
    <div
      class="at-field"
      [fieldId]="'invite-name'"
      [label]="t('field.fullName')"
      [error]="f.errorOf('fullName')"
    >
      <input class="at-input" autocomplete="off" name="fullName" [formControl]="f.control('fullName')" />
    </div>
    <div class="at-field" [fieldId]="'invite-email'" [label]="t('field.email')" [error]="f.errorOf('email')">
      <input
        class="at-input"
        type="email"
        autocomplete="off"
        name="email"
        [formControl]="f.control('email')"
      />
    </div>
    @if (atInvite()) {
      <div
        class="at-field"
        [orgPicker]="'invite-org'"
        [label]="t('users.inviteOrg')"
        [value]="f.valueOf('organizationId')"
        [error]="f.errorOf('organizationId')"
        (valueChange)="f.control('organizationId').setValue($event ?? '')"
        (org)="orgType.set($event?.type ?? ownType())"
      ></div>
    }
    <p style="margin: 0">{{ t('users.inviteRole', { role: label('RoleCode', role()) }) }}</p>
    <label
      class="at-check"
      [label]="t('field.isOrgAdmin')"
      [name]="'isOrgAdmin'"
      [checked]="f.valueOf('isOrgAdmin')"
      (toggled)="f.control('isOrgAdmin').setValue($event)"
    ></label>`,
  host: { id: 'invite-form', novalidate: '', style: FORM_GRID, '(submit)': 'submit($event)' },
})
export class InviteFormComponent {
  protected readonly t = t;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  readonly atInvite = input(false);
  readonly done = output<User>();
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly live = injectLive();
  protected readonly ownType = computed(() => this.session.me()?.organization.type ?? 'FARM');
  protected readonly orgType = signal<Schemas['OrganizationType'] | null>(null);
  protected readonly role = computed(() => ROLE_OF_TYPE[this.orgType() ?? this.ownType()]);
  readonly f = new SchemaForm<InviteValues, Schemas['UserInvite']>(
    wireSchema<InviteValues>(UserInviteSchema, (v) => ({
      email: v.email.trim(),
      fullName: v.fullName.trim(),
      roles: [untracked(this.role)],
      isOrgAdmin: v.isOrgAdmin,
      ...(this.atInvite() && v.organizationId ? { organizationId: v.organizationId } : {}),
    })),
    { email: '', fullName: '', organizationId: '', isOrgAdmin: false },
    ['email', 'fullName', 'organizationId', 'isOrgAdmin'],
    { dialog: true },
  );
  private readonly toasts = inject(ToastService);

  protected submit(e: Event): void {
    void this.f.submit(e, async (body) => {
      const generation = this.session.generation;
      try {
        const user = await call<User>(this.session.api.POST('/users', { body }));
        if (generation !== this.session.generation) return;
        this.cache.invalidate(KEY);
        this.toasts.push({ tone: 'ok', text: t('users.invited', { email: user.email }) });
        this.done.emit(user);
      } catch (err) {
        if (this.live(generation)) this.f.fail(err);
      }
    });
  }
}

const TEMPLATE = `<div class="at-page__header" [pageTitle]="admin ? t('page.users') : t('page.staff')">
      <div class="at-page__actions">
        <button class="at-button" [variant]="'primary'" [icon]="'plus'" (click)="inviting.set(true)">
          {{ t('action.invite') }}
        </button>
      </div>
    </div>
    <div style="${GAP}">
      @if (!admin) {
        <article class="at-card">
          <header class="at-card__header" [cardTitle]="t('users.logo')"></header>
          <div class="at-card__body">
            <div style="display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start">
              <span class="at-avatar" [name]="org()?.name ?? ''" [src]="logo()" [size]="'l'" [shape]="'square'"></span>
              <div style="flex: 1 1 16rem; min-width: 0">
                <div
                  [imageUpload]="'logo-file'"
                  [label]="t('field.file')"
                  [hint]="t('users.logoHint')"
                  [types]="logoTypes"
                  [maxBytes]="logoMax"
                  [upload]="uploadLogo"
                ></div>
              </div>
            </div>
          </div>
        </article>
      }
      <div style="${STACK}">
        <div class="at-page__toolbar" [search]="search()" [count]="count()" (searchChange)="list.set({ q: $event })">
          <ng-template atToolbarFilters>
            <div class="at-field" [fieldId]="'filter-status'" [label]="t('users.status')">
              <select class="at-select" (change)="list.set({ status: $any($event.target).value })">
                <option value="" [selected]="status() === ''">{{ t('filters.any') }}</option>
                @for (s of statuses; track s) {
                  <option [value]="s" [selected]="status() === s">{{ label('UserStatus', s) }}</option>
                }
              </select>
            </div>
            @if (admin) {
              <div class="at-field" [fieldId]="'filter-role'" [label]="t('users.role')">
                <select class="at-select" (change)="list.set({ role: $any($event.target).value })">
                  <option value="" [selected]="role() === ''">{{ t('filters.any') }}</option>
                  @for (r of roles; track r) {
                    <option [value]="r" [selected]="role() === r">{{ label('RoleCode', r) }}</option>
                  }
                </select>
              </div>
              <div
                class="at-field"
                [orgPicker]="'filter-org'"
                [label]="t('users.organization')"
                [value]="organizationId()"
                (valueChange)="list.set({ organizationId: $event })"
              ></div>
            }
          </ng-template>
        </div>
        @if (!query.data() && query.failed()) {
          ${loadFailed("t('users.failed')", 'query.fetching()', 'query.refetch()', 'badQuery()', 'list.reset()')}
        } @else if (!query.data() || gap() === 'pastEnd') {
          ${areaLoading(2)}
        } @else if (gap() === 'changed') {
          ${listChanged('query.fetching()', 'query.refetch()')}
        } @else if (items().length === 0) {
          <article class="at-card">
            @if (q() || count()) {
              <div class="at-empty" [art]="'empty-search'" [text]="t('empty.search')">
                <button class="at-button" [variant]="'primary'" (click)="list.reset()">{{ t('filters.reset') }}</button>
              </div>
            } @else {
              <div class="at-empty" [art]="'empty-search'" [text]="t('empty.users')"></div>
            }
          </article>
        } @else {
          <div [attr.aria-busy]="query.fetching() ? 'true' : null" style="${STACK}">
            <div class="at-table-mobilebar" [table]="table" [sortOptions]="sortOptions"></div>
            <div
              class="at-table-wrap"
              #table="atTable"
              [cards]="true"
              [caption]="admin ? t('page.users') : t('page.staff')"
              [rows]="items()"
              [rowKey]="rowKey"
              [sort]="list.sort()"
              (sortChange)="list.setSort($event)"
            >
              <ng-template [atColumn]="'user'" [header]="t('users.user')" [primary]="true" [sortField]="'fullName'" let-u>
                <span style="display: flex; gap: var(--sp-3); align-items: center; min-width: 0"
                  ><span
                    class="at-avatar"
                    [name]="u.fullName"
                    [src]="avatar(u)"
                    [size]="'s'"
                    [decorative]="true"
                  ></span
                  ><span class="at-table__primary"
                    ><span>{{ u.fullName }}</span><span class="at-table__sub">{{ u.email }}</span></span
                  ></span
                >
              </ng-template>
              <ng-template [atColumn]="'status'" [header]="t('users.status')" [status]="true" let-u>
                <span class="at-chip" [tone]="tone(u.status)">{{ label('UserStatus', u.status) }}</span>
              </ng-template>
              @if (admin) {
                <ng-template [atColumn]="'org'" [header]="t('users.organization')" let-u>{{
                  u.organization.name
                }}</ng-template>
              }
              <ng-template [atColumn]="'role'" [header]="t('users.role')" let-u>
                <span class="at-table__primary"
                  ><span>{{ rolesText(u) }}</span>@if (u.isOrgAdmin) {<span class="at-table__sub">{{
                      t('users.head')
                    }}</span>}</span
                >
              </ng-template>
              <ng-template atRowActions let-u>
                @if (u.id !== meId()) {
                  <button
                    class="at-button"
                    [size]="'s'"
                    [attr.aria-label]="t('users.editOf', { name: u.fullName })"
                    (click)="openEdit(u)"
                  >
                    {{ t('users.edit') }}
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
      </div>
    </div>
    @if (inviting()) {
      <dialog class="at-dialog" [open]="true" [dialogTitle]="t('users.inviteTitle')" (closed)="closeInvite(inv)">
        <form #inv="atInvite" [atInvite]="admin" (done)="invited()"></form>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closeInvite(inv)">{{ t('action.cancel') }}</button>
          <button
            class="at-button"
            [type]="'submit'"
            [attr.form]="'invite-form'"
            [variant]="'primary'"
            [busy]="inv.f.busy()"
            [disabled]="inv.f.wait() > 0"
            [focusAfterWait]="inv.f.wait()"
          >
            {{ inv.f.wait() > 0 ? t('auth.retryIn', { seconds: inv.f.wait() }) : t('action.invite') }}
          </button>
        </div>
      </dialog>
    }
    @if (editing(); as u) {
      <dialog
        class="at-dialog"
        [open]="true"
        [dialogTitle]="t('users.editTitle', { name: u.fullName })"
        (closed)="closeEdit()"
      >
        <div style="${FORM_GRID}">
          @if (editFailure.message()) {
            <p class="at-field__error" role="alert" style="margin: 0">{{ editFailure.message() }}</p>
          }
          <label
            class="at-check"
            [label]="t('field.isOrgAdmin')"
            [checked]="editHead()"
            (toggled)="editHead.set($event)"
          ></label>
          @if (u.status === 'INVITED') {
            <p style="margin: 0">{{ t('users.invitedNote') }}</p>
          } @else {
            <fieldset class="at-field" [legend]="t('users.status')">
              @for (s of editStatuses; track s) {
                <label
                  class="at-radio"
                  [label]="label('UserStatus', s)"
                  [name]="'user-status'"
                  [value]="s"
                  [checked]="editStatus() === s"
                  (picked)="editStatus.set(s)"
                ></label>
              }
            </fieldset>
          }
          @if (u.status !== 'BLOCKED' && editStatus() === 'BLOCKED') {
            <p class="at-field__warning" style="margin: 0">{{ t('users.blockNote') }}</p>
          }
        </div>
        <div class="at-dialog__actions">
          <button class="at-button" [variant]="'ghost'" (click)="closeEdit()">{{ t('action.cancel') }}</button>
          <button class="at-button" [variant]="'primary'" [busy]="editBusy()" (click)="saveEdit(u)">
            {{ t('action.save') }}
          </button>
        </div>
      </dialog>
    }`;

abstract class UsersScreen {
  protected readonly t = t;
  protected readonly size = SIZE;
  protected readonly statuses = STATUSES;
  protected readonly roles = ROLES;
  protected readonly editStatuses = ['ACTIVE', 'BLOCKED'] as const;
  protected readonly logoTypes = LOGO_TYPES;
  protected readonly logoMax = LOGO_MAX_BYTES;
  protected readonly label = (name: string, v: string) => enumLabel(t, name, v);
  protected readonly tone = (s: UserStatus): Tone => USER_TONE[s];
  protected readonly avatar = (u: User) => (u.avatarUrl ? withVariant(u.avatarUrl, 96) : null);
  protected readonly rolesText = (u: User) => u.roles.map((r) => enumLabel(t, 'RoleCode', r)).join(', ');
  protected readonly rowKey = (u: User) => u.id;
  protected readonly sortOptions = [
    { value: 'fullName,asc', label: t('users.sort.name') },
    { value: 'email,asc', label: t('users.sort.email') },
    { value: 'createdAt,desc', label: t('users.sort.created') },
  ];
  protected readonly admin: boolean;
  private readonly session = inject(SessionService);
  private readonly cache = inject(QueryCache);
  private readonly toasts = inject(ToastService);
  private readonly alive = injectAlive();
  private readonly live = injectLive();
  protected readonly meId = computed(() => this.session.me()?.id);
  protected readonly org = computed(() => this.session.me()?.organization);
  protected readonly logo = computed(() => {
    const url = this.org()?.logoUrl;
    return url ? withVariant(url, 96) : null;
  });
  protected readonly list;
  protected readonly q;
  protected readonly status;
  protected readonly role;
  protected readonly organizationId;
  protected readonly count;
  protected readonly search;
  protected readonly query;
  protected readonly items;
  protected readonly gap;
  protected readonly badQuery;

  protected readonly inviting = signal(false);
  protected readonly editing = signal<User | null>(null);
  protected readonly editHead = signal(false);
  protected readonly editStatus = signal<UserStatus>('ACTIVE');
  protected readonly editBusy = signal(false);
  protected readonly editFailure = dialogAlert();

  constructor(admin: boolean) {
    this.admin = admin;
    const list = injectListParams(admin ? '/admin/users' : '/org/staff', admin ? ADMIN_SPEC : STAFF_SPEC);
    this.list = list;
    const p = (key: string) => computed(() => list.params().get(key) ?? '');
    this.q = p('q');
    this.status = p('status');
    this.role = p('role');
    this.organizationId = p('organizationId');
    this.count = computed(() => [this.status(), this.role(), this.organizationId()].filter(Boolean).length);
    this.search = computed(() => ({
      label: t('users.search'),
      placeholder: t('users.searchPlaceholder'),
      value: this.q(),
    }));
    this.query = injectQuery(
      () => {
        const page = list.page();
        const sort = list.sort();
        const f = {
          q: this.q(),
          status: this.status(),
          role: this.role(),
          organizationId: this.organizationId(),
        };
        return {
          key: `${KEY}${JSON.stringify([admin, page, sort, f])}`,
          load: () =>
            call<Schemas['UserPage']>(
              this.session.api.GET('/users', {
                params: {
                  query: {
                    page,
                    size: SIZE,
                    ...(sort ? { sort: `${sort.field},${sort.dir}` } : {}),
                    ...(f.q ? { q: f.q } : {}),
                    ...(f.status ? { status: f.status as UserStatus } : {}),
                    ...(f.role ? { role: f.role as Role } : {}),
                    ...(f.organizationId ? { organizationId: f.organizationId } : {}),
                  },
                },
              }),
            ),
        };
      },
      { failedText: t('users.failed') },
    );
    const query = this.query;
    this.items = computed(() => query.data()?.items ?? []);
    this.gap = computed(() => {
      const d = query.data();
      return d ? listGap(d, list.page(), SIZE) : null;
    });
    this.badQuery = computed(() => isBadListQuery(query.error()));
    effect(() => {
      const d = query.data();
      if (d && d.items.length === 0 && d.total > 0) untracked(() => list.clampPage(d.total, SIZE));
    });
  }

  private reread(): void {
    this.cache.invalidate(KEY);
    if (this.alive()) void this.query.refetch();
  }

  protected invited(): void {
    if (!this.alive()) return;
    this.inviting.set(false);
    this.reread();
  }

  protected openEdit(u: User): void {
    this.editHead.set(u.isOrgAdmin);
    this.editStatus.set(u.status);
    this.editFailure.clear();
    this.editing.set(u);
  }

  protected closeInvite(form: InviteFormComponent): void {
    form.f.handOff();
    this.inviting.set(false);
  }

  protected closeEdit(): void {
    this.editFailure.handOff();
    this.editing.set(null);
  }

  protected async saveEdit(user: User): Promise<void> {
    const isOrgAdmin = this.editHead();
    const status = this.editStatus();
    const body = {
      ...(isOrgAdmin !== user.isOrgAdmin ? { isOrgAdmin } : {}),
      ...(status !== user.status && status !== 'INVITED' ? { status } : {}),
    };
    if (Object.keys(body).length === 0) {
      this.editing.set(null);
      return;
    }
    const generation = this.session.generation;
    this.editBusy.set(true);
    this.editFailure.clear();
    try {
      const next = await call<User>(
        this.session.api.PATCH('/users/{id}', { params: { path: { id: user.id } }, body: body as never }),
      );
      if (generation !== this.session.generation) return;
      this.cache.invalidate(KEY);
      this.toasts.push({ tone: 'ok', text: t('users.saved', { name: next.fullName }) });
      if (!this.alive()) return;
      this.editing.set(null);
      this.reread();
    } catch (e) {
      if (!this.live(generation)) return;
      const stale =
        e instanceof ApiProblem && e.code === 'INVALID_TRANSITION'
          ? t('users.stateChanged', {
              name: user.fullName,
              status: enumLabel(t, 'UserStatus', String(e.params?.['from'] ?? '')),
            })
          : e instanceof ApiProblem && e.status === 404
            ? t('users.gone', { name: user.fullName })
            : null;
      if (stale) {
        this.editing.set(null);
        this.reread();
        this.toasts.push({ tone: 'danger', text: stale });
      } else this.editFailure.show(errorText(e), errorTone(e));
    } finally {
      if (this.alive()) this.editBusy.set(false);
    }
  }

  protected readonly uploadLogo = async (file: File): Promise<void> => {
    const id = this.org()?.id;
    if (!id) return;
    const generation = this.session.generation;
    const body = new FormData();
    body.append('file', file);
    await call(
      this.session.api.PUT('/organizations/{id}/logo', { params: { path: { id } }, body: body as never }),
    );
    if (generation !== this.session.generation) return;
    this.toasts.push({ tone: 'ok', text: t('users.logoSaved') });
    void this.session.reloadMe(generation);
  };
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, InviteFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class UsersPage extends UsersScreen {
  constructor() {
    super(true);
  }
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [...IMPORTS, InviteFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: TEMPLATE,
})
export class StaffPage extends UsersScreen {
  constructor() {
    super(false);
  }
}
