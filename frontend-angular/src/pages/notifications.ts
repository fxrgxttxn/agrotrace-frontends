import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import type { ApiNotification, NotificationPage, UnreadCount } from '@agrotrace/api-client';
import { formatLocalDateTime, notificationMessage } from '@agrotrace/i18n';
import { canAccess, type Viewer } from '../app/access';
import { injectAlive } from '../app/alive';
import { call } from '../app/api';
import { actionOrigin, restoreFocus } from '../app/focus';
import { applyProblem, formAlert } from '../app/forms';
import { LOCALE, t } from '../app/i18n';
import { LiveEventsService } from '../app/live-events';
import { injectQuery, NOTIFICATIONS_KEY, QueryCache } from '../app/query';
import { CABINET_ROUTES, matchPath } from '../app/routes';
import { SessionService } from '../app/session';
import {
  ButtonComponent,
  CardComponent,
  ChipComponent,
  ColumnDirective,
  EmptyComponent,
  LinkDirective,
  PageHeaderComponent,
  PaginationComponent,
  SkeletonComponent,
  TableComponent,
  TableMobileBarComponent,
  TabPanelDirective,
  TabsComponent,
} from '../app/ui';

const SIZE = 20;
type Tab = 'all' | 'unread';

function targets(n: ApiNotification): string[] {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const at = (...parts: unknown[]) =>
    parts.every((x) => typeof x === 'string' && x !== '') ? parts.join('') : null;
  const list: (string | null)[] = (() => {
    switch (n.type) {
      case 'LAB_ASSIGNED':
      case 'LAB_OVERDUE':
        return [at('/lab/tests/', p['labTestId']), at('/batches/', p['batchId'])];
      case 'LAB_RESULT':
        return [at('/batches/', p['batchId'], '?tab=tests'), at('/lab/tests/', p['labTestId'])];
      case 'WAYBILL_INCOMING':
        return [at('/waybills/', p['waybillId'])];
      case 'RECALL':
        return [at('/recalls/', p['recallId']), at('/batches/', p['sourceBatchId'])];
      case 'RECALL_TASK':
        return ['/recall-tasks', at('/recalls/', p['recallId']), at('/batches/', p['batchId'])];
      case 'OVERDUE':
        return [at('/recalls/', p['recallId']), '/recall-tasks'];
      case 'COMPLAINT':
        return [at('/complaints/', p['complaintId']), at('/batches/', p['batchId'])];
      default:
        return [];
    }
  })();
  return list.filter((x): x is string => x !== null);
}

export function linkFor(n: ApiNotification, viewer: Viewer): string | null {
  for (const href of targets(n)) {
    const path = href.split('?')[0]!;
    const route = CABINET_ROUTES.find((r) => matchPath(r.path, path));
    if (route && canAccess(viewer, route.access)) return href;
  }
  return null;
}

interface Row {
  n: ApiNotification;
  title: string;
  body: string;
  href: string | null;
  at: string;
}

@Component({
  selector: 'div.at-page',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    ButtonComponent,
    CardComponent,
    ChipComponent,
    ColumnDirective,
    EmptyComponent,
    LinkDirective,
    PageHeaderComponent,
    PaginationComponent,
    SkeletonComponent,
    TableComponent,
    TableMobileBarComponent,
    TabPanelDirective,
    TabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-page__header" [pageTitle]="t('page.notifications')">
      <div class="at-page__actions">
        @if (selected().size > 0) {
          <button class="at-button" [busy]="marking() === 'ids'" (click)="mark('ids')">
            {{ t('action.markRead') }}
          </button>
        }
        <button
          class="at-button"
          [variant]="'primary'"
          [busy]="marking() === 'all'"
          [disabled]="markAllDisabled()"
          (click)="mark('all')"
        >
          {{ t('action.markAllRead') }}
        </button>
      </div>
    </div>
    <div
      class="at-tabs"
      [label]="t('notifications.tabs')"
      [tabs]="tabs()"
      [selected]="tab()"
      (select)="selectTab($event)"
    >
      <ng-template [atTabPanel]="'all'"><ng-container *ngTemplateOutlet="content" /></ng-template>
      <ng-template [atTabPanel]="'unread'"><ng-container *ngTemplateOutlet="content" /></ng-template>
    </div>
    <ng-template #content>
      @if (!data() && failed()) {
        <article class="at-card">
          <div class="at-empty" [art]="'empty-search'" [text]="t('notifications.failed')">
            <button class="at-button" [variant]="'primary'" [busy]="fetching()" (click)="load()">
              {{ t('action.retry') }}
            </button>
          </div>
        </article>
      } @else if (!data()) {
        <div aria-busy="true" style="display: grid; gap: var(--sp-3)">
          <span class="at-visually-hidden">{{ t('shell.loading') }}</span>
          <span class="at-skeleton" [shape]="'block'"></span>
          <span class="at-skeleton" [shape]="'block'"></span>
        </div>
      } @else if (rows().length === 0) {
        <article class="at-card">
          @if (tab() === 'unread') {
            <div class="at-empty" [art]="'empty-notifications'" [text]="t('notifications.emptyUnread')">
              <button class="at-button" [variant]="'primary'" (click)="selectTab('all')">
                {{ t('notifications.showAll') }}
              </button>
            </div>
          } @else {
            <div class="at-empty" [art]="'empty-notifications'" [text]="t('empty.notifications')">
              <a class="at-button" [variant]="'primary'" [to]="'/'">{{ t('action.home') }}</a>
            </div>
          }
        </article>
      } @else {
        <div [attr.aria-busy]="fetching() ? 'true' : null" style="display: grid; gap: var(--sp-4)">
          <div class="at-table-mobilebar" [table]="list"></div>
          <div
            class="at-table-wrap"
            #list="atTable"
            [cards]="true"
            [caption]="t('page.notifications')"
            [rows]="rows()"
            [rowKey]="rowKey"
            [selection]="selection()"
            (selectionChange)="selected.set($event)"
          >
            <ng-template [atColumn]="'title'" [header]="t('notifications.column')" [primary]="true" let-row>
              <span class="at-table__primary">
                @if (row.href) {
                  <a [to]="row.href">{{ row.title }}</a>
                } @else {
                  <span>{{ row.title }}</span>
                }
                <span class="at-table__sub">{{ row.body }}</span></span
              >
            </ng-template>
            <ng-template [atColumn]="'state'" [header]="t('notifications.status')" [status]="true" let-row>
              <span class="at-chip" [tone]="row.n.isRead ? 'neutral' : 'move'">{{
                t(row.n.isRead ? 'notifications.read' : 'notifications.new')
              }}</span>
            </ng-template>
            <ng-template [atColumn]="'createdAt'" [header]="t('notifications.received')" let-row>
              <time [attr.datetime]="row.n.createdAt">{{ row.at }}</time>
            </ng-template>
          </div>
          <nav
            class="at-pagination"
            [page]="page()"
            [size]="size"
            [total]="data()!.total"
            [hrefFor]="hrefFor"
          ></nav>
        </div>
      }
    </ng-template>`,
})
export class NotificationsPage {
  protected readonly t = t;
  protected readonly size = SIZE;
  private readonly session = inject(SessionService);
  private readonly live = inject(LiveEventsService);
  private readonly router = inject(Router);
  private readonly alert = formAlert();
  private readonly query = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });

  protected readonly tab = computed<Tab>(() => (this.query().get('tab') === 'unread' ? 'unread' : 'all'));
  protected readonly page = computed(() => Math.max(1, Math.floor(Number(this.query().get('page'))) || 1));
  private readonly list = injectQuery(
    () => {
      const tab = this.tab();
      const page = this.page();
      return {
        key: `${NOTIFICATIONS_KEY}tab=${tab}&page=${page}`,
        load: () =>
          call<NotificationPage>(
            this.session.api.GET('/notifications', {
              params: {
                query: { page, size: SIZE, sort: 'seq,desc', ...(tab === 'unread' ? { isRead: false } : {}) },
              },
            }),
          ),
      };
    },
    { failedText: t('notifications.failed') },
  );
  protected readonly data = this.list.data;
  protected readonly failed = this.list.failed;
  protected readonly fetching = this.list.fetching;
  private readonly cache = inject(QueryCache);
  private readonly injector = inject(Injector);
  private readonly alive = injectAlive();
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly marking = signal<'ids' | 'all' | null>(null);

  private readonly items = computed(() => this.data()?.items ?? []);
  protected readonly rows = computed<Row[]>(() => {
    const me = this.session.me();
    return this.items().map((n) => {
      const payload = (n.payload ?? {}) as Record<string, unknown>;
      return {
        n,
        title: notificationMessage(n.type, payload, 'title', t),
        body: notificationMessage(n.type, payload, 'body', t),
        href: me ? linkFor(n, me) : null,
        at: formatLocalDateTime(n.createdAt, LOCALE),
      };
    });
  });
  protected readonly rowKey = (r: Row) => r.n.id;
  protected readonly selection = computed(() => ({
    selected: this.selected(),
    allLabel: t('notifications.selectAll'),
    rowLabel: (r: Row) => t('notifications.select', { title: r.title }),
  }));
  protected readonly tabs = computed(() => {
    const unread = this.live.unread();
    return [
      { id: 'all', label: t('notifications.all') },
      { id: 'unread', label: t('notifications.unread'), count: unread > 0 ? unread : undefined },
    ];
  });
  protected readonly markAllDisabled = computed(
    () => this.items().length === 0 || (this.live.unread() === 0 && !this.items().some((n) => !n.isRead)),
  );

  private shown = '';

  constructor() {
    const destroyRef = inject(DestroyRef);
    const sub = inject(ActivatedRoute).queryParamMap.subscribe(() => {
      const key = `${this.tab()}|${this.page()}`;
      if (key === this.shown) return;
      this.shown = key;
      this.selected.set(new Set());
    });
    const live = this.live.notifications$.subscribe(() => void this.reload());
    destroyRef.onDestroy(() => {
      sub.unsubscribe();
      live.unsubscribe();
    });
  }

  protected load(): void {
    void this.list.refetch();
  }

  private reload(): Promise<void> {
    this.cache.invalidate(NOTIFICATIONS_KEY);
    return this.list.refetch();
  }

  protected readonly hrefFor = (p: number): string => {
    const q = new URLSearchParams();
    if (this.tab() === 'unread') q.set('tab', 'unread');
    if (p > 1) q.set('page', String(p));
    const s = q.toString();
    return `/notifications${s ? `?${s}` : ''}`;
  };

  protected selectTab(id: string): void {
    this.selected.set(new Set());
    void this.router.navigateByUrl(id === 'unread' ? '/notifications?tab=unread' : '/notifications');
  }

  private async newestSeq(): Promise<number> {
    const items = this.items();
    if (this.tab() === 'all' && this.page() === 1 && items[0]) return items[0].seq;
    const first = await call<NotificationPage>(
      this.session.api.GET('/notifications', { params: { query: { page: 1, size: 1, sort: 'seq,desc' } } }),
    );
    return first.items[0]?.seq ?? Math.max(...items.map((n) => n.seq));
  }

  protected async mark(kind: 'ids' | 'all'): Promise<void> {
    if (kind === 'all' && this.items().length === 0) return;
    this.alert.clear();
    this.marking.set(kind);
    const opener = actionOrigin();
    const generation = this.cache.generation;
    let res: UnreadCount;
    try {
      const body = kind === 'ids' ? { ids: [...this.selected()] } : { upToSeq: await this.newestSeq() };
      res = await call<UnreadCount>(this.session.api.POST('/notifications/read', { body }));
    } catch (e) {
      applyProblem(e, { alert: this.alert.show });
      this.marking.set(null);
      return;
    }
    this.live.setUnread(res.count, generation);
    this.cache.invalidate(NOTIFICATIONS_KEY);
    if (!this.alive()) return;
    this.marking.set(null);
    this.selected.set(new Set());
    await this.list.refetch();
    if (!this.alive()) return;
    afterNextRender(() => restoreFocus(opener), { injector: this.injector });
  }
}
