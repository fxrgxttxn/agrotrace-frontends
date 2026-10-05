import { forwardRef, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z, type ZodTypeAny } from 'zod';
import {
  applyProblem,
  fieldText,
  useCountdown,
  useDialogAlert,
  useFocusAfterWait,
  useFormAlert,
} from './api';
import { t } from './i18n';
import { Button } from '../ui/Button';

export const FORM_GRID = { display: 'grid', gap: 'var(--sp-4)' } as const;

export const Submit = forwardRef<
  HTMLButtonElement,
  {
    busy: boolean;
    wait: number;
    children: ReactNode;
    variant?: 'primary' | 'secondary';
    form?: string;
  }
>(function Submit({ busy, wait, children, variant = 'primary', form }, ref) {
  const own = useFocusAfterWait(wait);
  const both = (el: HTMLButtonElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  return (
    <Button ref={both} type="submit" form={form} variant={variant} busy={busy} disabled={wait > 0}>
      {wait > 0 ? t('auth.retryIn', { seconds: wait }) : children}
    </Button>
  );
});

export function useSchemaForm<F extends FieldValues>(
  schema: ZodTypeAny,
  defaultValues: F,
  fields: readonly Path<F>[],
  alias?: (path: string) => string,
  options: {
    shouldFocusError?: boolean;
    dialog?: boolean;
  } = {},
) {
  const form = useForm<F>({
    resolver: zodResolver(schema as never),
    defaultValues: defaultValues as never,
    shouldFocusError: options.shouldFocusError ?? true,
  });
  const toastAlert = useFormAlert();
  const dialogAlert = useDialogAlert();
  const alert = options.dialog ? dialogAlert : toastAlert;
  const [wait, startWait] = useCountdown();
  const fail = (e: unknown) =>
    applyProblem(e, { form, fields, alert: alert.show, onRateLimit: startWait, alias });
  return { form, alert, wait, startWait, fail, message: dialogAlert.message, handOff: dialogAlert.handOff };
}

export function errorOf<F extends FieldValues>(form: UseFormReturn<F>, name: string): string | undefined {
  let node: unknown = form.formState.errors;
  for (const p of name.split('.')) node = (node as Record<string, unknown> | undefined)?.[p];
  return fieldText((node as { message?: string } | undefined)?.message);
}

export function normalizeDecimal(text: string, places: number): string {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > places) return text;
  return `${m[1]}.${(m[2] ?? '').padEnd(places, '0')}`;
}

export function wireSchema<F>(
  shared: ZodTypeAny,
  toWire: (values: F) => unknown,
  precheck?: (values: F) => Record<string, string>,
) {
  return z.custom<F>().transform((values, ctx) => {
    const early = Object.entries(precheck?.(values) ?? {});
    const marked = new Set(early.map(([path]) => path));
    for (const [path, message] of early) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const wire = toWire(values) as Record<string, unknown>;
    const body = Object.fromEntries(Object.entries(wire).filter(([, v]) => v !== '' && v !== undefined));
    const res = shared.safeParse(body);
    if (res.success && early.length === 0) return res.data as unknown;
    for (const issue of res.success ? [] : res.error.issues) {
      const path = issue.path.slice(0, 1);
      if (marked.has(String(path[0]))) continue;
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: issue.message });
    }
    return z.NEVER;
  });
}

export function focusFirstInvalid(root: ParentNode | null | undefined): void {
  setTimeout(() => root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
}
