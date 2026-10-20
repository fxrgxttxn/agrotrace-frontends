import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Visible label; omitted for table selection boxes, which carry `aria-label` instead. */
  children?: ReactNode;
  /** Partial selection (a DOM property, not an attribute). */
  indeterminate?: boolean;
};

/** `at-check` (README «Флажок»). */
export const Checkbox = forwardRef<HTMLInputElement, CheckProps>(function Checkbox(
  { children, indeterminate = false, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="at-check">
      <input ref={inner} type="checkbox" {...rest} />
      {children !== undefined && <span>{children}</span>}
    </label>
  );
});

/** `at-radio`. */
export const Radio = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { children: ReactNode }
>(function Radio({ children, ...rest }, ref) {
  return (
    <label className="at-radio">
      <input ref={ref} type="radio" {...rest} />
      <span>{children}</span>
    </label>
  );
});

/** `at-switch`: the text is the accessible name; Enter/Space toggle (native button). */
export function Switch({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className="at-switch"
      type="button"
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {children}
    </button>
  );
}
