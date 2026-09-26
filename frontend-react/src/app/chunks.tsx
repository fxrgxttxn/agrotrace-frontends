import { lazy, type ComponentType } from 'react';
import { t } from './i18n';
import { AuthLayout } from './layouts';
import { Button, Card, Empty, Page } from '../ui';

// Page chunks (ruling FM11): a page chunk that fails to load (a deploy replaced the files, the network dropped) makes
// ONE full load of the target URL — the new build's files — guarded in sessionStorage against a loop; when it fails
// again, the page area shows «Не удалось загрузить страницу» with «Повторить» (a reload) — never a raw error dump.
// The URL stays at the target.

const GUARD = 'at:chunk-reload';

const here = () => `${window.location.pathname}${window.location.search}`;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The screen of a page whose chunk did not load. `outside` — a screen outside the cabinet shell. */
export function ChunkFailed({ title, outside }: { title: string; outside?: boolean }) {
  const empty = (
    <Empty
      art="empty-search"
      text={t('ui.chunkFailed')}
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

const cache = new Map<string, ComponentType>();

/** A lazy page (one chunk per page) with the FM11 failure handling. */
export function lazyPage(
  key: string,
  load: () => Promise<ComponentType>,
  titleKey: string,
  outside = false,
): ComponentType {
  let C = cache.get(key);
  if (!C) {
    C = lazy(async () => {
      try {
        const Page = await load();
        storage()?.removeItem(GUARD);
        return { default: Page };
      } catch {
        const store = storage();
        if (store && store.getItem(GUARD) !== here()) {
          store.setItem(GUARD, here());
          window.location.reload();
          // The document is being replaced; nothing to render meanwhile.
          return new Promise<never>(() => {});
        }
        store?.removeItem(GUARD);
        return { default: () => <ChunkFailed title={t(titleKey)} outside={outside} /> };
      }
    });
    cache.set(key, C);
  }
  return C;
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
          text={t('ui.chunkFailed')}
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
