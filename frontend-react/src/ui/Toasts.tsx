import type { ReactNode } from 'react';
import { t } from '../app/i18n';
import { ToastStack } from './ToastCore';

export { useToast, TOAST_HIDE_MS, type ToastInput, type ToastTone } from './ToastCore';

/** One `at-toasts` stack per app: both live regions are rendered from the start and never hidden (README), errors go
 * to the `role="alert"` region, the rest to `aria-live="polite"`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return <ToastStack closeLabel={t('shell.close')}>{children}</ToastStack>;
}
