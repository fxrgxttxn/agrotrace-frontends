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
import { writeReloadMark } from '../reload-mark';
import { NavigationService } from './navigation';
import { OutletDirective } from './outlet';
import { RouteFocusService } from './route-focus';
import { SessionService } from './session';
import { ShellFrameComponent } from './shell/shell';
import { PageLoadingComponent, ToastsComponent } from './ui';

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
  private readonly session = inject(SessionService);
  private readonly routed = signal(false);
  protected readonly loading = computed(() => !this.routed() || this.navigation.loadingIn() === 'root');
  protected readonly navigation = inject(NavigationService);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    queueMicrotask(() => host.removeAttribute('ng-version'));
    inject(LiveEventsService);
    inject(RouteFocusService);
    let ended = false;
    const sub = inject(Router).events.subscribe((e) => {
      if (e instanceof NavigationEnd) {
        if (!ended) writeReloadMark(null);
        ended = true;
        this.routed.set(true);
      } else if (e instanceof NavigationError) this.routed.set(true);
      else if (e instanceof NavigationCancel && e.code !== 0) this.routed.set(true);
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }
}
