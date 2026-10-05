import { createContext, useContext, type ReactNode } from 'react';

interface FieldState {
  id: string;
  errorId: string | undefined;
  invalid: boolean;
}

export const FieldContext = createContext<FieldState | null>(null);

export interface FieldProps {
  id: string;
  label: ReactNode;
  error?: string | null;
  children: ReactNode;
}

export function Field({ id, label, error, children }: FieldProps) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldContext.Provider value={{ id, errorId, invalid: Boolean(error) }}>
      <div className="at-field" data-invalid={error ? '' : undefined}>
        <label className="at-field__label" htmlFor={id}>
          {label}
        </label>
        {children}
        {error && (
          <p className="at-field__error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

export interface ControlAttrs {
  id?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  'aria-describedby'?: string;
}

export function useFieldControl<P extends ControlAttrs>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [props['aria-describedby'], field.errorId].filter(Boolean).join(' ') || undefined;
  return {
    ...props,
    id: props.id ?? field.id,
    'aria-invalid': field.invalid ? 'true' : props['aria-invalid'],
    'aria-describedby': describedBy,
  };
}
