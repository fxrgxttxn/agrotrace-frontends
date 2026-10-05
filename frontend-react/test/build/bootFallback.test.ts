import { describe, expect, it } from 'vitest';
import ru from '@agrotrace/i18n/locales/ru.json';
import { createT } from '@agrotrace/i18n';
import { bootFallbackHtml, bootTexts, injectBootFallback } from '../../vite-plugins/bootFallback';

describe('boot fallback', () => {
  it('texts are the i18n ones', () => {
    const t = createT('ru');
    expect(bootTexts(ru)).toEqual({ text: t('empty.pageLoadFailed'), retry: t('action.retry') });
  });

  it('README markup: at-page > at-card > at-empty, one line and a primary link to the current page', () => {
    const doc = new DOMParser().parseFromString(
      `<body>${bootFallbackHtml(bootTexts(ru))}</body>`,
      'text/html',
    );
    const main = doc.querySelector('main#at-boot.at-page.at-boot')!;
    expect(main).not.toBeNull();
    expect(main.querySelector('h1')).toBeNull();
    expect(main.querySelector('article.at-card > div.at-empty > p.at-empty__text')?.textContent).toBe(
      'Не удалось загрузить страницу.',
    );
    const link = main.querySelector('div.at-empty > a.at-button[data-variant="primary"]')!;
    expect(link.getAttribute('href')).toBe('');
    expect(link.textContent).toBe('Повторить');
    expect(doc.querySelector('script, [style], [onclick]')).toBeNull();
  });

  it('goes right after #root in index.html, once', () => {
    const html = '<body>\n    <div id="root"></div>\n  </body>';
    const out = injectBootFallback(html, bootTexts(ru));
    expect(out.indexOf('<div id="root"></div>')).toBeLessThan(out.indexOf('id="at-boot"'));
    expect(out.match(/id="at-boot"/g)).toHaveLength(1);
    expect(() => injectBootFallback('<body></body>', bootTexts(ru))).toThrow(/root/);
  });
});
