import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { ForbiddenPage, NotFoundPage } from '../pages/errors';
import { Shell } from '../shell/Shell';
import { PageLoading } from '../ui';
import { GuestOnly, RequireAuth, RequireRole } from './guards';
import { AUTH_ROUTES, CABINET_ROUTES } from './routes';
import { SessionProvider, useSession, type SessionCore } from './session';
import { LiveEventsProvider } from './sse';

// All routes of spec §9.4. The public QR pages (/p/*) are a separate entry (src/public): a client-side navigation
// into them reloads the document so the cabinet code never serves them.

const lazyCache = new Map<string, ComponentType>();
function lazyPage(key: string, load: () => Promise<ComponentType>): ComponentType {
  let C = lazyCache.get(key);
  if (!C) {
    C = lazy(async () => ({ default: await load() }));
    lazyCache.set(key, C);
  }
  return C;
}

/** Guest-only auth screens: a signed-in user is sent on (`next` or home). */
const GUEST_ONLY = new Set(['/login', '/login/2fa']);

function Root({ core, EventSourceImpl }: { core: SessionCore; EventSourceImpl?: typeof EventSource }) {
  return (
    <SessionProvider core={core}>
      <LiveEventsProvider EventSourceImpl={EventSourceImpl}>
        <Outlet />
      </LiveEventsProvider>
    </SessionProvider>
  );
}

/** 403 and 404: inside the shell for a signed-in user, standalone otherwise. */
function MaybeShell() {
  const { state } = useSession();
  if (state.status === 'loading') return <PageLoading />;
  return state.status === 'authenticated' ? <Shell /> : <Outlet />;
}

function PublicReload() {
  const location = useLocation();
  useEffect(() => {
    window.location.replace(`${location.pathname}${location.search}`);
  }, [location]);
  return null;
}

export function buildRoutes(core: SessionCore, EventSourceImpl?: typeof EventSource): RouteObject[] {
  return [
    {
      element: <Root core={core} EventSourceImpl={EventSourceImpl} />,
      children: [
        ...AUTH_ROUTES.map((r) => {
          const Page = lazyPage(r.path, r.load);
          return {
            path: r.path,
            element: GUEST_ONLY.has(r.path) ? (
              <GuestOnly>
                <Page />
              </GuestOnly>
            ) : (
              <Suspense fallback={<PageLoading />}>
                <Page />
              </Suspense>
            ),
          };
        }),
        {
          element: (
            <RequireAuth>
              <Shell />
            </RequireAuth>
          ),
          children: CABINET_ROUTES.map((r) => {
            const Page = lazyPage(r.path, r.load);
            return {
              path: r.path,
              element: (
                <RequireRole access={r.access}>
                  <Page />
                </RequireRole>
              ),
            };
          }),
        },
        { path: '/p/*', element: <PublicReload /> },
        {
          element: <MaybeShell />,
          children: [
            { path: '/403', element: <ForbiddenPage /> },
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}
