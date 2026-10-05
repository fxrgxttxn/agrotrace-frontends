import { DestroyRef, Directive, inject, input, type ComponentRef } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  RouteConfigLoadStart,
  Router,
  RouterOutlet,
} from '@angular/router';
import { NavigationService } from './navigation';

@Directive({ selector: 'ng-container[atOutlet]', standalone: true, exportAs: 'outlet' })
export class OutletDirective extends RouterOutlet {
  readonly level = input<'shell' | 'root' | ''>('', { alias: 'atOutlet' });
  private readonly navigation = inject(NavigationService);
  private hidden: { host: HTMLElement; lentId: boolean } | null = null;

  constructor() {
    super();
    const sub = inject(Router).events.subscribe((e) => {
      if (e instanceof RouteConfigLoadStart) {
        const loadingIn = this.navigation.loadingIn();
        const level = this.level();
        if (loadingIn === level || (loadingIn === 'enter-shell' && level === 'root')) this.hide();
      } else if (
        e instanceof NavigationEnd ||
        e instanceof NavigationCancel ||
        e instanceof NavigationError
      ) {
        this.show();
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private hide(): void {
    const ref = (this as unknown as { activated: ComponentRef<unknown> | null }).activated;
    const host = ref?.location.nativeElement as HTMLElement | undefined;
    if (!host || this.hidden) return;
    const lentId = host.id === 'main';
    host.setAttribute('hidden', '');
    host.setAttribute('inert', '');
    host.style.setProperty('display', 'none');
    if (lentId) host.removeAttribute('id');
    this.hidden = { host, lentId };
  }

  private show(): void {
    const h = this.hidden;
    this.hidden = null;
    if (!h) return;
    h.host.removeAttribute('hidden');
    h.host.removeAttribute('inert');
    h.host.style.removeProperty('display');
    if (h.host.getAttribute('style') === '') h.host.removeAttribute('style');
    if (h.lentId) h.host.id = 'main';
  }
}
