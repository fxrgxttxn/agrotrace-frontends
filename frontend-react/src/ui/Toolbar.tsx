import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../app/i18n';

export const SEARCH_INPUT_DELAY_MS = 300;

const WIDE = '(min-width: 768px)';

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export interface ToolbarSearch {
  label: string;
  placeholder: string;
  value: string;
  onChange: (text: string) => void;
}

export function PageToolbar({
  search,
  filters,
  count = 0,
  note,
}: {
  search?: ToolbarSearch;
  filters?: ReactNode;
  count?: number;
  note?: ReactNode;
}) {
  const wide = useWide();
  const [opened, setOpened] = useState(false);
  const open = wide || opened;
  const [text, setText] = useState(search?.value ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef(search?.value ?? '');
  const onChange = useRef(search?.onChange);
  onChange.current = search?.onChange;

  const external = search?.value ?? '';
  useEffect(() => {
    if (external !== sent.current) {
      sent.current = external;
      setText(external);
    }
  }, [external]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const type = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sent.current = value;
      onChange.current?.(value);
    }, SEARCH_INPUT_DELAY_MS);
  };

  return (
    <div className="at-page__toolbar">
      {search && (
        <div className="at-page__search">
          <svg aria-hidden="true">
            <use href="#i-search" />
          </svg>
          <input
            className="at-input"
            type="search"
            placeholder={search.placeholder}
            aria-label={search.label}
            value={text}
            onChange={(e) => type(e.target.value)}
          />
        </div>
      )}
      {filters && (
        <details
          className="at-page__filters"
          open={open}
          onToggle={(e) => {
            if (!wide) setOpened(e.currentTarget.open);
          }}
        >
          <summary className="at-page__filters-toggle">
            {t('filters.toggle')}
            {count > 0 && (
              <>
                <span className="at-visually-hidden">{t('filters.selected')}</span>{' '}
                <span className="at-page__filters-count">{count}</span>
              </>
            )}
          </summary>
          <div className="at-page__filters-body">{filters}</div>
        </details>
      )}
      {note && <p className="at-page__note">{note}</p>}
    </div>
  );
}
