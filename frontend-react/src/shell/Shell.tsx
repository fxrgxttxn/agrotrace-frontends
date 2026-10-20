import { useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { navFor } from '../app/nav';
import { t } from '../app/i18n';
import { useMe } from '../app/session';
import { useUnread } from '../app/sse';
import { BottomNav } from './BottomNav';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** `at-shell` (README «Оболочка»): both navigations are always in the markup, the CSS shows one per width. */
export function Shell() {
  const me = useMe();
  const unread = useUnread();
  const items = useMemo(() => navFor(me), [me]);
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo?.(0, 0);
  }, [pathname]);

  return (
    <div className="at-shell">
      <a className="at-shell__skip" href="#main">
        {t('shell.skip')}
      </a>
      <Sidebar items={items} />
      <Topbar me={me} unread={unread} />
      <main className="at-shell__main" id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <BottomNav items={items} />
    </div>
  );
}
