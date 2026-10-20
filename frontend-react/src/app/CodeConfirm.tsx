import { useEffect, useState, type ReactNode } from 'react';
import { useFocusAfterWait } from './api';
import { t } from './i18n';
import { Button, Dialog, DialogMessage, Field, Input } from '../ui';

// Confirmation of an irreversible action in its own `at-dialog` with the batch code repeated (spec §9.3, README
// «Диалог»): starting a recall, confirming a withdrawal. The danger button stays disabled until the typed code matches
// (case and surrounding spaces do not matter); a failure is said inside the dialog (the page's toast region is behind
// the modal) and what was typed stays; any close clears it — a dialog opened again asks for the code again.

export function CodeConfirmDialog({
  open,
  title,
  text,
  code,
  confirmLabel,
  busy,
  wait,
  message,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  text: ReactNode;
  /** The batch code to repeat. */
  code: string;
  confirmLabel: string;
  busy: boolean;
  /** Seconds of a 429 wait (0 — none). */
  wait: number;
  /** The failure of the last attempt, said in the dialog. */
  message: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const confirmRef = useFocusAfterWait(wait);
  // An unknown code (empty) never matches: an empty field must not confirm an irreversible action.
  const matches = code.trim() !== '' && typed.trim().toUpperCase() === code.trim().toUpperCase();
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant="danger"
            busy={busy}
            disabled={!matches || wait > 0}
            onClick={onConfirm}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
        <DialogMessage text={message} />
        {text}
        <Field id="confirm-code" label={t('recallTasks.confirmCode')}>
          <Input mono autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
