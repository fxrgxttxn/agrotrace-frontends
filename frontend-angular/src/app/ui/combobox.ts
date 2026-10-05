import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnDestroy,
} from '@angular/core';
import { t } from '../i18n';
import { FieldContext, FieldControlDirective } from './field';

export interface ComboOption {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
}

export const SEARCH_DELAY_MS = 250;

export interface HighlightParts {
  before: string;
  match: string;
  after: string;
}

export function highlight(label: string, query: string): HighlightParts | null {
  const q = query.trim();
  const at = q ? label.toLocaleLowerCase('ru').indexOf(q.toLocaleLowerCase('ru')) : -1;
  if (at < 0) return null;
  return {
    before: label.slice(0, at),
    match: label.slice(at, at + q.length),
    after: label.slice(at + q.length),
  };
}

@Component({
  selector: 'div.at-combobox',
  standalone: true,
  imports: [FieldControlDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<input
      class="at-input"
      [controlId]="baseId()"
      [invalid]="invalid()"
      [describedBy]="describedBy()"
      role="combobox"
      aria-autocomplete="list"
      autocomplete="off"
      [attr.aria-expanded]="open() ? 'true' : 'false'"
      [attr.aria-controls]="listId()"
      [attr.aria-activedescendant]="activeIndex() >= 0 && !showStatus() ? optId(activeIndex()) : null"
      [attr.aria-busy]="loading() ? 'true' : null"
      [disabled]="disabled()"
      [value]="query()"
      (input)="onInput($event)"
      (keydown)="onKeyDown($event)"
      (blur)="close()"
    />
    @if (showStatus()) {
      <div class="at-combobox__list" [attr.id]="listId()" role="status">
        @if (open() && loading()) {
          <p class="at-combobox__status">
            <span class="at-spinner" aria-hidden="true"></span>{{ t('ui.searching') }}
          </p>
        } @else if (open() && query().trim()) {
          <p class="at-combobox__status">{{ t('empty.search') }}</p>
        }
      </div>
    } @else {
      <ul
        class="at-combobox__list"
        role="listbox"
        [attr.id]="listId()"
        [attr.aria-label]="listLabel()"
        [hidden]="!open()"
        (mousedown)="$event.preventDefault()"
      >
        @for (o of options(); track o.value; let i = $index) {
          <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
          <li
            role="option"
            [attr.id]="optId(i)"
            [attr.aria-selected]="o.value === selected() ? 'true' : 'false'"
            [attr.aria-disabled]="o.disabled ? 'true' : null"
            [attr.data-active]="i === activeIndex() ? '' : null"
            (click)="!o.disabled && choose(o)"
          >
            <span>
              @if (parts(o.label); as p) {
                <ng-container>{{ p.before }}</ng-container
                ><mark>{{ p.match }}</mark
                ><ng-container>{{ p.after }}</ng-container>
              } @else {
                <ng-container>{{ o.label }}</ng-container>
              }
            </span>
            @if (o.meta) {
              <span class="at-combobox__meta">{{ o.meta }}</span>
            }
          </li>
        }
      </ul>
    }`,
})
export class ComboboxComponent implements OnDestroy {
  protected readonly t = t;
  readonly id = input<string | undefined>(undefined);
  readonly listLabel = input.required<string>();
  readonly query = input.required<string>();
  readonly options = input.required<ComboOption[]>();
  readonly loading = input(false);
  readonly selected = input<string | null | undefined>(null);
  readonly disabled = input(false);
  readonly invalid = input<boolean | undefined>(undefined);
  readonly describedBy = input<string | undefined>(undefined);
  readonly queryChange = output<string>();
  readonly search = output<string>();
  readonly chosen = output<ComboOption>();

  private readonly field = inject(FieldContext, { optional: true });
  protected readonly baseId = computed(() => this.id() ?? this.field?.controlId() ?? 'combobox');
  protected readonly listId = computed(() => `${this.baseId()}-list`);
  protected readonly open = signal(false);
  private readonly active = signal(-1);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected readonly showStatus = computed(() => this.loading() || this.options().length === 0);
  protected readonly activeIndex = computed(() => {
    const a = this.active();
    return this.open() && a >= 0 && a < this.options().length ? a : -1;
  });
  private readonly enabled = computed(() =>
    this.options()
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => !o.disabled),
  );

  protected optId(i: number): string {
    return `${this.baseId()}-opt-${i + 1}`;
  }

  protected parts(label: string): HighlightParts | null {
    return highlight(label, this.query());
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private move(to: number): void {
    const enabled = this.enabled();
    if (enabled.length === 0) return;
    const pos = Math.max(0, Math.min(enabled.length - 1, to));
    this.active.set(enabled[pos]!.i);
  }

  private posOf(index: number): number {
    return this.enabled().findIndex(({ i }) => i === index);
  }

  protected choose(o: ComboOption): void {
    this.chosen.emit(o);
    this.open.set(false);
    this.active.set(-1);
  }

  protected close(): void {
    this.open.set(false);
    this.active.set(-1);
  }

  protected onInput(e: Event): void {
    const text = (e.target as HTMLInputElement).value;
    this.queryChange.emit(text);
    this.open.set(true);
    this.active.set(-1);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search.emit(text), SEARCH_DELAY_MS);
  }

  protected onKeyDown(e: KeyboardEvent): void {
    const open = this.open();
    const activeIndex = this.activeIndex();
    const enabled = this.enabled();
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        if (!open) this.open.set(true);
        else this.move(activeIndex < 0 ? 0 : this.posOf(activeIndex) + 1);
        break;
      case 'ArrowUp':
        if (!open) handled = false;
        else this.move(activeIndex < 0 ? enabled.length - 1 : this.posOf(activeIndex) - 1);
        break;
      case 'Home':
        if (!open) handled = false;
        else this.move(0);
        break;
      case 'End':
        if (!open) handled = false;
        else this.move(enabled.length - 1);
        break;
      case 'Enter': {
        if (!open) {
          handled = false;
          break;
        }
        const o = activeIndex >= 0 ? this.options()[activeIndex] : undefined;
        if (o && !o.disabled) this.choose(o);
        break;
      }
      case 'Escape':
        if (!open) handled = false;
        else this.close();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }
}
