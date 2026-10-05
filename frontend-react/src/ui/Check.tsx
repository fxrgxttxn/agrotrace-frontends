import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  children?: ReactNode;
  indeterminate?: boolean;
};

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

export const Radio = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { children: ReactNode }
>(function Radio({ children, ...rest }, ref) {
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement);
  useLayoutEffect(() => {
    inner.current?.removeAttribute('checked');
  }, []);
  return (
    <label className="at-radio">
      <input ref={inner} type="radio" {...rest} />
      <span>{children}</span>
    </label>
  );
});

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
