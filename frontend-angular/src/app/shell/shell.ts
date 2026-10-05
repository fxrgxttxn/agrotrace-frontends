import { installFocusRescue } from '../focus-rescue';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { withVariant, type Me } from '@agrotrace/api-client';
import { t } from '../i18n';
import { LiveEventsService } from '../live-events';
import { isCurrent, navFor, NOTIFICATIONS_ITEM, PROFILE_ITEM, type NavItem } from '../nav';
import { OutletDirective } from '../outlet';
import { NavigationService } from '../navigation';
import { RouteFocusService } from '../route-focus';
import { SessionService } from '../session';
import { AvatarComponent, DialogComponent, LinkDirective, PageLoadingComponent } from '../ui';

export const BOTTOM_NAV_ITEMS = 4;

export function bellCount(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}

function currentPath() {
  return inject(NavigationService).pathname;
}

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

@Component({
  selector: 'nav.at-bottom-nav[items]',
  standalone: true,
  imports: [LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (item of main(); track item.key) {
      <a class="at-bottom-nav__link" [to]="item.href" [attr.aria-current]="current(item) ? 'page' : null"
        ><svg class="at-bottom-nav__icon" aria-hidden="true"><use [attr.href]="'#i-' + item.icon"></use></svg
        >{{ t(item.short ?? item.label) }}</a
      >
    }
    <button
      class="at-bottom-nav__link"
      type="button"
      [attr.aria-expanded]="open() ? 'true' : 'false'"
      aria-controls="more-menu"
      [disabled]="moreDisabled()"
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
  readonly moreDisabled = input(false);
  readonly more = output<void>();
  protected readonly main = computed(() => this.items().slice(0, BOTTOM_NAV_ITEMS));
  private readonly path = currentPath();
  protected current(item: NavItem): boolean {
    return isCurrent(item, this.path());
  }
}

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
    PageLoadingComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (me(); as me) {
    <a class="at-shell__skip" href="#main">{{ t('shell.skip') }}</a>
    <nav class="at-sidebar" [items]="items()"></nav>
    <header class="at-topbar" [me]="me" [unread]="unread()"></header>
    <main class="at-shell__main" id="main" tabindex="-1">
      @if (navigation.loadingIn() === 'shell') {
        <div class="at-page" [loading]="true"></div>
      }
      <ng-container atOutlet="shell" />
    </main>
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
              <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
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
  protected readonly navigation = inject(NavigationService);
  protected readonly unread = inject(LiveEventsService).unread;

  constructor() {
    installFocusRescue();
    this.navigation.shellActive = true;
    inject(DestroyRef).onDestroy(() => (this.navigation.shellActive = false));
  }
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
    this.routeFocus.skipNext(item.href);
    this.moreOpen.set(false);
  }
}

@Component({
  selector: 'div.at-shell[frame]',
  standalone: true,
  imports: [SidebarComponent, TopbarComponent, BottomNavComponent, PageLoadingComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (me(); as me) {
    <a class="at-shell__skip" href="#main">{{ t('shell.skip') }}</a>
    <nav class="at-sidebar" [items]="items()"></nav>
    <header class="at-topbar" [me]="me" [unread]="unread()"></header>
    <main class="at-shell__main" id="main" tabindex="-1"><div class="at-page" [loading]="true"></div></main>
    <nav class="at-bottom-nav" [items]="items()" [open]="false" [moreDisabled]="true"></nav>
  }`,
})
export class ShellFrameComponent {
  protected readonly t = t;
  readonly frame = input(true);
  protected readonly me = inject(SessionService).me;
  protected readonly unread = inject(LiveEventsService).unread;
  protected readonly items = computed(() => {
    const me = this.me();
    return me ? navFor(me) : [];
  });
}
