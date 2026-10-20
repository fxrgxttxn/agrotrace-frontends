import { useEffect, type ReactNode } from 'react';
import recallWarning from '@agrotrace/design-system/illustrations/recall-warning.svg?raw';
import emptySearch from '@agrotrace/design-system/illustrations/empty-search.svg?raw';
import { ArtSvg, parseArt, type ParsedArt } from '../ui/Art';
import { Button } from '../ui/ButtonBase';
import { useCountdown, useFocusAfterWait } from '../ui/wait';
import type { Failure } from './data';
import { t } from './i18n';

// Pieces of both public pages: the page frame, the loading area and the states (README markup: at-page, at-card,
// at-empty, at-skeleton). Only the illustrations the page shows are bundled.

export const ART = {
  recallWarning: parseArt(recallWarning)!,
  emptySearch: parseArt(emptySearch)!,
} satisfies Record<string, ParsedArt>;

/** The page: `main.at-page.at-public` with the title (`h1.at-page__title`, the focus target on route change). */
export function PublicPage({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} — AgroTrace`;
  }, [title]);
  return (
    <main className="at-page at-public" id="main" tabIndex={-1}>
      <div className="at-page__header">
        <h1 className="at-page__title" tabIndex={-1}>
          {title}
        </h1>
      </div>
      <div className="at-public__stack">{children}</div>
    </main>
  );
}

export function Loading() {
  return (
    <div className="at-card" data-furrow="" aria-busy="true">
      <div className="at-card__body at-public__loading">
        <span className="at-visually-hidden">{t('shell.loading')}</span>
        <span className="at-skeleton" data-shape="block"></span>
        <span className="at-skeleton" data-shape="text" style={{ width: '60%' }}></span>
        <span className="at-skeleton" data-shape="text" style={{ width: '40%' }}></span>
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <article className="at-card" data-furrow="">
      <div className="at-empty">
        <ArtSvg art={ART.emptySearch} />
        <p className="at-empty__text">{t('public.notFound')}</p>
      </div>
    </article>
  );
}

const FAILURE_TEXT: Record<Failure['kind'], string> = {
  offline: 'public.offline',
  unavailable: 'public.unavailable',
  limited: 'errors.RATE_LIMITED',
};

/** The data did not come: what happened and «Повторить» (after a 429 — once its Retry-After is over, FM17). */
export function Failed({ failure, busy, onRetry }: { failure: Failure; busy: boolean; onRetry: () => void }) {
  const [wait, startWait] = useCountdown();
  useEffect(() => {
    if (failure.kind === 'limited') startWait(failure.wait);
  }, [failure, startWait]);
  const button = useFocusAfterWait(wait);
  return (
    <article className="at-card" data-furrow="">
      <div className="at-empty">
        <ArtSvg art={ART.emptySearch} />
        <p className="at-empty__text">{t(FAILURE_TEXT[failure.kind])}</p>
        <Button ref={button} variant="primary" busy={busy} disabled={wait > 0} onClick={onRetry}>
          {wait > 0 ? t('auth.retryIn', { seconds: wait }) : t('action.retry')}
        </Button>
      </div>
    </article>
  );
}
