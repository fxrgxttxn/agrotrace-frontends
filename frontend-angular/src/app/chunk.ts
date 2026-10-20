import type { Type } from '@angular/core';
import { currentUrl, reloadOnce } from '../reload-mark';

// A page chunk that fails to load (rulings FM11/FM15: a deploy replaced the hashed files, a network hiccup). Without
// help the router would report a NavigationError and roll the eagerly updated URL back. Here:
// - the target is recorded when the loader starts (with `urlUpdateStrategy: 'eager'` the address bar already shows it);
// - on failure, if the location is still that target, the document is loaded once more (`reloadOnce`, no history
//   entry); on the reloaded document a second failure resolves to the error page (`failed`) at the target URL;
// - if the user has moved on meanwhile (another link, Back), nothing is reloaded: the error is rethrown into the
//   navigation that was already superseded, where the router drops it — and caches nothing, so a later visit retries.
// The error page itself clears the route's cached component (errors.ts), so the next navigation retries the import.

type Loader = () => Promise<Type<unknown>>;

export function resilientLoad(
  load: Loader,
  failed: Type<unknown>,
  reload: () => void = () => location.reload(),
): Loader {
  return async () => {
    const target = currentUrl();
    try {
      return await load();
    } catch (error) {
      if (currentUrl() !== target) throw error; // superseded or Back: not the page the user is on now
      if (reloadOnce(target, reload)) return new Promise<Type<unknown>>(() => {}); // the document is being replaced
      return failed;
    }
  };
}
