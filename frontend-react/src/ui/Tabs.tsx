import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: ReactNode;
  count?: number;
}

/** `at-tabs` (README «Вкладки»): roving tabindex, ←/→ (wrapping), Home/End, selection follows focus. Only the
 * selected panel is rendered visible; the others carry `hidden`. The caller mirrors the selection in `?tab=`. */
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
  /** Content of a panel; called for the selected tab only (the others stay empty and hidden). */
  panel: (id: string) => ReactNode;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
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
