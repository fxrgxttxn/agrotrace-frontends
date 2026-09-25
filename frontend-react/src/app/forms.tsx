import type { ReactNode } from 'react';
import { useForm, type FieldValues, type Path, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodTypeAny } from 'zod';
import { applyProblem, fieldText, useCountdown, useFormAlert } from './api';
import { t } from './i18n';
import { Button } from '../ui/Button';

// Forms (spec §9.2): React Hook Form on the shared Zod schemas of @agrotrace/validation. Error messages are i18n keys
// (from the schemas and from the server's `errors`), translated where they are shown.

export const FORM_GRID = { display: 'grid', gap: 'var(--sp-4)' } as const;

/** Submit button: busy while sending, disabled with a countdown after a 429. */
export function Submit({
  busy,
  wait,
  children,
  variant = 'primary',
}: {
  busy: boolean;
  wait: number;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Button type="submit" variant={variant} busy={busy} disabled={wait > 0}>
      {wait > 0 ? t('auth.retryIn', { seconds: wait }) : children}
    </Button>
  );
}

/** The pieces every form needs: the RHF form on its shared schema, the form message, the 429 countdown and `fail`
 * (puts a failed submit on the form, see `applyProblem`). */
export function useSchemaForm<F extends FieldValues>(
  schema: ZodTypeAny,
  defaultValues: F,
  fields: readonly Path<F>[],
) {
  // The cast: @hookform/resolvers declares no zod peer, so its own `zod` types do not resolve to ours (runtime is
  // duck-typed: `schema.parseAsync`).
  const form = useForm<F>({ resolver: zodResolver(schema as never), defaultValues: defaultValues as never });
  const alert = useFormAlert();
  const [wait, startWait] = useCountdown();
  const fail = (e: unknown) => applyProblem(e, { form, fields, alert: alert.show, onRateLimit: startWait });
  return { form, alert, wait, fail };
}

/** Translated error text of a (possibly nested: `admin.email`) field. */
export function errorOf<F extends FieldValues>(form: UseFormReturn<F>, name: string): string | undefined {
  let node: unknown = form.formState.errors;
  for (const p of name.split('.')) node = (node as Record<string, unknown> | undefined)?.[p];
  return fieldText((node as { message?: string } | undefined)?.message);
}
