import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { LiveEventsService } from './live-events';
import { OutletDirective } from './outlet';
import { RouteFocusService } from './route-focus';
import { SessionService } from './session';
import { PageLoadingComponent, ToastsComponent } from './ui';

/** Root of the cabinet app: the routed page, the loading page while the start-up restore holds the first navigation,
 * and the one `at-toasts` stack (both regions rendered from the start, README «Уведомления»). */
@Component({
  selector: 'at-root',
  standalone: true,
  imports: [OutletDirective, PageLoadingComponent, ToastsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (loading()) {
      <div class="at-page" [loading]="true"></div>
    }
    <ng-container atOutlet />
    <div class="at-toasts"></div>`,
})
export class AppComponent {
  // The session starts restoring as soon as the app does.
  private readonly session = inject(SessionService);
  private readonly routed = signal(false);
  /** Nothing routed yet: the first navigation waits (session restore, first page chunk). */
  protected readonly loading = computed(() => !this.routed());

  constructor() {
    inject(LiveEventsService);
    inject(RouteFocusService);
    const sub = inject(Router).events.subscribe((e) => {
      if (e instanceof NavigationEnd || e instanceof NavigationError) this.routed.set(true);
      else if (e instanceof NavigationCancel && e.code !== 0 /* redirect */) this.routed.set(true);
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }
}
