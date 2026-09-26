import { describe, expect, it, vi } from 'vitest';
import { resilientLoad } from '../../src/app/chunk';

// FM11: a page chunk that fails loads the target URL once more as a full document; failing again, the error page.

class Page {}
class Failed {}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('resilientLoad', () => {
  it('a loaded chunk is the page (and clears a reload mark of this URL)', async () => {
    sessionStorage.setItem('agrotrace-chunk-reload', '/');
    const reload = vi.fn();
    expect(await resilientLoad(async () => Page, Failed, reload)()).toBe(Page);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('agrotrace-chunk-reload')).toBeNull();
  });

  it('the first failure reloads the document once (marked), the load never settles meanwhile', async () => {
    sessionStorage.clear();
    const reload = vi.fn();
    let settled = false;
    void resilientLoad(
      () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
      Failed,
      reload,
    )().then(() => (settled = true));
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('agrotrace-chunk-reload')).toBe('/');
    expect(settled).toBe(false);
  });

  it('failing again after that reload: the error page, no second reload, the mark cleared', async () => {
    sessionStorage.setItem('agrotrace-chunk-reload', '/');
    const reload = vi.fn();
    expect(await resilientLoad(() => Promise.reject(new Error('chunk')), Failed, reload)()).toBe(Failed);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('agrotrace-chunk-reload')).toBeNull();
  });
});
