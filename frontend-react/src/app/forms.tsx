import { forwardRef, useMemo, useState, type ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z, type ZodTypeAny } from 'zod';
import { applyProblem, fieldText, useCountdown, useFocusAfterWait, useFormAlert } from './api';
import { t } from './i18n';
import { Button } from '../ui/Button';

// Forms (spec §9.2): React Hook Form on the shared Zod schemas of @agrotrace/validation. Error messages are i18n keys
// (from the schemas and from the server's `errors`), translated where they are shown.

export const FORM_GRID = { display: 'grid', gap: 'var(--sp-4)' } as const;

/** Submit button: busy while sending, disabled with a countdown after a 429; when the wait ends it takes the focus
 * back if nothing else holds it (FM17, `useFocusAfterWait`). */
export const Submit = forwardRef<
  HTMLButtonElement,
  {
    busy: boolean;
    wait: number;
    children: ReactNode;
    variant?: 'primary' | 'secondary';
    /** Id of the form when the button stands outside it (dialog actions). */
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

/** The pieces every form needs: the RHF form on its shared schema, the form message, the 429 countdown and `fail`
 * (puts a failed submit on the form, see `applyProblem`). */
export function useSchemaForm<F extends FieldValues>(
  schema: ZodTypeAny,
  defaultValues: F,
  fields: readonly Path<F>[],
  alias?: (path: string) => string,
  /** `false`: the form focuses its first invalid field itself (`focusFirstInvalid`) — when a field without a form ref
   * (a combobox, a picker) comes first, React Hook Form's own choice (the first registered field) would be wrong. */
  shouldFocusError = true,
) {
  // The cast: @hookform/resolvers declares no zod peer, so its own `zod` types do not resolve to ours (runtime is
  // duck-typed: `schema.parseAsync`).
  const form = useForm<F>({
    resolver: zodResolver(schema as never),
    defaultValues: defaultValues as never,
    shouldFocusError,
  });
  const toastAlert = useFormAlert();
  // The form-level message is also kept as `message`: a form inside a modal dialog says it in its body (README
  // «Диалог»: the page's toast region is behind the modal).
  const [message, setMessage] = useState<string | null>(null);
  const alert = useMemo(
    () => ({
      show: (text: string, tone?: 'danger' | 'attention') => {
        setMessage(text);
        toastAlert.show(text, tone);
      },
      clear: () => {
        setMessage(null);
        toastAlert.clear();
      },
    }),
    [toastAlert],
  );
  const [wait, startWait] = useCountdown();
  const fail = (e: unknown) =>
    applyProblem(e, { form, fields, alert: alert.show, onRateLimit: startWait, alias });
  return { form, alert, wait, fail, message };
}

/** Translated error text of a (possibly nested: `admin.email`) field. */
export function errorOf<F extends FieldValues>(form: UseFormReturn<F>, name: string): string | undefined {
  let node: unknown = form.formState.errors;
  for (const p of name.split('.')) node = (node as Record<string, unknown> | undefined)?.[p];
  return fieldText((node as { message?: string } | undefined)?.message);
}

/** Form text of a decimal as the wire format wants it: `1,5` → `1.500` for `places` = 3. Anything that is not a plain
 * number is returned as typed, so the shared schema reports it (`validation.*.format`). */
export function normalizeDecimal(text: string, places: number): string {
  const m = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(text);
  if (!m || (m[2] ?? '').length > places) return text;
  return `${m[1]}.${(m[2] ?? '').padEnd(places, '0')}`;
}

/** A form schema whose values are the form's own (texts, selects) and whose output is the request body: `toWire`
 * builds the body, the shared schema of @agrotrace/validation checks it, and each issue is put on the top-level form
 * field its path starts with (`geometry.coordinates.0` → `geometry`). An empty text or an unchosen select (`''`) is an
 * absent value, so it is reported as «Обязательное поле», not as a bad format. */
export function wireSchema<F>(
  shared: ZodTypeAny,
  toWire: (values: F) => unknown,
  /** Form-only checks before the body is built (e.g. text that must parse as JSON): field → i18n key. */
  precheck?: (values: F) => Record<string, string>,
) {
  return z.custom<F>().transform((values, ctx) => {
    // Form checks and the shared schema both report (one message per field, the form check first).
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

/** The first invalid field in the order of the form takes the focus (README «Поле формы», the same in every frontend):
 * once the errors are on the page, the first `[aria-invalid="true"]` inside `root` in document order — a combobox or a
 * picker without a React Hook Form ref included. For forms with `shouldFocusError: false`. */
export function focusFirstInvalid(root: ParentNode | null | undefined): void {
  setTimeout(() => root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
}
