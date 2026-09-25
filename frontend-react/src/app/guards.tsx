import { Suspense, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { canAccess, type Access } from './access';
import { safeNext, useSession } from './session';
import { t } from './i18n';
import { Button, Empty, PageLoading } from '../ui';
import { AuthLayout } from './layouts';

/** Screen shown when the session cannot be restored for a transient reason (R61): retry, not a logout. */
export function Unavailable() {
  const { restore } = useSession();
  return (
    <AuthLayout title={t('page.unavailable')}>
      <Empty
        art="empty-search"
        text={t('errors.BACKEND_UNAVAILABLE')}
        action={
          <Button variant="primary" onClick={() => void restore()}>
            {t('action.retry')}
          </Button>
        }
      />
    </AuthLayout>
  );
}

/** Cabinet guard: waits for the start-up restore, sends anonymous users to `/login?next=`. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === 'loading') return <PageLoading />;
  if (state.status === 'unavailable') return <Unavailable />;
  if (state.status === 'anonymous') {
    const next = safeNext(`${location.pathname}${location.search}`);
    return <Navigate to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/** Role guard of one route (§9.4): a direct visit to a route of another role goes to `/403`. The page chunk is only
 * requested after the check passed. */
export function RequireRole({ access, children }: { access: Access; children: ReactNode }) {
  const { state } = useSession();
  if (state.status !== 'authenticated') return null;
  if (!canAccess(state.me, access)) return <Navigate to="/403" replace />;
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

/** Auth screens (login, 2FA, …): a signed-in user goes where `next` says (or home). */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === 'loading') return <PageLoading />;
  if (state.status === 'authenticated') {
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    return <Navigate to={next} replace />;
  }
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}
