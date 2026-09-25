import { useEffect, type ReactNode } from 'react';
import { t } from '../app/i18n';

/** `at-page` with its header (README «Страница»): the title is a noun, no subtitle. Sets the document title. */
export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} — AgroTrace`;
  }, [title]);
  return (
    <div className="at-page">
      <div className="at-page__header">
        <h1 className="at-page__title">{title}</h1>
        {actions && <div className="at-page__actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** Loading placeholder of a page area (`aria-busy`). */
export function PageLoading() {
  return (
    <div className="at-page" aria-busy="true">
      <span className="at-visually-hidden">{t('shell.loading')}</span>
      <div className="at-page__header">
        <span className="at-skeleton" data-shape="text" style={{ width: '12rem' }}></span>
      </div>
      <span className="at-skeleton" data-shape="block"></span>
    </div>
  );
}
