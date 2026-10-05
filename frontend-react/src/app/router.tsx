import { Suspense, useEffect } from 'react';
import { Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { ForbiddenPage, NotFoundPage } from '../pages/errors';
import { Shell } from '../shell/Shell';
import { PageLoading } from '../ui';
import { GuestOnly, RequireAuth, RequireRole } from './guards';
import { AUTH_ROUTES, CABINET_ROUTES } from './routes';
import { SessionProvider, useSession, type SessionCore } from './session';
import { LiveEventsProvider } from './sse';
import { RouteFocusProvider } from './routeFocus';
import { lazyPage, RouteError } from './chunks';

const GUEST_ONLY = new Set(['/login', '/login/2fa']);

function Root({ core, EventSourceImpl }: { core: SessionCore; EventSourceImpl?: typeof EventSource }) {
  return (
    <RouteFocusProvider>
      <SessionProvider core={core}>
        <LiveEventsProvider EventSourceImpl={EventSourceImpl}>
          <Outlet />
        </LiveEventsProvider>
      </SessionProvider>
    </RouteFocusProvider>
  );
}

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

const DEV_ROUTES: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/_ds', lazy: async () => ({ Component: (await import('../dev/Showcase')).Showcase }) }]
  : [];

export function buildRoutes(core: SessionCore, EventSourceImpl?: typeof EventSource): RouteObject[] {
  return [
    {
      element: <Root core={core} EventSourceImpl={EventSourceImpl} />,
      errorElement: <RouteError />,
      children: [
        ...AUTH_ROUTES.map((r) => {
          const Page = lazyPage(r.load, r.title, true);
          return {
            path: r.path,
            element: GUEST_ONLY.has(r.path) ? (
              <GuestOnly key={r.path}>
                <Page />
              </GuestOnly>
            ) : (
              <Suspense key={r.path} fallback={<PageLoading />}>
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
            const Page = lazyPage(r.load, r.title);
            return {
              path: r.path,
              element: (
                <RequireRole key={r.path} access={r.access}>
                  <Page />
                </RequireRole>
              ),
            };
          }),
        },
        { path: '/p/*', element: <PublicReload /> },
        ...DEV_ROUTES,
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

export const ROUTER_FUTURE = {
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
} as const;
