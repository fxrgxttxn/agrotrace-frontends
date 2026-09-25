import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { withVariant, type Me } from '@agrotrace/api-client';
import { t } from '../i18n';
import { LiveEventsService } from '../live-events';
import { isCurrent, navFor, NOTIFICATIONS_ITEM, PROFILE_ITEM, type NavItem } from '../nav';
import { OutletDirective } from '../outlet';
import { pathnameOf, RouteFocusService } from '../route-focus';
import { SessionService } from '../session';
import { AvatarComponent, DialogComponent, LinkDirective } from '../ui';

/** How many role items the bottom bar holds before «Ещё» (spec §9.3). */
export const BOTTOM_NAV_ITEMS = 4;

/** Bell counter text: none at 0, «99+» above 99 (README «Шапка»). */
export function bellCount(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}

/** The current pathname, as a signal (for `aria-current`). */
function currentPath() {
  const router = inject(Router);
  return toSignal(
    router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => pathnameOf(e.urlAfterRedirects)),
    ),
    { initialValue: pathnameOf(router.url) },
  );
}

/** `at-sidebar` (README «Боковое меню»): ≥ 1024 px with labels, 768–1023 px icons only (`title` shows the name). */
@Component({
  selector: 'nav.at-sidebar[items]',
  standalone: true,
  imports: [LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<a class="at-sidebar__brand" [to]="'/'" title="AgroTrace"
      ><svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M4 20 9 4M10 20l5-16M16 20l4-13" /></svg
      ><span class="at-sidebar__label">AgroTrace</span></a
    >
    <ul class="at-sidebar__list">
      @for (item of items(); track item.key) {
        <li>
          <a
            class="at-sidebar__link"
            [to]="item.href"
            [attr.aria-current]="current(item) ? 'page' : null"
            [attr.title]="t(item.label)"
          >
            <svg class="at-sidebar__icon" aria-hidden="true"><use [attr.href]="'#i-' + item.icon"></use></svg>
            <span class="at-sidebar__label">{{ t(item.label) }}</span>
          </a>
        </li>
      }
    </ul>`,
  host: { '[attr.aria-label]': "t('shell.mainMenu')" },
})
export class SidebarComponent {
  protected readonly t = t;
  readonly items = input.required<NavItem[]>();
  private readonly path = currentPath();
  protected current(item: NavItem): boolean {
    return isCurrent(item, this.path());
  }
}

/** `at-topbar` with the organization, the `at-bell` and the profile link (README «Шапка», R28/R39: logo and avatar
 * are API file URLs, the 96 px variant). */
@Component({
  selector: 'header.at-topbar[me]',
  standalone: true,
  imports: [AvatarComponent, LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-topbar__org">
      <span
        class="at-avatar"
        [name]="me().organization.name"
        [src]="logo()"
        [shape]="'square'"
        [decorative]="true"
      ></span>
      <span class="at-topbar__org-name">{{ me().organization.name }}</span>
    </div>
    <div class="at-topbar__actions">
      <a
        class="at-bell"
        [to]="'/notifications'"
        [attr.aria-label]="count() ? t('shell.bellUnread', { count: count()! }) : t('shell.bell')"
      >
        <svg class="at-bell__icon" aria-hidden="true"><use href="#i-bell"></use></svg>
        @if (count()) {
          <span class="at-bell__count" aria-hidden="true">{{ count() }}</span>
        }
      </a>
      <a
        class="at-topbar__profile"
        [to]="'/profile'"
        [attr.aria-label]="t('shell.profileOf', { name: me().fullName })"
      >
        <span class="at-avatar" [name]="me().fullName" [src]="avatar()" [hidden]="true"></span>
      </a>
    </div>`,
})
export class TopbarComponent {
  protected readonly t = t;
  readonly me = input.required<Me>();
  readonly unread = input.required<number>();
  protected readonly count = computed(() => bellCount(this.unread()));
  protected readonly logo = computed(() => {
    const url = this.me().organization.logoUrl;
    return url ? withVariant(url, 96) : null;
  });
  protected readonly avatar = computed(() => {
    const url = this.me().avatarUrl;
    return url ? withVariant(url, 96) : null;
  });
}

/** `at-bottom-nav` (README «Нижняя навигация»): the first four items of the role and «Ещё», which opens the rest of
 * the menu, notifications and the profile in the `#more-menu` dialog (a sibling in the shell). */
@Component({
  selector: 'nav.at-bottom-nav[items]',
  standalone: true,
  imports: [LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (item of main(); track item.key) {
      <a class="at-bottom-nav__link" [to]="item.href" [attr.aria-current]="current(item) ? 'page' : null"
        ><svg class="at-bottom-nav__icon" aria-hidden="true"><use [attr.href]="'#i-' + item.icon"></use></svg
        >{{ t(item.label) }}</a
      >
    }
    <button
      class="at-bottom-nav__link"
      type="button"
      [attr.aria-expanded]="open() ? 'true' : 'false'"
      aria-controls="more-menu"
      (click)="more.emit()"
    >
      <svg class="at-bottom-nav__icon" aria-hidden="true"><use href="#i-more"></use></svg>{{ t('nav.more') }}
    </button>`,
  host: { '[attr.aria-label]': "t('shell.mainMenu')" },
})
export class BottomNavComponent {
  protected readonly t = t;
  readonly items = input.required<NavItem[]>();
  readonly open = input.required<boolean>();
  readonly more = output<void>();
  protected readonly main = computed(() => this.items().slice(0, BOTTOM_NAV_ITEMS));
  private readonly path = currentPath();
  protected current(item: NavItem): boolean {
    return isCurrent(item, this.path());
  }
}

/** `at-shell` (README «Оболочка»), the routed layout of the cabinet: both navigations are always in the markup, the
 * CSS shows one per width. */
@Component({
  selector: 'div.at-shell',
  standalone: true,
  imports: [
    SidebarComponent,
    TopbarComponent,
    BottomNavComponent,
    DialogComponent,
    LinkDirective,
    OutletDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (me(); as me) {
    <a class="at-shell__skip" href="#main">{{ t('shell.skip') }}</a>
    <nav class="at-sidebar" [items]="items()"></nav>
    <header class="at-topbar" [me]="me" [unread]="unread()"></header>
    <main class="at-shell__main" id="main" tabindex="-1"><ng-container atOutlet /></main>
    <nav class="at-bottom-nav" [items]="items()" [open]="moreOpen()" (more)="moreOpen.set(true)"></nav>
    <dialog
      class="at-dialog"
      id="more-menu"
      [open]="moreOpen()"
      [dialogTitle]="t('nav.more')"
      [titleId]="'more-title'"
      [lightDismiss]="true"
      [initialFocus]="'title'"
      (closed)="moreOpen.set(false)"
    >
      <nav [attr.aria-label]="t('shell.otherSections')">
        <ul class="at-sidebar__list">
          @for (item of more(); track item.key) {
            <li>
              <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -- a real link (href from [to]); Enter fires click -->
              <a
                class="at-sidebar__link"
                [to]="item.href"
                [attr.aria-current]="current(item) ? 'page' : null"
                (click)="pick(item)"
                ><svg class="at-sidebar__icon" aria-hidden="true">
                  <use [attr.href]="'#i-' + item.icon"></use></svg
                ><span class="at-sidebar__label">{{ t(item.label) }}</span></a
              >
            </li>
          }
        </ul>
      </nav>
    </dialog>
  }`,
})
export class ShellComponent {
  protected readonly t = t;
  private readonly session = inject(SessionService);
  private readonly routeFocus = inject(RouteFocusService);
  protected readonly unread = inject(LiveEventsService).unread;
  protected readonly me = this.session.me;
  protected readonly items = computed(() => {
    const me = this.me();
    return me ? navFor(me) : [];
  });
  protected readonly more = computed(() => [
    ...this.items().slice(BOTTOM_NAV_ITEMS),
    NOTIFICATIONS_ITEM,
    PROFILE_ITEM,
  ]);
  protected readonly moreOpen = signal(false);
  private readonly path = currentPath();

  protected current(item: NavItem): boolean {
    return isCurrent(item, this.path());
  }

  protected pick(item: NavItem): void {
    // README: a pick returns focus to «Ещё» (the page title does not take it).
    this.routeFocus.skipNext(item.href);
    this.moreOpen.set(false);
  }
}
