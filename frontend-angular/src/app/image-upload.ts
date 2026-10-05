import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ApiProblem } from '@agrotrace/api-client';
import { formatBytes } from '@agrotrace/i18n';
import { injectAlive } from './alive';
import { tooLargeText, typesText } from './admin';
import { countdown, errorText, retryAfterOf } from './api';
import { errorTone, FocusAfterWaitDirective, formAlert, type DialogAlert } from './forms';
import { LOCALE, t } from './i18n';
import { ButtonComponent, FileFieldComponent, type FileItem } from './ui';

interface Picked {
  file: File;
  url: string;
  error?: string;
}

@Component({
  selector: 'div[imageUpload]',
  standalone: true,
  imports: [ButtonComponent, FileFieldComponent, FocusAfterWaitDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div
      class="at-field"
      [files]="items()"
      [fileId]="imageUpload()"
      [label]="label()"
      [accept]="types().join(',')"
      [hint]="hint()"
      [error]="picked()?.error"
      [disabled]="busy()"
      (chosen)="pick($event)"
      (removed)="drop()"
    ></div>
    @if (picked() && !picked()!.error) {
      <div>
        <button
          class="at-button"
          [variant]="'primary'"
          [icon]="'upload'"
          [busy]="busy()"
          [disabled]="wait.left() > 0"
          [focusAfterWait]="wait.left()"
          (click)="send()"
        >
          {{ wait.left() > 0 ? t('auth.retryIn', { seconds: wait.left() }) : t('action.upload') }}
        </button>
      </div>
    }`,
  host: { style: 'display: grid; gap: var(--sp-3)' },
})
export class ImageUploadComponent {
  protected readonly t = t;
  readonly imageUpload = input.required<string>();
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly types = input.required<readonly string[]>();
  readonly maxBytes = input.required<number>();
  readonly upload = input.required<(file: File) => Promise<void>>();
  readonly done = output<void>();
  readonly dialogAlert = input<DialogAlert | undefined>(undefined);

  private readonly formAlert = formAlert();
  private readonly alert = {
    show: (text: string, tone?: 'danger' | 'attention') =>
      (this.dialogAlert() ?? this.formAlert).show(text, tone),
    clear: () => (this.dialogAlert() ?? this.formAlert).clear(),
  };
  private readonly alive = injectAlive();
  protected readonly picked = signal<Picked | null>(null);
  protected readonly busy = signal(false);
  protected readonly wait = countdown();
  protected readonly items = computed<FileItem[]>(() => {
    const p = this.picked();
    if (!p) return [];
    return [
      {
        key: 'image',
        name: p.file.name,
        sizeText: p.error ?? formatBytes(p.file.size, LOCALE),
        error: Boolean(p.error),
        ...(p.error ? { kind: typesText([p.file.type]) } : { previewUrl: p.url }),
        ...(this.busy() ? { progress: null } : {}),
      },
    ];
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      const p = this.picked();
      if (p) URL.revokeObjectURL(p.url);
    });
  }

  private replace(next: Picked | null): void {
    const prev = this.picked();
    if (prev && prev !== next && prev.url !== next?.url) URL.revokeObjectURL(prev.url);
    this.picked.set(next);
  }

  protected drop(): void {
    this.replace(null);
  }

  protected pick(files: File[]): void {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!this.types().includes(file.type))
      error = t('files.unsupported', { allowed: typesText(this.types()) });
    else if (file.size > this.maxBytes()) error = tooLargeText(this.maxBytes());
    this.replace({ file, url: URL.createObjectURL(file), ...(error ? { error } : {}) });
  }

  protected async send(): Promise<void> {
    const picked = this.picked();
    if (!picked || picked.error) return;
    this.alert.clear();
    this.busy.set(true);
    try {
      await this.upload()(picked.file);
      if (!this.alive()) return;
      this.replace(null);
      this.done.emit();
    } catch (e) {
      if (!this.alive()) return;
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.['maxBytes']) || this.maxBytes());
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE') {
        const allowed = e.params?.['allowed'];
        error = t('files.unsupported', {
          allowed: typesText(Array.isArray(allowed) ? allowed : this.types()),
        });
      } else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.['file']?.[0])
        error = t(e.errors['file'][0]);
      if (e instanceof ApiProblem && e.status === 429) this.wait.start(retryAfterOf(e));
      if (error) this.picked.update((p) => (p ? { ...p, error } : p));
      if (!(this.dialogAlert() && error))
        this.alert.show(error ?? errorText(e), error ? 'danger' : errorTone(e));
    } finally {
      if (this.alive()) this.busy.set(false);
    }
  }
}
