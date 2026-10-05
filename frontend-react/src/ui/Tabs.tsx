import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: ReactNode;
  count?: number;
}

export function Tabs({
  label,
  tabs,
  selected,
  onSelect,
  panel,
}: {
  label: string;
  tabs: TabDef[];
  selected: string;
  onSelect: (id: string) => void;
  panel: (id: string) => ReactNode;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const tab = refs.current.get(selected);
    const row = tab?.parentElement;
    if (!tab || !row) return;
    const t0 = tab.getBoundingClientRect();
    const r0 = row.getBoundingClientRect();
    if (t0.left < r0.left) row.scrollLeft -= r0.left - t0.left;
    else if (t0.right > r0.right) row.scrollLeft += t0.right - r0.right;
  }, [selected]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((tab) => tab.id === selected);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length]!;
    onSelect(target.id);
    refs.current.get(target.id)?.focus();
  };
  return (
    <>
      <div className="at-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const on = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              className="at-tabs__tab"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={on ? 'true' : 'false'}
              aria-controls={`panel-${tab.id}`}
              tabIndex={on ? 0 : -1}
              type="button"
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
              {tab.count !== undefined && (
                <>
                  {' '}
                  <span className="at-tabs__count">{tab.count}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="at-tabs__panel"
          role="tabpanel"
          id={`panel-${tab.id}`}
          aria-labelledby={`tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== selected}
        >
          {tab.id === selected ? panel(tab.id) : null}
        </div>
      ))}
    </>
  );
}
