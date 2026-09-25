import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { t } from '../app/i18n';
import { useRouteFocus } from '../app/routeFocus';

/** `at-page` with its header (README «Страница»): the title is a noun, no subtitle, `tabindex="-1"` — the focus target
 * after a route change (README «Фокус при смене маршрута»). Sets the document title. `main` — the page is the document's
 * main landmark itself (screens outside the shell). */
export function Page({
  title,
  actions,
  main,
  style,
  children,
}: {
  title: string;
  actions?: ReactNode;
  main?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const h1 = useRef<HTMLHeadingElement>(null);
  useRouteFocus(h1);
  useEffect(() => {
    document.title = `${title} — AgroTrace`;
  }, [title]);
  const content = (
    <>
      <div className="at-page__header">
        <h1 ref={h1} className="at-page__title" tabIndex={-1}>
          {title}
        </h1>
        {actions && <div className="at-page__actions">{actions}</div>}
      </div>
      {children}
    </>
  );
  return main ? (
    <main className="at-page" id="main" tabIndex={-1} style={style}>
      {content}
    </main>
  ) : (
    <div className="at-page" style={style}>
      {content}
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
