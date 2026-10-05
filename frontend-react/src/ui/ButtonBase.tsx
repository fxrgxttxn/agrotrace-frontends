import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { Icon, type IconName } from './Icon';

export interface ButtonLook {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'm' | 's';
  icon?: IconName;
  iconOnly?: boolean;
  busy?: boolean;
}

export function lookAttrs({ variant = 'secondary', size, iconOnly, busy }: ButtonLook) {
  return {
    className: 'at-button',
    'data-variant': variant,
    'data-size': size,
    'data-icon-only': iconOnly ? '' : undefined,
    'aria-busy': busy ? ('true' as const) : undefined,
  };
}

export type ButtonProps = ButtonLook & ButtonHTMLAttributes<HTMLButtonElement>;
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, iconOnly, busy, type = 'button', children, onClick, ...rest },
  ref,
) {
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button ref={ref} type={type} {...lookAttrs({ variant, size, iconOnly, busy })} {...rest} onClick={click}>
      {icon && <Icon name={icon} className="at-button__icon" />}
      {children}
    </button>
  );
});

export function ButtonAnchor({
  variant,
  size,
  icon,
  iconOnly,
  children,
  ...rest
}: ButtonLook & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a {...lookAttrs({ variant, size, iconOnly })} {...rest}>
      {icon && <Icon name={icon} className="at-button__icon" />}
      {children}
    </a>
  );
}
