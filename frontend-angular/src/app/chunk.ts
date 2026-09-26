import type { Type } from '@angular/core';

// A page chunk that fails to load (ruling FM11: a deploy replaced the hashed files, a network hiccup): the router would
// report a NavigationError and roll the eagerly updated URL back. Instead the loader loads the target URL once more as
// a full document (the URL is already the target: `urlUpdateStrategy: 'eager'`, so `location.reload()` adds no history
// entry); if the chunk fails again on that fresh document, the page «Не удалось загрузить страницу» with «Повторить» is
// shown at the target URL. A sessionStorage mark (the URL) prevents a reload loop and is cleared by a successful load.

const RELOAD_MARK = 'agrotrace-chunk-reload';

type Loader = () => Promise<Type<unknown>>;

function here(): string {
  return `${location.pathname}${location.search}`;
}

function readMark(): string | null {
  try {
    return sessionStorage.getItem(RELOAD_MARK);
  } catch {
    return null;
  }
}

function writeMark(value: string | null): boolean {
  try {
    if (value === null) sessionStorage.removeItem(RELOAD_MARK);
    else sessionStorage.setItem(RELOAD_MARK, value);
    return true;
  } catch {
    return false; // no storage: no loop guard, so no automatic reload either
  }
}

/** `load` with the FM11 recovery; `failed` is the component shown when the chunk cannot be loaded. */
export function resilientLoad(
  load: Loader,
  failed: Type<unknown>,
  reload: () => void = () => location.reload(),
): Loader {
  return async () => {
    try {
      const component = await load();
      if (readMark() === here()) writeMark(null);
      return component;
    } catch {
      const target = here();
      if (readMark() !== target && writeMark(target)) {
        reload();
        return new Promise<Type<unknown>>(() => {}); // the document is being replaced
      }
      writeMark(null);
      return failed;
    }
  };
}
