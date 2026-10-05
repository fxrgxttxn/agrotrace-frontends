import type { ReactNode } from 'react';
import { t } from '../app/i18n';
import { ToastStack } from './ToastCore';

export { useToast, TOAST_HIDE_MS, type ToastInput, type ToastTone } from './ToastCore';

export function ToastProvider({ children }: { children: ReactNode }) {
  return <ToastStack closeLabel={t('shell.close')}>{children}</ToastStack>;
}
