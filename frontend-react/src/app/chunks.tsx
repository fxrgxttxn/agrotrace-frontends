import { lazy, useEffect, useState, type ComponentType } from 'react';
import { t } from './i18n';
import { AuthLayout } from './layouts';
import { afterChunkFailure, chunkLoaded, here } from '../reload';
import { Button, Card, Empty, Page } from '../ui';

// Page chunks (rulings FM11/FM15): a page chunk that fails to load makes ONE full load of the target URL (only while the
// person is still there, `afterChunkFailure`); when it fails again, the page area shows «Не удалось загрузить
// страницу.» with «Повторить» (a reload) — never a raw error dump; the URL stays at the target. The failure is not kept
// as the route's component: the next navigation to the route asks for the chunk again.

/** The screen of a page whose chunk did not load. `outside` — a screen outside the cabinet shell. */
export function ChunkFailed({ title, outside }: { title: string; outside?: boolean }) {
  const empty = (
    <Empty
      art="empty-search"
      text={t('empty.pageLoadFailed')}
      action={
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t('action.retry')}
        </Button>
      }
    />
  );
  return outside ? (
    <AuthLayout title={title}>{empty}</AuthLayout>
  ) : (
    <Page title={title}>
      <Card>{empty}</Card>
    </Page>
  );
}

/** A lazy page (one chunk per page) with the FM11/FM15 failure handling. The lazy component of a route is kept while it
 * loads or has loaded (a render that suspends is thrown away and mounts again — it must meet the same component);
 * once its failure screen has been shown, the next mount of the route (route elements are keyed per route, so the
 * next navigation to it) gets a new lazy component, which asks for the chunk again. */
export function lazyPage(
  load: () => Promise<ComponentType>,
  titleKey: string,
  outside = false,
): ComponentType {
  let shownFailure = false;
  const fresh = (): ComponentType =>
    lazy(async () => {
      const target = here();
      try {
        const Page = await load();
        chunkLoaded();
        return { default: Page };
      } catch {
        const outcome = afterChunkFailure(target);
        if (outcome === 'reload')
          // The document is being replaced; nothing to render meanwhile.
          return new Promise<never>(() => {});
        // Nobody waits for a superseded page: its next visit starts again.
        if (outcome === 'superseded') shownFailure = true;
        return {
          default: function Failed() {
            useEffect(() => {
              shownFailure = true;
            }, []);
            return <ChunkFailed title={t(titleKey)} outside={outside} />;
          },
        };
      }
    });
  let current = fresh();
  function RoutePage() {
    const [Page] = useState<ComponentType>(() => {
      if (shownFailure) {
        shownFailure = false;
        current = fresh();
      }
      return current;
    });
    return <Page />;
  }
  return RoutePage;
}

/** Root error element: anything the router could not render is shown as a plain screen with a reload, not the
 * router's raw error page. Self-contained (it replaces the providers of the root route). */
export function RouteError() {
  return (
    <main className="at-page" id="main" tabIndex={-1} style={{ maxWidth: '30rem', marginInline: 'auto' }}>
      <div className="at-page__header">
        <h1 className="at-page__title" tabIndex={-1}>
          {t('page.unavailable')}
        </h1>
      </div>
      <Card>
        <Empty
          art="empty-search"
          text={t('empty.pageLoadFailed')}
          action={
            <Button variant="primary" onClick={() => window.location.reload()}>
              {t('action.retry')}
            </Button>
          }
        />
      </Card>
    </main>
  );
}
