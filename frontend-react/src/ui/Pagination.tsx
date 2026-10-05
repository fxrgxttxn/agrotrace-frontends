import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../app/i18n';

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

type Target =
  { hrefFor: (page: number) => string; onPage?: never } | { onPage: (page: number) => void; hrefFor?: never };

export function Pagination({
  page,
  size,
  total,
  label,
  ...target
}: {
  page: number;
  size: number;
  total: number;
  label?: string;
} & Target) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  const nav = useRef<HTMLElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || (active as HTMLButtonElement).disabled)
      nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, [page]);

  const item = (p: number, content: ReactNode, aria: { label?: string; current?: boolean } = {}) => {
    const common = {
      className: 'at-pagination__item',
      'aria-label': aria.label,
      'aria-current': aria.current ? ('page' as const) : undefined,
    };
    if (target.onPage) {
      const onPage = target.onPage;
      return (
        <button
          type="button"
          {...common}
          onClick={() => {
            if (p === page) return;
            moved.current = true;
            onPage(p);
          }}
        >
          {content}
        </button>
      );
    }
    return (
      <Link {...common} to={target.hrefFor(p)}>
        {content}
      </Link>
    );
  };
  const none = (content: ReactNode, name: string) => (
    <button className="at-pagination__item" type="button" aria-label={name} disabled>
      {content}
    </button>
  );

  return (
    <nav className="at-pagination" aria-label={label ?? t('ui.pages')} ref={nav}>
      <p className="at-pagination__summary">{t('ui.pageSummary', { from, to, total })}</p>
      <ul className="at-pagination__pages">
        <li>
          {page > 1
            ? item(page - 1, <Arrow dir="left" />, { label: t('ui.prevPage') })
            : none(<Arrow dir="left" />, t('ui.prevPage'))}
        </li>
        {pageWindow(page, pages).map((p, i) => (
          <li key={p ?? `gap-${i}`}>
            {p === null ? (
              <span className="at-pagination__gap" aria-hidden="true">
                …
              </span>
            ) : (
              item(p, p, { current: p === page })
            )}
          </li>
        ))}
        <li>
          {page < pages
            ? item(page + 1, <Arrow dir="right" />, { label: t('ui.nextPage') })
            : none(<Arrow dir="right" />, t('ui.nextPage'))}
        </li>
      </ul>
    </nav>
  );
}
