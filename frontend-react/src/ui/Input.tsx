import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useFieldControl } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ mono, ...rest }, ref) {
  const props = useFieldControl(rest);
  return <input ref={ref} className={mono ? 'at-input at-mono' : 'at-input'} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea(rest, ref) {
    const props = useFieldControl(rest);
    return <textarea ref={ref} className="at-textarea" {...props} />;
  },
);

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

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(rest, ref) {
    const props = useFieldControl(rest);
    return <select ref={ref} className="at-select" {...props} />;
  },
);
