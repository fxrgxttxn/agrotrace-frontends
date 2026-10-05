import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { DateInput, Field } from '../ui';

export function DateFilter({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (iso: string | null) => void;
}) {
  const latest = useRef<string | null>(value || null);
  useEffect(() => {
    latest.current = value || null;
  }, [value]);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field id={id} label={label} error={error ? t(error) : null}>
      <DateInput
        value={value || null}
        min={min}
        max={max}
        onChange={(iso) => {
          latest.current = iso;
          if (iso && iso !== value) onChange(iso);
        }}
        onValidate={(err) => {
          setError(err);
          if (!err && latest.current === null && value) onChange(null);
        }}
      />
    </Field>
  );
}
