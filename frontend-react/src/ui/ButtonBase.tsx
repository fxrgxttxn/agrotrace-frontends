import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { Icon, type IconName } from './Icon';

// `at-button` without the router (Button.tsx adds the router link): the public QR page uses these too.

export interface ButtonLook {
  /** `secondary` is the default and is always written out, so the DOM is the same in every framework. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Written only when given (`m` is the CSS default). */
  size?: 'm' | 's';
  icon?: IconName;
  /** Square icon button: `aria-label` is required. */
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
/** `at-button` (README «Кнопка»). While `busy`, clicks do not pass. */
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

/** Plain `<a class="at-button">` for downloads and signed file URLs (no client-side routing). */
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
