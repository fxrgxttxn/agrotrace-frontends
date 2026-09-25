import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Outlet, useLocation, type RouteObject } from 'react-router-dom';
import { ForbiddenPage, NotFoundPage } from '../pages/errors';
import { Shell } from '../shell/Shell';
import { PageLoading } from '../ui';
import { GuestOnly, RequireAuth, RequireRole } from './guards';
import { AUTH_ROUTES, CABINET_ROUTES } from './routes';
import { SessionProvider, useSession, type SessionCore } from './session';
import { LiveEventsProvider } from './sse';
import { RouteFocusProvider } from './routeFocus';

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
    <RouteFocusProvider>
      <SessionProvider core={core}>
        <LiveEventsProvider EventSourceImpl={EventSourceImpl}>
          <Outlet />
        </LiveEventsProvider>
      </SessionProvider>
    </RouteFocusProvider>
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

/** `/_ds` component showcase (spec §10.7): development build only — `import.meta.env.DEV` is a build-time constant, so
 * the route and its chunk are dropped from the production dist. */
const DEV_ROUTES: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/_ds', lazy: async () => ({ Component: (await import('../dev/Showcase')).Showcase }) }]
  : [];

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

/** React Router v7 behaviour, opted into now (no future-flag warnings; the same in the app and in tests). */
export const ROUTER_FUTURE = {
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
} as const;
