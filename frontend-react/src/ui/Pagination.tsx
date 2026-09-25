import { Link } from 'react-router-dom';
import { t } from '../app/i18n';

/** Page numbers to show: first, last, current ± 1; `null` is a gap. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const out: (number | null)[] = [];
  let prev = 0;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - prev > 1) out.push(p - prev === 2 ? p - 1 : null);
    out.push(p);
    prev = p;
  }
  return out;
}

function Arrow({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg aria-hidden="true">
      <use href={`#i-chevron-${dir}`} />
    </svg>
  );
}

/** `at-pagination` (README «Пагинация»): links keep the rest of the URL state (`hrefFor` builds them). */
export function Pagination({
  page,
  size,
  total,
  hrefFor,
}: {
  /** 1-based, as in the contract. */
  page: number;
  size: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return (
    <nav className="at-pagination" aria-label={t('ui.pages')}>
      <p className="at-pagination__summary">{t('ui.pageSummary', { from, to, total })}</p>
      <ul className="at-pagination__pages">
        <li>
          {page > 1 ? (
            <Link className="at-pagination__item" to={hrefFor(page - 1)} aria-label={t('ui.prevPage')}>
              <Arrow dir="left" />
            </Link>
          ) : (
            <button className="at-pagination__item" type="button" aria-label={t('ui.prevPage')} disabled>
              <Arrow dir="left" />
            </button>
          )}
        </li>
        {pageWindow(page, pages).map((p, i) => (
          <li key={p ?? `gap-${i}`}>
            {p === null ? (
              <span className="at-pagination__gap" aria-hidden="true">
                …
              </span>
            ) : (
              <Link
                className="at-pagination__item"
                to={hrefFor(p)}
                aria-current={p === page ? 'page' : undefined}
              >
                {p}
              </Link>
            )}
          </li>
        ))}
        <li>
          {page < pages ? (
            <Link className="at-pagination__item" to={hrefFor(page + 1)} aria-label={t('ui.nextPage')}>
              <Arrow dir="right" />
            </Link>
          ) : (
            <button className="at-pagination__item" type="button" aria-label={t('ui.nextPage')} disabled>
              <Arrow dir="right" />
            </button>
          )}
        </li>
      </ul>
    </nav>
  );
}
