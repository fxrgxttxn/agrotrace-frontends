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

/** `at-dialog` (README «Диалог») on the `<dialog>` itself: `showModal()` (native focus trap and Esc), initial focus on
 * the first focusable element of the body or else on the title (`tabindex="-1"`), focus back to the opener on close.
 * The body content exists only while open; actions are projected as `<div class="at-dialog__actions">`. */
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
  /** Id of the title (`aria-labelledby`); generated when omitted. */
  readonly titleId = input<string | undefined>(undefined);
  readonly size = input<'l' | undefined>(undefined);
  /** Backdrop click closes — only for dialogs without an irreversible action (menus, previews). */
  readonly lightDismiss = input(false);
  /** `title`: focus the title on open even when the body has focusable elements (the «Ещё» menu). */
  readonly initialFocus = input<'auto' | 'title'>('auto');
  /** Close request: Esc, the cross, or (only when `lightDismiss`) a backdrop click. */
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
    // After this change detection pass the body content of an opening dialog is in the DOM.
    queueMicrotask(() => this.sync());
  }

  /** A dialog rendered only while open (`@if (x) { <dialog [open]="true"> }`) is removed by its close — Esc, the
   * cross, a success — without its native `close` reaching us: it still gives the focus back to its opener if it held
   * it (FM21/FM25, polish P1 — the React Dialog's removal), closing first so the opener is no longer behind the modal.
   * A focus the screen already moved elsewhere stays there. */
  ngOnDestroy(): void {
    if (this.el.open) this.closeAndReturn();
  }

  /** Closes, and gives the focus back to the opener if the dialog held it (FM21) — at once, not on the native `close`
   * event, so the app-wide focus rescue never sees a lost focus in between (a body swapped or removed while closing).
   * A focus the screen already moved out of the dialog stays where it is. */
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
    // `tabindex="-1"` must be on the heading before it can take focus.
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
