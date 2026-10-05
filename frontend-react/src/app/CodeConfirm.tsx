import { useEffect, useState, type ReactNode } from 'react';
import { useFocusAfterWait } from './api';
import { t } from './i18n';
import { Button, Dialog, DialogMessage, Field, Input } from '../ui';

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
  code: string;
  confirmLabel: string;
  busy: boolean;
  wait: number;
  message: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const confirmRef = useFocusAfterWait(wait);
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
