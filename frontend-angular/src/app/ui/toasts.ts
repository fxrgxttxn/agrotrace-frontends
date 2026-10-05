import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injectable,
  input,
  output,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { t } from '../i18n';
import { ButtonComponent } from './button';

export type ToastTone = 'ok' | 'attention' | 'move' | 'danger' | 'neutral';

export interface ToastInput {
  tone: ToastTone;
  text: string;
  detail?: string;
}

export interface ToastEntry extends ToastInput {
  id: number;
}

export const TOAST_HIDE_MS = 5000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private next = 1;
  readonly toasts = signal<ToastEntry[]>([]);

  push(toast: ToastInput): number {
    const id = this.next++;
    this.toasts.update((all) => [...all, { ...toast, id }]);
    return id;
  }

  dismiss(id: number): void {
    this.toasts.update((all) => all.filter((x) => x.id !== id));
  }
}

@Component({
  selector: 'div.at-toast',
  standalone: true,
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // prettier-ignore
  template: `<p class="at-toast__text">{{ toast().text }}@if (toast().detail) {<small>{{ toast().detail }}</small>}</p>
    <button
      class="at-button"
      [variant]="'ghost'"
      [size]="'s'"
      [iconOnly]="true"
      [icon]="'close'"
      [attr.aria-label]="t('shell.close')"
      (click)="dismissed.emit()"
    ></button>`,
  host: { '[attr.data-tone]': 'toast().tone' },
})
export class ToastComponent implements OnInit, OnDestroy {
  protected readonly t = t;
  readonly toast = input.required<ToastEntry>();
  readonly dismissed = output<void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    if (this.toast().tone !== 'danger') this.timer = setTimeout(() => this.dismissed.emit(), TOAST_HIDE_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

@Component({
  selector: 'div.at-toasts',
  standalone: true,
  imports: [ToastComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="at-toast-region" role="alert">
      @for (x of errors(); track x.id) {
        <div class="at-toast" [toast]="x" (dismissed)="service.dismiss(x.id)"></div>
      }
    </div>
    <div class="at-toast-region" aria-live="polite">
      @for (x of others(); track x.id) {
        <div class="at-toast" [toast]="x" (dismissed)="service.dismiss(x.id)"></div>
      }
    </div>`,
})
export class ToastsComponent {
  protected readonly service = inject(ToastService);
  protected readonly errors = computed(() => this.service.toasts().filter((x) => x.tone === 'danger'));
  protected readonly others = computed(() => this.service.toasts().filter((x) => x.tone !== 'danger'));
}
