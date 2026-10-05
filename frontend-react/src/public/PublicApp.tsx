import { useEffect, useRef } from 'react';
import { BatchPage } from './BatchPage';
import { ComplaintPage } from './ComplaintPage';
import { t } from './i18n';
import { matchPublic, usePath } from './nav';
import { NotFound, PublicPage } from './views';

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
