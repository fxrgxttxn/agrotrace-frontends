import { Link, type LinkProps } from 'react-router-dom';
import { Icon } from './Icon';
import { lookAttrs, type ButtonLook } from './ButtonBase';

export { Button, ButtonAnchor, type ButtonLook, type ButtonProps } from './ButtonBase';

/** Link styled as a button: `<a class="at-button" href="…">` with the same attributes (client-side navigation). */
export function ButtonLink({ variant, size, icon, iconOnly, children, ...rest }: ButtonLook & LinkProps) {
  return (
    <Link {...lookAttrs({ variant, size, iconOnly })} {...rest}>
      {icon && <Icon name={icon} className="at-button__icon" />}
      {children}
    </Link>
  );
}
