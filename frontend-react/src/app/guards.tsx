import { useCountdown, useFocusAfterWait } from './api';
import { Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { canAccess, type Access } from './access';
import { safeNext, useSession } from './session';
import { t } from './i18n';
import { Button, Empty, PageLoading } from '../ui';
import { AuthLayout } from './layouts';

/** Set by «Повторить»: when the retry ends on this screen again, the new button gets the focus (FM10). */
let retried = false;

/** Screen shown when the session cannot be restored for a transient reason (R61): retry, not a logout. */
export function Unavailable() {
  const { restore, state } = useSession();
  const retryAfter = state.status === 'unavailable' ? state.retryAfter : undefined;
  // After a 429 the retry waits out Retry-After (the session itself is kept).
  const [wait, startWait] = useCountdown();
  useEffect(() => {
    if (retryAfter) startWait(retryAfter);
  }, [retryAfter, startWait]);
  // A disabled button drops the focus; when the wait is over, the focus goes to the button that can act now (FM17).
  const button = useFocusAfterWait(wait);
  // A failed retry (loading → unavailable) remounts this screen: the focus goes back to «Повторить».
  useEffect(() => {
    if (retried) {
      retried = false;
      button.current?.focus();
    }
  }, [button]);
  return (
    <AuthLayout title={t('page.unavailable')}>
      <Empty
        art="empty-search"
        text={retryAfter ? t('errors.RATE_LIMITED') : t('errors.BACKEND_UNAVAILABLE')}
        action={
          <Button
            ref={button}
            variant="primary"
            disabled={wait > 0}
            onClick={() => {
              retried = true;
              void restore();
            }}
          >
            {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('action.retry')}
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
    if (state.loggedOut) return <Navigate to="/login" replace />;
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
