import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
// The toast stack without texts (Toasts.tsx gives it the close label): the public QR page uses it too.
import { Button } from './ButtonBase';

export type ToastTone = 'ok' | 'attention' | 'move' | 'danger' | 'neutral';

export interface ToastInput {
  tone: ToastTone;
  text: string;
  /** Optional second line (`<small>`). */
  detail?: string;
}

interface ToastEntry extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Auto-hide delay (README «Уведомления»); error toasts stay until closed. */
export const TOAST_HIDE_MS = 5000;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast outside <ToastProvider>');
  return api;
}

function Toast({
  toast,
  onClose,
  closeLabel,
}: {
  toast: ToastEntry;
  onClose: () => void;
  closeLabel: string;
}) {
  useEffect(() => {
    if (toast.tone === 'danger') return;
    const timer = setTimeout(onClose, TOAST_HIDE_MS);
    return () => clearTimeout(timer);
  }, [toast.tone, onClose]);
  return (
    <div className="at-toast" data-tone={toast.tone}>
      <p className="at-toast__text">
        {toast.text}
        {toast.detail && <small>{toast.detail}</small>}
      </p>
      <Button variant="ghost" size="s" iconOnly icon="close" aria-label={closeLabel} onClick={onClose} />
    </div>
  );
}

/** One `at-toasts` stack per app: both live regions are rendered from the start and never hidden (README), errors go
 * to the `role="alert"` region, the rest to `aria-live="polite"`. */
export function ToastStack({ children, closeLabel }: { children: ReactNode; closeLabel: string }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const push = useCallback((toast: ToastInput) => {
    const id = next.current++;
    setToasts((all) => [...all, { ...toast, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  const closers = useRef(new Map<number, () => void>());
  const closer = (id: number) => {
    let fn = closers.current.get(id);
    if (!fn) {
      fn = () => {
        closers.current.delete(id);
        dismiss(id);
      };
      closers.current.set(id, fn);
    }
    return fn;
  };
  const render = (list: ToastEntry[]) =>
    list.map((x) => <Toast key={x.id} toast={x} onClose={closer(x.id)} closeLabel={closeLabel} />);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="at-toasts">
        <div className="at-toast-region" role="alert">
          {render(toasts.filter((x) => x.tone === 'danger'))}
        </div>
        <div className="at-toast-region" aria-live="polite">
          {render(toasts.filter((x) => x.tone !== 'danger'))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
