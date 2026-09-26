// The static screen of a bootstrap chunk that failed twice (ruling FM15): no framework, README markup (`at-page` with
// its header, `at-card` with `at-empty`: one line and one button). The entry carries no i18n bundle (the public page
// budget): the texts equal `page.unavailable`, `empty.pageLoadFailed` and `action.retry` of @agrotrace/i18n — a test
// (test/app/boot.test.ts) keeps them equal.

export const BOOT_TEXTS = {
  title: 'Сервис недоступен',
  text: 'Не удалось загрузить страницу.',
  retry: 'Повторить',
} as const;

export function renderBootFailure(root: HTMLElement): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const main = el('main', 'at-page');
  main.id = 'main';
  main.tabIndex = -1;
  main.style.maxWidth = '30rem';
  main.style.marginInline = 'auto';
  const header = el('div', 'at-page__header');
  const h1 = el('h1', 'at-page__title', BOOT_TEXTS.title);
  h1.tabIndex = -1;
  header.append(h1);
  const empty = el('div', 'at-empty');
  empty.append(el('p', 'at-empty__text', BOOT_TEXTS.text));
  const button = el('button', 'at-button', BOOT_TEXTS.retry);
  button.type = 'button';
  button.dataset.variant = 'primary';
  button.addEventListener('click', () => window.location.reload());
  empty.append(button);
  const card = el('article', 'at-card');
  card.append(empty);
  main.append(header, card);
  root.replaceChildren(main);
}
