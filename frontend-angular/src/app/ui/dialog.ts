import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  type OnChanges,
  type OnDestroy,
} from '@angular/core';
import { t } from '../i18n';
import { ButtonComponent } from './button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let nextId = 1;

@Component({
  selector: 'dialog.at-dialog',
  standalone: true,
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-dialog__header">
      <h2 #title class="at-dialog__title" [attr.id]="headingId()" [attr.tabindex]="titleFocus() ? -1 : null">
        {{ dialogTitle() }}
      </h2>
      <button
        class="at-button"
        [variant]="'ghost'"
        [iconOnly]="true"
        [icon]="'close'"
        [attr.aria-label]="t('shell.close')"
        (click)="closed.emit()"
      ></button>
    </div>
    <div #body class="at-dialog__body">
      @if (open()) {
        <ng-content />
      }
    </div>
    <ng-content select=".at-dialog__actions" />`,
  host: {
    '[attr.aria-labelledby]': 'headingId()',
    '[attr.data-size]': 'size() ?? null',
    '(click)': 'onClick($event)',
    '(cancel)': 'onCancel($event)',
    '(close)': 'onNativeClose()',
  },
})
export class DialogComponent implements OnChanges, OnDestroy {
  protected readonly t = t;
  readonly open = input.required<boolean>();
  readonly dialogTitle = input.required<string>();
  readonly titleId = input<string | undefined>(undefined);
  readonly size = input<'l' | undefined>(undefined);
  readonly lightDismiss = input(false);
  readonly initialFocus = input<'auto' | 'title'>('auto');
  readonly closed = output<void>();

  private readonly el = inject<ElementRef<HTMLDialogElement>>(ElementRef).nativeElement;
  private readonly autoId = `dialog-${nextId++}-title`;
  protected readonly headingId = computed(() => this.titleId() ?? this.autoId);
  protected readonly titleFocus = signal(false);
  private readonly titleRef = viewChild.required<ElementRef<HTMLElement>>('title');
  private readonly bodyRef = viewChild.required<ElementRef<HTMLElement>>('body');
  private opener: HTMLElement | null = null;

  ngOnChanges(): void {
    this.titleFocus.set(this.initialFocus() === 'title' || this.titleFocus());
    queueMicrotask(() => this.sync());
  }

  ngOnDestroy(): void {
    if (this.el.open) this.closeAndReturn();
  }

  private closeAndReturn(): void {
    const dialog = this.el;
    const back = this.opener;
    this.opener = null;
    const active = document.activeElement;
    const held =
      active === null || active === document.body || !active.isConnected || dialog.contains(active);
    dialog.close();
    if (held) {
      if (back?.isConnected) back.focus();
    } else if (active instanceof HTMLElement && document.activeElement !== active) active.focus();
  }

  private sync(): void {
    const dialog = this.el;
    if (this.open() && !dialog.open) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      const first = this.bodyRef().nativeElement.querySelector<HTMLElement>(FOCUSABLE);
      if (this.initialFocus() === 'title') {
        this.titleFocus.set(true);
        this.focusTitle();
      } else if (first) {
        this.titleFocus.set(false);
        first.focus();
      } else {
        this.titleFocus.set(true);
        this.focusTitle();
      }
    } else if (!this.open() && dialog.open) {
      this.closeAndReturn();
    }
  }

  private focusTitle(): void {
    const title = this.titleRef().nativeElement;
    title.setAttribute('tabindex', '-1');
    title.focus();
  }

  protected onClick(e: MouseEvent): void {
    if (this.lightDismiss() && e.target === this.el) this.closed.emit();
  }

  protected onCancel(e: Event): void {
    e.preventDefault();
    this.closed.emit();
  }

  protected onNativeClose(): void {
    const back = this.opener;
    this.opener = null;
    if (back && back.isConnected) back.focus();
  }
}
