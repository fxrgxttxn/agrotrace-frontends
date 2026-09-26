import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
} from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { LiveEventsService } from './live-events';
import { NavigationService } from './navigation';
import { OutletDirective } from './outlet';
import { RouteFocusService } from './route-focus';
import { SessionService } from './session';
import { ShellFrameComponent } from './shell/shell';
import { PageLoadingComponent, ToastsComponent } from './ui';

/** Root of the cabinet app: the routed page, the loading page while the start-up restore holds the first navigation,
 * and the one `at-toasts` stack (both regions rendered from the start, README «Уведомления»). */
@Component({
  selector: 'at-root',
  standalone: true,
  imports: [OutletDirective, PageLoadingComponent, ShellFrameComponent, ToastsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (loading()) {
      <div class="at-page" [loading]="true"></div>
    } @else if (navigation.loadingIn() === 'enter-shell') {
      <div class="at-shell" [frame]="true"></div>
    }
    <ng-container atOutlet="root" />
    <div class="at-toasts"></div>`,
})
export class AppComponent {
  // The session starts restoring as soon as the app does.
  private readonly session = inject(SessionService);
  private readonly routed = signal(false);
  /** Nothing routed yet (the first navigation waits: session restore, first page chunk), or a page chunk of a screen
   * outside the shell loads (FM10). */
  protected readonly loading = computed(() => !this.routed() || this.navigation.loadingIn() === 'root');
  protected readonly navigation = inject(NavigationService);

  constructor() {
    // FM10: no framework version attribute in the production DOM (Angular writes `ng-version` on the root host).
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    queueMicrotask(() => host.removeAttribute('ng-version'));
    inject(LiveEventsService);
    inject(RouteFocusService);
    const sub = inject(Router).events.subscribe((e) => {
      if (e instanceof NavigationEnd || e instanceof NavigationError) this.routed.set(true);
      else if (e instanceof NavigationCancel && e.code !== 0 /* redirect */) this.routed.set(true);
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }
}
