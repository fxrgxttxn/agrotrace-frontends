import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { t } from '../app/i18n';
import { Button } from './Button';

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

export interface FileFieldProps {
  id: string;
  label: ReactNode;
  accept?: string;
  multiple?: boolean;
  /** Formats and limit, e.g. «PDF, JPG или PNG до 10 МБ»; no hint — no `.at-file__hint`. */
  hint?: string;
  files: FileItem[];
  onFiles: (files: File[]) => void;
  onRemove: (key: string) => void;
  error?: string | null;
  disabled?: boolean;
}

/** `at-file` inside an `at-field` (README «Файл»): a focusable hidden input in a drop zone, the file list as «seed
 * tags» with preview, size and progress. Drag-and-drop toggles `data-dragover`. */
export function FileField({
  id,
  label,
  accept,
  multiple,
  hint,
  files,
  onFiles,
  onRemove,
  error,
  disabled,
}: FileFieldProps) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every nested element: count them so moving over the zone's children does not flicker.
  const depth = useRef(0);
  const labelId = `${id}-label`;
  const errorId = error ? `${id}-error` : undefined;

  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (disabled) return;
    const list = [...e.dataTransfer.files];
    if (list.length) onFiles(multiple ? list : list.slice(0, 1));
  };

  return (
    <div className="at-field" data-invalid={error ? '' : undefined}>
      <span className="at-field__label" id={labelId}>
        {label}
      </span>
      <div
        className="at-file"
        data-dragover={over ? '' : undefined}
        data-invalid={error ? '' : undefined}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current += 1;
          if (!disabled) setOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={drop}
      >
        <label className="at-file__drop">
          <input
            id={id}
            type="file"
            accept={accept}
            multiple={multiple}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={errorId}
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = '';
              if (list.length) onFiles(list);
            }}
          />
          <svg className="at-file__icon" aria-hidden="true">
            <use href="#i-upload" />
          </svg>
          <span className="at-file__action">{t('ui.chooseFile')}</span>
          {hint && (
            <span className="at-file__hint" id={`${id}-hint`}>
              {hint}
            </span>
          )}
        </label>
        {files.length > 0 && (
          <ul className="at-file__list">
            {files.map((f) => (
              <li key={f.key} className="at-file__item" data-error={f.error ? '' : undefined}>
                {f.previewUrl ? (
                  <span className="at-file__preview">
                    <img src={f.previewUrl} alt="" />
                  </span>
                ) : (
                  <span className="at-file__preview" aria-hidden="true">
                    {f.kind ?? ''}
                  </span>
                )}
                <span className="at-file__body">
                  <span className="at-file__name">{f.name}</span>
                  <span className="at-file__size">{f.sizeText}</span>
                  {f.progress !== undefined && (
                    <progress
                      className="at-file__progress"
                      max={100}
                      value={f.progress ?? undefined}
                      aria-label={t('ui.uploading', { name: f.name })}
                    ></progress>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="s"
                  iconOnly
                  icon="close"
                  aria-label={t('ui.removeFile', { name: f.name })}
                  onClick={() => onRemove(f.key)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="at-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
