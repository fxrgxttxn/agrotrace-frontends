import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../app/i18n';
import { Button } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  /** Close request: Esc, the cross, «Отмена», or (only when `lightDismiss`) a backdrop click. */
  onClose: () => void;
  title: ReactNode;
  id?: string;
  /** Id of the title (`aria-labelledby`); generated when omitted. */
  titleId?: string;
  size?: 'l';
  /** Backdrop click closes — only for dialogs without an irreversible action (menus, previews). */
  lightDismiss?: boolean;
  /** `title`: focus the title on open even when the body has focusable elements (the «Ещё» menu). */
  initialFocus?: 'auto' | 'title';
  /** `.at-dialog__actions` content (buttons). */
  actions?: ReactNode;
  children?: ReactNode;
}

/** `at-dialog` (README «Диалог»): `showModal()` (native focus trap and Esc), initial focus on the first focusable
 * element of the body or else on the title (`tabindex="-1"`), focus returns to the opener on close. */
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

  // Title fallback focus runs once `tabindex="-1"` is on the heading.
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

/** A failure shown inside a modal dialog (README «Диалог»: the page's toast region is behind the modal, so the dialog
 * says it itself; the page keeps its own message too). Nothing while there is no failure. */
export function DialogMessage({ text }: { text: string | null | undefined }) {
  return text ? (
    <p className="at-field__error" role="alert" style={{ margin: 0 }}>
      {text}
    </p>
  ) : null;
}
