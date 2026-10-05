import { afterEach, describe, expect, it, vi } from 'vitest';
import { resilientLoad } from '../../src/app/chunk';

class Page {}
class Failed {}
const flush = () => new Promise((r) => setTimeout(r, 0));
const MARK = 'agrotrace-chunk-reload';

afterEach(() => {
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

describe('resilientLoad', () => {
  it('a loaded chunk is the page, no reload', async () => {
    const reload = vi.fn();
    expect(await resilientLoad(async () => Page, Failed, reload)()).toBe(Page);
    expect(reload).not.toHaveBeenCalled();
  });

  it('the first failure at the target reloads the document once (marked); the load never settles meanwhile', async () => {
    history.replaceState(null, '', '/fields');
    const reload = vi.fn();
    let settled = false;
    void resilientLoad(
      async () => {
        throw new TypeError('Failed to fetch dynamically imported module');
      },
      Failed,
      reload,
    )().then(() => (settled = true));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(MARK)).toBe('/fields');
    expect(settled).toBe(false);
  });

  it('failing again after that reload: the error page, no second reload, the mark cleared', async () => {
    history.replaceState(null, '', '/fields');
    sessionStorage.setItem(MARK, '/fields');
    const reload = vi.fn();
    expect(
      await resilientLoad(
        async () => {
          throw new Error('chunk');
        },
        Failed,
        reload,
      )(),
    ).toBe(Failed);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MARK)).toBeNull();
  });

  it('the user moved on (another link, Back) before the failure: no reload, the error goes to the dead navigation', async () => {
    history.replaceState(null, '', '/fields');
    const reload = vi.fn();
    let fail: (e: Error) => void = () => {};
    const result = resilientLoad(() => new Promise<never>((_, reject) => (fail = reject)), Failed, reload)();
    history.pushState(null, '', '/batches');
    fail(new Error('chunk'));
    await expect(result).rejects.toThrow('chunk');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(MARK)).toBeNull();
  });
});
