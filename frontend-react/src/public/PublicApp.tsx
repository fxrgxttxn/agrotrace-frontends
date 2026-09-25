import { useEffect } from 'react';
import { createT } from '@agrotrace/i18n';

// No router and no shared cabinet modules here: the path is matched by hand so the chunk stays small.
const t = createT('ru');

export type PublicRoute =
  { name: 'batch'; code: string } | { name: 'complaint'; code: string } | { name: 'none' };

export function matchPublic(path: string): PublicRoute {
  const m = /^\/p\/([^/]+)(\/complaint)?\/?$/.exec(path);
  if (!m) return { name: 'none' };
  const code = decodeURIComponent(m[1]!);
  return m[2] ? { name: 'complaint', code } : { name: 'batch', code };
}

export function PublicApp({ path }: { path: string }) {
  const route = matchPublic(path);
  const title =
    route.name === 'batch'
      ? t('page.publicBatch')
      : route.name === 'complaint'
        ? t('page.publicComplaint')
        : t('page.notFound');
  useEffect(() => {
    document.title = `${title} — AgroTrace`;
  }, [title]);
  return (
    <main className="at-page" id="main" tabIndex={-1}>
      <div className="at-page__header">
        <h1 className="at-page__title">{title}</h1>
      </div>
      {route.name !== 'none' && <p className="at-mono">{route.code}</p>}
    </main>
  );
}
