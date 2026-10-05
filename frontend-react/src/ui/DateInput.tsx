import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { formatRuDate, isWithinRuDateBounds, maskRuDateInput, parseRuDate } from '@agrotrace/i18n';
import { t } from '../app/i18n';
import { useFieldControl } from './Field';

export type DateError = 'validation.date.format' | 'validation.range';

export interface DateInputProps {
  id?: string;
  value: string | null;
  onChange: (iso: string | null) => void;
  onValidate?: (error: DateError | null) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  name?: string;
  'aria-invalid'?: 'true' | 'false';
  'aria-describedby'?: string;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}

export function DateInput(props: DateInputProps) {
  const { value, onChange, onValidate, min, max, disabled, name, onBlur } = props;
  const control = useFieldControl({
    id: props.id,
    'aria-invalid': props['aria-invalid'],
    'aria-describedby': props['aria-describedby'],
  });
  const [text, setText] = useState(() => formatRuDate(value));
  const textRef = useRef<HTMLInputElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText((current) => (parseRuDate(current) === (value || null) ? current : formatRuDate(value)));
  }, [value]);

  const check = (typed: string): DateError | null => {
    if (!typed.trim()) return null;
    const iso = parseRuDate(typed);
    if (!iso) return 'validation.date.format';
    return isWithinRuDateBounds(iso, min, max) ? null : 'validation.range';
  };

  return (
    <div className="at-date">
      <input
        ref={textRef}
        className="at-input"
        {...control}
        name={name}
        inputMode="numeric"
        placeholder="ДД.ММ.ГГГГ"
        maxLength={10}
        autoComplete="off"
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const masked = maskRuDateInput(e.target.value);
          setText(masked);
          onChange(parseRuDate(masked));
        }}
        onBlur={(e) => {
          onValidate?.(check(text));
          onBlur?.(e);
        }}
      />
      <button
        className="at-date__button"
        type="button"
        aria-label={t('ui.openCalendar')}
        disabled={disabled}
        onClick={() => {
          const native = nativeRef.current;
          if (!native) return;
          native.value = parseRuDate(text) ?? '';
          try {
            native.showPicker();
          } catch {
            native.focus();
          }
        }}
      >
        <svg aria-hidden="true">
          <use href="#i-calendar" />
        </svg>
      </button>
      <input
        ref={nativeRef}
        className="at-date__native"
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const next = formatRuDate(e.target.value);
          setText(next);
          onChange(parseRuDate(next));
          onValidate?.(check(next));
          textRef.current?.focus();
        }}
      />
    </div>
  );
}

export function dateErrorText(error: DateError | null): string | null {
  return error ? t(error) : null;
}
