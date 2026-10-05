import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../app/i18n';
import { useFieldControl } from './Field';

export interface ComboOption {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  id?: string;
  listLabel: string;
  query: string;
  onQueryChange: (text: string) => void;
  onSearch?: (text: string) => void;
  options: ComboOption[];
  loading?: boolean;
  selected?: string | null;
  onSelect: (option: ComboOption) => void;
  disabled?: boolean;
  'aria-invalid'?: 'true' | 'false';
  'aria-describedby'?: string;
}

export const SEARCH_DELAY_MS = 250;

export function highlight(label: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? label.toLocaleLowerCase('ru').indexOf(q.toLocaleLowerCase('ru')) : -1;
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark>{label.slice(at, at + q.length)}</mark>
      {label.slice(at + q.length)}
    </>
  );
}

export function Combobox(props: ComboboxProps) {
  const { listLabel, query, onQueryChange, onSearch, options, loading, selected, onSelect, disabled } = props;
  const control = useFieldControl({
    id: props.id,
    'aria-invalid': props['aria-invalid'],
    'aria-describedby': props['aria-describedby'],
  });
  const id = control.id ?? 'combobox';
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
  const activeIndex = open && active >= 0 && active < options.length ? active : -1;

  const move = (to: number) => {
    if (enabled.length === 0) return;
    const pos = Math.max(0, Math.min(enabled.length - 1, to));
    setActive(enabled[pos]!.i);
  };
  const posOf = (index: number) => enabled.findIndex(({ i }) => i === index);

  const choose = (o: ComboOption) => {
    onSelect(o);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown':
          if (!open) setOpen(true);
          else move(activeIndex < 0 ? 0 : posOf(activeIndex) + 1);
          return true;
        case 'ArrowUp':
          if (!open) return false;
          move(activeIndex < 0 ? enabled.length - 1 : posOf(activeIndex) - 1);
          return true;
        case 'Home':
          if (!open) return false;
          move(0);
          return true;
        case 'End':
          if (!open) return false;
          move(enabled.length - 1);
          return true;
        case 'Enter': {
          if (!open) return false;
          const o = activeIndex >= 0 ? options[activeIndex] : undefined;
          if (o && !o.disabled) choose(o);
          return true;
        }
        case 'Escape':
          if (!open) return false;
          setOpen(false);
          setActive(-1);
          return true;
        default:
          return false;
      }
    })();
    if (handled) e.preventDefault();
  };

  const showStatus = loading || options.length === 0;
  const optId = (i: number) => `${id}-opt-${i + 1}`;

  return (
    <div className="at-combobox">
      <input
        className="at-input"
        {...control}
        id={id}
        role="combobox"
        aria-autocomplete="list"
        autoComplete="off"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={listId}
        aria-activedescendant={activeIndex >= 0 && !showStatus ? optId(activeIndex) : undefined}
        aria-busy={loading ? 'true' : undefined}
        disabled={disabled}
        value={query}
        onChange={(e) => {
          const text = e.target.value;
          onQueryChange(text);
          setOpen(true);
          setActive(-1);
          if (onSearch) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => onSearch(text), SEARCH_DELAY_MS);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
      />
      {showStatus ? (
        <div className="at-combobox__list" id={listId} role="status">
          {open && loading ? (
            <p className="at-combobox__status">
              <span className="at-spinner" aria-hidden="true"></span>
              {t('ui.searching')}
            </p>
          ) : open && query.trim() ? (
            <p className="at-combobox__status">{t('empty.search')}</p>
          ) : null}
        </div>
      ) : (
        <ul
          className="at-combobox__list"
          role="listbox"
          id={listId}
          aria-label={listLabel}
          hidden={!open}
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              id={optId(i)}
              aria-selected={o.value === selected ? 'true' : 'false'}
              aria-disabled={o.disabled ? 'true' : undefined}
              data-active={i === activeIndex ? '' : undefined}
              onClick={() => {
                if (!o.disabled) choose(o);
              }}
            >
              <span>{highlight(o.label, query)}</span>
              {o.meta && <span className="at-combobox__meta">{o.meta}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
