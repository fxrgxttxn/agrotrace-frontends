import { createContext, useContext, type ReactNode } from 'react';

interface FieldState {
  id: string;
  errorId: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldState | null>(null);

export interface FieldProps {
  /** Id of the control; the label points at it, the error element is `${id}-error`. */
  id: string;
  label: ReactNode;
  /** Error text (already translated). Rendered only when present (README «Поле формы»). */
  error?: string | null;
  children: ReactNode;
}

/** `at-field`: label + control + error. Controls inside (Input, Select, Textarea, DateInput, Combobox) take the id,
 * `aria-invalid` and `aria-describedby` from the field. */
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

/** Group of checkboxes / radios: `<fieldset class="at-field"><legend class="at-field__label">`. */
export function FieldSet({
  legend,
  error,
  errorId,
  direction = 'column',
  children,
}: {
  legend: ReactNode;
  error?: string | null;
  errorId?: string;
  direction?: 'column' | 'row';
  children: ReactNode;
}) {
  return (
    <fieldset className="at-field" data-invalid={error ? '' : undefined}>
      <legend className="at-field__label">{legend}</legend>
      <div className="at-field__options" data-direction={direction}>
        {children}
      </div>
      {error && (
        <p className="at-field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export interface ControlAttrs {
  id?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  'aria-describedby'?: string;
}

/** Merges the enclosing field's id / invalid state / error reference into a control's own props. */
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

/** An `at-field` inside a table cell or a row of a list form: the column header (`data-label` in card mode) or the
 * control's own `aria-label` names the control, so there is no `label` element; the error is as in `Field`. */
export function CellField({
  id,
  error,
  children,
}: {
  id: string;
  error?: string | null;
  children: ReactNode;
}) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <FieldContext.Provider value={{ id, errorId, invalid: Boolean(error) }}>
      <div className="at-field" data-invalid={error ? '' : undefined}>
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
