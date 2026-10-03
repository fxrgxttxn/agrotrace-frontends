import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
} from '@angular/core';
import { t } from '../i18n';
import { LinkDirective } from './link';

/** Page numbers to show: first, last, current ± 1; `null` is a gap (a gap of exactly one page shows that page). */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const out: (number | null)[] = [];
  let prev = 0;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - prev > 1) out.push(p - prev === 2 ? p - 1 : null);
    out.push(p);
    prev = p;
  }
  return out;
}

/** `at-pagination` (README «Пагинация»): links keep the rest of the URL state (`hrefFor` builds them); no previous /
 * next page — a disabled button instead of the link. Without `hrefFor` the pages of a list held in memory (inside a
 * card) are buttons (`pageChange`) and the `nav` has its own `label`; an arrow that became disabled by its own press
 * hands the focus to the current page. */
@Component({
  selector: 'nav.at-pagination',
  standalone: true,
  imports: [LinkDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="at-pagination__summary">
      {{ t('ui.pageSummary', { from: from(), to: to(), total: total() }) }}
    </p>
    <ul class="at-pagination__pages">
      <li>
        @if (page() > 1) {
          @if (hrefFor(); as href) {
            <a class="at-pagination__item" [to]="href(page() - 1)" [attr.aria-label]="t('ui.prevPage')"
              ><svg aria-hidden="true"><use href="#i-chevron-left"></use></svg
            ></a>
          } @else {
            <button
              class="at-pagination__item"
              type="button"
              [attr.aria-label]="t('ui.prevPage')"
              (click)="go(page() - 1)"
            >
              <svg aria-hidden="true"><use href="#i-chevron-left"></use></svg>
            </button>
          }
        } @else {
          <button class="at-pagination__item" type="button" [attr.aria-label]="t('ui.prevPage')" disabled>
            <svg aria-hidden="true"><use href="#i-chevron-left"></use></svg>
          </button>
        }
      </li>
      @for (p of window(); track $index) {
        <li>
          @if (p === null) {
            <span class="at-pagination__gap" aria-hidden="true">…</span>
          } @else if (hrefFor()) {
            <a
              class="at-pagination__item"
              [to]="hrefFor()!(p)"
              [attr.aria-current]="p === page() ? 'page' : null"
              >{{ p }}</a
            >
          } @else {
            <button
              class="at-pagination__item"
              type="button"
              [attr.aria-current]="p === page() ? 'page' : null"
              (click)="go(p)"
            >
              {{ p }}
            </button>
          }
        </li>
      }
      <li>
        @if (page() < pages()) {
          @if (hrefFor(); as href) {
            <a class="at-pagination__item" [to]="href(page() + 1)" [attr.aria-label]="t('ui.nextPage')"
              ><svg aria-hidden="true"><use href="#i-chevron-right"></use></svg
            ></a>
          } @else {
            <button
              class="at-pagination__item"
              type="button"
              [attr.aria-label]="t('ui.nextPage')"
              (click)="go(page() + 1)"
            >
              <svg aria-hidden="true"><use href="#i-chevron-right"></use></svg>
            </button>
          }
        } @else {
          <button class="at-pagination__item" type="button" [attr.aria-label]="t('ui.nextPage')" disabled>
            <svg aria-hidden="true"><use href="#i-chevron-right"></use></svg>
          </button>
        }
      </li>
    </ul>`,
  host: { '[attr.aria-label]': "label() ?? t('ui.pages')" },
})
export class PaginationComponent {
  protected readonly t = t;
  /** 1-based, as in the contract. */
  readonly page = input.required<number>();
  readonly size = input.required<number>();
  readonly total = input.required<number>();
  /** Links of the pages (the list's URL state); absent — the pages are buttons (`pageChange`). */
  readonly hrefFor = input<((page: number) => string) | undefined>(undefined);
  /** Name of the `nav` (default «Страницы»). */
  readonly label = input<string | undefined>(undefined);
  readonly pageChange = output<number>();
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.size())));
  protected readonly from = computed(() => (this.total() === 0 ? 0 : (this.page() - 1) * this.size() + 1));
  protected readonly to = computed(() => Math.min(this.total(), this.page() * this.size()));
  protected readonly window = computed(() => pageWindow(this.page(), this.pages()));
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private moved = false;

  constructor() {
    // An arrow that became disabled by its own press hands the focus to the current page (README).
    const injector = inject(Injector);
    effect(() => {
      this.page();
      if (!this.moved) return;
      this.moved = false;
      afterNextRender(() => this.focusCurrent(), { injector });
    });
  }

  private focusCurrent(): void {
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      !active.isConnected ||
      (active as HTMLButtonElement).disabled
    )
      this.el.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }

  protected go(p: number): void {
    if (p === this.page()) return;
    this.moved = true;
    this.pageChange.emit(p);
  }
}
