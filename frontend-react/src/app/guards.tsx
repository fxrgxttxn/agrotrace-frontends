import { useCountdown, useFocusAfterWait } from './api';
import { Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { canAccess, type Access } from './access';
import { safeNext, useSession } from './session';
import { t } from './i18n';
import { Button, Empty, PageLoading } from '../ui';
import { AuthLayout } from './layouts';

let retried = false;

export function Unavailable() {
  const { restore, state } = useSession();
  const retryAfter = state.status === 'unavailable' ? state.retryAfter : undefined;
  const [wait, startWait] = useCountdown();
  useEffect(() => {
    if (retryAfter) startWait(retryAfter);
  }, [retryAfter, startWait]);
  const button = useFocusAfterWait(wait);
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

export function RequireRole({ access, children }: { access: Access; children: ReactNode }) {
  const { state } = useSession();
  if (state.status !== 'authenticated') return null;
  if (!canAccess(state.me, access)) return <Navigate to="/403" replace />;
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

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
