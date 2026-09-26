import { afterEach, describe, expect, it, vi } from 'vitest';
import { createT } from '@agrotrace/i18n';
import { BOOT_TEXTS, renderBootFailure } from '../../src/bootFailure';
import { afterChunkFailure, chunkLoaded } from '../../src/reload';

// FM15: the static bootstrap failure screen and the reload-once guard shared with the lazy pages.

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('bootstrap failure (FM15)', () => {
  it('the static texts equal the i18n ones', () => {
    const t = createT('ru');
    expect(BOOT_TEXTS).toEqual({
      text: t('empty.pageLoadFailed'),
      retry: t('action.retry'),
    });
  });

  it('FM17: no title — at-page > at-card > at-empty with one line and «Повторить»', () => {
    const root = document.createElement('div');
    renderBootFailure(root);
    expect(root.querySelector('h1')).toBeNull();
    expect(root.textContent).not.toContain('Сервис недоступен');
    expect(root.querySelector('main.at-page > article.at-card > div.at-empty')).not.toBeNull();
    expect(root.querySelector('.at-empty__text')?.textContent).toBe('Не удалось загрузить страницу.');
    const button = root.querySelector<HTMLButtonElement>('button.at-button[data-variant="primary"]')!;
    expect(button.textContent).toBe('Повторить');
  });
});

describe('reload-once guard (FM15)', () => {
  const at = () => `${location.pathname}${location.search}`;

  it('a superseded navigation never reloads; the target reloads once, then the failure is shown', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    expect(afterChunkFailure('/elsewhere')).toBe('superseded');
    expect(reload).not.toHaveBeenCalled();
    expect(afterChunkFailure(at())).toBe('reload');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(afterChunkFailure(at())).toBe('failed');
    expect(reload).toHaveBeenCalledTimes(1);
    // A page that loads fine ends the chain: the next failure may reload again.
    chunkLoaded();
    expect(afterChunkFailure(at())).toBe('reload');
  });
});

describe('reload-once guard without sessionStorage (FM26)', () => {
  it('the mark lives in the history entry: one reload, then the failure — never a loop', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const at = `${location.pathname}${location.search}`;
    expect(afterChunkFailure(at)).toBe('reload');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(afterChunkFailure(at)).toBe('failed');
    expect(reload).toHaveBeenCalledTimes(1);
    chunkLoaded();
    expect(afterChunkFailure(at)).toBe('reload');
    chunkLoaded();
    vi.restoreAllMocks();
  });
});
