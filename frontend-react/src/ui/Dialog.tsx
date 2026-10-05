import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../app/i18n';
import { Button } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  id?: string;
  titleId?: string;
  size?: 'l';
  lightDismiss?: boolean;
  initialFocus?: 'auto' | 'title';
  actions?: ReactNode;
  children?: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  id,
  titleId: titleIdProp,
  size,
  lightDismiss,
  initialFocus = 'auto',
  actions,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const autoId = `${useId().replace(/:/g, '')}-title`;
  const titleId = titleIdProp ?? autoId;
  const [titleFocus, setTitleFocus] = useState(initialFocus === 'title');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      if (initialFocus === 'title') titleRef.current?.focus();
      else if (first) {
        setTitleFocus(false);
        first.focus();
      } else {
        setTitleFocus(true);
        titleRef.current?.focus();
      }
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocus]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      const back = opener.current;
      if (!dialog?.open) return;
      opener.current = null;
      const active = document.activeElement;
      const held = active === null || active === document.body || dialog.contains(active);
      dialog.close();
      if (held && back?.isConnected) back.focus();
    };
  }, []);

  useEffect(() => {
    if (open && titleFocus) titleRef.current?.focus();
  }, [open, titleFocus]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    const onNativeClose = () => {
      const back = opener.current;
      opener.current = null;
      if (back && back.isConnected) back.focus();
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onNativeClose);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onNativeClose);
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="at-dialog"
      id={id}
      aria-labelledby={titleId}
      data-size={size}
      onClick={(e) => {
        if (lightDismiss && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="at-dialog__header">
        <h2 ref={titleRef} className="at-dialog__title" id={titleId} tabIndex={titleFocus ? -1 : undefined}>
          {title}
        </h2>
        <Button variant="ghost" iconOnly icon="close" aria-label={t('shell.close')} onClick={onClose} />
      </div>
      <div className="at-dialog__body" ref={bodyRef}>
        {open ? children : null}
      </div>
      {actions && <div className="at-dialog__actions">{actions}</div>}
    </dialog>
  );
}

export function DialogMessage({ text }: { text: string | null | undefined }) {
  return text ? (
    <p className="at-field__error" role="alert" style={{ margin: 0 }}>
      {text}
    </p>
  ) : null;
}
