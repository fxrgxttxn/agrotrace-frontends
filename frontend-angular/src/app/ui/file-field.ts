import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { t } from '../i18n';
import { ButtonComponent } from './button';

export interface FileItem {
  key: string;
  name: string;
  /** Size text (`1,2 МБ`) or, with `error`, the error text. */
  sizeText: string;
  error?: boolean;
  /** Image preview URL (blob: or a signed URL); otherwise `kind` (e.g. `PDF`) is shown. */
  previewUrl?: string;
  kind?: string;
  /** Upload progress 0–100 while uploading; `null` — uploading, the sent part unknown (fetch has no upload progress:
   * an indeterminate `progress` without `value`); omitted otherwise. */
  progress?: number | null;
}

/** `at-file` inside an `at-field` (README «Файл»): a focusable hidden input in a drop zone, the file list as «seed
 * tags» with preview, size and progress. Drag-and-drop toggles `data-dragover` (enter/leave counted in pairs). */
@Component({
  selector: 'div.at-field[files]',
  standalone: true,
  imports: [ButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="at-field__label" [attr.id]="fileId() + '-label'">{{ label() }}</span>
    <div
      class="at-file"
      [attr.data-dragover]="over() ? '' : null"
      [attr.data-invalid]="error() ? '' : null"
      (dragenter)="onEnter($event)"
      (dragover)="$event.preventDefault()"
      (dragleave)="onLeave()"
      (drop)="onDrop($event)"
    >
      <label class="at-file__drop">
        <input
          [attr.id]="fileId()"
          type="file"
          [attr.accept]="accept() ?? null"
          [multiple]="multiple()"
          [disabled]="disabled()"
          [attr.aria-labelledby]="fileId() + '-label'"
          [attr.aria-invalid]="error() ? 'true' : null"
          [attr.aria-describedby]="error() ? fileId() + '-error' : null"
          (change)="onChange($event)"
        />
        <svg class="at-file__icon" aria-hidden="true"><use href="#i-upload"></use></svg>
        <span class="at-file__action">{{ t('ui.chooseFile') }}</span>
        @if (hint()) {
          <span class="at-file__hint" [attr.id]="fileId() + '-hint'">{{ hint() }}</span>
        }
      </label>
      @if (files().length > 0) {
        <ul class="at-file__list">
          @for (f of files(); track f.key) {
            <li class="at-file__item" [attr.data-error]="f.error ? '' : null">
              @if (f.previewUrl) {
                <span class="at-file__preview"><img [attr.src]="f.previewUrl" alt="" /></span>
              } @else {
                <span class="at-file__preview" aria-hidden="true">{{ f.kind ?? '' }}</span>
              }
              <span class="at-file__body">
                <span class="at-file__name">{{ f.name }}</span>
                <span class="at-file__size">{{ f.sizeText }}</span>
                @if (f.progress !== undefined) {
                  <progress
                    class="at-file__progress"
                    max="100"
                    [attr.value]="f.progress"
                    [attr.aria-label]="t('ui.uploading', { name: f.name })"
                  ></progress>
                }
              </span>
              <button
                class="at-button"
                [variant]="'ghost'"
                [size]="'s'"
                [iconOnly]="true"
                [icon]="'close'"
                [attr.aria-label]="t('ui.removeFile', { name: f.name })"
                (click)="removed.emit(f.key)"
              ></button>
            </li>
          }
        </ul>
      }
    </div>
    @if (error()) {
      <p class="at-field__error" [attr.id]="fileId() + '-error'" role="alert">{{ error() }}</p>
    }`,
  host: { '[attr.data-invalid]': "error() ? '' : null" },
})
export class FileFieldComponent {
  protected readonly t = t;
  /** Id of the input; the label is `${fileId}-label`, the error `${fileId}-error`, the hint `${fileId}-hint` (FM22). */
  readonly fileId = input.required<string>();
  readonly label = input.required<string>();
  readonly accept = input<string | undefined>(undefined);
  readonly multiple = input(false);
  /** Formats and limit, e.g. «PDF, JPG или PNG до 10 МБ»; no hint — no `.at-file__hint`. */
  readonly hint = input<string | undefined>(undefined);
  readonly files = input.required<FileItem[]>();
  readonly error = input<string | null | undefined>(null);
  readonly disabled = input(false);
  readonly chosen = output<File[]>();
  readonly removed = output<string>();

  protected readonly over = signal(false);
  // dragenter/dragleave fire for every nested element: counted so moving over the zone's children does not flicker.
  private depth = 0;

  protected onEnter(e: DragEvent): void {
    e.preventDefault();
    this.depth += 1;
    if (!this.disabled()) this.over.set(true);
  }

  protected onLeave(): void {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.over.set(false);
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.depth = 0;
    this.over.set(false);
    if (this.disabled()) return;
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length) this.chosen.emit(this.multiple() ? list : list.slice(0, 1));
  }

  protected onChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const list = [...(input.files ?? [])];
    input.value = '';
    if (list.length) this.chosen.emit(list);
  }
}
