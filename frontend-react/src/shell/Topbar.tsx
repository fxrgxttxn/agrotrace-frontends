import { Link } from 'react-router-dom';
import { withVariant, type Me } from '@agrotrace/api-client';
import { t } from '../app/i18n';
import { Avatar, Icon } from '../ui';

export function bellCount(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? '99+' : String(unread);
}

export function Topbar({ me, unread }: { me: Me; unread: number }) {
  const count = bellCount(unread);
  const logo = me.organization.logoUrl;
  return (
    <header className="at-topbar">
      <div className="at-topbar__org">
        <Avatar
          name={me.organization.name}
          src={logo ? withVariant(logo, 96) : null}
          shape="square"
          decorative
        />
        <span className="at-topbar__org-name">{me.organization.name}</span>
      </div>
      <div className="at-topbar__actions">
        <Link
          className="at-bell"
          to="/notifications"
          aria-label={count ? t('shell.bellUnread', { count }) : t('shell.bell')}
        >
          <Icon name="bell" className="at-bell__icon" />
          {count && (
            <span className="at-bell__count" aria-hidden="true">
              {count}
            </span>
          )}
        </Link>
        <Link
          className="at-topbar__profile"
          to="/profile"
          aria-label={t('shell.profileOf', { name: me.fullName })}
        >
          <Avatar name={me.fullName} src={me.avatarUrl ? withVariant(me.avatarUrl, 96) : null} hidden />
        </Link>
      </div>
    </header>
  );
}
