import type { ReactNode } from 'react';
import { FieldContext } from './Field';

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
