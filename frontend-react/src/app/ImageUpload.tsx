import { useEffect, useState } from 'react';
import { ApiProblem } from '@agrotrace/api-client';
import { formatBytes } from '@agrotrace/i18n';
import { tooLargeText, typesText } from './admin';
import { errorText, errorTone, retryAfterOf, useCountdown, useFocusAfterWait, useFormAlert } from './api';
import { LOCALE, t } from './i18n';
import { Button, FileField, type FileItem } from '../ui';

// One image to upload (a product photo, an organization logo): picked or dropped into an `at-file`, checked against the
// contract's types and size before sending (the server checks the signature again: 415 / 413), previewed, sent with
// «Загрузить». A failure is said on the file (and as the screen's message); a 429 waits on the button.

interface Picked {
  file: File;
  url: string;
  error?: string;
}

export function ImageUpload({
  id,
  label,
  hint,
  types,
  maxBytes,
  upload,
  onDone,
}: {
  id: string;
  label: string;
  hint: string;
  types: readonly string[];
  maxBytes: number;
  /** Sends the file; rejects with the API problem. */
  upload: (file: File) => Promise<void>;
  onDone?: () => void;
}) {
  const alert = useFormAlert();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, startWait] = useCountdown();
  const button = useFocusAfterWait(wait);

  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.url)), [picked]);

  const pick = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    let error: string | undefined;
    if (!types.includes(file.type)) error = t('files.unsupported', { allowed: typesText(types) });
    else if (file.size > maxBytes) error = tooLargeText(maxBytes);
    setPicked({ file, url: URL.createObjectURL(file), error });
  };

  const send = async () => {
    if (!picked || picked.error) return;
    alert.clear();
    setBusy(true);
    try {
      await upload(picked.file);
      setPicked(null);
      onDone?.();
    } catch (e) {
      let error: string | undefined;
      if (e instanceof ApiProblem && e.code === 'FILE_TOO_LARGE')
        error = tooLargeText(Number(e.params?.maxBytes) || maxBytes);
      else if (e instanceof ApiProblem && e.code === 'UNSUPPORTED_MEDIA_TYPE')
        error = t('files.unsupported', {
          allowed: typesText(Array.isArray(e.params?.allowed) ? e.params.allowed : types),
        });
      else if (e instanceof ApiProblem && e.code === 'VALIDATION' && e.errors?.file?.[0])
        error = t(e.errors.file[0]);
      if (e instanceof ApiProblem && e.status === 429) startWait(retryAfterOf(e));
      if (error) setPicked((p) => (p ? { ...p, error } : p));
      alert.show(error ?? errorText(e), error ? 'danger' : errorTone(e));
    } finally {
      setBusy(false);
    }
  };

  const items: FileItem[] = picked
    ? [
        {
          key: 'image',
          name: picked.file.name,
          sizeText: picked.error ?? formatBytes(picked.file.size, LOCALE),
          error: Boolean(picked.error),
          previewUrl: picked.error ? undefined : picked.url,
          kind: picked.error ? typesText([picked.file.type]) : undefined,
          ...(busy ? { progress: null } : {}),
        },
      ]
    : [];

  return (
    <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
      <FileField
        id={id}
        label={label}
        accept={types.join(',')}
        hint={hint}
        files={items}
        onFiles={pick}
        onRemove={() => setPicked(null)}
        error={picked?.error}
        disabled={busy}
      />
      {picked && !picked.error && (
        <div>
          <Button
            ref={button}
            variant="primary"
            icon="upload"
            busy={busy}
            disabled={wait > 0}
            onClick={() => void send()}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('action.upload')}
          </Button>
        </div>
      )}
    </div>
  );
}
