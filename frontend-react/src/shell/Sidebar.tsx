import { Link, useLocation } from 'react-router-dom';
import { t } from '../app/i18n';
import { isCurrent, type NavItem } from '../app/nav';
import { Icon } from '../ui';

export function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 20 9 4M10 20l5-16M16 20l4-13" />
    </svg>
  );
}

export function Sidebar({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  return (
    <nav className="at-sidebar" aria-label={t('shell.mainMenu')}>
      <Link className="at-sidebar__brand" to="/" title="AgroTrace">
        <BrandMark />
        <span className="at-sidebar__label">AgroTrace</span>
      </Link>
      <ul className="at-sidebar__list">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              className="at-sidebar__link"
              to={item.href}
              aria-current={isCurrent(item, pathname) ? 'page' : undefined}
              title={t(item.label)}
            >
              <Icon name={item.icon} className="at-sidebar__icon" />
              <span className="at-sidebar__label">{t(item.label)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
