import { ChangeDetectionStrategy, Component, ElementRef, inject, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** `at-button` (README «Кнопка») on its own element: `<button class="at-button">` or, as a link styled as a button,
 * `<a class="at-button" [to]>` / `<a class="at-button" href>`. `data-variant` is always written (default `secondary`),
 * `data-size` only when given. While `busy`, clicks do not pass (a capturing listener stops them before any handler). */
@Component({
  selector: 'button.at-button, a.at-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (icon()) {
      <svg class="at-button__icon" aria-hidden="true"><use [attr.href]="'#i-' + icon()"></use></svg>
    }
    <ng-content />`,
  host: {
    '[attr.data-variant]': 'variant()',
    '[attr.data-size]': 'size() ?? null',
    '[attr.data-icon-only]': "iconOnly() ? '' : null",
    '[attr.aria-busy]': "busy() ? 'true' : null",
    '[attr.type]': 'isButton ? type() : null',
  },
})
export class ButtonComponent {
  readonly variant = input<ButtonVariant>('secondary');
  readonly size = input<'m' | 's' | undefined>(undefined);
  readonly icon = input<string | undefined>(undefined);
  /** Square icon button: `aria-label` is required. */
  readonly iconOnly = input(false);
  readonly busy = input(false);
  readonly type = input<'button' | 'submit' | 'reset'>('button');

  protected readonly isButton: boolean;

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    this.isButton = el.tagName === 'BUTTON';
    el.addEventListener(
      'click',
      (e) => {
        if (!this.busy()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }
}
