import { Directive, HostListener, inject, input } from '@angular/core';
import { Router } from '@angular/router';

/** In-app link on a plain `<a [to]="…">`: `href` is exactly the given path (README markup, e.g. `/batches?page=2`), a
 * plain left click navigates client-side; modified clicks, other buttons and `target` keep the browser behaviour. */
@Directive({
  selector: 'a[to]',
  standalone: true,
  host: { '[attr.href]': 'to()' },
})
export class LinkDirective {
  readonly to = input.required<string>();
  private readonly router = inject(Router);

  @HostListener('click', ['$event'])
  onClick(e: MouseEvent): void {
    const a = e.currentTarget as HTMLAnchorElement;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    e.preventDefault();
    void this.router.navigateByUrl(this.to());
  }
}
