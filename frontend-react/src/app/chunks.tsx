import { lazy, useEffect, useState, type ComponentType } from 'react';
import { t } from './i18n';
import { AuthLayout } from './layouts';
import { afterChunkFailure, chunkLoaded, here } from '../reload';
import { Button, Card, Empty, Page } from '../ui';

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
        if (outcome === 'reload') return new Promise<never>(() => {});
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
