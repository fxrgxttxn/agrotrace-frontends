import type { ReactNode } from 'react';
import { FieldContext } from './Field';

// Field groups of the cabinet (kept apart from Field.tsx, which the public QR page also uses).

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
