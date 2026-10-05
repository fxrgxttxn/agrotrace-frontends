import type { Type } from '@angular/core';
import { currentUrl, reloadOnce } from '../reload-mark';

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
      if (currentUrl() !== target) throw error;
      if (reloadOnce(target, reload)) return new Promise<Type<unknown>>(() => {});
      return failed;
    }
  };
}
