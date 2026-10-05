import { getContext, setContext } from 'svelte';

export interface FieldState {
  readonly id: string;
  readonly errorId: string | undefined;
  readonly invalid: boolean;
}

const KEY = Symbol('at-field');

export function provideField(state: FieldState): void {
  setContext(KEY, state);
}

export interface ControlAttrs {
  id: string | undefined;
  'aria-invalid': 'true' | 'false' | undefined;
  'aria-describedby': string | undefined;
}

export function fieldControl(
  own: () => {
    id?: string | null;
    'aria-invalid'?: unknown;
    'aria-describedby'?: string | null;
  },
): () => ControlAttrs {
  const field = getContext<FieldState | undefined>(KEY);
  return () => {
    const p = own();
    const invalidOwn =
      p['aria-invalid'] === true || p['aria-invalid'] === 'true'
        ? 'true'
        : p['aria-invalid'] === false || p['aria-invalid'] === 'false'
          ? 'false'
          : undefined;
    if (!field)
      return {
        id: p.id ?? undefined,
        'aria-invalid': invalidOwn,
        'aria-describedby': p['aria-describedby'] ?? undefined,
      };
    const describedBy = [p['aria-describedby'], field.errorId].filter(Boolean).join(' ') || undefined;
    return {
      id: p.id ?? field.id,
      'aria-invalid': field.invalid ? 'true' : invalidOwn,
      'aria-describedby': describedBy,
    };
  };
}
