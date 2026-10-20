import { useEffect, useRef } from 'react';
import { BatchPage } from './BatchPage';
import { ComplaintPage } from './ComplaintPage';
import { t } from './i18n';
import { matchPublic, usePath } from './nav';
import { NotFound, PublicPage } from './views';

// The public QR pages without menu or session (spec §9.6). On every client-side path change except the first load
// the focus goes to the page title (ruling F4) and the page scrolls to the top.

export function PublicApp() {
  const path = usePath();
  const route = matchPublic(path);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>('h1.at-page__title')?.focus();
  }, [path]);
  return (
    <>
      {route.name === 'batch' ? (
        <BatchPage key={route.code} code={route.code} />
      ) : route.name === 'complaint' ? (
        <ComplaintPage key={route.code} code={route.code} />
      ) : (
        <PublicPage title={t('page.publicBatch')}>
          <NotFound />
        </PublicPage>
      )}
    </>
  );
}
