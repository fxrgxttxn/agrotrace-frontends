import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useFieldControl } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Codes, INN, waybill numbers: `at-mono`. */
  mono?: boolean;
}

/** `at-input` (README «Текстовые поля»). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, ...rest }, ref) {
  const props = useFieldControl(rest);
  return <input ref={ref} className={mono ? 'at-input at-mono' : 'at-input'} {...props} />;
});

/** `at-textarea`. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea(rest, ref) {
    const props = useFieldControl(rest);
    return <textarea ref={ref} className="at-textarea" {...props} />;
  },
);

/** `at-input-group`: a number aligned right against its unit (`кг`, `га`, `мг/кг`). */
export const InputGroup = forwardRef<HTMLInputElement, InputProps & { suffix: ReactNode }>(
  function InputGroup({ suffix, ...rest }, ref) {
    return (
      <div className="at-input-group">
        <Input ref={ref} {...rest} />
        <span className="at-input-group__suffix">{suffix}</span>
      </div>
    );
  },
);

/** `at-select`: native `<select>`, native keyboard. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(rest, ref) {
    const props = useFieldControl(rest);
    return <select ref={ref} className="at-select" {...props} />;
  },
);
