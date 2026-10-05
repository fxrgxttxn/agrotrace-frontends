import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { t } from '../app/i18n';
import { isCurrent, NOTIFICATIONS_ITEM, PROFILE_ITEM, type NavItem } from '../app/nav';
import { useSkipRouteFocus } from '../app/routeFocus';
import { Dialog, Icon } from '../ui';

export const BOTTOM_NAV_ITEMS = 4;

export function BottomNav({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const skipRouteFocus = useSkipRouteFocus();
  const main = items.slice(0, BOTTOM_NAV_ITEMS);
  const more = [...items.slice(BOTTOM_NAV_ITEMS), NOTIFICATIONS_ITEM, PROFILE_ITEM];
  return (
    <>
      <nav className="at-bottom-nav" aria-label={t('shell.mainMenu')}>
        {main.map((item) => (
          <Link
            key={item.key}
            className="at-bottom-nav__link"
            to={item.href}
            aria-current={isCurrent(item, pathname) ? 'page' : undefined}
          >
            <Icon name={item.icon} className="at-bottom-nav__icon" />
            {t(item.short ?? item.label)}
          </Link>
        ))}
        <button
          className="at-bottom-nav__link"
          type="button"
          aria-expanded={open ? 'true' : 'false'}
          aria-controls="more-menu"
          onClick={() => setOpen(true)}
        >
          <Icon name="more" className="at-bottom-nav__icon" />
          {t('nav.more')}
        </button>
      </nav>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        id="more-menu"
        titleId="more-title"
        title={t('nav.more')}
        lightDismiss
        initialFocus="title"
      >
        <nav aria-label={t('shell.otherSections')}>
          <ul className="at-sidebar__list">
            {more.map((item) => (
              <li key={item.key}>
                <Link
                  className="at-sidebar__link"
                  to={item.href}
                  aria-current={isCurrent(item, pathname) ? 'page' : undefined}
                  onClick={() => {
                    skipRouteFocus(item.href);
                    setOpen(false);
                  }}
                >
                  <Icon name={item.icon} className="at-sidebar__icon" />
                  <span className="at-sidebar__label">{t(item.label)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Dialog>
    </>
  );
}
